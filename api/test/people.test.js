import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { chooseSelfName, getOrCreateSelf, resolveEntity } from "../src/services/graph/entityResolver.js";
import { describeRelationshipLine, isRelationshipStatement, namesPersonWithRole } from "../src/services/graph/familyStatement.js";
import { buildSelfAliasSet, prepareTriples, selfMatchKind } from "../src/services/graph/graphQuality.js";
import { mentionsDate } from "../src/services/graph/dates.js";
import { peopleToGraph, validatePeople } from "../src/services/graph/peopleFacts.js";
import { answerPeopleQuestion, buildPeopleContext, deliverPeopleAnswer, groundAdvisorReply, isPeopleQuestion, resolvePeopleFollowUp } from "../src/services/graph/peopleGrounding.js";
import { commitTriples } from "../src/services/graph/relationshipExtractor.js";

// An invented family. Nothing here comes from a real account, and none of it appears in src/ prompts.
const SELF = "Lucía Andrade Pinto";
const INTRO = "My father Héctor Andrade was born on 2 June 1950 and died on 9 October 2011. My mother Marta Pinto lives in Braga. I have two brothers: Iván and Joaquín Andrade. My husband is Pablo Ruiz; we married on 14 February 2009. Our children are Sara, born 3 March 2010, and Nico. Sara is my eldest daughter.";
const context = { text: INTRO, selfName: SELF, selfAliases: [] };

test.after(async () => {
  await prisma.$disconnect();
});

const modelOutput = [
  { name: "Héctor Andrade", relation: "father", relationOf: "narrator", gender: "male", birthDate: "1950-06-02", deathDate: "2011-10-09", evidence: "My father Héctor Andrade was born on 2 June 1950 and died on 9 October 2011" },
  { name: "Marta Pinto", relation: "mother", relationOf: "narrator", gender: "female", livesIn: "Braga", evidence: "My mother Marta Pinto lives in Braga" },
  { name: "Iván Andrade", relation: "brother", relationOf: "narrator", gender: "male", evidence: "Iván and Joaquín Andrade" },
  { name: "Joaquín Andrade", relation: "brother", relationOf: "narrator", gender: "male", evidence: "Iván and Joaquín Andrade" },
  { name: "Pablo Ruiz", relation: "husband", relationOf: "narrator", gender: "male", marriageDate: "2009-02-14", evidence: "My husband is Pablo Ruiz; we married on 14 February 2009" },
  { name: "Sara", relation: "daughter", relationOf: "narrator", gender: "female", birthDate: "2010-03-03", evidence: "Our children are Sara, born 3 March 2010" },
  { name: "Nico", relation: "child", relationOf: "narrator", evidence: "Our children are Sara, born 3 March 2010, and Nico" },
];

test("validated people become kinship edges, dates and residences", () => {
  const { people, dropped } = validatePeople(modelOutput, context);
  assert.deepEqual(dropped, []);
  const graph = peopleToGraph(people);
  const lines = graph.triples.map((triple) => `${triple.subject.name} ${triple.predicate} ${triple.object.name}`);
  assert.deepEqual(lines, [
    "Héctor Andrade parent_of me",
    "Marta Pinto parent_of me",
    "Marta Pinto lives_at Braga",
    "Iván Andrade sibling_of me",
    "Joaquín Andrade sibling_of me",
    "Pablo Ruiz spouse_of me",
    "me parent_of Sara",
    "me parent_of Nico",
  ]);
  assert.equal(graph.triples.find((triple) => triple.predicate === "spouse_of").validFrom, "2009-02-14");
  assert.deepEqual(graph.entityFacts.find((fact) => fact.name === "Héctor Andrade"), { name: "Héctor Andrade", birthDate: "1950-06-02", deathDate: "2011-10-09", kind: "father", birthOrder: null });
  assert.equal(graph.entityFacts.find((fact) => fact.name === "Sara").kind, "daughter");
  const prepared = prepareTriples(graph.triples, { selfAliases: buildSelfAliasSet({ names: [SELF] }), selfName: SELF, relatives: [], message: INTRO });
  assert.equal(prepared.kept.length, 8);
  assert.equal(prepared.kept.filter((triple) => triple.subject.type === "self" || triple.object.type === "self").length, 7);
});

test("invariants drop what the text does not support", () => {
  const text = "Her mother Ana Lopes lives in Faro. My sister Inés was born on 5 May 1990. My aunt paid 500 EUR. She called me. Diego's son Bruno was born on 1 May 2012; Bruno is not Carla's child.";
  const { people, dropped } = validatePeople([
    { name: "Ana Lopes", relation: "mother", relationOf: "narrator", gender: "female", livesIn: "Faro", evidence: "Her mother Ana Lopes lives in Faro" },
    { name: "Inés", relation: "sister", relationOf: "narrator", gender: "male", birthDate: "1990-05-05", evidence: "My sister Inés was born on 5 May 1990" },
    { name: "Inés", birthDate: "1990-05-06", evidence: "My sister Inés was born on 5 May 1990" },
    { name: "500 EUR", relation: "child", evidence: "paid 500 EUR" },
    { name: "She", relation: "sister", evidence: "She called me" },
    { name: "aunt", evidence: "My aunt" },
    { name: "Carlos Mendes", relation: "brother", relationOf: "narrator", evidence: "My brother Carlos Mendes" },
    { name: "Bruno", relation: "son", relationOf: "Carla", notChildOf: ["Carla"], birthDate: "2012-05-01", deathDate: "2001-01-01", evidence: "Diego's son Bruno was born on 1 May 2012" },
  ], { text, selfName: SELF });
  const reasons = dropped.map((item) => `${item.name}:${item.reason}`);
  // "Her mother" is someone else's mother; a relation to the narrator needs my/our/I.
  assert.ok(reasons.includes("Ana Lopes:relation-without-narrator-possessive"));
  // The kinship word says female; a stated "male" contradicts it.
  assert.ok(reasons.includes("Inés:gender-mismatch"));
  // A date the text never states is not kept.
  assert.ok(reasons.includes("Inés:birthDate-not-in-text"));
  assert.ok(reasons.includes("500 EUR:amount-as-person"));
  assert.ok(reasons.includes("She:pronoun"));
  assert.ok(reasons.includes("aunt:kinship-word"));
  assert.ok(reasons.includes("Carlos Mendes:name-not-in-text"));
  assert.ok(reasons.includes("Bruno:contradicts-not-child-of"));
  assert.ok(reasons.includes("Bruno:deathDate-not-in-text"));
  const ana = people.find((person) => person.name === "Ana Lopes");
  assert.equal(ana.relation, null);
  assert.equal(ana.livesIn, "Faro");
  assert.equal(people.find((person) => person.name === "Inés").birthDate, "1990-05-05");

  // One birth date per person: two stated dates for the same person keep neither.
  const twice = validatePeople([
    { name: "Inés", birthDate: "1990-05-05", evidence: "Inés was born on 5 May 1990" },
    { name: "Inés", birthDate: "1991-05-05", evidence: "Inés was born on 5 May 1991" },
  ], { text: "Inés was born on 5 May 1990. Inés was born on 5 May 1991.", selfName: SELF });
  assert.equal(twice.people.length, 1);
  assert.equal(twice.people[0].birthDate, null);
  assert.ok(twice.dropped.some((item) => item.reason === "conflicting-birthDate"));

  // What the graph already knows wins: a man on record is never "my mother".
  const known = validatePeople([{ name: "Héctor Andrade", relation: "mother", relationOf: "narrator", evidence: "my mother Héctor Andrade" }], { text: "my mother Héctor Andrade", selfName: SELF, knownGender: () => "male" });
  assert.equal(known.people[0].relation, null);
  assert.equal(known.dropped[0].reason, "gender-mismatch");

  // The narrator is never a person entry, by name or pronoun; their own dates go on the narrator.
  const narrator = validatePeople([{ name: "Lucía Andrade Pinto", birthDate: "1981-07-30" }, { name: "me", relation: "sister" }], { text: "I, Lucía Andrade Pinto, was born on 30 July 1981.", selfName: SELF });
  assert.equal(narrator.people.every((person) => person.isNarrator && !person.relation), true);
  assert.equal(peopleToGraph(narrator.people).narrator.birthDate, "1981-07-30");
});

test("dates count only when the text states them", () => {
  assert.equal(mentionsDate("born on 3 February 1993", "1993-02-03"), true);
  assert.equal(mentionsDate("born February 3rd, 1993", "1993-02-03"), true);
  assert.equal(mentionsDate("born 3rd of Feb 1993", "1993-02-03"), true);
  assert.equal(mentionsDate("alizaliwa tarehe 3 Februari 1993", "1993-02-03"), true);
  assert.equal(mentionsDate("born in 1993", "1993-02-03"), false);
  assert.equal(mentionsDate("born on 4 February 1993", "1993-02-03"), false);
});

// Stored facts the way loadPeopleContext hands them over.
function storedFamily(extra = {}) {
  const people = [
    { id: "self", name: SELF, kind: "self", role: "self" },
    { id: "hector", name: "Héctor Andrade", kind: "father", role: "parent", birthDate: "1950-06-02", deathDate: "2011-10-09" },
    { id: "marta", name: "Marta Pinto", kind: "mother", role: "parent" },
    { id: "ivan", name: "Iván Andrade", kind: "brother", role: "sibling", birthDate: "1984-01-20" },
    { id: "joaquin", name: "Joaquín Andrade", kind: "brother", role: "sibling" },
    { id: "pablo", name: "Pablo Ruiz", kind: "husband", role: "spouse" },
    { id: "sara", name: "Sara", kind: "daughter", role: "child", birthDate: "2010-03-03" },
  ];
  const edge = (id, type, fromId, toId, status = "confirmed", validFrom = null) => ({ id, type, status, fromId, toId, validFrom, fromName: people.find((p) => p.id === fromId)?.name || "Nico", toName: people.find((p) => p.id === toId)?.name || "Nico" });
  return buildPeopleContext({
    self: people[0],
    people,
    others: [{ id: "nico", name: "Nico", kind: "child" }],
    edges: [
      edge("e1", "parent_of", "hector", "self"),
      edge("e2", "parent_of", "marta", "self"),
      edge("e3", "sibling_of", "ivan", "self"),
      edge("e4", "sibling_of", "joaquin", "self"),
      edge("e5", "spouse_of", "pablo", "self", "confirmed", "2009-02-14"),
      edge("e6", "parent_of", "self", "sara"),
      edge("e7", "parent_of", "self", "nico", "suggested"),
    ],
    ...extra,
  });
}

test("answers read stored facts, and mark what is still unconfirmed", () => {
  const family = storedFamily();
  assert.match(answerPeopleQuestion("who is my husband?", family), /^Pablo Ruiz — your husband \(married 14 Feb 2009\)\.$/);
  const parents = answerPeopleQuestion("who are my parents?", family);
  assert.match(parents, /Héctor Andrade — your father \(passed 9 Oct 2011\)/);
  assert.match(parents, /Marta Pinto — your mother/);
  assert.equal(answerPeopleQuestion("who is my mother?", family), "Marta Pinto — your mother.");
  const births = answerPeopleQuestion("when were my brothers born?", family);
  assert.match(births, /Iván Andrade — 20 Jan 1984/);
  assert.match(births, /Joaquín Andrade — birth date not recorded yet/);
  // Nico is only on a suggested edge: counted, and the answer says to confirm.
  const kids = answerPeopleQuestion("how many children do I have?", family);
  assert.match(kids, /You have 2 children: Sara, Nico\./);
  assert.match(kids, /confirm in Review/);
  assert.equal(resolvePeopleFollowUp("what are their names?", "how many kids do I have?"), "what are my children's names?");
  const tree = answerPeopleQuestion("show my family tree", family);
  assert.match(tree, /Parents: Héctor Andrade \(father, b\. 2 Jun 1950, passed 9 Oct 2011\); Marta Pinto \(mother\)/);
  assert.match(tree, /Spouse: Pablo Ruiz \(husband, married 14 Feb 2009\)/);
  assert.match(tree, /Children: Sara \(daughter, b\. 3 Mar 2010\); Nico/);
  for (const line of tree.split("\n")) if (/^(Siblings|Children):/.test(line)) assert.equal(line.includes("Pablo"), false, line);
  assert.equal(answerPeopleQuestion("list my children", buildPeopleContext({ self: { id: "self", name: SELF }, people: [{ id: "self", name: SELF, kind: "self" }] })), "Your children aren't recorded yet.");
});

test("a reply may only use names and dates that are stored", () => {
  const family = storedFamily({ conflicts: [{ entityId: "ivan", name: "Iván Andrade", field: "birthDate", values: ["1984-01-20", "1984-02-20"] }] });
  const invented = "Your father's wife is Rosa Andrade (married 1975). Iván Andrade was born on 20 January 1984. Joaquín was born in 1987.";
  const checked = groundAdvisorReply(invented, family);
  assert.equal(checked.reply.includes("Rosa"), false);
  assert.equal(checked.reply.includes("1987"), false);
  assert.match(checked.reply, /20 January 1984/);
  const delivered = deliverPeopleAnswer(invented, family, "my father's family tree");
  assert.equal(delivered.reply.includes("Rosa"), false);
  assert.match(answerPeopleQuestion("tell me about my family", family), /Iván Andrade's birth date is recorded as both 20 Jan 1984 and 20 Feb 1984\. Which is right\?/);
});

test("question and statement wording", () => {
  assert.equal(isPeopleQuestion("who is my husband?"), true);
  assert.equal(isPeopleQuestion("my parents?"), true);
  assert.equal(isPeopleQuestion("brothers' birth dates"), true);
  assert.equal(isRelationshipStatement(INTRO), true);
  assert.equal(isRelationshipStatement("Who are my brothers?"), false);
  assert.equal(isRelationshipStatement("I have two brothers"), false);
  assert.equal(namesPersonWithRole("Today I felt grateful for my family."), false);
  assert.equal(namesPersonWithRole("My brother Iván Andrade was born on 20 January 1984."), true);
  const you = { id: "self", name: "you" };
  assert.equal(describeRelationshipLine({ type: "parent_of", from: { id: "h", name: "Héctor Andrade", kind: "father", deathDate: "2011-10-09" }, to: you, selfId: "self" }), "Héctor Andrade — your father (passed 9 Oct 2011)");
  assert.equal(describeRelationshipLine({ type: "parent_of", from: you, to: { id: "s", name: "Sara", kind: "daughter" }, selfId: "self", attributes: { birthOrder: 1 } }), "Sara — your daughter (eldest)");
  assert.equal(describeRelationshipLine({ type: "spouse_of", from: { id: "p", name: "Pablo Ruiz", kind: "husband" }, to: { id: "h", name: "Héctor Andrade", kind: "father" }, selfId: "self" }), "Pablo Ruiz — husband of Héctor Andrade (your father)");
  assert.equal(chooseSelfName({ profileName: "lucia", handle: "lucia", eventNames: [{ name: SELF, count: 2 }] }), SELF);
});

test("possessive kinship stays on the narrator", () => {
  const prepared = prepareTriples([
    { subject: { name: "Pablo Ruiz", type: "person" }, predicate: "spouse_of", object: { name: "Héctor Andrade", type: "person" }, evidence: INTRO },
  ], { selfAliases: buildSelfAliasSet({ names: [SELF] }), selfName: SELF, relatives: [], message: INTRO });
  assert.equal(prepared.kept.length, 0);
  assert.equal(prepared.dropped[0].reason, "possessive-mismatch");
  const aliases = buildSelfAliasSet({ names: [SELF], aliases: ["lucia", "me", "i", "mimi"] });
  assert.equal(aliases.some((alias) => ["i", "me", "mimi", "my"].includes(alias.toLowerCase())), false);
  assert.equal(selfMatchKind("I", aliases), "pronoun");
  for (const pronoun of ["she", "She", "he", "they", "her"]) assert.equal(selfMatchKind(pronoun, aliases), null);
  const she = prepareTriples([{ subject: { name: "She", type: "person" }, predicate: "lives_at", object: { name: "family home", type: "property" }, evidence: "She lives in our family home" }], { selfAliases: aliases, selfName: SELF, relatives: [] });
  assert.equal(she.kept.length, 0);
  assert.equal(she.dropped[0].reason, "unresolved-pronoun");
});

test("with the father confirmed, a mother sentence links her and not the self", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not ready for graph tests");
    return;
  }
  const user = await prisma.user.create({ data: { email: `mother-${Date.now()}@example.com`, handle: `mother${Date.now()}`, name: SELF } });
  try {
    // The shape that lost a mother in production: pronoun aliases on the self, the father confirmed, the mother a
    // separate person with a generic kind, an earlier rejection of her parent edge, an older residence on the self.
    const self = await prisma.entity.create({ data: { userId: user.id, name: SELF, entityType: "person", kind: "self", isSelf: true, normalizedName: "lucia andrade pinto", aliases: ["lucia", "me", "i", "mimi", SELF], status: "active" } });
    const hector = await prisma.entity.create({ data: { userId: user.id, name: "Héctor Andrade", entityType: "person", kind: "person", normalizedName: "hector andrade", status: "active" } });
    const marta = await prisma.entity.create({ data: { userId: user.id, name: "Marta Pinto", entityType: "person", kind: "person", normalizedName: "marta pinto", status: "active" } });
    const braga = await prisma.entity.create({ data: { userId: user.id, name: "Braga", entityType: "place", normalizedName: "braga", status: "active" } });
    const home = await prisma.entity.create({ data: { userId: user.id, name: "family home", entityType: "property", normalizedName: "family home", status: "active" } });
    const edge = (fromId, type, toId, status, category = "family") => prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId, toKind: "entity", toId, type, category, status, source: "conversation", attributes: {} } });
    await edge(hector.id, "parent_of", self.id, "confirmed");
    await edge(marta.id, "parent_of", self.id, "rejected");
    await edge(self.id, "lives_at", braga.id, "suggested", "location");
    const endedBraga = await edge(marta.id, "lives_at", braga.id, "confirmed", "location");
    await prisma.relationship.update({ where: { id: endedBraga.id }, data: { validTo: new Date("2025-01-01") } });
    const atHome = await edge(marta.id, "lives_at", home.id, "confirmed", "location");

    assert.equal((await resolveEntity(user.id, { name: "my mother", entityType: "person" })).entity, null);
    assert.equal((await resolveEntity(user.id, { name: "my mother Marta Pinto", entityType: "person" })).entity?.id, marta.id);
    assert.equal((await resolveEntity(user.id, { name: "She", entityType: "person" })).entity, null);
    assert.equal((await resolveEntity(user.id, { name: "me", entityType: "person" })).entity?.id, self.id);

    const message = "Marta Pinto is my mother. She lives in our family home in Braga.";
    const { people } = validatePeople([{ name: "Marta Pinto", relation: "mother", relationOf: "narrator", gender: "female", livesIn: "Braga", evidence: message }], { text: message, selfName: SELF });
    const graph = peopleToGraph(people);
    const committed = await commitTriples(user.id, graph.triples, { source: "conversation", forceStatus: "suggested", entityFacts: graph.entityFacts, message, restated: true });
    const saved = await prisma.relationship.findMany({ where: { id: { in: committed.edgeIds } } });
    const describe = (row) => `${row.fromId === marta.id ? "Marta" : row.fromId === self.id ? "self" : row.fromId} ${row.type} ${row.toId === self.id ? "self" : row.toId === braga.id ? "Braga" : row.toId}`;
    assert.deepEqual(saved.map(describe).sort(), ["Marta lives_at Braga", "Marta parent_of self"]);
    assert.equal(saved.find((row) => row.type === "parent_of").status, "suggested");
    assert.equal((await prisma.entity.findUnique({ where: { id: marta.id } })).kind, "mother");
    // Said again, her ended Braga residence is current again and replaces the family home.
    assert.equal((await prisma.relationship.findUnique({ where: { id: endedBraga.id } })).validTo, null);
    assert.notEqual((await prisma.relationship.findUnique({ where: { id: atHome.id } })).validTo, null);
    // A residence that is only suggested ends nothing.
    await commitTriples(user.id, [{ subject: { name: "Marta Pinto", type: "person" }, predicate: "lives_at", object: { name: "Faro", type: "place" }, evidence: "Marta moved to Faro", confidence: 0.6 }], { source: "intake" });
    assert.equal((await prisma.relationship.findUnique({ where: { id: endedBraga.id } })).validTo, null);
    assert.equal(await prisma.entity.count({ where: { userId: user.id, normalizedName: { in: ["she", "my mother"] } } }), 0);
    assert.equal(await prisma.relationship.count({ where: { userId: user.id, fromId: hector.id, type: "parent_of", status: "confirmed" } }), 1);
    // A marriage date stated after the spouse edge exists lands on that edge.
    const pablo = await prisma.entity.create({ data: { userId: user.id, name: "Pablo Ruiz", entityType: "person", kind: "husband", normalizedName: "pablo ruiz", status: "active" } });
    // Symmetric edges are stored lower id first, as commitTriples writes them.
    const [low, high] = [pablo.id, self.id].sort();
    const spouse = await edge(low, "spouse_of", high, "confirmed");
    await commitTriples(user.id, [{ subject: { name: "Pablo Ruiz", type: "person" }, predicate: "spouse_of", object: { name: "me", type: "self" }, validFrom: "2009-02-14", evidence: "I married Pablo Ruiz on 14 February 2009", confidence: 0.9 }], { source: "intake", message: "I married Pablo Ruiz on 14 February 2009." });
    assert.equal((await prisma.relationship.findUnique({ where: { id: spouse.id } })).validFrom?.toISOString().slice(0, 10), "2009-02-14");

    const refreshed = await getOrCreateSelf(user.id);
    assert.deepEqual(refreshed.aliases.filter((alias) => ["i", "me", "mimi"].includes(alias.toLowerCase())), []);
  } finally {
    await prisma.relationship.deleteMany({ where: { userId: user.id } });
    await prisma.entity.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

async function databaseReady() {
  try {
    await prisma.$queryRaw`SELECT "isSelf" FROM entities LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}
