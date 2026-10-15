import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { chooseSelfName, mergeEntities, resolveEntity } from "../src/services/graph/entityResolver.js";
import { describeRelationshipLine, isRelationshipStatement, parseFamilyStatement } from "../src/services/graph/familyStatement.js";
import { answerPeopleQuestion, buildPeopleContext, conflictEdgeData, deliverPeopleAnswer, groundAdvisorReply, isPeopleQuestion } from "../src/services/graph/peopleGrounding.js";
import { assemblePaths, getFamilyTree } from "../src/services/graph/graphQuery.js";
import { rebuildGraph } from "../src/services/graph/rebuild.js";
import { stripEntityIds } from "../src/services/graph/reset.js";
import { alignPredicate, applySupersession, buildSelfAliasSet, dedupeProposedNames, groupSuggestions, mentionsSelf, prepareTriples } from "../src/services/graph/graphQuality.js";
import { absorbDroppedPayment, commitTriples, deterministicEdgePlans, dropReason, extractWithRetry, graphExtractProvider, headerDelayFrom, retryDelayMs } from "../src/services/graph/relationshipExtractor.js";
import { isSensitive, normalizeType } from "../src/services/graph/relationshipTypes.js";

test("graph reset drops entity ids and keeps names", () => {
  const people = stripEntityIds([
    { entityId: "person-1", name: "Burton", role: "supervisor" },
    "Ada",
    { name: "Neema", role: "spouse" },
  ]);
  assert.equal(people.removed, 1);
  assert.deepEqual(people.list[0], { name: "Burton", role: "supervisor" });
  assert.equal(people.list[1], "Ada");
  assert.deepEqual(people.list[2], { name: "Neema", role: "spouse" });
  const places = stripEntityIds([{ entityId: "place-1", name: "Mbeya", role: "location", relationship: "location" }]);
  assert.equal(places.removed, 1);
  assert.equal(places.list[0].name, "Mbeya");
  assert.equal(places.list[0].role, "location");
  assert.equal(places.list[0].entityId, undefined);
});

const FAMILY_MESSAGE = "My family: my father Enock Mwakyusa passed away on 25 April 2004 and my mother Froidah Biniala Kyando lives in our family home in Mbeya. My sisters are Jeni, Leah, Neema and Zenah Enock Mwakyusa. My wife is Zelda Goodluck Mambosho. My children are Careen (my eldest daughter, born before my marriage), Patrick, Presley, Powell and Prisha.";

test("a family introduction expands into kinship edges", () => {
  assert.equal(isRelationshipStatement(FAMILY_MESSAGE), true);
  assert.equal(isRelationshipStatement("Who are my sisters?"), false);
  const parsed = parseFamilyStatement(FAMILY_MESSAGE);
  const prepared = prepareTriples(parsed.triples, {
    selfAliases: buildSelfAliasSet({ names: ["Phesto Enock Mwakyusa"], aliases: ["phesto"] }),
    selfName: "Phesto Enock Mwakyusa",
    relatives: [],
    message: FAMILY_MESSAGE,
  });
  const kept = prepared.kept;
  const parents = kept.filter((triple) => triple.predicate === "parent_of" && triple.object?.type === "self");
  const children = kept.filter((triple) => triple.predicate === "parent_of" && triple.subject?.type === "self");
  const siblings = kept.filter((triple) => triple.predicate === "sibling_of");
  const spouses = kept.filter((triple) => triple.predicate === "spouse_of");
  const homes = kept.filter((triple) => triple.predicate === "lives_at");
  assert.equal(parents.length, 2);
  assert.equal(siblings.length, 4);
  assert.equal(spouses.length, 1);
  assert.equal(children.length, 5);
  assert.equal(homes.length, 1);
  assert.deepEqual(siblings.map((triple) => triple.subject.name).sort(), [
    "Jeni Enock Mwakyusa",
    "Leah Enock Mwakyusa",
    "Neema Enock Mwakyusa",
    "Zenah Enock Mwakyusa",
  ]);
  assert.equal(spouses[0].subject.name, "Zelda Goodluck Mambosho");
  assert.equal(homes[0].object.name, "Mbeya");
  assert.equal(parsed.entityFacts.find((fact) => fact.name === "Enock Mwakyusa").deathDate, "2004-04-25");
  const careen = children.find((triple) => triple.object.name === "Careen");
  assert.equal(careen.object.kind, "daughter");
  assert.equal(careen.attributes.birthOrder, 1);
  assert.equal(kept.some((triple) => [triple.subject?.name, triple.object?.name].includes("Careen") && [triple.subject?.name, triple.object?.name].includes("Zelda Goodluck Mambosho")), false);
  assert.equal(dropReason({
    subject: { name: "Jeni Enock Mwakyusa", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "",
  }, { message: FAMILY_MESSAGE }), null);
  const you = { id: "self", name: "you" };
  assert.equal(describeRelationshipLine({
    type: "parent_of",
    from: { id: "enock", name: "Enock Mwakyusa", kind: "father", deathDate: "2004-04-25" },
    to: you,
    selfId: "self",
  }), "Enock Mwakyusa — your father (passed 25 Apr 2004)");
  assert.equal(describeRelationshipLine({
    type: "sibling_of",
    from: { id: "jeni", name: "Jeni Enock Mwakyusa", kind: "sister" },
    to: you,
    selfId: "self",
  }), "Jeni Enock Mwakyusa — your sister");
  assert.equal(describeRelationshipLine({
    type: "spouse_of",
    from: { id: "zelda", name: "Zelda Goodluck Mambosho", kind: "wife" },
    to: you,
    selfId: "self",
  }), "Zelda Goodluck Mambosho — your wife");
  assert.equal(describeRelationshipLine({
    type: "parent_of",
    from: you,
    to: { id: "careen", name: "Careen", kind: "daughter" },
    selfId: "self",
    attributes: { birthOrder: 1 },
  }), "Careen — your daughter (eldest)");
  assert.equal(chooseSelfName({
    profileName: "phesto",
    handle: "phesto",
    eventNames: [{ name: "Phesto Enock Mwakyusa", count: 2 }],
  }), "Phesto Enock Mwakyusa");
});

test("my father's family tree stays inside recorded facts", () => {
  const question = "my father's family tree";
  assert.equal(isPeopleQuestion(question), true);
  assert.equal(isRelationshipStatement(question), false);
  const context = buildPeopleContext({
    self: { id: "self", name: "Phesto Enock Mwakyusa", kind: "self" },
    people: [
      { id: "self", name: "Phesto Enock Mwakyusa", kind: "self" },
      { id: "enock", name: "Enock Mwakyusa", kind: "father", deathDate: "2004-04-25" },
      { id: "froidah", name: "Froidah Biniala Kyando", kind: "mother" },
      { id: "zelda", name: "Zelda Goodluck Mambosho", kind: "wife" },
      { id: "jeni", name: "Jeni Enock Mwakyusa", kind: "sister" },
      { id: "leah", name: "Leah Enock Mwakyusa", kind: "sister" },
      { id: "neema", name: "Neema Enock Mwakyusa", kind: "sister" },
      { id: "zenah", name: "Zenah Enock Mwakyusa", kind: "sister" },
    ],
    edges: [
      { id: "e-father", type: "parent_of", status: "confirmed", fromId: "enock", toId: "self", fromName: "Enock Mwakyusa", toName: "Phesto Enock Mwakyusa" },
      { id: "e-mother", type: "parent_of", status: "confirmed", fromId: "froidah", toId: "self", fromName: "Froidah Biniala Kyando", toName: "Phesto Enock Mwakyusa" },
      { id: "e-wife", type: "spouse_of", status: "confirmed", fromId: "zelda", toId: "self", fromName: "Zelda Goodluck Mambosho", toName: "Phesto Enock Mwakyusa" },
      { id: "e-asha", type: "sibling_of", status: "suggested", fromId: "asha", toId: "self", fromName: "Asha Mwakyusa", toName: "Phesto Enock Mwakyusa" },
    ],
    events: [
      { id: "ev-feb", title: "Birth note", fullText: "Phesto Enock Mwakyusa was born on 17 February 1978." },
      { id: "ev-may", title: "Later note", fullText: "Phesto Enock Mwakyusa born 12 May 1978." },
    ],
  });
  const invented = "Your father's spouse is Hermes Mwakyusa (married 1980). Zelda Goodluck Mambosho, his child, was born 1987. You were born May 12, 1978. Jeni was born in 1980, Leah in 1982, Neema in 1984 and Zenah in 1986.";
  const checked = groundAdvisorReply(invented, context);
  assert.equal(checked.removed.includes("Hermes Mwakyusa"), true);
  assert.equal(checked.reply.includes("Hermes"), false);
  assert.equal(checked.reply.includes("1987"), false);
  assert.equal(checked.reply.includes("1980"), false);
  assert.equal(checked.reply.includes("1982"), false);
  const delivered = deliverPeopleAnswer(invented, context, question);
  assert.match(delivered.reply, /Your father's spouse: Froidah Biniala Kyando/);
  assert.match(delivered.reply, /Your sisters' birth dates aren't recorded yet/);
  assert.match(delivered.reply, /Zelda Goodluck Mambosho — your wife/);
  assert.match(delivered.reply, /17 Feb 1978/);
  assert.match(delivered.reply, /12 May 1978/);
  assert.match(delivered.reply, /Which is right/);
  assert.match(delivered.reply, /unconfirmed: Asha Mwakyusa/);
  assert.equal(delivered.reply.includes("Hermes"), false);
  assert.equal(delivered.reply.includes("1987"), false);
  assert.equal(/Zelda[\s\S]{0,40}child|child[\s\S]{0,40}Zelda/i.test(delivered.reply), false);
  assert.equal(context.conflicts.length, 1);
  const review = conflictEdgeData("user-1", context.conflicts[0]);
  assert.equal(review.label, "conflict");
  assert.match(review.evidenceText, /1978-02-17/);
  assert.match(review.evidenceText, /1978-05-12/);
  assert.equal(answerPeopleQuestion(question, context), delivered.reply);
});

test("events answer wife, parents and sister births before an edge exists", () => {
  const sisters = [
    { id: "jeni", name: "Jeni Enock Mwakyusa", kind: "sister" },
    { id: "leah", name: "Leah Enock Mwakyusa", kind: "sister" },
    { id: "neema", name: "Neema Enock Mwakyusa", kind: "sister" },
    { id: "zenah", name: "Zenah Enock Mwakyusa", kind: "sister" },
  ];
  const context = buildPeopleContext({
    self: { id: "self", name: "Phesto Enock Mwakyusa", kind: "self" },
    people: [{ id: "self", name: "Phesto Enock Mwakyusa", kind: "self" }, ...sisters],
    edges: sisters.map((person) => ({
      id: `edge-${person.id}`,
      type: "sibling_of",
      status: "confirmed",
      fromId: person.id,
      toId: "self",
      fromName: person.name,
      toName: "Phesto Enock Mwakyusa",
    })),
    events: [
      { id: "ev-wife", title: "Marriage", fullText: "Engagement and marriage to Zelda Goodluck Mambosho on 5 Aug 2006. Zelda joined me in Finland." },
      { id: "ev-parents", title: "Parents", fullText: "My parents' marriage. My father Enock Mwakyusa was born in our home and passed away on 25 April 2004. My mother is Froidah Biniala Kyando." },
      { id: "ev-three", title: "Sisters", fullText: "Jeni 4 Dec 1980, Leah 14 Dec 1983, Neema 3 Dec 1987" },
      { id: "ev-zenah", title: "Zenah", fullText: "Zenah Enock Mwakyusa was born on 3 February 1993." },
    ],
  });
  assert.equal(isPeopleQuestion("who is my wife?"), true);
  assert.equal(isPeopleQuestion("my parents?"), true);
  assert.equal(isPeopleQuestion("sisters' birth dates"), true);
  const wife = answerPeopleQuestion("who is my wife?", context);
  assert.match(wife, /Zelda Goodluck Mambosho/);
  assert.match(wife, /5 Aug 2006/);
  assert.match(wife, /From your records — confirm in Review to lock it in\./);
  assert.equal(/not recorded/i.test(wife), false);
  const parents = answerPeopleQuestion("my parents?", context);
  assert.match(parents, /Enock Mwakyusa — your father/);
  assert.match(parents, /25 Apr 2004/);
  assert.match(parents, /Froidah Biniala Kyando — your mother/);
  assert.match(parents, /From your records — confirm in Review to lock it in\./);
  assert.equal(/not recorded/i.test(parents), false);
  const births = answerPeopleQuestion("sisters' birth dates", context);
  assert.match(births, /Jeni Enock Mwakyusa — 4 Dec 1980/);
  assert.match(births, /Leah Enock Mwakyusa — 14 Dec 1983/);
  assert.match(births, /Neema Enock Mwakyusa — 3 Dec 1987/);
  assert.match(births, /Zenah Enock Mwakyusa — 3 Feb 1993/);
  assert.match(births, /From your records — confirm in Review to lock it in\./);
  assert.equal(/not recorded/i.test(births), false);
  const grounded = groundAdvisorReply("Zelda Goodluck Mambosho married on 5 Aug 2006. Hermes Mwakyusa was born in 1987.", context);
  assert.equal(grounded.reply.includes("Zelda Goodluck Mambosho"), true);
  assert.equal(grounded.reply.includes("5 Aug 2006"), true);
  assert.equal(grounded.reply.includes("Hermes"), false);
  const missed = deliverPeopleAnswer("Your wife isn't recorded yet.", context, "who is my wife?");
  assert.match(missed.reply, /Zelda Goodluck Mambosho/);
  assert.equal(/not recorded/i.test(missed.reply), false);
});

const ANCHOR_MESSAGE = `My family: my father Enock Mwakyusa passed away
on 25 April 2004 and my mother Froidah Biniala Kyando
lives in our family home in Mbeya. My sisters are Jeni,
Leah, Neema and Zenah Enock Mwakyusa. My wife is Zelda
Goodluck Mambosho. My children are Careen (my eldest
daughter, born before my marriage), Patrick, Presley,
Powell and Prisha Neema.`;

test("possessive kinship stays on you and keeps full names", () => {
  const parsed = parseFamilyStatement(ANCHOR_MESSAGE);
  const prepared = prepareTriples([
    ...parsed.triples,
    {
      subject: { name: "Zelda Goodluck Mambosho", type: "person" },
      predicate: "spouse_of",
      object: { name: "Enock Mwakyusa", type: "person" },
      evidence: ANCHOR_MESSAGE,
    },
  ], {
    selfAliases: buildSelfAliasSet({ names: ["Phesto Enock Mwakyusa"], aliases: ["phesto"] }),
    selfName: "Phesto Enock Mwakyusa",
    relatives: [],
    message: ANCHOR_MESSAGE,
  });
  const kept = prepared.kept;
  const parents = kept.filter((triple) => triple.predicate === "parent_of" && triple.object?.type === "self");
  const children = kept.filter((triple) => triple.predicate === "parent_of" && triple.subject?.type === "self");
  const siblings = kept.filter((triple) => triple.predicate === "sibling_of");
  const spouses = kept.filter((triple) => triple.predicate === "spouse_of");
  assert.equal(parents.length, 2);
  assert.deepEqual(parents.map((triple) => triple.subject.name).sort(), ["Enock Mwakyusa", "Froidah Biniala Kyando"]);
  assert.equal(siblings.length, 4);
  assert.equal(spouses.length, 1);
  assert.equal(spouses[0].subject.name, "Zelda Goodluck Mambosho");
  assert.equal(spouses[0].object.type, "self");
  assert.equal(children.length, 5);
  assert.deepEqual(children.map((triple) => triple.object.name).sort(), ["Careen", "Patrick", "Powell", "Presley", "Prisha Neema"]);
  assert.equal(kept.some((triple) => {
    const names = [triple.subject?.name, triple.object?.name];
    return names.includes("Zelda Goodluck Mambosho") && names.includes("Enock Mwakyusa");
  }), false);
  assert.equal(prepared.dropped.some((triple) => triple.reason === "possessive-mismatch"), true);
  assert.equal(describeRelationshipLine({
    type: "spouse_of",
    from: { id: "zelda", name: "Zelda Goodluck Mambosho", kind: "wife" },
    to: { id: "enock", name: "Enock Mwakyusa", kind: "father" },
    selfId: "self",
  }), "Zelda Goodluck Mambosho — wife of Enock Mwakyusa (your father)");
  const hyphen = parseFamilyStatement("My children are Careen and Prisha - Neema.");
  assert.equal(hyphen.triples.some((triple) => triple.object?.name === "Prisha Neema"), true);
  assert.equal(hyphen.triples.some((triple) => String(triple.object?.name || "").includes(" - ")), false);
});

test("normalizeType maps kinship words and work roles", () => {
  assert.deepEqual(normalizeType("mama").type, "parent_of");
  assert.equal(normalizeType("mama").reverse, true);
  assert.equal(normalizeType("dada").type, "sibling_of");
  assert.equal(normalizeType("fundi").type, "contractor_for");
  assert.equal(normalizeType("supervises").type, "supervises");
  assert.equal(normalizeType("supervises").reverse, false);
  assert.equal(isSensitive("parent_of"), true);
  assert.equal(isSensitive("supervises"), false);
});

test("amounts, dates and unknown predicates are not nodes", () => {
  assert.equal(normalizeType("hasTotalContractValue"), null);
  assert.equal(dropReason({
    subject: { name: "Electrical Works", type: "project" },
    predicate: "hasTotalContractValue",
    object: { name: "2,399,500 TSH", type: "asset" },
  }), "amount-as-node");
  assert.equal(dropReason({
    subject: { name: "Plot P9104", type: "property" },
    predicate: "dated",
    object: { name: "12 May 2024", type: "other" },
  }), "date-as-node");
  const birth = prepareTriples([{
    subject: { name: "Ada", type: "person" },
    predicate: "born",
    object: { name: "2004", type: "other" },
    evidence: "born in 2004",
  }]);
  assert.equal(birth.kept.length, 0);
  assert.equal(birth.entityFacts[0].name, "Ada");
  assert.equal(birth.entityFacts[0].birthDate, "2004-01-01");
  assert.equal(dropReason({
    subject: { name: "Ada", type: "self" },
    predicate: "hasTotalContractValue",
    object: { name: "Mbeya Home", type: "property" },
  }), "unknown-predicate");
  assert.equal(dropReason({
    subject: { name: "Burton", type: "person" },
    predicate: "supervises",
    object: { name: "Mbeya Home", type: "property" },
  }), null);

  const event = { id: "event-1", title: "Electrical Works", people: [], places: [], financials: {} };
  const plans = deterministicEdgePlans(event, "Ada");
  const absorbed = absorbDroppedPayment(plans, {
    subject: { name: "Electrical Works", type: "project" },
    predicate: "hasTotalContractValue",
    object: { name: "2,399,500 TSH", type: "asset" },
  }, event, "Ada");
  assert.equal(absorbed, true);
  assert.equal(plans.find((plan) => plan.type === "paid").attributes.amount, 2399500);
  assert.equal(plans.find((plan) => plan.type === "paid").attributes.currency, "TSH");
});

test("graph rebuild quality rules keep self, family and places honest", () => {
  const aliases = buildSelfAliasSet({ names: ["Phesto Enock Mwakyusa", "Phesto Mwakyusa"] });
  assert.equal(mentionsSelf("Phesto Enock Mwakayusa", aliases), true);
  assert.equal(mentionsSelf("Phesto Mwakyusa", aliases), true);
  const selfOwned = prepareTriples([{
    subject: { name: "Phesto Enock Mwakayusa", type: "person" },
    predicate: "owns",
    object: { name: "Plot P9104", type: "property" },
    evidence: "registered occupier",
    confidence: 0.9,
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(selfOwned.kept[0].subject.type, "self");
  assert.equal(selfOwned.kept[0].subject.name, "Phesto Enock Mwakyusa");

  const surname = prepareTriples([{
    subject: { name: "Amina Mwakyusa", type: "person" },
    predicate: "sibling_of",
    object: { name: "Phesto Mwakyusa", type: "person" },
    evidence: "Amina Mwakyusa appears on the same title",
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(surname.dropped[0].reason, "unsupported-family");

  const wife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], {
    selfAliases: aliases,
    selfName: "Phesto Enock Mwakyusa",
    relatives: [{ role: "spouse", name: "Neema", id: "spouse-1" }],
  });
  assert.equal(wife.kept[0].subject.name, "Neema");
  assert.equal(wife.reviewQuestions.length, 0);

  const unknownWife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(unknownWife.dropped[0].reason, "unresolved-kinship");
  assert.match(unknownWife.reviewQuestions[0], /Who is 'wife'/);

  assert.equal(alignPredicate("person", "has_participant", "project").type, "participant_in");
  assert.equal(normalizeType("married").type, "spouse_of");
  assert.equal(normalizeType("alioa").type, "spouse_of");

  let places = [];
  places = applySupersession(places, { fromName: "Jimny", toName: "Dar es Salaam", type: "located_in", at: "2019-01-01" });
  places = applySupersession(places, { fromName: "Jimny", toName: "Mbeya", type: "located_in", at: "2024-01-01" });
  assert.equal(places[0].validTo, "2024-01-01");
  assert.equal(places[1].validTo, null);

  const names = dedupeProposedNames(["land in Ntabha, Mbeya", "existing plot in Ntabha"]);
  assert.equal(names.get("land in Ntabha, Mbeya"), "Ntabha plot");
  assert.equal(names.get("existing plot in Ntabha"), "Ntabha plot");

  const grouped = groupSuggestions([
    { id: "1", category: "family", type: "spouse_of", fromName: "Phesto", toName: "Neema" },
    { id: "2", category: "family", type: "parent_of", fromName: "Mara", toName: "Phesto" },
    { id: "3", category: "ownership", type: "owns", fromName: "Phesto", toName: "Plot P9104" },
    { id: "4", category: "work", type: "supervises", fromName: "Burton", toName: "Mbeya Home" },
  ], "Phesto");
  assert.equal(grouped.count, 3);
  assert.equal(grouped.family.people.length, 2);
  assert.equal(grouped.assets.items[0].name, "Plot P9104");
});

test("graph extraction backs off on rate limits", async () => {
  const previous = process.env.GRAPH_EXTRACT_PROVIDER;
  delete process.env.GRAPH_EXTRACT_PROVIDER;
  assert.equal(graphExtractProvider(), "openai");
  process.env.GRAPH_EXTRACT_PROVIDER = "groq";
  assert.equal(graphExtractProvider(), "groq");
  if (previous == null) delete process.env.GRAPH_EXTRACT_PROVIDER;
  else process.env.GRAPH_EXTRACT_PROVIDER = previous;
  assert.equal(retryDelayMs({ retryAfter: 5000 }, 1), 5000);
  assert.equal(retryDelayMs({ status: 429 }, 1), 2000);
  assert.equal(retryDelayMs({ status: 429 }, 2), 4000);
  assert.equal(retryDelayMs({ status: 429 }, 3), 8000);
  assert.equal(retryDelayMs({ status: 429 }, 4), 16000);
  assert.equal(retryDelayMs({ status: 429 }, 5), 32000);
  assert.equal(headerDelayFrom(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(headerDelayFrom(new Headers({ "x-ratelimit-reset-requests": "6s" })), 6000);

  let calls = 0;
  const waits = [];
  await assert.rejects(() => extractWithRetry(() => {
    calls += 1;
    const error = new Error("rate");
    error.status = 429;
    throw error;
  }, async (ms) => { waits.push(ms); }));
  assert.equal(calls, 5);
  assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
});

test("assemblePaths stops at depth and does not loop", () => {
  const edges = [
    edge("1", "a", "b"),
    edge("2", "b", "a"),
    edge("3", "b", "c"),
    edge("4", "c", "d"),
    edge("5", "d", "e"),
  ];
  const paths = assemblePaths(edges, { kind: "entity", id: "a" }, { kind: "entity", id: "c" }, 4, 3);
  assert.ok(paths.length >= 1 && paths.length <= 3);
  assert.ok(paths.every((path) => path.at(-1).node === "entity:c"));
  assert.ok(paths.every((path) => path.length <= 5));
  const tooDeep = assemblePaths(edges, { kind: "entity", id: "a" }, { kind: "entity", id: "e" }, 2, 3);
  assert.equal(tooDeep.length, 0);
});

test("graph records stay consistent", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not ready for graph tests");
    return;
  }
  const user = await prisma.user.create({
    data: { email: `graph-${Date.now()}@example.com`, handle: `graph${Date.now()}`, name: "Ada Tester" },
  });
  try {
    const parent = await prisma.entity.create({
      data: { userId: user.id, name: "Mara Test", entityType: "person", normalizedName: "mara test", status: "active" },
    });
    const self = await prisma.entity.create({
      data: { userId: user.id, name: "Ada Tester", entityType: "person", isSelf: true, normalizedName: "ada tester", status: "active" },
    });
    await prisma.relationship.create({
      data: {
        userId: user.id,
        fromKind: "entity",
        fromId: parent.id,
        toKind: "entity",
        toId: self.id,
        type: "parent_of",
        category: "family",
        status: "confirmed",
        source: "user",
        attributes: {},
      },
    });
    const kinship = await resolveEntity(user.id, { name: "my mother", entityType: "person" });
    assert.equal(kinship.entity?.id, parent.id);
    assert.equal(kinship.matchedBy, "kinship");

    await prisma.entity.create({
      data: { userId: user.id, name: "Nia Solo", entityType: "person", normalizedName: "nia solo", status: "active" },
    });
    const first = await resolveEntity(user.id, { name: "Nia", entityType: "person" });
    assert.equal(first.matchedBy, "first-name");

    await prisma.entity.create({
      data: { userId: user.id, name: "Nia Other", entityType: "person", normalizedName: "nia other", status: "active" },
    });
    const ambiguous = await resolveEntity(user.id, { name: "Nia", entityType: "person" });
    assert.equal(ambiguous.entity, null);
    assert.equal(ambiguous.matchedBy, "ambiguous");

    const sensitive = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 0.95,
    }], { source: "intake" });
    assert.ok(sensitive.suggested >= 1);

    const confirmed = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 1,
    }], { source: "user" });
    assert.ok(confirmed.updated + confirmed.created >= 1);
    const sibling = await prisma.relationship.findFirst({ where: { userId: user.id, type: "sibling_of" } });
    assert.equal(sibling.status, "confirmed");

    await prisma.relationship.update({ where: { id: sibling.id }, data: { status: "rejected" } });
    await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 0.99,
    }], { source: "intake" });
    const still = await prisma.relationship.findFirst({ where: { id: sibling.id } });
    assert.equal(still.status, "rejected");

    const money = await commitTriples(user.id, [
      { subject: { name: "Ada Tester", type: "self" }, predicate: "sent money to", object: { name: "Kito Example", type: "person" }, attributes: { amount: 10, currency: "EUR" }, confidence: 0.9 },
      { subject: { name: "Ada Tester", type: "self" }, predicate: "sent money to", object: { name: "Kito Example", type: "person" }, attributes: { amount: 5, currency: "EUR" }, confidence: 0.9 },
    ], { source: "user" });
    assert.ok(money.created + money.updated >= 1);
    const flow = await prisma.relationship.findFirst({ where: { userId: user.id, type: "sent_money_to" } });
    assert.equal(flow.attributes.total, 15);
    assert.equal(flow.attributes.count, 2);

    await prisma.entity.update({ where: { id: parent.id }, data: { deathDate: new Date("2000-01-01") } });
    const tree = await getFamilyTree(user.id);
    assert.equal(tree.parents[0].name, "Mara Test");
    assert.ok(tree.parents[0].deathDate);

    const copy = await prisma.entity.create({
      data: { userId: user.id, name: "Mara T", entityType: "person", normalizedName: "mara t", status: "active" },
    });
    await prisma.relationship.create({
      data: {
        userId: user.id,
        fromKind: "entity",
        fromId: copy.id,
        toKind: "entity",
        toId: self.id,
        type: "knows",
        category: "social",
        status: "suggested",
        source: "inferred",
        attributes: {},
      },
    });
    const before = await prisma.relationship.count({ where: { userId: user.id } });
    const report = await rebuildGraph(user.id, { dryRun: true });
    const after = await prisma.relationship.count({ where: { userId: user.id } });
    assert.equal(after, before);
    assert.equal(report.dryRun, true);
    assert.ok(Array.isArray(report.proposed));

    const merged = await mergeEntities(user.id, parent.id, copy.id);
    assert.ok(merged.moved + merged.deduped >= 1);
    const archived = await prisma.entity.findUnique({ where: { id: copy.id } });
    assert.equal(archived.mergedIntoId, parent.id);
    const moved = await prisma.relationship.findFirst({ where: { userId: user.id, type: "knows", fromId: parent.id } });
    assert.ok(moved);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

async function databaseReady() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$queryRaw`SELECT "isSelf" FROM entities LIMIT 1`;
    await prisma.$queryRaw`SELECT "fromKind" FROM relationships LIMIT 1`;
    await prisma.$queryRaw`SELECT "graphExtractedAt" FROM events LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

function edge(id, fromId, toId) {
  return { id, fromKind: "entity", fromId, toKind: "entity", toId, type: "knows" };
}
