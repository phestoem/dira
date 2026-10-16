// Golden questions against a running API.
//   npm run golden                                   fixture mode: temp user seeded through /home, deleted after
//   npm run golden -- --user <id> --readonly         live mode: ask an existing user with X-DIRA-Readonly: 1,
//                                                    so the API saves nothing; any row that changes anyway fails the run
// Options: --only wife,parents   --base http://127.0.0.1:4801
import "dotenv/config";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";
import { CASES, SEED_MESSAGES, SELF_NAME } from "./cases.js";

const REQUIRED_DB = "dira_dev";
const REQUIRED_PORT = "4801";
const BUSY = /^DIRA is busy right now/i;
const TABLES = ["user", "entity", "event", "vision", "diaryEntry", "relationship", "lifeEvent", "inputQueue"];
const DELETE_ORDER = ["relationship", "lifeEvent", "inputQueue", "diaryEntry", "event", "vision", "entity"];

const args = parseArgs(process.argv.slice(2));
const base = (args.base || `http://127.0.0.1:${process.env.PORT}`).replace(/\/$/, "");
const prisma = new PrismaClient();
let token = "";

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
  if (dbName !== REQUIRED_DB) throw new Error(`refusing to run: database is not ${REQUIRED_DB}`);
  if (process.env.PORT === "4800") throw new Error("refusing to run: PORT is 4800 (production)");
  if (new URL(base).port !== REQUIRED_PORT) throw new Error(`refusing to run: API must be on port ${REQUIRED_PORT}`);
  const bridge = ["ALTIMETRIX_URL", "ALTIMETRIX_API_URL", "ALTIMETRIX_BRIDGE_SECRET", "ALTIMETRIX_WEBHOOK_SECRET"].filter((name) => process.env[name]);
  if (bridge.length) throw new Error(`refusing to run: Altimetrix bridge is configured (${bridge.join(", ")})`);
  if (args.user && !args.readonly) throw new Error("live mode needs --readonly");
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
}

async function health() {
  const res = await fetch(`${base}/health`).catch(() => null);
  if (!res?.ok) throw new Error(`API is not answering at ${base}`);
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
    data: { id, email: `golden+${id}@example.invalid`, handle: `golden-${id.slice(0, 8)}`, name: SELF_NAME },
  });
  console.log(`fixture user ${id}`);
  signIn(id);
  try {
    console.log("\n== seeding through /home ==");
    for (const message of SEED_MESSAGES) {
      const steps = await seed(message);
      console.log(`- ${message.slice(0, 70)}${message.length > 70 ? "…" : ""}\n    ${steps.join(" → ")}`);
    }
    await settle(id);
    return await ask(id, false);
  } finally {
    await settle(id).catch(() => {});
    await prisma.user.delete({ where: { id } });
    console.log(`\nfixture user ${id} deleted`);
  }
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
  if (!user) throw new Error(`no user ${userId} in ${REQUIRED_DB}`);
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
    if (changes.length) {
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
      failures.push(`readonly violated: ${writes.map((change) => `${change.kind} ${change.table}`).join(", ")} (reverted)`);
      failures.push(...(await revert(rowsBefore, writes)).map((line) => line.trim()));
    }
    if (failures.length) failed += 1;
    console.log(`\n${failures.length ? "FAIL" : "PASS"}  ${item.id}  [${turn?.response.routing?.intent || "?"}/${turn?.response.result?.type || "?"}]  ${startedAt}`);
    console.log(`  Q: ${item.turns.join("  ⇢  ")}`);
    console.log(indent(answerText(turn?.response) || "(no answer)"));
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
    async treeProblems() {
      const [people, edges] = await Promise.all([
        prisma.entity.findMany({ where: { userId, entityType: "person", status: { not: "archived" } }, select: { id: true, name: true, isSelf: true } }),
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
