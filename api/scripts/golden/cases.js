// Golden facts and questions about the account owner. Both modes ask the same cases.

export const SELF_NAME = "Phesto Enock Mwakyusa";

// Fixture mode feeds these through /home/input and confirms whatever DIRA offers to save.
export const SEED_MESSAGES = [
  "My name is Phesto Enock Mwakyusa. My father is Enock Mwakyusa, born 19 February 1956 in Rungwe, Mbeya, and he died on 25 April 2004. My mother is Froidah Biniala Kyando; she lives in the family home in Mbeya. I have four sisters: Jeni Enock Mwakyusa, Leah Enock Mwakyusa, Neema Enock Mwakyusa and Zenah Enock Mwakyusa. My wife is Zelda Goodluck Mambosho. I have five children: Careen, Patrick, Presley, Powell and Prisha. Careen is my eldest daughter, born before I married Zelda, so she is not Zelda's daughter. Powell is our third son.",
  "My sisters' birthdays: Jeni Enock Mwakyusa was born on 4 December 1980, Leah Enock Mwakyusa on 14 December 1983 and Neema Enock Mwakyusa on 3 December 1987.",
  "My youngest sister Zenah Enock Mwakyusa was born on 3 February 1993.",
  "I married Zelda Goodluck Mambosho on 5 August 2006.",
  "Patrick was born on 25 September 2008, Presley on 11 December 2012 and Prisha on 20 June 2020.",
  "I own two plots in Kitunda, plot numbers P9104 and P9098.",
  "I bought land in Jambiani for 2,000,000 TSH in 2021.",
  "I have land in Ntabha, Mbeya, and a house in Kisarawe. Tuliza Nafsi is our place in Zanzibar.",
  "I own two cars, a Toyota Prado and a Suzuki Jimny, both kept in Dar es Salaam.",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Accepts "4 Dec 1980", "December 4th, 1980", "1980-12-04" and "04/12/1980".
export function mentionsDate(text, iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const mon = `(?:${LONG[month - 1]}|${MONTHS[month - 1]}\\.?)`;
  const dd = `0?${day}(?:st|nd|rd|th)?`;
  const pad = (n) => String(n).padStart(2, "0");
  const patterns = [
    `\\b${dd}\\s+${mon},?\\s+${year}\\b`,
    `\\b${mon}\\s+${dd},?\\s+${year}\\b`,
    `\\b${year}-${pad(month)}-${pad(day)}\\b`,
    `\\b${pad(day)}/${pad(month)}/${year}\\b`,
  ];
  return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

const SCALE = { k: 1e3, thousand: 1e3, elfu: 1e3, m: 1e6, mn: 1e6, million: 1e6, milioni: 1e6, bn: 1e9, billion: 1e9 };

// Accepts "970,000", "970 000", "970000", "1.75 million", "KES 1.75m", "450k" and "1.750.000" for the same amount.
export function mentionsAmount(text, value) {
  const pattern = /(\d{1,3}(?:[,\s.\u00a0'’]\d{3})+|\d+)(?:[.,](\d+))?\s*(thousand|million|milioni|billion|elfu|mn|bn|k|m)?(?![\p{L}\d])/giu;
  for (const match of String(text || "").matchAll(pattern)) {
    const whole = Number(match[1].replace(/[^\d]/g, ""));
    const number = match[2] ? Number(`${whole}.${match[2]}`) : whole;
    const amount = number * (SCALE[(match[3] || "").toLowerCase()] || 1);
    if (Math.abs(amount - value) <= Math.max(1, value * 0.005)) return true;
  }
  return false;
}

const has = (...names) => (answer) => names.filter((name) => !new RegExp(`\\b${name}\\b`, "i").test(answer)).map((name) => `missing "${name}"`);
const lacks = (...names) => (answer) => names.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(answer)).map((name) => `must not mention "${name}"`);
const ANSWER_INTENTS = new Set(["question", "graph_query"]);

function answered(turn) {
  const failures = [];
  if (!ANSWER_INTENTS.has(turn.response.routing?.intent)) failures.push(`routed as ${turn.response.routing?.intent}, not a question`);
  if (turn.response.result?.type !== "answer") failures.push(`result was ${turn.response.result?.type}, not an answer`);
  if (turn.response.result?.confirmationRequired) failures.push("asked to confirm a save");
  return failures;
}

// Each case is a conversation. Checks run on the last turn; `db` reads the user's graph without writing.
export const MOTHER_SENTENCE = "Froidah Biniala Kyando is my mother. She lives in our family home in Mbeya.";

export const CASES = [
  {
    id: "wife",
    turns: ["who is my wife?"],
    check: ({ answer }) => [...has("Zelda Goodluck Mambosho")(answer), ...(mentionsDate(answer, "2006-08-05") ? [] : ["missing the marriage date 2006-08-05"])],
  },
  {
    id: "parents",
    turns: ["who are my parents?"],
    check: ({ answer }) => [...has("Enock Mwakyusa", "Froidah Biniala Kyando")(answer), ...lacks("Hermes")(answer)],
  },
  {
    id: "sisters",
    turns: ["list my sisters"],
    check: ({ answer, turn }) => [...answered(turn), ...has("Jeni", "Leah", "Neema", "Zenah")(answer), ...lacks("Zelda")(answer)],
  },
  {
    id: "sister-births",
    turns: ["when were my sisters born?"],
    check: ({ answer }) => [
      ["Jeni", "1980-12-04"],
      ["Leah", "1983-12-14"],
      ["Neema", "1987-12-03"],
      ["Zenah", "1993-02-03"],
    ].filter(([, iso]) => !mentionsDate(answer, iso)).map(([name, iso]) => `missing ${name}'s birth date ${iso}`),
  },
  {
    id: "children",
    turns: ["list my children"],
    check: ({ answer }) => has("Careen", "Patrick", "Presley", "Powell", "Prisha")(answer),
  },
  {
    id: "children-count",
    turns: ["how many children do I have?"],
    check: ({ answer }) => (/\b(5|five)\b/i.test(answer) ? [] : ["does not say 5"]),
  },
  {
    id: "properties",
    turns: ["what properties do I have?"],
    check: ({ answer }) => has("P9104", "P9098", "Jambiani", "Ntabha", "Kisarawe")(answer),
  },
  {
    id: "cars",
    turns: ["how many cars do I own?"],
    check: ({ answer }) => (/\b(2|two)\b/i.test(answer) ? [] : ["does not say 2"]),
  },
  {
    id: "family-tree",
    turns: ["show my family tree"],
    check: async ({ answer, db }) => {
      const failures = lacks("Hermes")(answer);
      for (const line of answer.split(/\n|(?<=[.;])\s+/)) {
        if (!/\bZelda\b/i.test(line)) continue;
        if (/\b(sisters?|brothers?|siblings?|daughter|son|child(ren)?)\b/i.test(line) && !/\b(wife|spouse|married)\b/i.test(line)) {
          failures.push(`Zelda listed as a child or sibling: "${line.trim()}"`);
        }
      }
      if (/\bCareen\b[^\n]*\bZelda\b|\bZelda\b[^\n]*\bCareen\b/i.test(answer) && /\b(Zelda'?s (daughter|child)|children with Zelda|mother:?\s*Zelda)\b/i.test(answer)) {
        failures.push("answer shows Careen as Zelda's child");
      }
      failures.push(...(await db.treeProblems()));
      return failures;
    },
  },
  {
    id: "four-sisters-statement",
    turns: ["I have four sisters"],
    countsEvents: true,
    check: ({ eventsCreated, turn }) => {
      const failures = eventsCreated ? [`${eventsCreated} new event(s) created`] : [];
      if (turn.response.result?.type === "saved") failures.push("saved an event");
      if (turn.response.result?.type === "relationship_preview") failures.push("offered connections the message doesn't name");
      return failures;
    },
  },
  {
    // A connection needs a named person and their role to you; feelings or "my family" alone never qualify.
    id: "grateful-family",
    turns: ["Today I felt grateful for my family."],
    countsEvents: true,
    check: ({ eventsCreated, turn }) => {
      const intent = turn.response.routing?.intent;
      const failures = ["journal", "question"].includes(intent) ? [] : [`routed as ${intent}, not journal or conversation`];
      if (turn.response.result?.type === "relationship_preview") failures.push("offered connections");
      if (eventsCreated) failures.push(`${eventsCreated} new event(s) created`);
      return failures;
    },
  },
  {
    id: "children-follow-up",
    turns: ["how many children do I have?", "what are their names?"],
    check: ({ answer, turn }) => {
      const intent = turn.response.routing?.intent;
      const failures = ANSWER_INTENTS.has(intent) ? [] : [`follow-up routed as ${intent}, not a question`];
      return [...failures, ...has("Careen", "Patrick", "Presley", "Powell", "Prisha")(answer)];
    },
  },
  {
    // Production lost the mother here: "my mother" and "she" ended up on the self. Fixture mode reads the card;
    // live readonly reads what DIRA would have suggested.
    id: "mother-sentence",
    turns: [MOTHER_SENTENCE],
    check: ({ turn }) => motherProblems(turn.response),
  },
];

// The lines a relationship card (or a readonly preview) offers, as "<from> <type> <to>" or the card's own wording.
export function offeredLines(response) {
  const result = response?.result;
  if (result?.type === "relationship_preview") return (result.content?.edges || []).map((edge) => edge.line);
  if (result?.type === "readonly_skipped") {
    const text = String(result.content?.message || "").replace(/^Readonly: would suggest /, "").replace(/\. Nothing was saved\.$/, "");
    return text.split(/;\s*/).filter(Boolean);
  }
  return [];
}

export function motherProblems(response, selfName = SELF_NAME) {
  const lines = offeredLines(response);
  if (!lines.length) return [`offered no connections (${response?.routing?.intent}/${response?.result?.type})`];
  const failures = [];
  const self = new RegExp(`^(me|${selfName})\\b`, "i");
  if (!lines.some((line) => /^Froidah Biniala Kyando (— your (mother|parent)|parent_of me)\b/.test(line))) failures.push("no Froidah → self parent_of");
  if (!lines.some((line) => /^Froidah Biniala Kyando (— lives in|lives_at) Mbeya\b/.test(line))) failures.push("no Froidah lives_at Mbeya");
  for (const line of lines) {
    if (self.test(line) && /lives(_at| in)/.test(line)) failures.push(`lives_at on the self: "${line}"`);
    if (/\b(she|her)\b/i.test(line.replace(/\(already saved\)/, ""))) failures.push(`pronoun as a node: "${line}"`);
    if (/child of|child_of/.test(line)) failures.push(`reversed parent edge: "${line}"`);
  }
  return failures;
}
