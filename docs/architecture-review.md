# Knowledge layer: architecture review

2026-10-17, branch fix/people-answers at `40231d3`. Read-only review: every
code path that writes or reads facts about people, relationships, dates or
assets. Paths are under api/src/. "Dup" = does the same job as another path.

## 1. Ingestion: where a fact can enter

| # | Path | What it does | Dup |
|---|---|---|---|
| I1 | routes/home.js `/home/input` → intentRouter.routeIntent | Main chat box. Model plus a regex fallback (`heuristic()`) picks one of 9 intents; each intent has its own handler below. | — |
| I2 | home.js runIntakeText / runIntakeFile | contextEngine.understandText/File → createEventFromUnderstanding → entities.extractAndLinkEntities → scheduleExtraction | I3, I4, I5 |
| I3 | routes/intake.js `/intake` | Same chain as I2, separate route (intake page). | I2 |
| I4 | routes/queue.js confirm | Same chain as I2 for queued items. | I2 |
| I5 | routes/email.js inbound mail | understandText → createEventFromUnderstanding (→ I2's linking/extraction). | I2 |
| I6 | home.js runJournal, routes/journal.js | DiaryEntry + scheduleExtraction. Two handlers for one thing. | each other |
| I7 | home.js runRelationshipAdd / runRelationshipChange | extractTriples straight on the message → commitTriples (suggested) → relationship card → confirm. Bypasses events. | I2 (same text could arrive either way) |
| I8 | home.js runQuestion | While answering: scheduleExtraction if `looksRelational` (regex) and not `isPeopleQuestion` (regex); plus fact chips (I9). | I7 |
| I9 | intentRouter.extractConversationalFacts → UI chip → routes/graph.js `/graph/facts` → extractTriples | Fact chips from questions. | I10 |
| I10 | routes/advisor.js → lifeAdvisor.detectSignificantFacts | Fact chips from the advisor page; second chip extractor. | I9 |
| I11 | routes/graph.js `/graph/relationships`, PATCH, confirm/reject, merge/separate, `/graph/entities/:id` | Manual graph edits. | I12, I13 |
| I12 | routes/entities.js POST/PATCH `/entities`, `/entities/:id/link` | Manual entity edits and links (own `findOrCreateEntity`). | I11 |
| I13 | commandInterpreter planLink / planMerge / applyActionPlan | "link X to Y" / merge via the command intent; writes relationships directly. | I11 |
| I14 | graph/rebuild.js rebuildGraph, catchUpGraphExtractions (at boot) | Re-extracts every event/diary entry into the graph. | I2 extraction |
| I15 | services/fileProcessor.js | Vision/OCR of documents feeding understanding. | — |
| I16 | contextEngine.detectVisionInJournalEntry, routes/visions.js | Visions with `connectedEntities` JSON. | — |
| I17 | altimetrixBridge.js | External bridge: marks events synced, reads edges for notifyRelationshipShift. Out of scope; keep. | — |

## 2. Extraction: model calls that produce facts

| # | Path | What it does | Dup |
|---|---|---|---|
| E1 | contextEngine.understandText | Model reads a save: title, occurredAt, `people[]` names, places, financials → stored as JSON on Event. | E2 (people, places, amounts) |
| E2 | graph/relationshipExtractor.extractTriples | Two model calls per text: general triples (assets, work, money, places) and the people pass (rules prompt in peopleFacts.js, or schema prompt in peopleSchema.js per PEOPLE_EXTRACTOR). | E1 |
| E3 | routes/entities.extractAndLinkEntities | No model, but turns E1's unvalidated `people[]` into Entity rows (exact-name lookup). A second person-creation path next to E2. | E2 |
| E4 | intentRouter.extractConversationalFacts | Fact chips from a question. | E5 |
| E5 | lifeAdvisor.detectSignificantFacts | Fact chips from advisor chat. | E4 |
| E6 | commandInterpreter.extractEventDate | Model re-reads an event's date for "fix dates" commands. | E1 dates |
| E7 | fileProcessor | Document reading (vision model). | — |

## 3. Validation

| # | Path | What it does | Dup |
|---|---|---|---|
| V1 | graph/peopleFacts.validatePeople | Invariants for the rules people pass: names/dates verbatim, possessive kinship, gender, one birth date, death after birth. | V2 |
| V2 | graph/peopleSchema.validateSchemaFacts | Same invariants for the schema format. | V1 |
| V3 | graph/graphQuality (prepareTriples, dropReason, notPersonReason, alignPredicate, applySupersession, dedupeProposedNames) | Triple-level checks for the general pass; `notPersonReason` shared with V1/V2. | V1/V2 for people |
| V4 | graph/relationshipTypes.normalizeType, categoryOf | Predicate vocabulary. | kinship.js vocabulary |
| V5 | graph/kinship.js | Kin vocabulary used by V1, answering and tools. | V4 |
| V6 | graph/familyStatement (isRelationshipStatement, namesPersonWithRole) | Regex gates: does a message qualify as a connection to save. | R2 regexes |
| V7 | contextEngine.checkForDuplicate | Event-level duplicate check. | — |

## 4. Storage and resolution

| # | Path | What it holds / does | Dup |
|---|---|---|---|
| S1 | Entity (birthDate, deathDate, kind, aliases, attributes) | People, places, assets. | — |
| S2 | Relationship (type, validFrom/To, status, attributes.kind/ended/endPrecision, evidence) | Typed edges. Only spouse end dates carry precision; any other year is stored as 1 January. | — |
| S3 | Event.people / places / financials JSON; DiaryEntry.people; LifeEvent.people; Vision.connectedEntities | Copies of who/where/how much per record. | S1/S2: the same fact lives in up to four places |
| S4 | graph/entityResolver.resolveEntity, mergeEntities, expandGraphNames, findDuplicateCandidates | Name/alias/edit-distance resolution. | S5 |
| S5 | routes/entities.findOrCreateEntity | Case-insensitive exact-name lookup; creates otherwise. | S4 (makes duplicates S4 would merge) |
| S6 | relationshipExtractor.commitTriples, anchorEventEdges, closeSupersededBy | Edge writes, supersession, status, person dates from entityFacts. | I11–I13 write edges their own way |
| S7 | graph/reset.js, rebuild force | Wipe and regenerate. | — |

## 5. Routing: what decides whether a sentence is stored, and who answers

| # | Path | What it does | Dup |
|---|---|---|---|
| R1 | intentRouter.routeIntent (model) + heuristic(), QUESTION_WORD, CORRECTION_WORD … | 9 intents; a statement routed to "question" or left unsaved is never extracted. | R5 |
| R2 | home.js looksRelational, runGraphQuery regex branches, previousWasQuestion, openIntake | More routing inside handlers. | R1, R3, V6 |
| R3 | peopleGrounding.isPeopleQuestion, usesRecordedAnswer | Regex: is this a people question / can it be answered from records. | R2, R4 |
| R4 | lifeAdvisor HOLDINGS_QUESTION, HOLDINGS_EVENT | Regex for asset questions and asset events (English/Swahili words). | R3 |
| R5 | commandInterpreter.classifyIntent (model) + heuristicClassify | A second intent classifier for commands. | R1 |
| R6 | graph/engine.js PEOPLE_ENGINE, PEOPLE_EXTRACTOR | Picks extractor and answerer. | — |
| R7 | graph/autoExtract.autoExtractOn | Gate on automatic extraction. | — |

## 6. Answering: readers of people/date/asset facts

| # | Path | What it reads | Dup |
|---|---|---|---|
| A1 | lifeAdvisor.chat → answerPeople → peopleGrounding (loadPeopleContext, answerPeopleQuestion, groundAdvisorReply) | Rules engine: entities, edges, spouse validFrom, conflicts; deterministic answers plus model with post-check. | A2, A3 |
| A2 | graph/peopleTools.answerWithTools + groundToolReply | Tools engine over a graph snapshot. | A1, A3 |
| A3 | graph/peopleHybrid | Parked: code-formatted tool answers. | A1, A2 |
| A4 | lifeAdvisor fallback: loadContext (30 events, visions, journal, entities), graphContext, familyLines, holdingLines | Everything else; asset answers come from regex-filtered event text. | A1 (family), A6 |
| A5 | home.js runGraphQuery (non-people branch): getFamilyTree, getMoneyFlows, findPaths → model | Graph questions the router sends here. | A1, A4 |
| A6 | commandInterpreter.executeQuery / askCommand | Word search over events/entities/visions plus model summary (`/commands/ask`, command intent). | A4 |
| A7 | Family-tree builders: graphQuery.getFamilyTree, graphQuality.relativesFromEdges, peopleTools.links | Three ways to compute "the narrator's relatives". | each other |
| A8 | digestService, nudgeService | Due items from events, visions, entities. Keep. | — |
| A9 | altimetrixBridge.getAltimetrixContext | External context. Keep. | — |

## 7. Duplication in one view

- Ingestion: 5 doors lead into the understand → event chain (fine), but the
  chain then creates people twice (E3 from unvalidated names, E2 validated),
  and relationship_add (I7) bypasses events entirely.
- 2 fact-chip extractors, 2 people extractors with 2 validators, 2 entity
  resolvers, 3 family-tree builders, 2 intent classifiers.
- About 8 regex gates across 6 files decide routing or answer path.
- 5 answer paths for a people question, chosen by engine flag, router
  intent and regex.
- The same fact can sit in Event JSON, Entity, Relationship and the raw
  text, and the readers don't agree on which is authoritative.
- Date precision is lost at storage (a year becomes 1 January) except spouse
  end dates.

## 8. What the measurements say (interim, 2026-10-17)

Extraction harness, rules extractor, totals only for hold-outs:

| | gpt-4o-mini | gpt-4o |
|---|---|---|
| synthetic recall | 83% | 90% |
| hold-out 1 | 65% | 68% |
| hold-out 2 | 69% | 62% |
| hold-out 3 | 21% | 21% |

- Hold-out 3: ~9 of 19 expected facts are lost at routing (≈3 seeds not
  saved, 1 routed as a question) before any extractor sees them. That is
  an architecture loss, not a model loss.
- Elsewhere the losses are mostly the model not stating a fact (wrong
  person, one relation per person, roster echo), then validation.
- A stronger extraction model gives no consistent gain so far (gpt-4.1 and
  the schema extractor are still running).

## 9. Options

### (a) Keep patching to 9/10 on a fresh hold-out

What it takes: stop routing from dropping statements; let the people pass
hold several relations per person; unify the two resolvers; fix answer
paths. Each fix lands in 2–5 places (two extractors, two validators,
several answer paths, regex gates), and each must be re-proven on golden,
synthetic and hold-outs.

- Effort: open-ended. The last three rounds (rules → tools → hybrid → post-
  check) moved the best hold-out score by 0–1 point each. Estimate 10–20
  more sessions with no clear end.
- Chance of 9/10 on a fresh hold-out: low (rough guess 20–30%). Every fix
  is made against seen sets, and every hold-out can be used only once.
- Risk: high. Regressions in paths the golden sets don't cover, more code
  each round, and continued pressure to tune to the family set.

### (b) Replace the knowledge layer

One ingestion path → one claim store → tool-based answers. Keep auth,
intake UI, Event as the source record, email, digest, bridge, and the test
harness (golden, synthetic, hold-outs, extraction scoring, contamination
test).

- **One ingestion path.** Every saved text (home intake, journal, email,
  intake route, queue, relationship_add, confirmed fact chip, document)
  calls one `ingest(userId, text, source, ref)`. The router only decides
  question vs statement; a statement is always stored as text and
  extracted, never dropped.
- **One claim store.** A new table: subject entity, predicate from a closed
  vocabulary (parent_of, spouse_of, sibling_of, born_on, died_on,
  married_on, divorced_on, owns, sold_to, lives_in …), object (entity or
  value), date with precision (day/month/year), status (stated /
  confirmed / rejected / superseded), evidence quote, source ref,
  extractor and model version. One resolver. Event JSON people stop being
  a fact source; Relationship becomes a view over claims (or is migrated).
- **Derived, not extracted:** in-laws, step and half relations, counts,
  eldest/youngest, assets held on a date, all computed in code from claims.
- **Answers:** tools over claims. List, count, date and tree answers are
  formatted by code (the parked hybrid's value); open questions get a
  model reply with the meaning-based post-check. One answer path.
- **Reused:** V1 invariants, kinship vocabulary, dates.js, peopleTools /
  peopleHybrid tool code, post-check, golden and extraction harnesses.
- **Replaced:** most of graph/* (~5,300 lines) and the knowledge parts of
  lifeAdvisor, commandInterpreter, home.js, routes/graph.js and
  routes/entities.js (~2,000 lines), with roughly 2,500–3,500 new lines.

Phases, each ending with a harness run:

| Phase | Work | Sessions |
|---|---|---|
| 1 | Claim table + migration, one resolver, `ingest()`, built next to the old graph behind a flag | 2–3 |
| 2 | Extraction into claims (one extractor, several relations per person, date precision), V1 invariants; extraction harness scores claims | 2 |
| 3 | Tool answers over claims; code-formatted list/count/date/tree; post-check | 2 |
| 4 | Point every entry point at `ingest()`; adapt UI endpoints (relationship cards, confirm/reject, /graph/family, suggestions, merge), bridge's notifyRelationshipShift, digest's entity reads; remove old readers | 3–4 |
| 5 | Re-ingest dira_dev from events, parity runs on all sets, production migration plan | 2 |

- Effort: about 11–14 sessions, roughly 2–3 weeks with your reviews.
- Risk: medium. The UI depends on Relationship rows (cards, confirm/reject,
  graph pages); production needs a migration and a re-ingest; the period of
  running both stores side by side has to be managed. Mitigation: build
  behind a flag, compare with the harness, switch per entry point.
- What it does not fix by itself: model errors in extraction (wrong person,
  missed facts). Those remain, but each fix then lands once, and the
  extraction harness measures it directly.

### Recommendation

(b), staged. The biggest measured loss on the freshest hold-out is routing
and duplicated paths, which patching keeps paying for in every fix. Phase 1
plus "statements are never dropped" can be measured with the extraction
harness within the first few sessions, before anything old is removed.
Reaching 9/10 on a fresh hold-out is uncertain either way; (b) is the
better base for getting there.
