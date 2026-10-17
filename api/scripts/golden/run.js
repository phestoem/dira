// Golden questions against a running API.
//   npm run golden                                   fixture mode: temp user seeded through /home, deleted after
//   npm run golden -- --user <id> --readonly         live mode: ask an existing user with X-DIRA-Readonly: 1,
//                                                    so the API saves nothing; any row that changes anyway fails the run
//   npm run golden -- --base http://127.0.0.1:4800 --user <id> --readonly --allow-prod-readonly
//                                                    production, readonly only: DATABASE_URL and JWT_SECRET must be
//                                                    production's (passed in the environment), and the server must
//                                                    advertise readonly support on /health; nothing is ever reverted there
// Options: --only wife,parents   --base http://127.0.0.1:4801
//   npm run golden -- --set holdout3 --extraction --trace <file> [--dump <dir>] [--score-only]
//                                                    seed only, then score the stored graph against
//                                                    test/extraction/<set>.expect.json; <file> is the API's DIRA_EXTRACT_TRACE
import "dotenv/config";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { Prisma, PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { precisionRecall, routeOf, scoreExtraction } from "./extraction.js";
import { gate, scoreClaims } from "./claims.js";
import { CASES, mentionsAmount, mentionsDate, MOTHER_SENTENCE, motherProblems, offeredLines, SEED_MESSAGES, SELF_NAME } from "./cases.js";

const DEV = { port: "4801", db: "dira_dev" };
const PROD = { port: "4800", db: "dira" };
const BUSY = /^DIRA is busy right now/i;
const TABLES = ["user", "entity", "event", "vision", "diaryEntry", "relationship", "lifeEvent", "inputQueue", "claim"];
const DELETE_ORDER = ["claim", "relationship", "lifeEvent", "inputQueue", "diaryEntry", "event", "vision", "entity"];
// Every question turn's server measurements, summarised once per run.
const answerMetrics = [];
// Other families as JSON: --set synthetic, or --set holdout (test/holdout/, run with --score-only and never tuned for).
const SETS = { synthetic: new URL("./sets/synthetic.json", import.meta.url), holdout: new URL("../../test/holdout/holdout.json", import.meta.url), holdout2: new URL("../../test/holdout/holdout2.json", import.meta.url), holdout3: new URL("../../test/holdout/holdout3.json", import.meta.url), life: new URL("./sets/life.json", import.meta.url), holdout4: new URL("../../test/holdout/holdout4.json", import.meta.url), holdout5: new URL("../../test/holdout/holdout5.json", import.meta.url), dev2: new URL("./sets/dev2.json", import.meta.url), dev3: new URL("./sets/dev3.json", import.meta.url) };
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const args = parseArgs(process.argv.slice(2));
const base = (args.base || `http://127.0.0.1:${process.env.PORT}`).replace(/\/$/, "");
const prisma = new PrismaClient();
let token = "";
// A set's "today" (asOf), sent as X-DIRA-As-Of; the dev API honours it only with DIRA_ALLOW_AS_OF=1.
let asOf = null;
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
    else if (arg === "--set") out.set = argv[++index];
    else if (arg === "--score-only") out.scoreOnly = true;
    else if (arg === "--extraction") out.extraction = true;
    else if (arg === "--claims") out.claims = true;
    else if (arg === "--trace") out.trace = argv[++index];
    else if (arg === "--dump") out.dump = argv[++index];
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
  if (args.set && args.user) throw new Error("--set seeds its own fixture user; it has no live mode");
  if (args.claims && !args.set) throw new Error("--claims needs --set");
  if (args.extraction && (!args.set || !args.trace)) throw new Error("--extraction needs --set and --trace (the API's DIRA_EXTRACT_TRACE file)");
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
      "x-dira-metrics": "1",
      ...(asOf ? { "x-dira-as-of": asOf } : {}),
      ...(args.readonly ? { "x-dira-readonly": "1" } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json.error || "no body"}`);
  return json;
}


function loadSet(name) {
  const set = JSON.parse(readFileSync(SETS[name] || name, "utf8"));
  const cases = set.questions.map((question) => ({ id: question.id, domain: question.domain, turns: question.turns, check: ({ answer }) => expectProblems(answer, question.expect || {}) }));
  // A seed is chat text, or { text, source } for an email, journal entry or file.
  const seeds = set.seeds.map((seed) => (typeof seed === "string" ? seed : seed.text));
  return { selfName: set.selfName, seeds, sources: set.seeds.map((seed) => seed.source || "chat"), asOf: set.asOf, cases };
}


// Unicode-aware whole-word match, so "Siobhán" and "O'Connor" match the way they are written.
function mentions(answer, text) {
  const flat = (value) => String(value || "").replace(/[’‘]/g, "'").normalize("NFC");
  const escaped = flat(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(flat(answer));
}

function expectProblems(answer, expect) {
  const failures = [];
  for (const text of expect.has || []) if (!mentions(answer, text)) failures.push(`missing "${text}"`);
  for (const text of expect.lacks || []) if (mentions(answer, text)) failures.push(`must not mention "${text}"`);
  for (const iso of expect.dates || []) if (!mentionsDate(answer, iso)) failures.push(`missing date ${iso}`);
  for (const { value, currency } of expect.amounts || []) if (!mentionsAmount(answer, value)) failures.push(`missing amount ${value} ${currency || ""}`.trim());
  if (expect.count != null && !mentions(answer, String(expect.count)) && !mentions(answer, NUMBER_WORDS[expect.count] || "")) failures.push(`does not say ${expect.count}`);
  return failures;
}

async function fixture() {
  const set = args.set ? loadSet(args.set) : { selfName: SELF_NAME, seeds: SEED_MESSAGES, cases: CASES };
  const quiet = Boolean(args.scoreOnly);
  const id = randomUUID();
  await prisma.user.create({
    // Auto-extract on, like an account that was never reset; the reset case turns it off.
    data: { id, email: `golden+${id}@example.invalid`, handle: `golden-${id.slice(0, 8)}`, name: set.selfName, settings: { graphAutoExtract: true } },
  });
  if (!quiet) console.log(`fixture user ${id}`);
  signIn(id);
  try {
    if (!quiet) console.log("\n== seeding through /home ==");
    const routes = [];
    asOf = set.asOf || null;
    for (const [index, message] of set.seeds.entries()) {
      const steps = await seed(message, [], set.sources?.[index]);
      routes.push(routeOf(steps));
      if (!quiet) console.log(`- ${message.slice(0, 70)}${message.length > 70 ? "…" : ""}\n    ${steps.join(" → ")}`);
    }
    if (args.claims) {
      await extracted(id);
      return claimsReport(id, set, routes, quiet);
    }
    await settle(id);
    if (args.extraction) return extractionReport(id, set, routes, quiet);
    const code = await ask(id, false, set.cases);
    if (args.set) return code;
    const resetCode = !args.only || args.only.has("reset-gate") ? await resetGate(id) : 0;
    const motherCode = !args.only || args.only.has("mother-gate") ? await motherGate() : 0;
    signIn(id);
    return code || resetCode || motherCode;
  } finally {
    await settle(id).catch(() => {});
    await prisma.user.delete({ where: { id } });
    if (!quiet) console.log(`\nfixture user ${id} deleted`);
  }
}

async function extractionReport(userId, set, routes, quiet) {
  const expect = JSON.parse(readFileSync(new URL(`../../test/extraction/${args.set}.expect.json`, import.meta.url), "utf8"));
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
  const [entities, edges] = await Promise.all([
    prisma.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null } }),
    prisma.relationship.findMany({ where: { userId, status: { in: ["confirmed", "suggested"] }, fromKind: "entity", toKind: "entity", OR: [{ label: null }, { label: { not: "conflict" } }] } }),
  ]);
  const snapshot = { self, entities, edges, byId: new Map(entities.map((entity) => [entity.id, entity])) };
  const traces = existsSync(args.trace) ? readFileSync(args.trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.userId === userId) : [];
  const score = scoreExtraction({ expect, seeds: set.seeds, routes, snapshot, traces });
  // --dump <dir> keeps what was scored, so the run can be re-scored without seeding again.
  if (args.dump) {
    mkdirSync(args.dump, { recursive: true });
    writeFileSync(`${args.dump}/${args.set}-${userId}.json`, JSON.stringify({ set: args.set, seeds: set.seeds, routes, self, entities, edges, traces }));
  }
  if (!quiet) {
    console.log("\n== extraction ==");
    for (const item of score.missed) console.log(`MISS  [${item.stage}]  seed ${item.fact.seed}  ${JSON.stringify(item.fact)}`);
    for (const item of score.extra) console.log(`EXTRA  ${item}`);
    if (score.extraPeople.length) console.log(`EXTRA people: ${score.extraPeople.join("; ")}`);
    for (const [key, value] of Object.entries(score.byType).sort()) console.log(`  ${key.padEnd(18)} tp ${value.tp} fp ${value.fp} fn ${value.fn}`);
  }
  const totals = Object.values(score.byType).reduce((sum, value) => ({ tp: sum.tp + value.tp, fp: sum.fp + value.fp, fn: sum.fn + value.fn }), { tp: 0, fp: 0, fn: 0 });
  const { precision, recall } = precisionRecall(totals);
  console.log(`${totals.tp}/${score.facts} facts stored (recall ${recall?.toFixed(2)}, precision ${precision?.toFixed(2)})`);
  console.log(`extraction: ${JSON.stringify({ set: args.set, facts: score.facts, totals, byType: score.byType, people: score.people, routing: score.routing, lost: score.lost, validationDrops: score.validationDrops, traced: traces.length })}`);
  return 0;
}

// Claim store: every saved event extracted (graphExtractedAt set), or 20 minutes.
async function extracted(userId, maxMs = 20 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const pending = await prisma.event.count({ where: { userId, graphExtractedAt: null } });
    if (!pending) return;
    await sleep(3000);
  }
  console.log("  (extraction still running after 20 minutes; scoring what is stored)");
}

// --claims: score the stored claims per domain (docs/knowledge-layer.md). Hold-outs (--score-only) print totals
// and the gate only; other sets list every miss and extra.
async function claimsReport(userId, set, routes, quiet) {
  const expectFile = new URL(`../../test/extraction/${args.set}.expect.json`, import.meta.url);
  // Sets whose expectations are not claims yet (old people-only format) report routing only.
  const expect = existsSync(expectFile) ? JSON.parse(readFileSync(expectFile, "utf8")) : {};
  if (!Array.isArray(expect.claims)) expect.claims = [];
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
  const [entities, claims] = await Promise.all([
    prisma.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null } }),
    prisma.claim.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  const score = scoreClaims({ expect, entities, claims, selfId: self?.id });
  const routing = {};
  routes.forEach((route) => { routing[route] = (routing[route] || 0) + 1; });
  const dropped = routes.filter((route) => route === "question" || route === "dropped").length;
  if (args.dump) {
    mkdirSync(args.dump, { recursive: true });
    writeFileSync(`${args.dump}/${args.set}-claims-${userId}.json`, JSON.stringify({ set: args.set, routes, self, entities, claims }));
  }
  if (!quiet) {
    const name = new Map(entities.map((entity) => [entity.id, entity.name]));
    console.log("\n== claims ==");
    routes.forEach((route, index) => { if (route === "question" || route === "dropped") console.log(`DROPPED AT ROUTING  seed ${index}`); });
    for (const fact of score.missed) console.log(`MISS  seed ${fact.seed}  ${JSON.stringify(fact)}`);
    for (const claim of score.extra) console.log(`EXTRA  ${name.get(claim.subjectId) || claim.subjectId} ${claim.predicate} ${claim.objectId ? name.get(claim.objectId) : JSON.stringify(claim.value)}${claim.amount != null ? ` ${claim.amount} ${claim.currency || ""}` : ""}${claim.date ? ` @${claim.date}` : ""}`);
  }
  const pct = (value) => (value == null ? "–" : `${Math.round(value * 100)}%`);
  console.log(`${score.total.tp}/${score.claims} claims stored (recall ${pct(score.total.recall)}, precision ${pct(score.total.precision)}); dropped at routing ${dropped}`);
  console.log(`domains: ${Object.entries(score.byDomain).filter(([, value]) => value.tp + value.fn + value.fp).map(([domain, value]) => `${domain} ${pct(value.recall)} (${value.tp}/${value.tp + value.fn}, fp ${value.fp})`).join(" | ")}`);
  const verdict = gate(score, dropped);
  console.log(`claims: ${JSON.stringify({ set: args.set, claims: score.claims, total: score.total, byDomain: score.byDomain, routing, dropped, gate: verdict })}`);
  return 0;
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

// Production's shape when the mother vanished: the self still carries pronoun aliases, the father is confirmed,
// Froidah exists as a person with a generic kind, an earlier card rejected her parent edge, and older suggested
// residences sit on the self. The mother sentence and then the full introduction must link her, not the self.
async function motherGate() {
  const id = randomUUID();
  const failures = [];
  const startedAt = new Date().toISOString();
  await prisma.user.create({ data: { id, email: `golden+${id}@example.invalid`, handle: `golden-${id.slice(0, 8)}`, name: SELF_NAME } });
  try {
    const entity = (name, entityType, kind, extra = {}) => prisma.entity.create({ data: { userId: id, name, entityType, kind, normalizedName: name.toLowerCase(), aliases: [name], status: "active", ...extra } });
    const self = await entity(SELF_NAME, "person", "self", { isSelf: true, aliases: ["phesto", "me", "i", "mimi", SELF_NAME] });
    const enock = await entity("Enock Mwakyusa", "person", "person");
    const froidah = await entity("Froidah Biniala Kyando", "person", "person");
    const mbeya = await entity("Mbeya", "place", null);
    const home = await entity("family home", "property", null);
    const edge = (fromId, type, toId, status, category) => prisma.relationship.create({ data: { userId: id, fromKind: "entity", fromId, toKind: "entity", toId, type, category, status, source: "conversation", attributes: {}, createdAt: new Date(Date.now() - 86400000) } });
    await edge(enock.id, "parent_of", self.id, "confirmed", "family");
    await edge(froidah.id, "parent_of", self.id, "rejected", "family");
    await edge(self.id, "lives_at", mbeya.id, "suggested", "location");
    await edge(self.id, "lives_at", home.id, "suggested", "location");
    // Her Mbeya residence was ended once and "family home" is current, as in dira_dev.
    const ended = await edge(froidah.id, "lives_at", mbeya.id, "confirmed", "location");
    await prisma.relationship.update({ where: { id: ended.id }, data: { validTo: new Date(Date.now() - 3600000) } });
    await edge(froidah.id, "lives_at", home.id, "confirmed", "location");
    signIn(id);

    const cards = [];
    const motherSteps = await seed(MOTHER_SENTENCE, cards);
    failures.push(...motherProblems(cards[0]).map((failure) => `mother sentence card: ${failure}`));
    await settle(id, 4000);
    const current = { userId: id, status: "confirmed", validTo: null };
    if (!(await prisma.relationship.count({ where: { ...current, fromId: froidah.id, type: "parent_of", toId: self.id } }))) failures.push("Froidah → self parent_of not confirmed");
    if (!(await prisma.relationship.count({ where: { ...current, fromId: froidah.id, type: "lives_at", toId: mbeya.id } }))) failures.push("Froidah lives_at Mbeya not confirmed");
    const selfLives = await prisma.relationship.count({ where: { ...current, fromId: self.id, type: "lives_at" } });
    if (selfLives) failures.push(`${selfLives} confirmed lives_at on the self`);
    const pronouns = await prisma.entity.count({ where: { userId: id, normalizedName: { in: ["she", "her", "he", "my mother"] } } });
    if (pronouns) failures.push(`${pronouns} entity named after a pronoun or "my mother"`);
    const aliases = (await prisma.entity.findUnique({ where: { id: self.id } })).aliases.filter((alias) => ["i", "me", "mimi"].includes(alias.toLowerCase()));
    if (aliases.length) failures.push(`self still has pronoun aliases: ${aliases.join(", ")}`);
    if ((await prisma.entity.findUnique({ where: { id: froidah.id } })).kind !== "mother") failures.push("Froidah's kind is not mother");

    const introSteps = await seed(SEED_MESSAGES[0], cards);
    const introLines = offeredLines(cards[1]);
    if (!introLines.some((line) => /^Froidah Biniala Kyando — your mother\b/.test(line))) failures.push("introduction card has no mother line");
    for (const line of introLines) if (new RegExp(`^${SELF_NAME} — lives in`).test(line)) failures.push(`introduction card offers "${line}"`);
    await settle(id, 4000);
    const family = await prisma.relationship.count({ where: { ...current, category: "family", OR: [{ fromId: self.id }, { toId: self.id }] } });
    if (family !== 12) failures.push(`${family} confirmed family edges on the self after the introduction, expected 12`);
    if ((await prisma.relationship.count({ where: { ...current, fromId: self.id, type: "lives_at" } }))) failures.push("introduction confirmed a lives_at on the self");

    console.log(`\n${failures.length ? "FAIL" : "PASS"}  mother-gate  [production shape]  ${startedAt}`);
    console.log(`  Q: ${MOTHER_SENTENCE}  ⇢  full introduction`);
    console.log(indent(`mother: ${motherSteps.join(" → ")}\n${offeredLines(cards[0]).join("\n")}\nintroduction: ${introSteps.join(" → ")}; ${introLines.length} card line(s); ${family} confirmed family edges`));
  } catch (err) {
    failures.push(`error: ${err.message}`);
    console.log(`\nFAIL  mother-gate  [production shape]  ${startedAt}`);
  } finally {
    await settle(id).catch(() => {});
    for (const table of DELETE_ORDER) await prisma[table].deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  return failures.length ? 1 : 0;
}

// Confirms whatever DIRA offers, the way a person tapping Save would. Relationship cards are collected in `cards`.
async function seed(message, cards = [], source = null) {
  // A non-chat source (email, journal, file) is only read by the claim store; the old paths ignore it.
  let response = await sendWithRetry({ message, conversationHistory: [], lastAction: null, ...(source && source !== "chat" ? { source } : {}) });
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
      if (response.result.type === "relationship_preview") cards.push(response);
      response = await post("/home/confirm", { sessionId: response.sessionId, confirmed: true });
      steps.push(`confirmed → ${response.result?.type}`);
      continue;
    }
    break;
  }
  // A mixed message (claim store) is answered and saved: result.saved says so.
  if (!["saved", "journal_saved"].includes(response.result?.type) && response.result?.saved !== true) steps.push("NOT SAVED");
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

async function ask(userId, readonly, all = CASES) {
  const cases = all.filter((item) => !args.only || args.only.has(item.id));
  let failed = 0;
  const domains = {};
  const quiet = Boolean(args.scoreOnly);
  if (!quiet) console.log(`\n== ${cases.length} golden cases ==`);
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
    if (item.domain) {
      const tally = (domains[item.domain] ||= { passed: 0, asked: 0 });
      tally.asked += 1;
      if (!failures.length) tally.passed += 1;
    }
    if (quiet) continue;
    console.log(`\n${failures.length ? "FAIL" : "PASS"}  ${item.id}  [${turn?.response.routing?.intent || "?"}/${turn?.response.result?.type || "?"}]  ${startedAt}`);
    console.log(`  Q: ${item.turns.join("  ⇢  ")}`);
    console.log(indent(answerText(turn?.response) || "(no answer)"));
    for (const failure of failures) console.log(`  ✗ ${failure}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  // Per domain, never only one total (whole-life sets).
  if (Object.keys(domains).length) console.log(`domains: ${Object.entries(domains).map(([domain, { passed, asked }]) => `${domain} ${passed}/${asked}`).join(" | ")}`);
  console.log(metricsSummary());
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
    if (response.metrics) answerMetrics.push(response.metrics);
  }
  return turns;
}


function metricsSummary() {
  if (!answerMetrics.length) return "metrics: none returned (server without x-dira-metrics)";
  const sorted = answerMetrics.map((item) => item.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const calls = answerMetrics.map((item) => item.modelCalls);
  const mean = calls.reduce((sum, value) => sum + value, 0) / calls.length;
  const paths = {};
  for (const item of answerMetrics) paths[item.path || "other"] = (paths[item.path || "other"] || 0) + 1;
  return `metrics: answers ${answerMetrics.length} | median ${median} ms | model calls mean ${mean.toFixed(1)} (min ${Math.min(...calls)}, max ${Math.max(...calls)}) | paths ${JSON.stringify(paths)}`;
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
