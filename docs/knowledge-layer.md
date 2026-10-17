# Knowledge layer: design

Status: phase 0 (2026-10-17). Scope and phases: docs/PROGRESS.md.
This file is the contract shared by the code, the test sets and the
hold-out writers. Change it deliberately, never to fit one case.

## Flow

```
any input ──► ingest(userId, text, source, ref)
                │
                ├─ router: question | statement | mixed  (nothing else)
                │
   statement ───┼─► Event saved (fullText, source, ref), chunked + embedded
                │   └─► extract(text) ─► validate ─► resolve ─► claims
                │                                       └─► materialised views
                │                                           (Relationship, …)
   question ────┴─► answer(userId, question)
                      ├─ structured tools over claims (+ code derivations)
                      ├─ retrieval over source text (pgvector)
                      └─ code-formatted reply, or model reply + post-check
```

`source`: chat | email | journal | file | queue | chip | relationship.
A statement is always saved and extracted, even when extraction finds
nothing. A mixed message ("my sister Ana got married in May; when is her
birthday?") is stored as a statement and then answered.

## Entities

One table (`entities`), one resolver for every type.

| Type | Examples |
|---|---|
| person | the user (`isSelf`), relatives, colleagues, contractors |
| organisation | employer, own business, bank, school, ministry |
| place | city, district, village, country, address |
| property | house, plot, flat, farm, building |
| vehicle | car, motorbike, truck, boat |
| document | title deed, passport, licence, contract, insurance policy |
| project | renovation, building, business launch, wedding, study |
| asset | other possessions: shares, equipment, livestock, account |
| event | a trip, a ceremony, a meeting, as a thing with a date |

The resolver matches a mention to an existing entity by type plus
normalised name, aliases, and context ("the Mbezi plot" = property named
for its place); a role phrase ("my wife") resolves through stored claims,
never by creating a person called "wife". Ambiguous mentions create a new
entity and a merge suggestion, never a silent merge.

## Claims

One row per fact.

| Field | Meaning |
|---|---|
| subjectId | entity the claim is about |
| predicate | from the core vocabulary below |
| objectId | entity, when the object is an entity |
| value | text/number, when the object is a value |
| label | free text: role title, relative word, detail name, `related_to` label |
| amount, currency | money (ISO 4217); amount in major units |
| contextId | entity the claim is for / about (payment *for* a project) |
| date, datePrecision | when it happened or started; day / month / year |
| until, untilPrecision | when it ended (sold, moved out, divorced, left job) |
| status | stated / confirmed / rejected / superseded |
| supersedesId | the claim this one corrects or replaces |
| evidence | quote from the source text that states it |
| eventId, source, sourceRef | where it came from |
| extractor, model | which extractor version and model produced it |

Dates are never more precise than the text: "in 2019" is a year, "in May
2019" a month. A correction ("actually it was 2018", "we sold the car")
adds a new claim; the old one becomes `superseded` (correction) or gets an
`until` (change over time). Nothing is deleted.

## Core vocabulary

Direction is subject → object. Symmetric predicates are marked ↔. The
domain column is the scoring bucket.

### people (family and social)
| Predicate | Object | Notes |
|---|---|---|
| parent_of | person | label: step / adoptive / foster when stated |
| spouse_of ↔ | person | date = married, until = divorced/ended; label: partner, fiancé(e) |
| sibling_of ↔ | person | label: half / step when stated |
| relative_of | person | any other kin stated without the connecting people; label is the word used (grandmother, uncle, cousin, sister-in-law, godson) |
| friend_of ↔ | person | |
| neighbour_of ↔ | person | |
| knows | person | label: how (met at church, school friend) |

### work
| Predicate | Object | Notes |
|---|---|---|
| works_at | organisation | label: job title; date / until |
| colleague_of ↔ | person | |
| manages | person | supervisor → report |
| client_of | person / organisation | subject is the client |
| contractor_for | person / organisation / project | subject does paid work for object; label: trade |
| business_partner_of ↔ | person | |
| founded | organisation | date |
| director_of | organisation | label: chair, CEO, board member |
| owns_share_of | organisation | value: percent |
| member_of | organisation | church, association, chama, club |
| studied_at | organisation | label: course; date / until |

### assets and documents
| Predicate | Object | Notes |
|---|---|---|
| owns | property / vehicle / asset / document | date = acquired, until = disposed; label: bought / inherited / gift / co-owned |
| rents | property | date / until |
| bought | property / vehicle / asset | amount, date; contextId = seller if named |
| sold | property / vehicle / asset | amount, date; contextId = buyer if named |
| located_in | place | for any entity |
| identifier | value | label: plot number, registration, title number, policy number |
| expires_on | value (date) | documents, licences, insurance |
| renews_on | value (date) | recurring renewals |
| valued_at | value | amount, date |
| issued_by | organisation | documents |

### money
| Predicate | Object | Notes |
|---|---|---|
| paid | person / organisation | subject payer → payee; amount, date; contextId = what for |
| received_from | person / organisation | subject received; amount, date; contextId |
| contributed_to | project / person / organisation | amount, date |
| owes | person / organisation | debtor → creditor; amount; date; until = settled |
| earns | value / organisation | amount; label: per month / per year / salary / rent income |
| costs | value | for a project or asset: amount; label: budget / quote / total |

### projects
| Predicate | Object | Notes |
|---|---|---|
| status | value | planned / active / paused / done / cancelled; date |
| works_on | project | person or organisation; label: role |
| part_of | project / property | |
| milestone | value | label: what happened; date |

### time
| Predicate | Object | Notes |
|---|---|---|
| born | value (date) | birthdays derive from it |
| died | value (date) | |
| happened | value (date) | an event entity's date; contextId = place |
| visited | place | date / until (travel) |
| lives_in | place | date / until (moves) |
| scheduled | value (date) | a planned event or appointment |
| due_on | value (date) | deadline for a project, payment, task, document |

### plans
| Predicate | Object | Notes |
|---|---|---|
| plans | value | "I plan to…"; date = target when stated |
| decided | value | "we decided…"; date; contextId = project/entity |
| intends | value | softer intention, wish, vision |

### escape hatch
| Predicate | Object | Notes |
|---|---|---|
| related_to | entity / value | label = the relation in the user's words, evidence required |

Nothing stated is dropped for lack of a predicate: it becomes
`related_to`.

## Derived in code, never extracted

- child_of, grandparents, grandchildren, aunts/uncles, nieces/nephews,
  cousins, in-laws (via spouse_of), step-parents/step-children (via a
  parent's spouse), half-siblings (one shared parent). A stated
  `relative_of` label fills in where the chain is unknown.
- Counts, eldest/youngest, ages, upcoming birthdays.
- Assets held on a date (owns date/until, sold).
- Sums: money by person, project, place (via located_in), period.
- Project totals (paid with contextId = project, costs, contributions).
- What's due: due_on, expires_on, renews_on, scheduled after today.

## Test-set format

Shared by the synthetic life set and every hold-out.

Set file (`{ name, selfName, asOf, seeds, questions }`):
- `asOf`: the date the set is written for ("today"), ISO day; questions
  like "what's due" are answered relative to it.
- `seeds`: strings (chat), or `{ "text": "...", "source": "email" |
  "journal" | "file" | "chat" }`.
- `questions`: `{ id, domain, turns: [...], expect }`, where `expect` may
  hold `has` (strings that must appear), `lacks` (must not appear),
  `dates` (ISO; any format in the answer), `count` (number), `amounts`
  (`[{ "value": 1200000, "currency": "TZS" }]`, any reasonable format).
- Question domains: people, work, money, projects, assets, time, plans,
  open.

Expected-claims file (`{ set, claims: [...] }`), one per stated fact:

```json
{ "seed": 3, "domain": "money", "subject": "me", "predicate": "paid",
  "object": "Juma Mrisho", "amount": 2500000, "currency": "TZS",
  "date": "2024-03", "context": "Bagamoyo house" }
```

- `subject` / `object` / `context`: entity names as written in the seeds,
  or `"me"` for the narrator; `value` instead of `object` for values.
- Optional: `label`, `amount`, `currency`, `date`, `until` (ISO, length
  gives precision: `2024`, `2024-03`, `2024-03-15`), `status`
  (`superseded` for a fact the seeds later correct).
- Only facts the text states, in the vocabulary above; nothing derived.
- Scoring (api/scripts/golden/claims.js): names match exactly, by alias, or
  as the closest word-subset; symmetric predicates in either order;
  received_from is paid turned around; dates at the stated precision;
  amounts within 0.5%; a corrected fact counts only if stored as
  superseded. Equivalences: plans / intends / decided are one family; an
  expected owns is met by a bought (same date if given) and an owns with
  until by a sold on that date, sharing that claim with the bought/sold
  expectation; a plan's expected date may appear in its stored words; a
  stored claim without context is not wrong when the expected one has a
  context (a different context is).
- Claim domains: people, work, money, projects, assets, time, plans.
