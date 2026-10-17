import OpenAI from "openai";
import { prisma } from "../prisma.js";
import { isRelationshipStatement, namesPersonWithRole } from "./graph/familyStatement.js";
import { isPeopleQuestion } from "./graph/peopleGrounding.js";

const OPENAI_MODEL = "gpt-4o-mini";
const GROQ_MODEL = "qwen/qwen3.8-27b";
const INTENTS = new Set([
  "intake_file",
  "intake_text",
  "question",
  "command",
  "journal",
  "correction",
  "relationship_add",
  "relationship_change",
  "graph_query",
  "unclear",
]);

const ROUTER_PROMPT = `You are the intent router for DIRA, a personal
intelligence system. Classify what the user wants.

Intent types:
- intake_file: they attached a file to process
- intake_text: they shared information to save
  (facts, events, purchases, dates, notes about
   their life — things that happened)
- question: they want to know something
  (asking DIRA to reason, explain, or retrieve)
- command: they want DIRA to do something
  (fix, change, update, archive, link, correct)
- journal: they are reflecting, noting how they feel,
  writing about their day, expressing thoughts
  (not facts to save — personal reflection)
- correction: they are correcting something DIRA
  said or did in this conversation
- relationship_add: they state a connection to remember
  ("Gunnar supervises the house", "Sigrún is my sister",
   "Einar anasimamia nyumba")
- relationship_change: a connection ended or changed
  ("Gunnar no longer supervises", "we sold the car",
   "dada yangu amehama")
- graph_query: they ask who is connected, how they are
  connected, for a family tree, or who they sent
  money to
- unclear: genuinely ambiguous

When the user says 'I meant X' or 'not that, I meant'
or 'the previous one' — this is a correction or
clarification of the PREVIOUS exchange.
Look at conversationHistory to understand what
they are referring to. Do not treat it as a new
standalone input.

When the previous DIRA response was a factual
answer (question intent), the next message is
about THAT answer. Short factual follow-ups are
clarifications, not new events. Classify as
correction, not intake_text, when the follow-up
contains 'but', 'actually', 'no', 'wait', a date
or fact that contradicts the previous answer,
'today is', 'it is now', or 'currently'.

Return JSON:
{
  intent: string,
  confidence: number,
  interpretation: string,
  alternatives: [
    { intent, interpretation }
  ],
  extractedData: {
    isQuestion: boolean,
    isCorrecting: boolean,
    mentionsFile: boolean,
    topics: string[],
    financialMention: boolean,
    datesMentioned: boolean,
    emotionalTone: "neutral" | "reflective" | "practical"
  },
  followUp: {
    action: "accept" | "decline" | "none",
    fact: string
  }
}

followUp reads the conversation, not a fixed phrase.
The previous DIRA response may hint that a life fact should be saved, noted, remembered, added, or updated, in whatever wording it used.
accept: the latest message agrees or tells DIRA to go ahead with that hint. fact is the specific life fact from the conversation, as a sentence. Never "this" or "that" alone.
decline: the latest message refuses that hint.
none: a new question, a different subject, or ordinary conversation. A question about what is already recorded is none.
If unsure, none.

alternatives has at most 2 other readings.

Examples:
'Here is the receipt for the Akureyri land purchase' + file
→ intent: intake_file, confidence: 0.95

'How much have I spent in Iceland this year?'
→ intent: question, confidence: 0.92

'Gunnar Magnusson supervises all my Akureyri projects'
→ intent: relationship_add, confidence: 0.9

'Sigrún ni dada yangu'
→ intent: relationship_add, confidence: 0.9

'My father Einar Arason died in 1999 and my mother lives in Ísafjörður. My brothers are Kári and Leifur.'
→ intent: relationship_add, confidence: 0.93
   Dates and places in a family introduction are facts about those people, not a new event.

'Gunnar no longer supervises the Akureyri house'
→ intent: relationship_change, confidence: 0.88

'Who is connected to the Akureyri house?'
→ intent: graph_query, confidence: 0.9

'How am I connected to Einar?'
→ intent: graph_query, confidence: 0.9

'Nani ameunganishwa na Akureyri?'
→ intent: graph_query, confidence: 0.86

'Fix the dates on my events'
→ intent: command, confidence: 0.88

'Today was a good day, I managed to close the deal'
→ intent: journal, confidence: 0.75
   alternative: intake_text (it could be an event)

'I felt really proud of my children today'
→ intent: journal, confidence: 0.90

'The Akureyri roof repair was 4,200 EUR not 3,900'
→ intent: correction, confidence: 0.85

conversationHistory shows DIRA just described
the garden plans for the Valparaíso cottage.
'Not that, I meant the terrace is part of the garden work'
→ intent: correction, confidence: 0.9
   The previous exchange is the subject, not a new event.

DIRA just answered a question about a date.
'But today is the 15th'
→ intent: correction, confidence: 0.9
   This corrects the previous answer, not a new event.

The interpretation string is shown to the user.
Follow these format rules for that wording.
You still return only the JSON object above.
Do not wrap the JSON in markdown.

RESPONSE FORMAT RULES — follow these precisely:

USE A MARKDOWN TABLE when:
- Showing cost breakdowns (item + amount columns)
- Comparing two or more things side by side
- Listing records with consistent attributes
- Financial line items from documents
Format: | Item | Amount (EUR) | with header row

USE A BULLET LIST when:
- Listing conditions, features, or requirements
- Showing details of one thing (owner, date, location)
- Steps or sequential items
- When items have no second column to compare

USE PROSE (paragraphs) when:
- Reasoning, analysis, or explanation
- Answering open questions about life and plans
- Connecting ideas across different areas
- Any conversational response

USE A SINGLE LINE when:
- The answer is one fact (a number, a name, a date)
- A direct yes/no with brief explanation
- Confirming an action was taken

AMOUNT FORMATTING:
- Always write amounts with commas: 12,450 EUR
- Always include the currency: TSH, EUR, USD
- For totals: bold the amount using **12,450 EUR**

NEVER:
- Mix a table and a list in the same response
- Use headers (###) for simple responses
- Add unnecessary preamble ('Based on your records...')
  when a direct answer is better
- Show raw markdown syntax — always use proper markdown
- Start every response the same way

GOOD EXAMPLE — cost breakdown request:
| Item | Cost (EUR) |
|------|-----------|
| Roof tiles | 6,200 |
| Gutters | 1,850 |
| Labour | 4,400 |
| **Total** | **12,450** |

BAD EXAMPLE — same request:
'Based on your records, the roof repair
cost 12,450 EUR. The items include tiles,
gutters, and labour.'

GOOD EXAMPLE — factual question:
'Your van's chassis number is WF0XXXTTGXKA00001.'

BAD EXAMPLE — same question:
'Based on the vehicle registration document
dated 3 May 2017, I can see that the vehicle
details include... the chassis number is...'

Be direct. Use the right format. Let the data speak.`;

export async function routeIntent(input, userId, attachedFile, history, lastAction) {
  const text = String(input || "").trim();
  const fileAttached = Boolean(attachedFile);
  if (!text && fileAttached) {
    return decide({
      intent: "intake_file",
      confidence: 0.95,
      interpretation: "Read the attached file and keep what it records.",
      alternatives: [],
      extractedData: emptyExtracted({ mentionsFile: true }),
    });
  }

  const snapshot = await loadSnapshot(userId, fileAttached).catch((err) => {
    console.error("[router] snapshot failed:", err.message);
    return { recentEvents: [], activeVisions: 0, journalThemes: [], fileAttached };
  });
  let classified;
  try {
    classified = await classify(text, snapshot, attachedFile, history, lastAction);
  } catch (err) {
    console.error("[router] classifier fallback:", err.message);
    classified = heuristic(text, fileAttached);
  }
  if (fileAttached && (classified.intent === "intake_text" || classified.intent === "unclear")) {
    classified.intent = "intake_file";
    classified.confidence = Math.max(classified.confidence, 0.9);
    classified.extractedData.mentionsFile = true;
  }
  applyConversationCorrection(classified, text, history, fileAttached);
  applyAnswerFollowUp(classified, text, history, lastAction, fileAttached);
  // Accepting or declining needs something DIRA offered first; a fresh statement is neither.
  if (!conversationItems(history).some((item) => item.role === "assistant")) {
    classified.followUp = { action: "none", fact: "" };
  }
  if (!fileAttached && rejectsCorrection(text) && classified.intent === "correction") {
    classified.intent = isPeopleQuestion(text) ? "graph_query" : "question";
    classified.confidence = Math.max(Number(classified.confidence) || 0, 0.9);
    classified.interpretation = "Answer a question.";
    if (classified.extractedData) classified.extractedData.isCorrecting = false;
  }
  if (!fileAttached && isPeopleQuestion(text) && !["relationship_change", "correction", "command"].includes(classified.intent)) {
    classified.intent = "graph_query";
    classified.confidence = Math.max(Number(classified.confidence) || 0, 0.9);
    classified.interpretation = "Answer from recorded family facts.";
  }
  if (!fileAttached && isRelationshipStatement(text) && !isPeopleQuestion(text) && !["relationship_change", "correction", "graph_query", "command"].includes(classified.intent)) {
    if (classified.intent !== "relationship_add") {
      classified.alternatives = [
        { intent: classified.intent, interpretation: classified.interpretation },
        ...classified.alternatives,
      ].filter((item) => item?.intent && item.intent !== "relationship_add").slice(0, 2);
    }
    classified.intent = "relationship_add";
    classified.confidence = Math.max(Number(classified.confidence) || 0, 0.9);
    classified.interpretation = "Save who these people are to you.";
  }
  // The classifier can still pick relationship_add for "I felt grateful for my family"; without a named person
  // and their role it's a reflection or conversation instead.
  if (!fileAttached && classified.intent === "relationship_add" && !namesPersonWithRole(text)) {
    const reflective = /\b(i feel|i felt|feeling|grateful|thankful|proud|happy|sad|anxious|tired|miss|love|blessed|today was)\b/i.test(text);
    classified.intent = reflective ? "journal" : "question";
    classified.alternatives = (classified.alternatives || []).filter((item) => item?.intent !== "relationship_add");
    classified.interpretation = reflective ? "Keep this as a reflection." : "Talk it through.";
  }
  return decide(classified);
}

export function previousExchangeFrom(history) {
  const items = conversationItems(history);
  let lastResponse = "";
  let priorUser = "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!lastResponse && item.role === "assistant") {
      lastResponse = item.content;
      continue;
    }
    if (lastResponse && item.role === "user") {
      priorUser = item.content;
      break;
    }
  }
  return {
    lastResponse,
    priorUser,
    about: aboutFrom(lastResponse),
  };
}

async function loadSnapshot(userId, fileAttached) {
  const [events, visions, journal] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" } },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { title: true },
    }),
    prisma.vision.count({
      where: { userId, status: { in: ["seed", "forming", "held", "active"] } },
    }),
    prisma.diaryEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { understoodThemes: true },
    }),
  ]);
  const themes = journal.flatMap((entry) => entry.understoodThemes || []).filter(Boolean).slice(0, 8);
  return {
    recentEvents: events.map((event) => event.title).filter(Boolean),
    activeVisions: visions,
    journalThemes: themes,
    fileAttached,
  };
}

async function classify(text, snapshot, attachedFile, history, lastAction) {
  const prior = previousExchangeFrom(history);
  const correcting = isConversationCorrection(text) && prior.lastResponse && !rejectsCorrection(text);
  const answerFollowUp = lastResponseWasAnswer(history, lastAction) && !rejectsCorrection(text);
  const user = [
    `File attached: ${attachedFile ? "yes" : "no"}`,
    `Recent events: ${snapshot.recentEvents.join("; ") || "none"}`,
    `Active visions: ${snapshot.activeVisions}`,
    `Recent journal themes: ${snapshot.journalThemes.join(", ") || "none"}`,
    "",
    conversationBlock(history),
    correcting
      ? [
          "",
          "The latest message corrects the previous exchange. Do not treat it as a new standalone input.",
          `Previous DIRA response: ${prior.lastResponse.slice(0, 700)}`,
          `That exchange was about: ${prior.about || "the previous reply"}`,
        ].join("\n")
      : "",
    answerFollowUp
      ? [
          "",
          "The previous DIRA response was a factual answer to a question.",
          "A follow-up is a correction only when it contains no, not, wrong, actually, or I meant.",
          "A message that ends in ? or starts with what, who, when, where, how, which, why, je, nani, lini, wapi, or vipi is a question, not a correction.",
          "Follow-ups such as 'their names' or 'and his family?' are questions. Carry the previous answer as context.",
        ].join("\n")
      : "",
    "",
    text,
  ].filter((line) => line !== undefined).join("\n");

  const raw = await completeRouter(user);
  const parsed = parseJson(raw);
  if (!parsed) throw new Error("Router did not return JSON");
  return normalize(parsed);
}

function routerProvider() {
  return String(process.env.ROUTER_PROVIDER || "openai").trim().toLowerCase() === "groq" ? "groq" : "openai";
}

async function completeRouter(user) {
  const provider = routerProvider();
  try {
    if (provider === "groq") return await completeWithGroq(user);
    return await completeWithOpenAI(user);
  } catch (err) {
    if (provider === "openai" && !isRateLimitError(err)) {
      console.error("[router] openai failed, trying groq:", err.message);
      return completeWithGroq(user);
    }
    throw err;
  }
}

async function completeWithOpenAI(user) {
  const openaiKey = usableKey(process.env.OPENAI_API_KEY);
  if (!openaiKey) throw new Error("OPENAI_API_KEY is not set");
  const client = new OpenAI({ apiKey: openaiKey, timeout: 12000 });
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: user },
    ],
  });
  return response.choices?.[0]?.message?.content || "";
}

async function completeWithGroq(user) {
  const key = usableKey(process.env.GROQ_API_KEY);
  if (!key) throw new Error("No model key is configured");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        { role: "system", content: `${ROUTER_PROMPT}\nReturn JSON only.` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error(`Groq router status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return stripThink(data.choices?.[0]?.message?.content || "");
}

function isRateLimitError(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429) return true;
  return /\b429\b|rate limit/i.test(String(err?.message || ""));
}

function normalize(parsed) {
  const intent = INTENTS.has(parsed.intent) ? parsed.intent : "unclear";
  const alternatives = Array.isArray(parsed.alternatives)
    ? parsed.alternatives
        .filter((item) => item && INTENTS.has(item.intent) && item.intent !== intent)
        .slice(0, 2)
        .map((item) => ({
          intent: item.intent,
          interpretation: textOr(item.interpretation, labelFor(item.intent)),
        }))
    : [];
  return {
    intent,
    confidence: clamp(parsed.confidence),
    interpretation: textOr(parsed.interpretation, labelFor(intent)),
    alternatives,
    extractedData: normalizeExtracted(parsed.extractedData),
    followUp: normalizeFollowUp(parsed.followUp),
  };
}

function normalizeFollowUp(value) {
  const action = value?.action === "accept" || value?.action === "decline" ? value.action : "none";
  const fact = textOr(value?.fact, "").replace(/\s+/g, " ").slice(0, 180);
  if (action === "accept" && (fact.length < 12 || /^(this|that|it)\b/i.test(fact))) return { action: "none", fact: "" };
  return { action, fact };
}

function decide(classified) {
  let action = "clarify";
  if (classified.intent !== "unclear" && classified.confidence > 0.8) action = "proceed";
  else if (classified.intent !== "unclear" && classified.confidence >= 0.55) action = "confirm";
  return { ...classified, action };
}

function heuristic(text, fileAttached) {
  const lower = text.toLowerCase();
  if (fileAttached) {
    return normalize({
      intent: "intake_file",
      confidence: 0.86,
      interpretation: "Read the attached file and keep what it records.",
      alternatives: [],
    });
  }
  if (!rejectsCorrection(text) && (isConversationCorrection(text) || /\b(no,?\s+that'?s wrong|you misunderstood)\b/.test(lower) || /\bwas\b.+\bnot\b/.test(lower))) {
    return normalize({
      intent: "correction",
      confidence: 0.72,
      interpretation: "Correct something from the last reply.",
      alternatives: [{ intent: "command", interpretation: "Change a saved record." }],
    });
  }
  if (/\b(no longer|not my|sold the|amehama|si tena)\b/.test(lower) && /\b(supervis|sister|brother|wife|owns|dada|mke|mume)\b/.test(lower)) {
    return normalize({
      intent: "relationship_change",
      confidence: 0.78,
      interpretation: "Update a connection that has ended.",
      alternatives: [],
    });
  }
  if (/\b(who is connected|how am i connected|family tree|sent money|nani ameunganishwa)\b/.test(lower)) {
    return normalize({
      intent: "graph_query",
      confidence: 0.8,
      interpretation: "Answer from the relationship graph.",
      alternatives: [],
    });
  }
  if (isPeopleQuestion(text)) {
    return normalize({
      intent: "graph_query",
      confidence: 0.86,
      interpretation: "Answer from recorded family facts.",
      alternatives: [],
    });
  }
  if (isRelationshipStatement(text) || /\b(is my|ni dada|ni kaka|supervises|takes care of|anasimamia)\b/.test(lower)) {
    return normalize({
      intent: "relationship_add",
      confidence: 0.76,
      interpretation: "Save a connection between people or places.",
      alternatives: [{ intent: "intake_text", interpretation: "It could also be an event." }],
    });
  }
  if (/^(how|what|when|where|why|which|who|did|have|has|am)\b/i.test(text) || text.includes("?")) {
    return normalize({
      intent: "question",
      confidence: 0.74,
      interpretation: "Answer a question from the life graph.",
      alternatives: [],
    });
  }
  if (/\b(fix|update all|archive|link|change)\b/.test(lower)) {
    return normalize({
      intent: "command",
      confidence: 0.7,
      interpretation: "Change something already saved.",
      alternatives: [],
    });
  }
  if (/\b(i feel|i felt|today was|i'm proud|i am proud|grateful|anxious|tired)\b/.test(lower)) {
    return normalize({
      intent: "journal",
      confidence: 0.7,
      interpretation: "Save this as a personal reflection.",
      alternatives: [{ intent: "intake_text", interpretation: "It could also be an event to save." }],
    });
  }
  if (text.length >= 10) {
    return normalize({
      intent: "intake_text",
      confidence: 0.6,
      interpretation: "Save this as something that happened.",
      alternatives: [{ intent: "journal", interpretation: "It could be a reflection." }],
    });
  }
  return normalize({
    intent: "unclear",
    confidence: 0.3,
    interpretation: "This could be read more than one way.",
    alternatives: [
      { intent: "question", interpretation: "Ask something." },
      { intent: "intake_text", interpretation: "Save something that happened." },
    ],
  });
}

function normalizeExtracted(value) {
  const source = value && typeof value === "object" ? value : {};
  const tone = source.emotionalTone;
  return {
    isQuestion: Boolean(source.isQuestion),
    isCorrecting: Boolean(source.isCorrecting),
    mentionsFile: Boolean(source.mentionsFile),
    topics: Array.isArray(source.topics) ? source.topics.map((item) => String(item)).filter(Boolean).slice(0, 6) : [],
    financialMention: Boolean(source.financialMention),
    datesMentioned: Boolean(source.datesMentioned),
    emotionalTone: tone === "reflective" || tone === "practical" ? tone : "neutral",
  };
}

function emptyExtracted(extra = {}) {
  return {
    isQuestion: false,
    isCorrecting: false,
    mentionsFile: false,
    topics: [],
    financialMention: false,
    datesMentioned: false,
    emotionalTone: "neutral",
    ...extra,
  };
}

function applyConversationCorrection(classified, text, history, fileAttached) {
  if (fileAttached || rejectsCorrection(text) || !isConversationCorrection(text)) return;
  const prior = previousExchangeFrom(history);
  if (!prior.lastResponse) return;
  classified.extractedData.isCorrecting = true;
  const standalone = classified.intent === "intake_text"
    || classified.intent === "intake_file"
    || classified.intent === "journal"
    || classified.intent === "unclear";
  if (!standalone) return;
  classified.intent = "correction";
  classified.confidence = Math.max(classified.confidence, 0.86);
  classified.interpretation = prior.about
    ? `You're correcting the previous exchange about ${prior.about}.`
    : "You're correcting the previous exchange.";
}

function isConversationCorrection(text) {
  return /\b(i meant|not that|i was referring to|the previous)\b/i.test(String(text || ""));
}

const QUESTION_WORD = /^(what|who|when|where|how|which|why|je|nani|lini|wapi|vipi)\b/i;
const CORRECTION_WORD = /\b(no|not|wrong|actually|i meant)\b/i;
const FOLLOW_UP_REFERENCE = /\b(their names|who are they|what are they called|and (?:his|her|their) family)\b/i;

export function rejectsCorrection(text) {
  const value = String(text || "").trim();
  if (!value || CORRECTION_WORD.test(value)) return false;
  if (/\?\s*$/.test(value) || QUESTION_WORD.test(value) || FOLLOW_UP_REFERENCE.test(value)) return true;
  return false;
}

export function isNoiseReply(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  return /^(taking a moment\b|request failed\b|dira is busy right now\b|dira couldn't take that in\b|the advisor could not answer\b)/i.test(value);
}

function applyAnswerFollowUp(classified, text, history, lastAction, fileAttached) {
  if (fileAttached || rejectsCorrection(text) || !lastResponseWasAnswer(history, lastAction)) return;
  const prior = previousExchangeFrom(history);
  if (!clarifiesPreviousAnswer(text, prior.lastResponse)) return;
  classified.extractedData.isCorrecting = true;
  classified.extractedData.datesMentioned = classified.extractedData.datesMentioned || dateTokens(text).length > 0;
  if (classified.intent === "correction") return;
  if (classified.intent !== "intake_text" && classified.intent !== "unclear" && classified.intent !== "journal") return;
  classified.intent = "correction";
  classified.confidence = Math.max(classified.confidence, 0.88);
  classified.interpretation = prior.about
    ? `You're correcting the previous answer about ${prior.about}.`
    : "You're correcting the previous answer.";
}

function lastResponseWasAnswer(history, lastAction) {
  const prior = previousExchangeFrom(history);
  if (!prior.lastResponse) return false;
  if (/^title:|save it\?/im.test(prior.lastResponse)) return false;
  if (lastAction?.intent === "question") return true;
  if (lastAction?.intent === "correction" && !/confirm\?|shall i /i.test(prior.lastResponse)) return true;
  if (lastAction?.intent) return false;
  return /\?/.test(prior.priorUser) || /^(how|what|when|where|why|which|who|did|have|has|is|am|can|could)\b/i.test(prior.priorUser.trim());
}

function clarifiesPreviousAnswer(text, lastResponse) {
  const trimmed = String(text || "").trim();
  if (!trimmed || isFreshQuestion(trimmed)) return false;
  if (CURRENT_FACT.test(trimmed)) return wordCount(trimmed) <= 40;
  if (LEADING_CUE.test(trimmed)) return !looksLikeNewEvent(trimmed) || CURRENT_FACT.test(trimmed);
  if (ANSWER_CUE.test(trimmed) && wordCount(trimmed) <= 16 && !looksLikeNewEvent(trimmed)) return true;
  return wordCount(trimmed) <= 16 && !looksLikeNewEvent(trimmed) && contradictsAnswer(trimmed, lastResponse);
}

function isFreshQuestion(text) {
  if (CURRENT_FACT.test(text)) return false;
  const rest = text.replace(/^(but|actually|no|wait|and)[,:\s]+/i, "").trim();
  if (/\?\s*$/.test(text) && !dateTokens(text).length) return true;
  return /^(how|what|when|where|why|which|who|did|have|has|is|am|can|could)\b/i.test(rest);
}

function contradictsAnswer(text, lastResponse) {
  const followDates = dateTokens(text);
  const answerDates = dateTokens(lastResponse);
  if (followDates.length && answerDates.some((date) => !followDates.includes(date)) && followDates.some((date) => !answerDates.includes(date))) {
    return true;
  }
  if (followDates.length) return true;
  const answerNumbers = new Set(numberTokens(lastResponse));
  return numberTokens(text).some((value) => value.length >= 2 && !answerNumbers.has(value));
}

function dateTokens(text) {
  const source = String(text || "").toLowerCase();
  const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
    new RegExp(`\\b(?:${months})\\b(?:\\s+\\d{1,2})?(?:,?\\s+\\d{4})?`, "g"),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${months})\\b`, "g"),
    /\b(?:19|20)\d{2}\b/g,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)\b/g,
  ];
  const found = patterns.flatMap((pattern) => source.match(pattern) || []);
  return [...new Set(found.map((item) => item.replace(/\s+/g, " ").trim()))];
}

function numberTokens(text) {
  return [...new Set((String(text || "").match(/\d[\d,.]*/g) || []).map((item) => item.replace(/,/g, "")))];
}

function looksLikeNewEvent(text) {
  return /\b(i bought|i purchased|i paid|i spent|i sold|i signed|i met|i went|receipt|invoice)\b/i.test(text);
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

const ANSWER_CUE = /\b(but|actually|no|wait)\b/i;
const LEADING_CUE = /^(but|actually|no|wait)\b/i;
const CURRENT_FACT = /\b(today is|it is now|it'?s now|currently)\b/i;

function conversationItems(history) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
    .filter((item) => item.role !== "assistant" || !isNoiseReply(item.content))
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 1200) }));
}

function conversationBlock(history) {
  const items = conversationItems(history);
  if (!items.length) return "conversationHistory: none";
  return [
    "conversationHistory:",
    ...items.map((item) => `${item.role === "assistant" ? "DIRA" : "User"}: ${item.content.slice(0, 500)}`),
  ].join("\n");
}

function aboutFrom(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  const title = source.match(/^Title:\s*(.+)$/m);
  if (title) return title[1].trim().slice(0, 180);
  const line = source.split("\n").map((part) => part.trim()).find(Boolean) || "";
  return line.replace(/\s*Save it\??\s*$/i, "").slice(0, 180);
}

function labelFor(intent) {
  if (intent === "intake_file") return "Read an attached file.";
  if (intent === "intake_text") return "Save something that happened.";
  if (intent === "question") return "Answer a question.";
  if (intent === "command") return "Change something already saved.";
  if (intent === "journal") return "Keep a reflection.";
  if (intent === "correction") return "Correct the last thing.";
  return "This could be read more than one way.";
}

function parseJson(text) {
  const source = stripThink(String(text || ""));
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    return JSON.parse(fenced ? fenced[1] : source);
  } catch {
    return null;
  }
}

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

const FACT_CATEGORIES = new Set(["person", "date", "place", "event", "financial", "relationship"]);
const FACT_PROMPT = `Extract any specific biographical or life facts from this message. Return JSON:
{ "facts": [{ "fact": string, "category": "person" | "date" | "place" | "event" | "financial" | "relationship", "suggestedTitle": string, "confidence": 0-1 }] }
A relationship fact uses suggestedTitle like "Link: Sigrún — sister of you".
Only return facts that are specific and saveable.
Names, dates, and places are facts.
Opinions and questions are not facts.
Return { "facts": [] } if nothing specific.`;

export async function extractConversationalFacts(message) {
  const text = String(message || "").trim();
  if (text.length < 12) return [];
  let parsed = [];
  try {
    const raw = await completeFacts(text.slice(0, 4000));
    parsed = parseFactList(raw).filter((fact) => fact.confidence > 0.75);
  } catch (err) {
    console.error("[router] fact extract failed:", err.message);
  }
  const facts = (parsed.length ? parsed : heuristicFacts(text)).slice(0, 2);
  console.log("[router] conversational facts:", facts.length);
  return facts;
}

async function completeFacts(text) {
  const openaiKey = usableKey(process.env.OPENAI_API_KEY);
  if (openaiKey) {
    const client = new OpenAI({ apiKey: openaiKey, timeout: 12000 });
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FACT_PROMPT },
        { role: "user", content: text },
      ],
    });
    return response.choices?.[0]?.message?.content || "";
  }
  const key = usableKey(process.env.GROQ_API_KEY);
  if (!key) return "{\"facts\":[]}";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: `${FACT_PROMPT}\nReturn JSON only.` },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Groq fact status ${response.status}`);
  const data = await response.json();
  return stripThink(data.choices?.[0]?.message?.content || "");
}

function parseFactList(raw) {
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.facts) ? parsed.facts : [];
  return list.map(normalizeConversationalFact).filter(Boolean);
}

function normalizeConversationalFact(item) {
  if (!item || typeof item !== "object") return null;
  const fact = textOr(item.fact || item.content || item.summary, "").replace(/\s+/g, " ").slice(0, 160);
  const category = factCategory(item.category || item.factType);
  const stated = Number(item.confidence);
  const confidence = Number.isFinite(stated) ? clamp(stated) : fact && category ? 0.85 : 0;
  if (!fact || !category || confidence <= 0.75) return null;
  const suggestedTitle = textOr(item.suggestedTitle || item.suggestedEventTitle || item.title, fact).replace(/\s+/g, " ").slice(0, 80);
  return { fact, category, suggestedTitle, confidence };
}

function factCategory(value) {
  const raw = String(value || "").toLowerCase();
  if (FACT_CATEGORIES.has(raw)) return raw;
  if (raw === "relationship" || raw === "link") return "relationship";
  if (/(person|people|family|child|daughter|son)/.test(raw)) return "person";
  if (/(date|birth|birthday|time)/.test(raw)) return "date";
  if (/(place|location|city)/.test(raw)) return "place";
  if (/(money|financial|cost|payment)/.test(raw)) return "financial";
  if (/(event|asset|decision)/.test(raw)) return "event";
  return "";
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const STOP_NAME = new Set(["our", "my", "the", "a", "an", "her", "his", "their", "daughter", "son", "child", "wife", "husband", "born", "was", "were", "in", "at", "on"]);

function heuristicFacts(text) {
  const link = text.match(/\b([A-Z][\p{L}'’-]{2,})\s+is my\s+(sister|brother|mother|father|wife|husband|son|daughter)\b/u);
  if (link) {
    return [{
      fact: `${link[1]} is my ${link[2]}`,
      category: "relationship",
      suggestedTitle: `Link: ${link[1]} — ${link[2]} of you`,
      confidence: 0.9,
    }];
  }
  const dated = text.match(new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,)?\\s+\\d{4}\\b|\\b\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}\\b`, "i"));
  const monthDay = text.match(new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"));
  const year = text.match(/\b(?:19|20)\d{2}\b/);
  const when = (dated?.[0] || (monthDay && year ? `${monthDay[0].replace(/(\d)(st|nd|rd|th)/i, "$1")}, ${year[0]}` : "")).trim();
  const life = /\b(born|birth|died|married|moved|bought|purchased|paid|signed)\b/i.test(text)
    || /\b(?:got|had)\s+(?:our|my)\s+(?:daughter|son|child)\b/i.test(text);
  if (!when || !life) return [];
  const name = properName(text);
  const place = text.match(/\b(?:in|at)\s+([A-Z][\p{L}'’-]{2,}(?:\s+[A-Z][\p{L}'’-]{2,}){0,2})/u);
  const where = place?.[1] && !/^\d/.test(place[1]) ? place[1] : "";
  const fact = [[name, bornVerb(text), when].filter(Boolean).join(" "), where].filter(Boolean).join(", ").slice(0, 160);
  if (fact.length < 12) return [];
  return [{ fact, category: "event", suggestedTitle: fact.slice(0, 80), confidence: 0.9 }];
}

function properName(text) {
  const child = text.match(/\b(?:daughter|son|child|wife|husband)\s+([A-Z][\p{L}'’-]{2,})/u);
  if (child && !STOP_NAME.has(child[1].toLowerCase())) return child[1];
  const beforeBorn = text.match(/\b([A-Z][\p{L}'’-]{2,})\b(?=[^.?!]{0,40}\bborn\b)/u);
  if (beforeBorn && !STOP_NAME.has(beforeBorn[1].toLowerCase())) return beforeBorn[1];
  const words = text.match(/\b[A-Z][\p{L}'’-]{2,}\b/gu) || [];
  return words.find((word) => !STOP_NAME.has(word.toLowerCase()) && !/^(January|February|March|April|May|June|July|August|September|October|November|December)$/.test(word)) || "";
}

function bornVerb(text) {
  if (/\bborn\b|\bbirth\b/i.test(text) || /\b(?:got|had)\s+(?:our|my)\s+(?:daughter|son|child)\b/i.test(text)) return "born";
  if (/\bdied\b/i.test(text)) return "died";
  if (/\bmarried\b/i.test(text)) return "married";
  if (/\bmoved\b/i.test(text)) return "moved";
  if (/\bbought\b|\bpurchased\b/i.test(text)) return "bought";
  if (/\bpaid\b/i.test(text)) return "paid";
  if (/\bsigned\b/i.test(text)) return "signed";
  return "";
}

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_")) return null;
  return key;
}

function textOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}
