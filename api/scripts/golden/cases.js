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
  "Trip to Tanzania: I fly to Dar es Salaam on 10 December 2026.",
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

const has = (...names) => (answer) => names.filter((name) => !new RegExp(`\\b${name}\\b`, "i").test(answer)).map((name) => `missing "${name}"`);
const MONTH_NUMBER = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const dayValue = (text) => {
  const [day, month, year] = text.split(/\s+/);
  return Number(year) * 10000 + MONTH_NUMBER[month.slice(0, 3).toLowerCase()] * 100 + Number(day);
};
// No person in the answer may be born on or after the day they died.
export const birthAfterDeath = (answer) => {
  const failures = [];
  for (const match of String(answer).matchAll(/([\p{L}' -]+?)\s*\([^)]*?\bb\. (\d{1,2} \w{3,} \d{4})[^)]*?\bpassed (\d{1,2} \w{3,} \d{4})/gu)) {
    if (dayValue(match[2]) >= dayValue(match[3])) failures.push(`${match[1].trim()}: birth date ${match[2]} is not before death date ${match[3]}`);
  }
  return failures;
};

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
export const CASES = [
  {
    id: "wife",
    turns: ["who is my wife?"],
    check: ({ answer }) => has("Zelda Goodluck Mambosho")(answer),
  },
  {
    id: "parents",
    turns: ["who are my parents?"],
    check: ({ answer }) => [...has("Enock Mwakyusa", "Froidah Biniala Kyando")(answer), ...lacks("Hermes")(answer)],
  },
  {
    // One question, several relations: every one answered from records, in one reply.
    id: "wife-and-parents",
    turns: ["my wife and parents?"],
    check: ({ answer }) => {
      const failures = [...has("Zelda Goodluck Mambosho", "Enock Mwakyusa", "Froidah Biniala Kyando")(answer), ...lacks("Hermes")(answer)];
      if (!/Zelda Goodluck Mambosho — your wife/.test(answer)) failures.push("Zelda not named as wife");
      if (!/Enock Mwakyusa — your father/.test(answer)) failures.push("Enock not named as father");
      if (!/Froidah Biniala Kyando — your mother/.test(answer)) failures.push("Froidah not named as mother");
      return failures;
    },
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
    // Days left, what is recorded and what is not; never "on track" without recorded progress.
    id: "trip-timeline",
    turns: ["how many days until my trip to Tanzania?"],
    check: ({ answer }) => {
      const failures = [];
      if (!/\bin \d+ days\b|\btomorrow\b|\btoday\b/.test(answer)) failures.push("no days-until for a recorded date");
      if (!/Not recorded: /.test(answer)) failures.push("does not say what is not recorded");
      if (/\bon track\b/i.test(answer)) failures.push('says "on track"');
      return failures;
    },
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
      const father = answer.split("\n").find((line) => /\bEnock Mwakyusa \(father\b/.test(line)) || "";
      if (!/\bEnock Mwakyusa \(father[^)]*\bb\. 19 Feb 1956\b/.test(father)) failures.push("father's birth date is not 19 Feb 1956");
      if (!/\bEnock Mwakyusa \(father[^)]*\bpassed 25 Apr 2004\b/.test(father)) failures.push("father's death date is not 25 Apr 2004");
      failures.push(...birthAfterDeath(answer));
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
];
