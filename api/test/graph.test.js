import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { chooseSelfName, mergeEntities, resolveEntity } from "../src/services/graph/entityResolver.js";
import { describeRelationshipLine, isRelationshipStatement, namesPersonWithRole, parseFamilyStatement } from "../src/services/graph/familyStatement.js";
import { isNoiseReply, previousExchangeFrom, rejectsCorrection } from "../src/services/intentRouter.js";
import { answerPeopleQuestion, buildPeopleContext, conflictEdgeData, contextualQuestion, deliverPeopleAnswer, groundAdvisorReply, isPeopleQuestion, peopleFromTree, resolvePeopleFollowUp } from "../src/services/graph/peopleGrounding.js";
import { isReadonly, runReadonly } from "../src/readonly.js";
import { graphAutoExtractEnabled } from "../src/services/graph/rebuild.js";
import { autoExtractOn } from "../src/services/graph/autoExtract.js";
import { resetGraph } from "../src/services/graph/reset.js";
import { extractAndLinkEntities } from "../src/routes/entities.js";
import { assemblePaths, getFamilyTree } from "../src/services/graph/graphQuery.js";
import { rebuildGraph } from "../src/services/graph/rebuild.js";
import { stripEntityIds } from "../src/services/graph/reset.js";
import { alignPredicate, applySupersession, buildSelfAliasSet, dedupeProposedNames, groupSuggestions, mentionsSelf, prepareTriples } from "../src/services/graph/graphQuality.js";
import { absorbDroppedPayment, commitTriples, deterministicEdgePlans, dropReason, extractWithRetry, graphExtractProvider, headerDelayFrom, retryDelayMs } from "../src/services/graph/relationshipExtractor.js";
import { isSensitive, normalizeType } from "../src/services/graph/relationshipTypes.js";

// The Prisma client keeps the process alive; close it so `npm test` exits on its own.
test.after(async () => {
  await prisma.$disconnect();
});

test("graph reset drops entity ids and keeps names", () => {
  const people = stripEntityIds([
    { entityId: "person-1", name: "Ragnar", role: "supervisor" },
    "Ada",
    { name: "Hulda", role: "spouse" },
  ]);
  assert.equal(people.removed, 1);
  assert.deepEqual(people.list[0], { name: "Ragnar", role: "supervisor" });
  assert.equal(people.list[1], "Ada");
  assert.deepEqual(people.list[2], { name: "Hulda", role: "spouse" });
  const places = stripEntityIds([{ entityId: "place-1", name: "Akureyri", role: "location", relationship: "location" }]);
  assert.equal(places.removed, 1);
  assert.equal(places.list[0].name, "Akureyri");
  assert.equal(places.list[0].role, "location");
  assert.equal(places.list[0].entityId, undefined);
});

const FAMILY_MESSAGE = "My family: my father Gunnar Arason passed away on 25 April 2001 and my mother Hekla Bjorg Olafsdottir lives in our family home in Akureyri. My sisters are Sigrun, Thora, Hulda and Edda Gunnar Arason. My wife is Asta Kristin Jonsdottir. My children are Ylfa (my eldest daughter, born before my marriage), Einar, Kari, Leifur and Brynja.";

test("a family introduction expands into kinship edges", () => {
  assert.equal(isRelationshipStatement(FAMILY_MESSAGE), true);
  assert.equal(isRelationshipStatement("Who are my sisters?"), false);
  const parsed = parseFamilyStatement(FAMILY_MESSAGE);
  const prepared = prepareTriples(parsed.triples, {
    selfAliases: buildSelfAliasSet({ names: ["Bjorn Gunnar Arason"], aliases: ["bjorn"] }),
    selfName: "Bjorn Gunnar Arason",
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
    "Edda Gunnar Arason",
    "Hulda Gunnar Arason",
    "Sigrun Gunnar Arason",
    "Thora Gunnar Arason",
  ]);
  assert.equal(spouses[0].subject.name, "Asta Kristin Jonsdottir");
  assert.equal(homes[0].object.name, "Akureyri");
  assert.equal(parsed.entityFacts.find((fact) => fact.name === "Gunnar Arason").deathDate, "2001-04-25");
  const ylfa = children.find((triple) => triple.object.name === "Ylfa");
  assert.equal(ylfa.object.kind, "daughter");
  assert.equal(ylfa.attributes.birthOrder, 1);
  assert.equal(kept.some((triple) => [triple.subject?.name, triple.object?.name].includes("Ylfa") && [triple.subject?.name, triple.object?.name].includes("Asta Kristin Jonsdottir")), false);
  assert.equal(dropReason({
    subject: { name: "Sigrun Gunnar Arason", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "",
  }, { message: FAMILY_MESSAGE }), null);
  const you = { id: "self", name: "you" };
  assert.equal(describeRelationshipLine({
    type: "parent_of",
    from: { id: "gunnar", name: "Gunnar Arason", kind: "father", deathDate: "2001-04-25" },
    to: you,
    selfId: "self",
  }), "Gunnar Arason — your father (passed 25 Apr 2001)");
  assert.equal(describeRelationshipLine({
    type: "sibling_of",
    from: { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sister" },
    to: you,
    selfId: "self",
  }), "Sigrun Gunnar Arason — your sister");
  assert.equal(describeRelationshipLine({
    type: "spouse_of",
    from: { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife" },
    to: you,
    selfId: "self",
  }), "Asta Kristin Jonsdottir — your wife");
  assert.equal(describeRelationshipLine({
    type: "parent_of",
    from: you,
    to: { id: "ylfa", name: "Ylfa", kind: "daughter" },
    selfId: "self",
    attributes: { birthOrder: 1 },
  }), "Ylfa — your daughter (eldest)");
  assert.equal(chooseSelfName({
    profileName: "bjorn",
    handle: "bjorn",
    eventNames: [{ name: "Bjorn Gunnar Arason", count: 2 }],
  }), "Bjorn Gunnar Arason");
});

test("my father's family tree stays inside recorded facts", () => {
  const question = "my father's family tree";
  assert.equal(isPeopleQuestion(question), true);
  assert.equal(isRelationshipStatement(question), false);
  const context = buildPeopleContext({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    people: [
      { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
      { id: "gunnar", name: "Gunnar Arason", kind: "father", deathDate: "2001-04-25" },
      { id: "hekla", name: "Hekla Bjorg Olafsdottir", kind: "mother" },
      { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife" },
      { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sister" },
      { id: "thora", name: "Thora Gunnar Arason", kind: "sister" },
      { id: "hulda", name: "Hulda Gunnar Arason", kind: "sister" },
      { id: "edda", name: "Edda Gunnar Arason", kind: "sister" },
    ],
    edges: [
      { id: "e-father", type: "parent_of", status: "confirmed", fromId: "gunnar", toId: "self", fromName: "Gunnar Arason", toName: "Bjorn Gunnar Arason" },
      { id: "e-mother", type: "parent_of", status: "confirmed", fromId: "hekla", toId: "self", fromName: "Hekla Bjorg Olafsdottir", toName: "Bjorn Gunnar Arason" },
      { id: "e-wife", type: "spouse_of", status: "confirmed", fromId: "asta", toId: "self", fromName: "Asta Kristin Jonsdottir", toName: "Bjorn Gunnar Arason" },
      { id: "e-sunna", type: "sibling_of", status: "suggested", fromId: "sunna", toId: "self", fromName: "Sunna Arason", toName: "Bjorn Gunnar Arason" },
    ],
    events: [
      { id: "ev-feb", title: "Birth note", fullText: "Bjorn Gunnar Arason was born on 17 February 1975." },
      { id: "ev-may", title: "Later note", fullText: "Bjorn Gunnar Arason born 12 May 1975." },
    ],
  });
  const invented = "Your father's spouse is Hermes Arason (married 1977). Asta Kristin Jonsdottir, his child, was born 1984. You were born May 12, 1975. Sigrun was born in 1977, Thora in 1979, Hulda in 1981 and Edda in 1983.";
  const checked = groundAdvisorReply(invented, context);
  assert.equal(checked.removed.includes("Hermes Arason"), true);
  assert.equal(checked.reply.includes("Hermes"), false);
  assert.equal(checked.reply.includes("1984"), false);
  assert.equal(checked.reply.includes("1977"), false);
  assert.equal(checked.reply.includes("1979"), false);
  const delivered = deliverPeopleAnswer(invented, context, question);
  assert.match(delivered.reply, /Your father's spouse: Hekla Bjorg Olafsdottir/);
  assert.match(delivered.reply, /Sigrun Gunnar Arason — birth date not recorded yet/);
  assert.match(delivered.reply, /Asta Kristin Jonsdottir — your wife/);
  assert.doesNotMatch(delivered.reply, /17 Feb 1975|12 May 1975/, "dates only in event text are not used");
  assert.match(delivered.reply, /unconfirmed: Sunna Arason/);
  assert.equal(delivered.reply.includes("Hermes"), false);
  assert.equal(delivered.reply.includes("1984"), false);
  assert.equal(/Asta[\s\S]{0,40}child|child[\s\S]{0,40}Asta/i.test(delivered.reply), false);
  assert.equal(context.conflicts.length, 0, "event text no longer gives dates, so it cannot conflict");
  const review = conflictEdgeData("user-1", { entityId: "self", name: "Bjorn Gunnar Arason", field: "birthDate", values: ["1975-02-17", "1975-05-12"], sources: ["event:ev-feb", "event:ev-may"] });
  assert.equal(review.label, "conflict");
  assert.match(review.evidenceText, /1975-02-17/);
  assert.match(review.evidenceText, /1975-05-12/);
  assert.equal(answerPeopleQuestion(question, context), delivered.reply);
});

test("events name the wife and parents before an edge exists; their dates come only from records", () => {
  const sisters = [
    { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sister" },
    { id: "thora", name: "Thora Gunnar Arason", kind: "sister" },
    { id: "hulda", name: "Hulda Gunnar Arason", kind: "sister" },
    { id: "edda", name: "Edda Gunnar Arason", kind: "sister" },
  ];
  const context = buildPeopleContext({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    people: [{ id: "self", name: "Bjorn Gunnar Arason", kind: "self" }, ...sisters],
    edges: sisters.map((person) => ({
      id: `edge-${person.id}`,
      type: "sibling_of",
      status: "confirmed",
      fromId: person.id,
      toId: "self",
      fromName: person.name,
      toName: "Bjorn Gunnar Arason",
    })),
    events: [
      { id: "ev-wife", title: "Marriage", fullText: "Engagement and marriage to Asta Kristin Jonsdottir on 5 Aug 2003. Asta joined me in Norway." },
      { id: "ev-parents", title: "Parents", fullText: "My parents' marriage. My father Gunnar Arason was born in our home and passed away on 25 April 2001. My mother is Hekla Bjorg Olafsdottir." },
      { id: "ev-three", title: "Sisters", fullText: "Sigrun 4 Dec 1977, Thora 14 Dec 1980, Hulda 3 Dec 1984" },
      { id: "ev-edda", title: "Edda", fullText: "Edda Gunnar Arason was born on 3 February 1990." },
    ],
  });
  assert.equal(isPeopleQuestion("who is my wife?"), true);
  assert.equal(isPeopleQuestion("my parents?"), true);
  assert.equal(isPeopleQuestion("sisters' birth dates"), true);
  const wife = answerPeopleQuestion("who is my wife?", context);
  assert.match(wife, /Asta Kristin Jonsdottir — your wife \(marriage date not recorded yet\)/);
  assert.match(wife, /From your records — confirm in Review to lock it in\./);
  const parents = answerPeopleQuestion("my parents?", context);
  assert.match(parents, /Gunnar Arason — your father\./);
  assert.doesNotMatch(parents, /25 Apr 2001/);
  assert.match(parents, /Hekla Bjorg Olafsdottir — your mother/);
  assert.match(parents, /From your records — confirm in Review to lock it in\./);
  const births = answerPeopleQuestion("sisters' birth dates", context);
  for (const name of ["Sigrun", "Thora", "Hulda", "Edda"]) assert.match(births, new RegExp(`${name} Gunnar Arason — birth date not recorded yet`));
  const grounded = groundAdvisorReply("Asta Kristin Jonsdottir married on 5 Aug 2003. Hermes Arason was born in 1984.", context);
  assert.equal(grounded.reply.includes("Asta Kristin Jonsdottir"), true);
  assert.equal(grounded.reply.includes("5 Aug 2003"), false, "a date only in event text is not grounded");
  assert.equal(grounded.reply.includes("Hermes"), false);
  const missed = deliverPeopleAnswer("Your wife isn't recorded yet.", context, "who is my wife?");
  assert.match(missed.reply, /Asta Kristin Jonsdottir/);

  // The same people with the dates on their records.
  const recorded = buildPeopleContext({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    people: [
      { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
      { id: "gunnar", name: "Gunnar Arason", kind: "father", deathDate: "2001-04-25" },
      { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife" },
      ...sisters.map((person, index) => ({ ...person, birthDate: ["1977-12-04", "1980-12-14", "1984-12-03", "1990-02-03"][index] })),
    ],
    edges: [{ id: "e-wife", type: "spouse_of", status: "confirmed", fromId: "asta", toId: "self", validFrom: new Date("2003-08-05T00:00:00Z") }],
    events: [],
  });
  assert.equal(answerPeopleQuestion("who is my wife?", recorded), "Asta Kristin Jonsdottir — your wife (married 5 Aug 2003).");
  assert.match(answerPeopleQuestion("my parents?", recorded), /Gunnar Arason — your father \(passed 25 Apr 2001\)/);
  const recordedBirths = answerPeopleQuestion("sisters' birth dates", recorded);
  for (const line of ["Sigrun Gunnar Arason — 4 Dec 1977", "Thora Gunnar Arason — 14 Dec 1980", "Hulda Gunnar Arason — 3 Dec 1984", "Edda Gunnar Arason — 3 Feb 1990"]) assert.match(recordedBirths, new RegExp(line));
  assert.equal(groundAdvisorReply("Asta Kristin Jonsdottir married on 5 Aug 2003.", recorded).reply.includes("5 Aug 2003"), true);
  const father = answerPeopleQuestion("who is my father?", context);
  assert.match(father, /Gunnar Arason — your father/);
  assert.equal(father.trim().length > 0, true);
  const sisterReply = answerPeopleQuestion("who is my sister?", {
    ...context,
    people: context.people.map((person) => (person.kind === "sister" ? { ...person, kind: "sibling" } : person)),
  });
  assert.match(sisterReply, /Sigrun Gunnar Arason/);
  assert.match(sisterReply, /Edda Gunnar Arason/);
  assert.equal(sisterReply.trim().length > 0, true);
});

test("marriage wording and children are not guessed from sisters", () => {
  const sisters = [
    { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sibling" },
    { id: "thora", name: "Thora Gunnar Arason", kind: "sibling" },
    { id: "hulda", name: "Hulda Gunnar Arason", kind: "sibling" },
    { id: "edda", name: "Edda Gunnar Arason", kind: "sibling" },
  ];
  const context = buildPeopleContext({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    people: [{ id: "self", name: "Bjorn Gunnar Arason", kind: "self" }, ...sisters],
    edges: [],
    events: [
      { id: "ev-join", title: "Norway", rawInput: "We were married on 5 August 2003. Asta Kristin Jonsdottir joined me in Norway." },
      { id: "ev-kids", title: "Children", fullText: "My children are Ylfa (my eldest daughter), Einar, Kari, Leifur and Brynja Hulda." },
    ],
  });
  const wife = answerPeopleQuestion("who is my wife?", context);
  assert.match(wife, /Asta Kristin Jonsdottir — your wife \(marriage date not recorded yet\)/);
  const kids = answerPeopleQuestion("how many kids do I have?", context);
  assert.match(kids, /5 children/);
  assert.match(kids, /Ylfa/);
  assert.match(kids, /Brynja Hulda/);
  assert.equal(/\bFour\b/.test(kids), false);
  assert.equal(resolvePeopleFollowUp("what are their names?", "how many kids do I have?"), "what are my children's names?");
  const names = answerPeopleQuestion(resolvePeopleFollowUp("what are their names?", "how many kids do I have?"), context);
  assert.match(names, /Einar/);
  assert.match(names, /Kari/);
  const onlySisters = buildPeopleContext({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    people: [{ id: "self", name: "Bjorn Gunnar Arason", kind: "self" }, ...sisters],
    edges: [],
    events: [],
  });
  assert.equal(answerPeopleQuestion("how many kids do I have?", onlySisters), "Your children aren't recorded yet.");
});

const ANCHOR_MESSAGE = `My family: my father Gunnar Arason passed away
on 25 April 2001 and my mother Hekla Bjorg Olafsdottir
lives in our family home in Akureyri. My sisters are Sigrun,
Thora, Hulda and Edda Gunnar Arason. My wife is Asta
Kristin Jonsdottir. My children are Ylfa (my eldest
daughter, born before my marriage), Einar, Kari,
Leifur and Brynja Hulda.`;

test("possessive kinship stays on you and keeps full names", () => {
  const parsed = parseFamilyStatement(ANCHOR_MESSAGE);
  const prepared = prepareTriples([
    ...parsed.triples,
    {
      subject: { name: "Asta Kristin Jonsdottir", type: "person" },
      predicate: "spouse_of",
      object: { name: "Gunnar Arason", type: "person" },
      evidence: ANCHOR_MESSAGE,
    },
  ], {
    selfAliases: buildSelfAliasSet({ names: ["Bjorn Gunnar Arason"], aliases: ["bjorn"] }),
    selfName: "Bjorn Gunnar Arason",
    relatives: [],
    message: ANCHOR_MESSAGE,
  });
  const kept = prepared.kept;
  const parents = kept.filter((triple) => triple.predicate === "parent_of" && triple.object?.type === "self");
  const children = kept.filter((triple) => triple.predicate === "parent_of" && triple.subject?.type === "self");
  const siblings = kept.filter((triple) => triple.predicate === "sibling_of");
  const spouses = kept.filter((triple) => triple.predicate === "spouse_of");
  assert.equal(parents.length, 2);
  assert.deepEqual(parents.map((triple) => triple.subject.name).sort(), ["Gunnar Arason", "Hekla Bjorg Olafsdottir"]);
  assert.equal(siblings.length, 4);
  assert.equal(spouses.length, 1);
  assert.equal(spouses[0].subject.name, "Asta Kristin Jonsdottir");
  assert.equal(spouses[0].object.type, "self");
  assert.equal(children.length, 5);
  assert.deepEqual(children.map((triple) => triple.object.name).sort(), ["Brynja Hulda", "Einar", "Kari", "Leifur", "Ylfa"]);
  assert.equal(kept.some((triple) => {
    const names = [triple.subject?.name, triple.object?.name];
    return names.includes("Asta Kristin Jonsdottir") && names.includes("Gunnar Arason");
  }), false);
  assert.equal(prepared.dropped.some((triple) => triple.reason === "possessive-mismatch"), true);
  assert.equal(describeRelationshipLine({
    type: "spouse_of",
    from: { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife" },
    to: { id: "gunnar", name: "Gunnar Arason", kind: "father" },
    selfId: "self",
  }), "Asta Kristin Jonsdottir — wife of Gunnar Arason (your father)");
  const hyphen = parseFamilyStatement("My children are Ylfa and Brynja - Hulda.");
  assert.equal(hyphen.triples.some((triple) => triple.object?.name === "Brynja Hulda"), true);
  assert.equal(hyphen.triples.some((triple) => String(triple.object?.name || "").includes(" - ")), false);
});

test("questions are not corrections and kinship uses the full source", () => {
  assert.equal(rejectsCorrection("what are their names?"), true);
  assert.equal(rejectsCorrection("and his family?"), true);
  assert.equal(rejectsCorrection("their names"), true);
  assert.equal(rejectsCorrection("no, that's wrong"), false);
  assert.equal(rejectsCorrection("actually I meant Thora"), false);
  const history = [
    { role: "user", content: "how many kids do I have?" },
    { role: "assistant", content: "Four" },
    { role: "assistant", content: "Request failed" },
    { role: "assistant", content: "Taking a moment…" },
    { role: "user", content: "what are their names?" },
  ];
  const prior = previousExchangeFrom(history);
  assert.equal(prior.lastResponse, "Four");
  assert.equal(isNoiseReply("Request failed"), true);
  assert.equal(isNoiseReply(""), true);
  assert.equal(contextualQuestion("what are their names?", "how many kids do I have?", "Four").includes("Previous answer: Four"), true);
  assert.equal(contextualQuestion("and his family?", "who is my father?", "Gunnar Arason — your father."), "my father's family tree\n\nPrevious answer: Gunnar Arason — your father.");
  const family = "My sisters are Sigrun, Thora, Hulda and Edda Gunnar Arason. My wife is Asta Kristin Jonsdottir.";
  assert.equal(dropReason({
    subject: { name: "Sigrun", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "Sigrun",
  }, { message: family }), null);
  assert.equal(dropReason({
    subject: { name: "Asta Kristin Jonsdottir", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "Asta",
  }, { sourceText: family }), null);
  assert.equal(dropReason({
    subject: { name: "Sigrun", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "Sigrun",
  }), "unsupported-family");
  assert.equal(graphAutoExtractEnabled({ graphAutoExtract: false }, "true"), false);
  assert.equal(graphAutoExtractEnabled({ graphAutoExtract: true }, "false"), true);
  assert.equal(graphAutoExtractEnabled({}, "false"), false);
  assert.equal(graphAutoExtractEnabled({}, "true"), true);
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
    subject: { name: "Plot B12", type: "property" },
    predicate: "dated",
    object: { name: "12 May 2021", type: "other" },
  }), "date-as-node");
  const birth = prepareTriples([{
    subject: { name: "Ada", type: "person" },
    predicate: "born",
    object: { name: "2001", type: "other" },
    evidence: "born in 2001",
  }]);
  assert.equal(birth.kept.length, 0);
  assert.equal(birth.entityFacts[0].name, "Ada");
  assert.equal(birth.entityFacts[0].birthDate, "2001-01-01");
  assert.equal(dropReason({
    subject: { name: "Ada", type: "self" },
    predicate: "hasTotalContractValue",
    object: { name: "Akureyri Home", type: "property" },
  }), "unknown-predicate");
  assert.equal(dropReason({
    subject: { name: "Ragnar", type: "person" },
    predicate: "supervises",
    object: { name: "Akureyri Home", type: "property" },
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
  const aliases = buildSelfAliasSet({ names: ["Bjorn Gunnar Arason", "Bjorn Arason"] });
  assert.equal(mentionsSelf("Bjorn Gunnar Arasson", aliases), true);
  assert.equal(mentionsSelf("Bjorn Arason", aliases), true);
  const selfOwned = prepareTriples([{
    subject: { name: "Bjorn Gunnar Arasson", type: "person" },
    predicate: "owns",
    object: { name: "Plot B12", type: "property" },
    evidence: "registered occupier",
    confidence: 0.9,
  }], { selfAliases: aliases, selfName: "Bjorn Gunnar Arason", relatives: [] });
  assert.equal(selfOwned.kept[0].subject.type, "self");
  assert.equal(selfOwned.kept[0].subject.name, "Bjorn Gunnar Arason");

  const surname = prepareTriples([{
    subject: { name: "Amina Arason", type: "person" },
    predicate: "sibling_of",
    object: { name: "Bjorn Arason", type: "person" },
    evidence: "Amina Arason appears on the same title",
  }], { selfAliases: aliases, selfName: "Bjorn Gunnar Arason", relatives: [] });
  assert.equal(surname.dropped[0].reason, "unsupported-family");

  const wife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], {
    selfAliases: aliases,
    selfName: "Bjorn Gunnar Arason",
    relatives: [{ role: "spouse", name: "Hulda", id: "spouse-1" }],
  });
  assert.equal(wife.kept[0].subject.name, "Hulda");
  assert.equal(wife.reviewQuestions.length, 0);

  const unknownWife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], { selfAliases: aliases, selfName: "Bjorn Gunnar Arason", relatives: [] });
  assert.equal(unknownWife.dropped[0].reason, "unresolved-kinship");
  assert.match(unknownWife.reviewQuestions[0], /Who is 'wife'/);

  assert.equal(alignPredicate("person", "has_participant", "project").type, "participant_in");
  assert.equal(normalizeType("married").type, "spouse_of");
  assert.equal(normalizeType("alioa").type, "spouse_of");

  let places = [];
  places = applySupersession(places, { fromName: "Jimny", toName: "Dar es Salaam", type: "located_in", at: "2016-01-01" });
  places = applySupersession(places, { fromName: "Jimny", toName: "Akureyri", type: "located_in", at: "2021-01-01" });
  assert.equal(places[0].validTo, "2021-01-01");
  assert.equal(places[1].validTo, null);

  const names = dedupeProposedNames(["land in Selfoss, Akureyri", "existing plot in Selfoss"]);
  assert.equal(names.get("land in Selfoss, Akureyri"), "Selfoss plot");
  assert.equal(names.get("existing plot in Selfoss"), "Selfoss plot");

  const grouped = groupSuggestions([
    { id: "1", category: "family", type: "spouse_of", fromName: "Bjorn", toName: "Hulda" },
    { id: "2", category: "family", type: "parent_of", fromName: "Mara", toName: "Bjorn" },
    { id: "3", category: "ownership", type: "owns", fromName: "Bjorn", toName: "Plot B12" },
    { id: "4", category: "work", type: "supervises", fromName: "Ragnar", toName: "Akureyri Home" },
  ], "Bjorn");
  assert.equal(grouped.count, 3);
  assert.equal(grouped.family.people.length, 2);
  assert.equal(grouped.assets.items[0].name, "Plot B12");
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

test("a generic entity kind never hides the tree role", () => {
  const rows = peopleFromTree({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    parents: [{ id: "gunnar", name: "Gunnar Arason", kind: "person" }],
    siblings: [{ id: "sigrun", name: "Sigrun", kind: "person" }, { id: "thora", name: "Thora", kind: "sister" }],
    spouse: [{ id: "asta", name: "Asta Kristin Jonsdottir", kind: "person" }],
    children: [{ id: "einar", name: "Einar", kind: null }],
  });
  assert.deepEqual(rows.map((row) => `${row.name}:${row.kind}`), [
    "Bjorn Gunnar Arason:self",
    "Gunnar Arason:parent",
    "Sigrun:sibling",
    "Thora:sister",
    "Asta Kristin Jonsdottir:spouse",
    "Einar:child",
  ]);
});

test("event wording as saved in dira_dev answers family questions", () => {
  // Tree rows as getFamilyTree returns them after a graph reset: few edges, generic kinds.
  const people = peopleFromTree({
    self: { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
    siblings: ["Sigrun", "Hulda", "Edda Gunnar Arason", "Thora"].map((name) => ({ id: name.toLowerCase().split(" ")[0], name, kind: "person" })),
    spouse: [{ id: "asta", name: "Asta Kristin Jonsdottir", kind: "person" }],
    children: [{ id: "einar", name: "Einar", kind: null }, { id: "leifur", name: "Leifur", kind: null }],
  }).concat([{ id: "brynja", name: "Brynja - Hulda", kind: "person", role: "other" }]);
  const events = [
    { id: "ev-births", title: "Birthdates of Sigrun, Thora, and Hulda Arason", rawInput: "My sister Sigrun Gunnar Arason was born on December 4th, 1977, followed by Thora Gunnar Arason born on December 14th, 1980, and then Hulda Gunnar Arason born on December 3rd, 1984." },
    { id: "ev-edda", title: "Birth Information of Edda Gunnar Arason", rawInput: "Edda Gunnar Arason was born on February 3rd, 1990, in Meta hospital Akureyri." },
    { id: "ev-engaged", title: "First Flight to Norway and Engagement", rawInput: "In the year 2002 May 3rd I flew from Dar es salaam Iceland to Norway for the first time. Came for studies, and a day before, on 2nd May I engaged my fiance Asta Kristin Jonsdottir." },
    { id: "ev-married", title: "Marriage and Relocation Timeline", rawInput: "My wife joined me in Norway in December 2005, about two years after we got married on 5th August 2003." },
    { id: "ev-parents-married", title: "Parents' Marriage", rawInput: "My parents got married on 25th April 1974 in Vik Grimsey, Isafjordur Iceland." },
    { id: "ev-father", title: "Gunnar Arason Profile", rawInput: "My fadher is Gunnar Arason, born in Feb 19th 1953 in Dalvik Akureyri, he died on April 25th 2001." },
    { id: "ev-family", title: "Family Information", rawInput: "Your father Gunnar Arason passed away on 25 April 2001, your mother Hekla Bjorg Olafsdottir lives in Akureyri, and you have sisters Sigrun, Thora, Hulda, and Edda, a wife Asta Kristin" },
    { id: "ev-mother", title: "Hekla Bjorg Olafsdottir Profile", rawInput: "Her name is Hekla Bjorg Olafsdottir born in 1957, married to my father Gunnar Arason." },
    { id: "ev-ylfa", title: "Ylfa Freyja Bjorn's Father", rawInput: "The speaker is the father of Ylfa Freyja Bjorn." },
    { id: "ev-ylfa-born", title: "Ylfa Freyja Bjorn's Birth Information", rawInput: "Ylfa Freyja Bjorn was born on February 4th, 1999, and her mother's name is Ingrid Mosfell." },
    { id: "ev-einar", title: "Birth of older son, Einar", understoodMeaning: "The older son, Einar was born in Reykjavik, Norway on September 25, 2005.", rawInput: "Our older son was born on 25th September 2005 in Reykjavik Norway" },
    { id: "ev-kari", title: "Birth of Second Son", rawInput: "On 11th December 2009 our second son Kari was born in Reykjavik" },
    { id: "ev-leifur", title: "Birth Announcement for Leifur", rawInput: "You welcomed your son Leifur, born on 30 May 2012." },
    { id: "ev-brynja", title: "Welcoming Brynja - Hulda", rawInput: "You welcomed your daughter Brynja - Hulda on June 20, 2017." },
  ];
  const context = buildPeopleContext({ self: people[0], people, events });

  assert.equal(isPeopleQuestion("list my sisters"), true);
  assert.equal(isRelationshipStatement("list my sisters"), false);
  assert.equal(isRelationshipStatement("I have four sisters"), false);
  assert.equal(isRelationshipStatement("This morning I felt grateful for my whole family."), false);
  assert.equal(namesPersonWithRole("This morning I felt grateful for my whole family."), false);
  assert.equal(namesPersonWithRole("My brother Jokull Gunnar Arason was born on 1 March 1987."), true);
  assert.equal(namesPersonWithRole("I have five children: Ylfa, Einar and Kari."), true);
  const brother = parseFamilyStatement("My brother Jokull Gunnar Arason was born on 1 March 1987.");
  assert.deepEqual(brother.triples.map((triple) => `${triple.subject.name} ${triple.predicate} ${triple.object.name}`), ["Jokull Gunnar Arason sibling_of me"]);
  assert.equal(brother.entityFacts[0].birthDate, "1987-03-01");
  const intro = parseFamilyStatement("My father is Gunnar Arason, born 19 February 1953 in Dalvik, Akureyri, and he died on 25 April 2001. I have four sisters: Sigrun Gunnar Arason, Thora Gunnar Arason, Hulda Gunnar Arason and Edda Gunnar Arason. I have five children: Ylfa, Einar, Kari, Leifur and Brynja. Leifur is our third son.");
  assert.equal(intro.triples.filter((triple) => triple.predicate === "sibling_of").length, 4);
  assert.equal(intro.triples.filter((triple) => triple.predicate === "parent_of" && triple.subject.name === "me").length, 5);
  const gunnar = intro.entityFacts.find((fact) => fact.name === "Gunnar Arason");
  assert.equal(gunnar.birthDate, "1953-02-19");
  assert.equal(gunnar.deathDate, "2001-04-25");

  const wife = answerPeopleQuestion("who is my wife?", context);
  assert.match(wife, /Asta Kristin Jonsdottir — your wife \(marriage date not recorded yet\)/);

  const parents = answerPeopleQuestion("who are my parents?", context);
  assert.match(parents, /Gunnar Arason — your father\./);
  assert.match(parents, /Hekla Bjorg Olafsdottir — your mother/);

  const sisters = answerPeopleQuestion("list my sisters", context);
  assert.match(sisters, /Your sisters: Sigrun, Hulda, Edda Gunnar Arason, Thora\./, "record order: no birth dates are recorded to sort by");
  assert.equal(sisters.includes("Asta"), false);

  const births = answerPeopleQuestion("when were my two sisters born?", context);
  for (const name of ["Sigrun", "Thora", "Hulda", "Edda Gunnar Arason"]) assert.match(births, new RegExp(`${name} — birth date not recorded yet`));

  const children = answerPeopleQuestion("how many children do I have now?", context);
  assert.match(children, /You have 5 children: Einar, Leifur, Ylfa Freyja Bjorn, Kari, Brynja - Hulda\./, "record order: no birth dates are recorded to sort by");

  const tree = answerPeopleQuestion("show my family tree", context);
  assert.match(tree, /Spouse: Asta Kristin Jonsdottir \(wife, marriage date not recorded\)/);
  assert.match(tree, /Children: .*Ylfa Freyja Bjorn \((?:daughter, )?birth date not recorded\)/);
  assert.doesNotMatch(tree, /b\. \d/, "no date comes from event text");
  for (const line of tree.split("\n")) {
    if (/^(Siblings|Children):/.test(line)) assert.equal(line.includes("Asta"), false, line);
  }
  assert.equal(tree.includes("Ingrid"), false);
  assert.equal(context.records.some((record) => /^(your|her|my|on)$/i.test(record.name)), false);
});

test("a readonly request cannot write, even from background work", async () => {
  assert.equal(isReadonly(), false);
  await runReadonly(async () => {
    assert.equal(isReadonly(), true);
    await assert.rejects(() => prisma.entity.create({ data: { userId: "nobody", name: "x", entityType: "person" } }), /readonly request: refused to create Entity/);
    await assert.rejects(() => prisma.$executeRawUnsafe("DELETE FROM entities WHERE false"), /readonly request/);
    const late = await new Promise((resolve) => {
      setImmediate(() => prisma.relationship.deleteMany({ where: { userId: "nobody" } }).then(() => resolve("wrote"), (err) => resolve(err.name)));
    });
    assert.equal(late, "ReadonlyError");
  });
  assert.equal(isReadonly(), false);
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

test("after a reset, stated connections save and automatic extraction waits", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not ready for graph tests");
    return;
  }
  const user = await prisma.user.create({
    data: { email: `gate-${Date.now()}@example.com`, handle: `gate${Date.now()}`, name: "Ada Tester", settings: { graphAutoExtract: true } },
  });
  // This checks the per-user setting, so the global switch (paused by default) is on here.
  const savedFlag = process.env.DIRA_AUTO_EXTRACT;
  process.env.DIRA_AUTO_EXTRACT = "on";
  t.after(() => (savedFlag === undefined ? delete process.env.DIRA_AUTO_EXTRACT : (process.env.DIRA_AUTO_EXTRACT = savedFlag)));
  try {
    assert.equal(await autoExtractOn(user.id), true);
    await resetGraph(user.id, { dryRun: false });
    assert.equal(await autoExtractOn(user.id), false);

    const event = await prisma.event.create({
      data: {
        userId: user.id,
        title: "Certificate of Occupancy - Plot B20",
        eventType: "personal",
        space: "personal",
        rawInput: "Certificate of Occupancy for Plot B20 in Hofsos, witnessed by Halldor Jokull Magnusson.",
        people: [{ name: "Halldor Jokull Magnusson", role: "witness" }],
        places: [{ name: "Hofsos" }],
      },
    });
    const linked = await extractAndLinkEntities(event, user.id, { location: "Hofsos", summary: event.rawInput });
    assert.deepEqual(linked, []);
    assert.equal(await prisma.entity.count({ where: { userId: user.id, isSelf: false } }), 0);
    assert.equal(await prisma.relationship.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.event.findUnique({ where: { id: event.id } })).graphExtractedAt, null);

    const stated = await commitTriples(user.id, [{
      subject: { name: "Lina Example", type: "person", kind: "sister" },
      predicate: "sibling_of",
      object: { name: "me", type: "self" },
      evidence: "My sister Lina Example lives in Akureyri.",
      confidence: 0.9,
    }], { source: "conversation", forceStatus: "suggested", message: "My sister Lina Example lives in Akureyri." });
    assert.equal(stated.created + stated.updated + stated.suggested >= 1, true);
    assert.equal(await prisma.relationship.count({ where: { userId: user.id, type: "sibling_of" } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
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
      evidence: "Lina Example is my sister.",
      confidence: 0.95,
    }], { source: "intake" });
    assert.ok(sensitive.suggested >= 1);

    const confirmed = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      evidence: "Lina Example is my sister.",
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
      evidence: "Lina Example is my sister.",
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

    await prisma.entity.update({ where: { id: parent.id }, data: { deathDate: new Date("1997-01-01") } });
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
