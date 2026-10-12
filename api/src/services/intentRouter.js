import OpenAI from "openai";
import { prisma } from "../prisma.js";

const OPENAI_MODEL = "gpt-4o-mini";
const GROQ_MODEL = "qwen/qwen3.8-27b";
const INTENTS = new Set([
  "intake_file",
  "intake_text",
  "question",
  "command",
  "journal",
  "correction",
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
- unclear: genuinely ambiguous

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
  }
}

alternatives has at most 2 other readings.

Examples:
'Here is the receipt for Ntabha land purchase' + file
→ intent: intake_file, confidence: 0.95

'How much have I spent in Tanzania this year?'
→ intent: question, confidence: 0.92

'Fix the dates on my events'
→ intent: command, confidence: 0.88

'Today was a good day, I managed to close the deal'
→ intent: journal, confidence: 0.75
   alternative: intake_text (it could be an event)

'I felt really proud of my children today'
→ intent: journal, confidence: 0.90

'The Mbeya electrical cost was 2.4M TSH not 2.3M'
→ intent: correction, confidence: 0.85`;

export async function routeIntent(input, userId, attachedFile) {
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
    classified = await classify(text, snapshot, attachedFile);
  } catch (err) {
    console.error("[router] classifier fallback:", err.message);
    classified = heuristic(text, fileAttached);
  }
  if (fileAttached && (classified.intent === "intake_text" || classified.intent === "unclear")) {
    classified.intent = "intake_file";
    classified.confidence = Math.max(classified.confidence, 0.9);
    classified.extractedData.mentionsFile = true;
  }
  return decide(classified);
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

async function classify(text, snapshot, attachedFile) {
  const user = [
    `File attached: ${attachedFile ? "yes" : "no"}`,
    `Recent events: ${snapshot.recentEvents.join("; ") || "none"}`,
    `Active visions: ${snapshot.activeVisions}`,
    `Recent journal themes: ${snapshot.journalThemes.join(", ") || "none"}`,
    "",
    text,
  ].join("\n");

  const raw = await completeRouter(user);
  const parsed = parseJson(raw);
  if (!parsed) throw new Error("Router did not return JSON");
  return normalize(parsed);
}

async function completeRouter(user) {
  const openaiKey = usableKey(process.env.OPENAI_API_KEY);
  if (openaiKey) {
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
  return completeWithGroq(user);
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
      max_tokens: 500,
      messages: [
        { role: "system", content: `${ROUTER_PROMPT}\nReturn JSON only.` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Groq router status ${response.status}`);
  const data = await response.json();
  return stripThink(data.choices?.[0]?.message?.content || "");
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
  };
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
  if (/\b(no,?\s+that'?s wrong|i meant|not that|you misunderstood)\b/.test(lower) || /\bwas\b.+\bnot\b/.test(lower)) {
    return normalize({
      intent: "correction",
      confidence: 0.72,
      interpretation: "Correct something from the last reply.",
      alternatives: [{ intent: "command", interpretation: "Change a saved record." }],
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
