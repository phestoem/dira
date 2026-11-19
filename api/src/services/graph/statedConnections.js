import { prisma } from "../../prisma.js";
import { confirmedPeople, fold, nameKeys } from "../peopleLinks.js";

// "X is the mother of my children, except Y", "X is the father of A, B and C": a parent connection stated about
// people who are already records. Read by code, no model. The result is a proposal only; nothing is written until
// the user confirms the card (applyProposedConnections).

const PARENT = /\b(?:is|was)\s+(?:the\s+)?(mother|father|mum|mom|dad|parent)\s+of\s+(.+)$/i;
const EXCEPT = /\s*(?:,\s*)?\b(?:except(?:\s+for)?|but\s+not|apart\s+from|other\s+than|excluding|isipokuwa)\b\s*/i;
const ALL_CHILDREN = /^(?:all\s+)?(?:of\s+)?(?:my|our)\s+(?:children|kids|sons\s+and\s+daughters)\b/i;

function splitNames(text) {
  return String(text || "")
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,|\band\b|&|\bna\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function findPerson(name, keys) {
  const key = fold(name);
  return keys.find((entry) => entry.key === key) || null;
}

// { parent, children: [{ id, name }], excepted: [names], unknown: [names], kind } or null.
export async function proposeParentConnections(userId, text) {
  const sentence = String(text || "").trim();
  const match = sentence.match(PARENT);
  if (!match) return null;
  const subject = sentence.slice(0, match.index).trim();
  const people = await confirmedPeople(userId);
  const keys = nameKeys(people);
  const parent = findPerson(subject, keys);
  if (!parent) return null;
  const [rest, exceptText] = match[2].split(EXCEPT);
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true } });
  if (!self) return null;
  const ownChildren = await prisma.relationship.findMany({ where: { userId, type: "parent_of", status: "confirmed", fromId: self.id, validTo: null }, select: { toId: true } });
  const childIds = new Set(ownChildren.map((edge) => edge.toId));
  const childKeys = keys.filter((entry) => childIds.has(entry.id));
  let children = [];
  const unknown = [];
  if (ALL_CHILDREN.test(rest.trim())) {
    children = people.filter((person) => childIds.has(person.id)).map((person) => ({ id: person.id, name: person.name }));
  } else {
    for (const name of splitNames(rest)) {
      const found = findPerson(name, keys);
      if (found && found.id !== parent.id) children.push({ id: found.id, name: found.name });
      else unknown.push(name);
    }
  }
  const excepted = [];
  for (const name of splitNames(exceptText)) {
    const found = findPerson(name, childKeys.length ? childKeys : keys);
    if (found) {
      excepted.push(found.name);
      children = children.filter((child) => child.id !== found.id);
    } else {
      unknown.push(name);
    }
  }
  children = children.filter((child, index) => children.findIndex((other) => other.id === child.id) === index && child.id !== parent.id);
  const kind = { mum: "mother", mom: "mother", dad: "father" }[match[1].toLowerCase()] || match[1].toLowerCase();
  return { parent: { id: parent.id, name: parent.name }, children, excepted, unknown, kind };
}

// Proposed edges for the card: [{ id: "proposed:<n>", type, fromId, toId, existing }] where existing is a recorded
// connection already confirmed (shown, not proposed again).
export async function proposalEdges(userId, proposal) {
  const out = [];
  for (const [index, child] of proposal.children.entries()) {
    const existing = await prisma.relationship.findFirst({ where: { userId, type: "parent_of", fromId: proposal.parent.id, toId: child.id } });
    if (existing?.status === "confirmed") continue;
    out.push({ id: `proposed:${index}`, type: "parent_of", fromId: proposal.parent.id, toId: child.id, category: "family", attributes: { parentRole: proposal.kind } });
  }
  return out;
}

// On confirm: the chosen proposals become confirmed connections (an earlier suggested or rejected one is confirmed).
export async function applyProposedConnections(userId, proposals, chosenIds, message) {
  let written = 0;
  for (const edge of proposals) {
    if (!chosenIds.has(edge.id)) continue;
    await prisma.relationship.upsert({
      where: { userId_fromKind_fromId_type_toKind_toId: { userId, fromKind: "entity", fromId: edge.fromId, type: edge.type, toKind: "entity", toId: edge.toId } },
      create: { userId, fromKind: "entity", fromId: edge.fromId, toKind: "entity", toId: edge.toId, type: edge.type, category: "family", status: "confirmed", source: "user", confidence: 1, attributes: edge.attributes || {}, evidenceText: String(message || "").slice(0, 500) },
      update: { status: "confirmed", source: "user", validTo: null },
    });
    written += 1;
  }
  return written;
}
