// Golden questions against a running API.
//   npm run golden                                   fixture mode: temp user seeded through /home, deleted after
//   npm run golden -- --user <id> --readonly         live mode: ask an existing user with X-DIRA-Readonly: 1,
//                                                    so the API saves nothing; any row that changes anyway fails the run
//   npm run golden -- --base http://127.0.0.1:4800 --user <id> --readonly --allow-prod-readonly
//                                                    production, readonly only: DATABASE_URL and JWT_SECRET must be
//                                                    production's (passed in the environment), and the server must
//                                                    advertise readonly support on /health; nothing is ever reverted there
// Options: --only wife,parents   --base http://127.0.0.1:4801
import "dotenv/config";
import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import jwt from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";
import { CASES, SEED_MESSAGES, SEED_PLANNED, SEED_PROJECT, SEED_VISIONS, SELF_NAME } from "./cases.js";

const DEV = { port: "4801", db: "dira_dev" };
const PROD = { port: "4800", db: "dira" };
const BUSY = /^DIRA is busy right now/i;
const TABLES = ["user", "entity", "event", "vision", "diaryEntry", "relationship", "lifeEvent", "inputQueue"];
const DELETE_ORDER = ["relationship", "lifeEvent", "inputQueue", "diaryEntry", "event", "vision", "entity"];

const args = parseArgs(process.argv.slice(2));
const base = (args.base || `http://127.0.0.1:${process.env.PORT}`).replace(/\/$/, "");
const prisma = new PrismaClient();
let token = "";
let production = false;

try {
  guard();
  await health();
  const code = args.user ? await live(args.user) : await fixture();
  process.exitCode = code;
} catch (err) {
  console.error(`golden: ${err.message}`);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}

function parseArgs(argv) {
  const out = { readonly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--readonly") out.readonly = true;
    else if (arg === "--user") out.user = argv[++index];
    else if (arg === "--only") out.only = new Set(String(argv[++index] || "").split(",").filter(Boolean));
    else if (arg === "--base") out.base = argv[++index];
    else if (arg === "--allow-prod-readonly") out.allowProdReadonly = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

function guard() {
  let dbName = "";
  try {
    dbName = new URL(process.env.DATABASE_URL || "").pathname.replace(/^\//, "");
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  const port = new URL(base).port;
  production = port === PROD.port || process.env.PORT === PROD.port || dbName === PROD.db;
  if (production) {
    // Production is only ever asked questions: an existing user, readonly, and an explicit opt-in.
    if (!args.allowProdReadonly) throw new Error("refusing to run against production (port 4800 / dira): pass --allow-prod-readonly");
    if (!args.user || !args.readonly) throw new Error("refusing to run against production: only live mode with --user <id> --readonly is allowed");
    if (port !== PROD.port || dbName !== PROD.db) throw new Error(`refusing to run against production: --base must be port ${PROD.port} and DATABASE_URL must be ${PROD.db}, so the no-writes check reads the same database`);
  } else {
    if (args.allowProdReadonly) throw new Error(`--allow-prod-readonly is only for --base on port ${PROD.port}`);
    if (dbName !== DEV.db) throw new Error(`refusing to run: database is not ${DEV.db}`);
    if (port !== DEV.port) throw new Error(`refusing to run: API must be on port ${DEV.port}`);
  }
  const bridge = ["ALTIMETRIX_URL", "ALTIMETRIX_API_URL", "ALTIMETRIX_BRIDGE_SECRET", "ALTIMETRIX_WEBHOOK_SECRET"].filter((name) => process.env[name]);
  if (bridge.length) throw new Error(`refusing to run: Altimetrix bridge is configured (${bridge.join(", ")})`);
  if (args.user && !args.readonly) throw new Error("live mode needs --readonly");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
}

async function health() {
  const res = await fetch(`${base}/health`).catch(() => null);
  if (!res?.ok) throw new Error(`API is not answering at ${base}`);
  // A server without X-DIRA-Readonly would save what live mode sends, so don't send it anything.
  const body = await res.json().catch(() => ({}));
  if (args.readonly && !(body.capabilities || []).includes("readonly-header")) {
    throw new Error(`refusing to run: ${base} does not advertise readonly support (deploy the X-DIRA-Readonly change first)`);
  }
}

function signIn(userId) {
  token = jwt.sign({ userId, type: "access" }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(args.readonly ? { "x-dira-readonly": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json.error || "no body"}`);
  return json;
}

async function fixture() {
  const id = randomUUID();
  await prisma.user.create({
    // Auto-extract on, like an account that was never reset; the reset case turns it off.
    data: { id, email: `golden+${id}@example.invalid`, handle: `golden-${id.slice(0, 8)}`, name: SELF_NAME, settings: { graphAutoExtract: true } },
  });
  console.log(`fixture user ${id}`);
  signIn(id);
  try {
    console.log("\n== seeding through /home ==");
    for (const message of SEED_MESSAGES) {
      const steps = await seed(message);
      console.log(`- ${message.slice(0, 70)}${message.length > 70 ? "…" : ""}\n    ${steps.join(" → ")}`);
    }
    for (const vision of SEED_VISIONS) await prisma.vision.create({ data: { userId: id, ...vision } });
    console.log(`- ${SEED_VISIONS.length} visions created`);
    await settle(id);
    console.log(`- ${await seedProject(id)}`);
    const code = await ask(id, false);
    const resetCode = !args.only || args.only.has("reset-gate") ? await resetGate(id) : 0;
    const keepCode = !args.only || args.only.has("upload-keep-gate") ? await uploadKeepGate(id) : 0;
    return code || resetCode || keepCode;
  } finally {
    await settle(id).catch(() => {});
    await prisma.user.delete({ where: { id } });
    console.log(`\nfixture user ${id} deleted`);
  }
}

// After /graph/reset a stated, confirmed family introduction still becomes edges,
// while a confirmed document event adds nothing to the graph and waits for the next rebuild.
async function resetGate(userId) {
  const failures = [];
  const startedAt = new Date().toISOString();
  await post("/graph/reset", { dryRun: false });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (user?.settings?.graphAutoExtract !== false) failures.push("reset left graphAutoExtract on");

  // The reset removed every edge, so resending the full introduction must rebuild the whole family on its own.
  const intro = SEED_MESSAGES[0];
  const introSteps = await seed(intro);
  await settle(userId, 8000);
  const familyEdges = await prisma.relationship.findMany({ where: { userId, category: "family", status: "confirmed", validTo: null } });
  const people = await prisma.entity.findMany({ where: { userId, status: { not: "archived" } }, select: { id: true, name: true, isSelf: true } });
  const names = new Map(people.map((row) => [row.id, row.name]));
  const selfId = people.find((row) => row.isSelf)?.id;
  const named = (id, pattern) => pattern.test(names.get(id) || "");
  const between = (a, b) => familyEdges.filter((edge) => (named(edge.fromId, a) && named(edge.toId, b)) || (named(edge.fromId, b) && named(edge.toId, a)));
  const parentOf = (edge, parent, child) =>
    (edge.type === "parent_of" && parent(edge.fromId) && child(edge.toId)) || (edge.type === "child_of" && child(edge.fromId) && parent(edge.toId));
  const isSelf = (id) => id === selfId;
  const expected = [
    ...[/^Enock Mwakyusa$/i, /^Froidah/i].map((pattern) => ["parent", pattern, (edge) => parentOf(edge, (id) => named(id, pattern), isSelf)]),
    ...[/^Jeni/i, /^Leah/i, /^Neema/i, /^Zenah/i].map((pattern) => ["sister", pattern, (edge) => edge.type === "sibling_of"]),
    [ "wife", /^Zelda/i, (edge) => edge.type === "spouse_of" ],
    ...[/^Careen/i, /^Patrick/i, /^Presley/i, /^Powell/i, /^Prisha/i].map((pattern) => ["child", pattern, (edge) => parentOf(edge, isSelf, (id) => named(id, pattern))]),
  ];
  let restored = 0;
  for (const [role, pattern, matches] of expected) {
    const found = familyEdges.some((edge) => (isSelf(edge.fromId) || isSelf(edge.toId)) && (named(edge.fromId, pattern) || named(edge.toId, pattern)) && matches(edge));
    if (found) restored += 1;
    else failures.push(`no confirmed ${role} edge for ${pattern.source.replace(/[\^$]/g, "")}`);
  }
  if (familyEdges.length !== 12) failures.push(`family introduction left ${familyEdges.length} confirmed family edge(s), expected 12 (${introSteps.join(" → ")})`);
  const zeldaEnock = between(/^Zelda/i, /^Enock Mwakyusa$/i).length;
  const careenZelda = between(/^Careen/i, /^Zelda/i).length;
  if (zeldaEnock) failures.push(`${zeldaEnock} Zelda–Enock edge(s), expected 0`);
  if (careenZelda) failures.push(`${careenZelda} Careen–Zelda edge(s), expected 0`);

  const edgesBefore = await prisma.relationship.count({ where: { userId } });
  const entitiesBefore = await prisma.entity.count({ where: { userId } });
  const doc = "Certificate of Occupancy for Plot P9200 in Kitunda Industrial Area, issued to Phesto Enock Mwakyusa on 3 March 2024 and witnessed by Hassani Juma Mrisho.";
  const docSteps = await seed(doc);
  await settle(userId, 8000);
  const event = await prisma.event.findFirst({ where: { userId, rawInput: doc }, select: { id: true, graphExtractedAt: true } });
  const edgesAdded = (await prisma.relationship.count({ where: { userId } })) - edgesBefore;
  const entitiesAdded = (await prisma.entity.count({ where: { userId } })) - entitiesBefore;
  if (!event) failures.push(`document event was not saved (${docSteps.join(" → ")})`);
  else if (event.graphExtractedAt) failures.push("document event was marked extracted; the rebuild would skip it");
  if (edgesAdded) failures.push(`document event added ${edgesAdded} edge(s) while auto-extract is off`);
  if (entitiesAdded) failures.push(`document event added ${entitiesAdded} entit${entitiesAdded === 1 ? "y" : "ies"} while auto-extract is off`);

  console.log(`\n${failures.length ? "FAIL" : "PASS"}  reset-gate  [graph reset]  ${startedAt}`);
  console.log(`  Q: /graph/reset  ⇢  full introduction  ⇢  ${doc}`);
  console.log(indent(`family: ${introSteps.join(" → ")}; ${familyEdges.length} confirmed family edge(s), ${restored}/12 expected, Zelda–Enock ${zeldaEnock}, Careen–Zelda ${careenZelda}\ndocument: ${docSteps.join(" → ")}; ${edgesAdded} edge(s), ${entitiesAdded} entities, graphExtractedAt ${event?.graphExtractedAt ? "set" : "null"}`));
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  return failures.length ? 1 : 0;
}

// The project record, its links and the planned events, written directly like the approved one-off on prod.
async function seedProject(userId) {
  const project = await prisma.entity.create({ data: { userId, entityType: "project", name: SEED_PROJECT.name, normalizedName: SEED_PROJECT.name.toLowerCase(), description: `Place: ${SEED_PROJECT.place}`, attributes: { place: SEED_PROJECT.place } } });
  const ref = { entityId: project.id, name: SEED_PROJECT.name, role: "project" };
  const vision = await prisma.vision.findFirst({ where: { userId, title: SEED_PROJECT.vision } });
  await prisma.vision.update({ where: { id: vision.id }, data: { connectedEntities: [...vision.connectedEntities, ref] } });
  let linked = 0;
  for (const event of await prisma.event.findMany({ where: { userId, status: { not: "archived" } } })) {
    const text = [event.title, event.rawInput].join(" ");
    if (!SEED_PROJECT.links.test(text) || SEED_PROJECT.unlinked.test(text)) continue;
    await prisma.event.update({ where: { id: event.id }, data: { people: [...(Array.isArray(event.people) ? event.people : []), ref] } });
    linked += 1;
  }
  for (const planned of SEED_PLANNED) await prisma.event.create({ data: { userId, ...planned, eventType: "project_update", status: "planned", source: "manual", people: [ref] } });
  return `project created, ${linked} events linked, ${SEED_PLANNED.length} planned event(s)`;
}

// Dismissing an uploaded file keeps the file and its path: only Phesto deletes files.
async function uploadKeepGate(userId) {
  const failures = [];
  const startedAt = new Date().toISOString();
  const body = new FormData();
  body.append("message", "");
  body.append("conversationHistory", "[]");
  body.append("file", new Blob(["item,amount,currency\nseeds,120,EUR\nwater tank,300,EUR\n"], { type: "text/csv" }), "garden-costs.csv");
  const res = await fetch(`${base}/home/input`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
  const response = await res.json().catch(() => ({}));
  const queue = await prisma.inputQueue.findFirst({ where: { userId, rawContent: { contains: "garden-costs.csv" } }, orderBy: { createdAt: "desc" } });
  if (!res.ok) failures.push(`upload ${res.status}: ${response.error || "no body"}`);
  if (!queue?.filePath) failures.push("no queue row with a file path");
  else if (!existsSync(queue.filePath)) failures.push("file missing right after upload");
  if (response.sessionId) await post("/home/confirm", { sessionId: response.sessionId, confirmed: false });
  else failures.push(`no card to dismiss (got ${response.result?.type})`);
  const after = queue ? await prisma.inputQueue.findUnique({ where: { id: queue.id } }) : null;
  if (after && after.processingStatus !== "dismissed") failures.push(`queue row is ${after.processingStatus}, not dismissed`);
  if (after && after.filePath !== queue.filePath) failures.push("dismissing changed the file path");
  const kept = Boolean(queue?.filePath && existsSync(queue.filePath));
  if (queue?.filePath && !kept) failures.push("dismissing removed the file");
  if (queue?.filePath && /^\/tmp\//.test(queue.filePath)) failures.push(`stored under /tmp: ${queue.filePath}`);
  console.log(`\n${failures.length ? "FAIL" : "PASS"}  upload-keep-gate  [upload ⇢ dismiss]  ${startedAt}`);
  console.log(indent(`${response.result?.type || "?"} → dismissed; ${queue?.filePath || "no path"}: ${kept ? "kept" : "gone"}`));
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  // The fixture's own test file: the harness tidies up after itself, DIRA never does.
  if (kept) unlinkSync(queue.filePath);
  return failures.length ? 1 : 0;
}

// Confirms whatever DIRA offers, the way a person tapping Save would.
async function seed(message) {
  let response = await sendWithRetry({ message, conversationHistory: [], lastAction: null });
  const steps = [`${response.routing?.intent}/${response.result?.type}`];
  for (let round = 0; round < 3; round += 1) {
    if (response.action === "clarify" && response.sessionId) {
      const options = (response.clarificationOptions || []).map((option) => option.intent);
      const selectedOption = ["relationship_add", "intake_text"].find((intent) => options.includes(intent)) || options[0];
      response = await post("/home/confirm", { sessionId: response.sessionId, confirmed: true, selectedOption });
      steps.push(`chose ${selectedOption} → ${response.routing?.intent}/${response.result?.type}`);
      continue;
    }
    if (response.sessionId && response.result?.confirmationRequired) {
      response = await post("/home/confirm", { sessionId: response.sessionId, confirmed: true });
      steps.push(`confirmed → ${response.result?.type}`);
      continue;
    }
    break;
  }
  if (!["saved", "journal_saved"].includes(response.result?.type)) steps.push("NOT SAVED");
  return steps;
}

async function live(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new Error(`no user ${userId} in ${production ? PROD.db : DEV.db}`);
  console.log(`live readonly run for ${userId}`);
  signIn(userId);
  await settle(userId);
  const before = await snapshot(userId);
  let code = 1;
  try {
    code = await ask(userId, true);
  } finally {
    await settle(userId);
    const after = await snapshot(userId);
    const changes = diff(before, after);
    if (changes.length && production) {
      console.log(`\nREADONLY VIOLATION: the run wrote ${changes.length} row(s) in production; not touching them:`);
      for (const change of changes) console.log(`  ${change.kind} ${change.table} ${change.id}`);
      code = 1;
    } else if (changes.length) {
      console.log(`\nREADONLY VIOLATION: the run wrote ${changes.length} row(s); reverting them`);
      for (const line of await revert(before, changes)) console.log(line);
      const left = diff(before, await snapshot(userId));
      console.log(left.length ? `revert incomplete: ${left.length} row(s) still differ` : "reverted; the account matches its state before the run");
      code = 1;
    } else {
      console.log("\nreadonly: no rows changed");
    }
  }
  return code;
}

async function ask(userId, readonly) {
  const cases = CASES.filter((item) => !args.only || args.only.has(item.id));
  let failed = 0;
  console.log(`\n== ${cases.length} golden cases ==`);
  for (const item of cases) {
    const startedAt = new Date().toISOString();
    const eventsBefore = await prisma.event.count({ where: { userId } });
    const rowsBefore = readonly ? await snapshot(userId) : null;
    let failures;
    let turn = null;
    let eventsCreated = 0;
    try {
      const turns = await converse(item.turns);
      turn = turns.at(-1);
      if (item.countsEvents || readonly) await settle(userId, 8000);
      eventsCreated = (await prisma.event.count({ where: { userId } })) - eventsBefore;
      const answer = answerText(turn.response);
      failures = await item.check({ answer, turn, eventsCreated, db: graphReader(userId) });
      if (!answer) failures.unshift("empty answer");
      if (turn.busyRetries) failures.push(`answered only after ${turn.busyRetries} busy retr${turn.busyRetries === 1 ? "y" : "ies"}`);
    } catch (err) {
      failures = [`error: ${err.message}`];
    }
    const writes = rowsBefore ? diff(rowsBefore, await snapshot(userId)) : [];
    if (writes.length) {
      failures.push(`readonly violated: ${writes.map((change) => `${change.kind} ${change.table}`).join(", ")}${production ? "" : " (reverted)"}`);
      if (!production) failures.push(...(await revert(rowsBefore, writes)).map((line) => line.trim()));
    }
    if (failures.length) failed += 1;
    console.log(`\n${failures.length ? "FAIL" : "PASS"}  ${item.id}  [${turn?.response.routing?.intent || "?"}/${turn?.response.result?.type || "?"}]  ${startedAt}`);
    console.log(`  Q: ${item.turns.join("  ⇢  ")}`);
    console.log(indent(answerText(turn?.response) || "(no answer)"));
    const edges = turn?.response?.result?.content?.edges;
    if (Array.isArray(edges) && edges.length) console.log(indent(edges.map((edge) => `[ ] ${edge.line}`).join("\n")));
    for (const failure of failures) console.log(`  ✗ ${failure}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  return failed ? 1 : 0;
}

async function converse(messages) {
  const history = [];
  let lastAction = null;
  const turns = [];
  for (const message of messages) {
    const turn = await sendWithRetry({ message, conversationHistory: history.slice(-16), lastAction }, true);
    const response = turn.response;
    history.push({ role: "user", content: message });
    const text = historyText(response);
    if (text) history.push({ role: "assistant", content: text });
    lastAction = {
      sessionId: response.sessionId,
      intent: response.routing?.intent,
      summary: response.result?.confirmationText || response.routing?.interpretation || response.result?.content?.message || "",
      saved: response.result?.type === "saved" || (response.result?.type === "journal_saved" && !response.result?.confirmationRequired),
    };
    turns.push(turn);
  }
  return turns;
}

// The UI asks people to send again when DIRA is busy; do the same, and report it.
async function sendWithRetry(body, wrap = false) {
  let busyRetries = 0;
  for (;;) {
    const response = await post("/home/input", body);
    if (!BUSY.test(answerText(response)) || busyRetries >= 2) return wrap ? { response, busyRetries } : response;
    busyRetries += 1;
    await sleep(20000);
  }
}

function answerText(response) {
  const content = response?.result?.content;
  return String(content?.reply || content?.message || response?.result?.confirmationText || "").trim();
}

// Mirrors diraHistoryText in web/app/home/page.tsx.
function historyText(response) {
  const { result } = response;
  const parts = [];
  if (result?.confirmationText) parts.push(result.confirmationText);
  const understood = result?.content?.understood;
  if (understood?.title) {
    parts.push(`Title: ${understood.title}`);
    if (understood.summary) parts.push(`Summary: ${understood.summary}`);
    if (understood.location) parts.push(`Location: ${understood.location}`);
  }
  if (result?.content?.reply) parts.push(result.content.reply);
  if (result?.content?.message && result.content.message !== result.content.reply) parts.push(result.content.message);
  const preview = result?.content?.preview || [];
  if (preview.length) parts.push(preview.map((item) => `${item.title}: ${item.change}`).join("; "));
  if (result?.type === "clarification" && response.clarificationOptions?.length) {
    parts.push(`Asked which was meant: ${response.clarificationOptions.map((option) => option.label).join(", ")}`);
  }
  return parts.filter(Boolean).join("\n").slice(0, 1200);
}

function graphReader(userId) {
  return {
    // From the rows, apart from DIRA's own code: which suggested links already exist (a ref on the event, a
    // relationship of any status, or a vision holding both), and which records name the project without a link.
    async linkCheck(ids, projectName) {
      const [entities, events, visions, relationships] = await Promise.all([
        prisma.entity.findMany({ where: { userId }, select: { id: true, name: true, entityType: true, status: true } }),
        prisma.event.findMany({ where: { userId }, select: { id: true, title: true, rawInput: true, status: true, people: true, places: true } }),
        prisma.vision.findMany({ where: { userId }, select: { id: true, title: true, connectedEntities: true, connectedEvents: true } }),
        prisma.relationship.findMany({ where: { userId }, select: { fromId: true, toId: true } }),
      ]);
      const list = (value) => (Array.isArray(value) ? value : []);
      const name = new Map(entities.map((entity) => [entity.id, entity.name]));
      const pair = new Set(relationships.flatMap((row) => [`${row.fromId}|${row.toId}`, `${row.toId}|${row.fromId}`]));
      const viaVision = (eventId, entityId) => visions.some((vision) => list(vision.connectedEvents).some((ref) => ref?.eventId === eventId) && list(vision.connectedEntities).some((ref) => ref?.entityId === entityId));
      const linked = (kind, recordId, entityId) => {
        if (pair.has(`${recordId}|${entityId}`)) return true;
        if (kind === "vision") return list(visions.find((vision) => vision.id === recordId)?.connectedEntities).some((ref) => ref?.entityId === entityId);
        const event = events.find((row) => row.id === recordId);
        return [...list(event?.people), ...list(event?.places)].some((ref) => ref?.entityId === entityId) || viaVision(recordId, entityId);
      };
      const existing = [];
      for (const id of ids) {
        const [kind, recordId, entityId] = String(id).split(":");
        const title = (kind === "vision" ? visions : events).find((row) => row.id === recordId)?.title || recordId;
        if (linked(kind, recordId, entityId)) existing.push(`${title} → ${name.get(entityId) || entityId}`);
      }
      const project = entities.find((entity) => entity.entityType === "project" && entity.status !== "archived" && entity.name === projectName);
      const missed = [];
      if (project) {
        const asked = new Set(ids.map(String));
        for (const event of events) {
          if (event.status === "archived" || !new RegExp(projectName, "i").test(`${event.title} ${event.rawInput || ""}`)) continue;
          if (!linked("event", event.id, project.id) && !asked.has(`event:${event.id}:${project.id}`)) missed.push(event.title);
        }
      }
      return { existing, missed };
    },
    async treeProblems() {
      const [people, edges] = await Promise.all([
        prisma.entity.findMany({ where: { userId, entityType: "person", status: { not: "archived" } }, select: { id: true, name: true, isSelf: true, birthDate: true, deathDate: true } }),
        prisma.relationship.findMany({ where: { userId, category: "family", status: "confirmed", validTo: null } }),
      ]);
      const name = new Map(people.map((person) => [person.id, person.name]));
      const self = people.find((person) => person.isSelf);
      const is = (id, pattern) => pattern.test(name.get(id) || "");
      const problems = [];
      for (const edge of edges) {
        const from = name.get(edge.fromId) || edge.fromId;
        const to = name.get(edge.toId) || edge.toId;
        if (is(edge.fromId, /hermes/i) || is(edge.toId, /hermes/i)) problems.push(`graph: confirmed family edge ${from} ${edge.type} ${to}`);
        if (edge.type === "sibling_of" && (is(edge.fromId, /zelda/i) || is(edge.toId, /zelda/i))) problems.push(`graph: Zelda is a sibling (${from} sibling_of ${to})`);
        if (edge.type === "parent_of" && is(edge.toId, /zelda/i)) problems.push(`graph: Zelda is a child of ${from}`);
        if (edge.type === "parent_of" && is(edge.fromId, /zelda/i) && is(edge.toId, /careen/i)) problems.push("graph: Careen is Zelda's child");
      }
      for (const person of people) {
        if (person.birthDate && person.deathDate && person.birthDate >= person.deathDate) {
          problems.push(`graph: ${person.name} birth date ${person.birthDate.toISOString().slice(0, 10)} is not before death date ${person.deathDate.toISOString().slice(0, 10)}`);
        }
      }
      if (!self) problems.push("graph: no self entity");
      return problems;
    },
  };
}

// Waits until background extraction stops writing for this user.
async function settle(userId, quietMs = 15000, maxMs = 240000) {
  const started = Date.now();
  let last = fingerprint(await snapshot(userId));
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(2000);
    const next = fingerprint(await snapshot(userId));
    if (next !== last) {
      last = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
  }
  console.log(`  (still writing after ${Math.round(maxMs / 1000)}s; continuing)`);
}

async function snapshot(userId) {
  const tables = {};
  for (const table of TABLES) {
    const where = table === "user" ? { id: userId } : { userId };
    tables[table] = new Map((await prisma[table].findMany({ where })).map((row) => [row.id, row]));
  }
  return tables;
}

function fingerprint(tables) {
  return JSON.stringify(TABLES.map((table) => [...tables[table].values()].sort((a, b) => a.id.localeCompare(b.id))));
}

function diff(before, after) {
  const changes = [];
  for (const table of TABLES) {
    for (const [id, row] of after[table]) {
      const old = before[table].get(id);
      if (!old) changes.push({ table, id, kind: "created" });
      else if (JSON.stringify(old) !== JSON.stringify(row)) changes.push({ table, id, kind: "updated" });
    }
    for (const id of before[table].keys()) {
      if (!after[table].has(id)) changes.push({ table, id, kind: "deleted" });
    }
  }
  return changes;
}

async function revert(before, changes) {
  const lines = [];
  const created = changes.filter((change) => change.kind === "created");
  for (const table of DELETE_ORDER) {
    for (const change of created.filter((item) => item.table === table)) {
      await prisma[table].deleteMany({ where: { id: change.id } });
      lines.push(`  removed ${table} ${change.id}`);
    }
  }
  for (const change of changes.filter((item) => item.kind !== "created")) {
    const data = restorable(change.table, before[change.table].get(change.id));
    if (change.kind === "updated") await prisma[change.table].update({ where: { id: change.id }, data });
    else await prisma[change.table].create({ data });
    lines.push(`  restored ${change.table} ${change.id} (${change.kind})`);
  }
  return lines;
}

function restorable(table, row) {
  const model = Prisma.dmmf.datamodel.models.find((item) => item.name.toLowerCase() === table.toLowerCase());
  const json = new Set(model.fields.filter((field) => field.type === "Json").map((field) => field.name));
  const data = {};
  for (const [key, value] of Object.entries(row)) data[key] = json.has(key) && value === null ? Prisma.DbNull : value;
  return data;
}

function indent(text) {
  return text.split("\n").map((line) => `  │ ${line}`).join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
