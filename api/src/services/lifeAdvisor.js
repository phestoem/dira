import OpenAI from "openai";
import { prisma } from "../prisma.js";
import { resolveEntity } from "./graph/entityResolver.js";
import { getFamilyTree, getSubgraph, serializeForPrompt } from "./graph/graphQuery.js";
import { isNoiseReply } from "./intentRouter.js";
import { peopleEngine } from "./graph/engine.js";
import { allowedFrom, answerWithTools, groundToolReply } from "./graph/peopleTools.js";
import { notePath } from "../metrics.js";
import { answerPeopleQuestion, contextualQuestion, deliverPeopleAnswer, isPeopleQuestion, loadPeopleContext, PEOPLE_PROMPT, peopleContextBlock, usesRecordedAnswer } from "./graph/peopleGrounding.js";

const GROQ_MODEL = "qwen/qwen3.8-27b";
const FACT_MODEL = "gpt-4o-mini";
const BUSY = "DIRA is busy right now. Send that again.";
const FACT_TYPES = new Set(["financial", "person", "place", "decision", "date", "asset", "other"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const ADVISOR_ROLE = `You are DIRA's life advisor — an intelligent assistant
that knows this person's life operations deeply.

You have access to their:
- Recent events and activities
- Active visions and plans
- Journal entries (treated with discretion)
- Key people, places, and projects
- Financial activity

Your role:
- Answer questions about their life and data precisely
- Help them think through decisions and plans
- Surface connections they might not see
- Be direct and specific — you have real data, use it
- Recommend concrete next steps when asked
- Never make up data — only reference what you can see
- Never state a name, date, relationship or place about a person
  unless it appears in the provided context.
  If it isn't recorded, say "not recorded yet".
- Suggested connections may be mentioned only as "unconfirmed: …", never as fact.

Your responses:
- Match the format to the question
  (one line for simple facts, paragraphs for analysis,
   lists for options or action items)
- Be conversational but substantive
- Reference specific data points naturally
  ('your Coimbra land purchase in July',
   'the 12,450 EUR roof repair')
- Connect dots across different areas when relevant`;

const FORMAT_RULES = `RESPONSE FORMAT RULES — follow these precisely:

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
- Ask whether to add, save, record, note, or remember an event.
  Never end with "Would you like me to make a note",
  "Should I add", or any permission question about saving.
  Answer the person and continue the conversation.
  A separate control offers to save a fact.

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

export async function chat(messages, userId) {
  const history = normalizeMessages(messages);
  const userTurns = history.filter((message) => message.role === "user");
  const latest = userTurns.at(-1)?.content || "";
  const priorAnswer = [...history].reverse().find((message) => message.role === "assistant" && !isNoiseReply(message.content))?.content || "";
  // Tools engine: the model reads the conversation and picks tools itself; no question wording is parsed here.
  if (peopleEngine() === "tools") {
    const answered = await answerWithTools(userId, history).catch((err) => {
      console.error("[advisor] tools answer failed:", err.message);
      return null;
    });
    if (answered) {
      notePath("tools", { rounds: answered.rounds, tools: answered.toolsUsed });
      return { reply: answered.reply, contextUsed: { eventsCount: 0, visionsCount: 0, entitiesCount: 0, tools: answered.toolsUsed } };
    }
  }
  const question = contextualQuestion(latest, userTurns.at(-2)?.content || "", priorAnswer);
  if (peopleEngine() !== "tools" && isPeopleQuestion(question)) {
    const answered = await answerPeople(userId, question);
    return { reply: answered.reply, contextUsed: { eventsCount: 0, visionsCount: 0, entitiesCount: answered.sourceIds.length } };
  }
  const context = await loadContext(userId);
  const graph = await graphContext(userId, latest);
  context.graphLines = graph.lines;
  context.familyLines = graph.family;
  context.holdingLines = HOLDINGS_QUESTION.test(latest) ? await holdingLines(userId) : [];
  const system = buildSystemPrompt(context);
  let reply = await completeChat(history, system);
  if (peopleEngine() === "tools") {
    // The agent needed no tool, so the old advisor answered; its names and dates are still checked, against
    // everything it was shown.
    const checked = groundToolReply(reply, allowedFrom([context, latest], latest));
    notePath("fallback", { removed: checked.removed.length });
    reply = checked.reply || "I couldn't find that in your records.";
  } else {
    notePath("model");
  }
  console.log(
    "[advisor] chat",
    context.events.length,
    "events",
    context.visions.length,
    "visions",
    context.entities.length,
    "entities",
  );
  return {
    reply,
    contextUsed: {
      eventsCount: context.events.length,
      visionsCount: context.visions.length,
      entitiesCount: context.entities.length,
    },
  };
}

const FACT_PROMPT = `You are a fact detector for a personal intelligence
system. Read this message and extract any significant
facts the person has shared about their life.

A significant fact is:
- A financial amount with context
  (cost, payment, debt, income)
- A date or timeframe tied to an event
- A person mentioned with their role or relationship
- A decision made or planned
- A property, place, or asset described
- A quantity or measurement

Return JSON array (empty if nothing significant):
[{
  factType: 'financial' | 'person' | 'place' |
            'decision' | 'date' | 'asset' | 'other',
  content: string,  // the fact in plain English, max 100 chars
  confidence: number, // 0-1
  suggestedEventTitle: string | null
}]

Only return facts the PERSON stated — not things
the advisor said. Return [] if nothing significant.
Keep confidence below 0.7 for vague mentions.
For a person, suggestedEventTitle is their name.
For any other fact, suggestedEventTitle is a short event title, or null.
Never extract journal entries or private reflections.
The journal is sealed and is not a source of facts.`;

export async function detectSignificantFacts(userMessage, userId) {
  const text = typeof userMessage === "string" ? userMessage.trim() : "";
  if (text.length < 8) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith("your_")) return [];

  const client = new OpenAI({ apiKey, timeout: 12000 });
  const response = await client.chat.completions.create({
    model: FACT_MODEL,
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: "system", content: FACT_PROMPT },
      { role: "user", content: text.slice(0, 4000) },
    ],
  });
  const facts = parseFacts(response.choices?.[0]?.message?.content || "")
    .filter((fact) => fact.confidence >= 0.7)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3);
  console.log("[advisor] facts", userId, facts.length);
  return facts;
}

export async function suggest(userId) {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [events, visions] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { title: true, places: true },
    }),
    prisma.vision.findMany({
      where: { userId, status: { in: ["seed", "forming", "active"] } },
      orderBy: { lastTouchedAt: "desc" },
      take: 3,
      select: { title: true, tags: true, connectedEntities: true },
    }),
  ]);

  const focus = visions[0]?.title || events[0]?.title || null;
  const place = firstLocation(events) || firstVisionLocation(visions);
  const pool = [
    "What should I focus on this week?",
    focus ? `Help me plan the next phase of ${focus}` : "Help me plan the next phase of what I'm building",
    place ? `How am I tracking against my ${place} timeline?` : "How am I tracking against my plans?",
    events[0] ? `What does ${events[0].title} change for the rest of this month?` : "What changed for me this month?",
    visions[1] ? `How does ${visions[1].title} connect to what I'm doing now?` : "What connections am I missing?",
  ];
  const unique = [...new Set(pool)];
  const start = dayIndex(unique.length);
  return [0, 1, 2].map((offset) => unique[(start + offset) % unique.length]);
}

async function loadContext(userId) {
  const now = Date.now();
  const [events, financialEvents, visions, journal, entities, user] = await Promise.all([
    prisma.event.findMany({
      where: {
        userId,
        status: { not: "archived" },
      },
      orderBy: [
        { occurredAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: 30,
      select: {
        title: true,
        eventType: true,
        space: true,
        occurredAt: true,
        createdAt: true,
        understoodMeaning: true,
        financials: true,
        people: true,
        places: true,
        tags: true,
        fullText: true,
      },
    }),
    prisma.event.findMany({
      where: {
        userId,
        status: { not: "archived" },
      },
      select: {
        title: true,
        occurredAt: true,
        createdAt: true,
        financials: true,
      },
    }),
    prisma.vision.findMany({
      where: { userId, status: { in: ["seed", "forming", "active"] } },
      orderBy: { lastTouchedAt: "desc" },
      take: 5,
      select: { title: true, status: true, tags: true, connectedEntities: true },
    }),
    prisma.diaryEntry.findMany({
      where: { userId, createdAt: { gte: new Date(now - 7 * DAY_MS) } },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { understoodThemes: true },
    }),
    prisma.entity.findMany({
      where: { userId, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, name: true, entityType: true, description: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { altimetrixUserId: true },
    }),
  ]);

  const entityNames = new Map(entities.map((entity) => [entity.id, entity.name]));
  const missing = [];
  for (const vision of visions) {
    const ref = locationRef(vision);
    if (ref?.entityId && !ref.name && !entityNames.has(ref.entityId)) missing.push(ref.entityId);
  }
  if (missing.length) {
    const extra = await prisma.entity.findMany({
      where: { userId, id: { in: [...new Set(missing)] } },
      select: { id: true, name: true },
    });
    for (const entity of extra) entityNames.set(entity.id, entity.name);
  }

  return {
    events,
    financialEvents,
    visions,
    themes: [...new Set(journal.flatMap((entry) => entry.understoodThemes || []))],
    entities,
    entityNames,
    altimetrixLinked: Boolean(user?.altimetrixUserId),
  };
}

function buildSystemPrompt(context) {
  const eventLimit = (context.graphLines || []).length > 20 ? 8 : context.events.length;
  const lines = context.events.slice(0, eventLimit).map(buildEventContext);
  const visionLines = context.visions.map((vision) => formatVision(vision, context.entityNames));
  const entityLines = context.entities.map((entity) => {
    const description = clip(entity.description, 140);
    return [entity.name, entity.entityType, description].filter(Boolean).join(" | ");
  });
  const financials = financialPicture(context.financialEvents);
  const coverage = context.financialEvents.length > lines.length
    ? `\nShowing the ${lines.length} most recent of ${context.financialEvents.length} events. The financial totals below include every recorded event.`
    : "";
  const themes = context.themes.length ? context.themes.join(", ") : "none recorded";
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `${ADVISOR_ROLE}

You have access to ALL of the user's events.
Use semantic understanding to find relevant ones —
do not rely on exact keyword matching.
'Cusco project' should find events about Cusco
even if the word 'project' doesn't appear.
'car' should find vehicle registration events.
'land' should find property purchase events.
Understand intent, not just keywords.

You have access to structured data AND full document
text for each event. Use ALL of it to answer questions.
If someone asks about plot boundaries, look in the
document content. If they ask about legal conditions,
look in the document content. If they ask about
technical specifications, look in the document content.
The summary is a starting point — the full context
is what matters.

${FORMAT_RULES}

CURRENT DATE: ${today}

LIFE GRAPH CONTEXT:

EVENTS:
${lines.length ? lines.join("\n\n") : "none recorded"}${coverage}

ACTIVE VISIONS:
${visionLines.length ? visionLines.join("\n") : "none"}

KEY ENTITIES:
${entityLines.length ? entityLines.join("\n") : "none"}

RECENT JOURNAL THEMES:
${themes}

RELATIONSHIP GRAPH:
${(context.graphLines || []).length ? context.graphLines.join("\n") : "none confirmed"}

${(context.familyLines || []).length ? `FAMILY:\n${context.familyLines.join("\n")}` : ""}

${(context.holdingLines || []).length ? `PROPERTY RECORDS (every recorded event about land, plots or houses; several records can describe the same place):\n${context.holdingLines.join("\n")}\nWhen asked what properties they have, name each distinct place from these records with its plot number or location. Leave none out.` : ""}

Prefer confirmed graph edges for who-is-connected questions.
Mention when a relationship has ended.
Never state a name, date, relationship or place about a person unless it appears above.
If it isn't recorded, say "not recorded yet".
Never state a suggested edge as fact. Say "unconfirmed: …" when one is useful.
Speak about people who have died in the past tense, and leave them out of upcoming birthdays.

FINANCIAL PICTURE:
${financials}
${context.altimetrixLinked ? "\nNote: This person also uses Altimetrix for personal reflection. Their emotional context is held there, not here." : ""}`;
}

async function graphContext(userId, text) {
  try {
    const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
    const seeds = self ? [{ kind: "entity", id: self.id }] : [];
    const names = [
      ...(String(text).match(/\b(?:my|our)\s+(?:mother|father|wife|husband|sister|brother|son|daughter|mama|baba)\b/gi) || []),
      ...(String(text).match(/\b[A-Z][\p{L}'-]{2,}(?:\s+[A-Z][\p{L}'-]{2,}){0,2}\b/gu) || []),
    ].slice(0, 6);
    for (const name of names) {
      const resolved = await resolveEntity(userId, { name }, { readOnly: true });
      if (resolved.entity) seeds.push({ kind: "entity", id: resolved.entity.id });
    }
    if (!seeds.length) return { lines: [], family: [] };
    const subgraph = await getSubgraph(userId, seeds, { depth: 2, maxNodes: 60 });
    const family = /\b(family|mother|father|sister|brother|wife|husband|son|daughter|birthday|mama|baba|dada)\b/i.test(text)
      ? familyLines(await getFamilyTree(userId))
      : [];
    return { lines: serializeForPrompt(subgraph, { maxTriples: 40 }), family };
  } catch (err) {
    console.error("[graph] advisor context failed:", err.message);
    return { lines: [], family: [] };
  }
}

async function answerPeople(userId, question) {
  const context = await loadPeopleContext(userId);
  if (usesRecordedAnswer(question, context)) {
    notePath("recorded");
    return { reply: answerPeopleQuestion(question, context), sourceIds: context.facts.map((fact) => `${fact.source.type}:${fact.source.id}`) };
  }
  let modelText = "";
  notePath("model");
  try {
    modelText = await completeChat(
      [{ role: "user", content: question }],
      `${PEOPLE_PROMPT}\n\nCONTEXT:\n${peopleContextBlock(context) || "none recorded"}`,
      { temperature: 0 },
    );
  } catch (err) {
    console.error("[advisor] people answer failed:", err.message);
    return { reply: answerPeopleQuestion(question, context), sourceIds: [] };
  }
  return deliverPeopleAnswer(modelText, context, question);
}

const HOLDINGS_QUESTION = /\b(propert(?:y|ies)|lands?|plots?|houses?|homes|real estate|assets|kiwanja|viwanja|nyumba|mali)\b/i;
const HOLDINGS_EVENT = /\b(plots?|land|house|property|certificate of occupancy|title deed|kiwanja|nyumba|shamba|mauziano)\b/i;

// Property questions see every property record, not just the most recent events.
async function holdingLines(userId) {
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: [{ occurredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: { title: true, occurredAt: true, understoodMeaning: true, rawInput: true },
  });
  return events
    .filter((event) => HOLDINGS_EVENT.test([event.title, event.understoodMeaning, event.rawInput].filter(Boolean).join(" ")))
    .slice(0, 40)
    .map((event) => [
      event.title,
      event.occurredAt ? event.occurredAt.toISOString().slice(0, 10) : "undated",
      clip(event.understoodMeaning, 260),
    ].filter(Boolean).join(" | "));
}

function familyLines(tree) {
  const line = (person) => {
    if (!person?.name) return "";
    const born = person.birthDate ? ` b. ${new Date(person.birthDate).getUTCFullYear()}` : "";
    const died = person.deathDate ? ` d. ${new Date(person.deathDate).getUTCFullYear()}` : "";
    return `${person.name}${born}${died}`;
  };
  const rows = [];
  if (tree.self) rows.push(`Self: ${line(tree.self)}`);
  for (const [label, people] of [["Spouse", tree.spouse], ["Parents", tree.parents], ["Siblings", tree.siblings], ["Children", tree.children]]) {
    const names = (people || []).map(line).filter(Boolean);
    if (names.length) rows.push(`${label}: ${names.join(", ")}`);
  }
  return rows;
}

function buildEventContext(event) {
  const parts = [];
  const financials = event.financials && typeof event.financials === "object" && !Array.isArray(event.financials) ? event.financials : {};
  const money = readMoney(financials);
  const people = Array.isArray(event.people) ? event.people : [];
  const tags = Array.isArray(event.tags) ? event.tags.filter((tag) => typeof tag === "string" && tag.trim()) : [];
  const location = typeof event.location === "string" && event.location.trim()
    ? event.location.trim()
    : placeName(event.places);
  const summary = typeof event.understoodMeaning === "string" ? event.understoodMeaning.trim() : "";
  const fullText = typeof event.fullText === "string" ? event.fullText.replace(/\s+/g, " ").trim() : "";

  parts.push(`Title: ${event.title}`);
  parts.push(`Date: ${formatWhen(event.occurredAt) || "unknown"}`);
  parts.push(`Type: ${event.eventType}`);
  parts.push(`Space: ${event.space}`);
  if (summary) parts.push(`Summary: ${summary.slice(0, 300)}`);
  if (location) parts.push(`Location: ${location}`);

  const namedPeople = people
    .map((person) => {
      if (!person || typeof person !== "object") return "";
      const name = typeof person.name === "string" ? person.name.trim() : "";
      const role = typeof person.role === "string" ? person.role.trim() : "";
      if (!name) return "";
      return role ? `${name} (${role})` : name;
    })
    .filter(Boolean);
  if (namedPeople.length) parts.push(`People involved: ${namedPeople.join(", ")}`);

  if (financials.hasFinancials || money || (Array.isArray(financials.items) && financials.items.length)) {
    if (money) parts.push(`Total: ${formatNumber(money.amount)} ${money.currency}`);
    const items = (Array.isArray(financials.items) ? financials.items : [])
      .slice(0, 10)
      .map((item) => {
        const description = typeof item?.description === "string" && item.description.trim() ? item.description.trim() : "Item";
        const amount = numberOrNull(item?.amount);
        const currency = typeof item?.currency === "string" && item.currency.trim() ? item.currency.trim() : money?.currency || "";
        return amount == null ? `  - ${description}` : `  - ${description}: ${formatNumber(amount)} ${currency}`.trim();
      });
    if (items.length) parts.push(`Line items:\n${items.join("\n")}`);
  }

  if (fullText) parts.push(`Document content: ${fullText.slice(0, 500)}`);
  if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);
  return parts.join("\n");
}

function formatVision(vision, entityNames) {
  const tags = Array.isArray(vision.tags) && vision.tags.length ? vision.tags.join(", ") : null;
  return [vision.title, vision.status, tags, visionLocation(vision, entityNames)].filter(Boolean).join(" | ");
}

function financialPicture(events) {
  const rows = events
    .map((event) => ({ event, money: readMoney(event.financials) }))
    .filter((row) => row.money);
  if (!rows.length) return "Total recorded financial activity: none\nLast 30 days: none";
  const since = Date.now() - 30 * DAY_MS;
  const recent = rows.filter((row) => {
    const when = new Date(row.event.occurredAt || row.event.createdAt).getTime();
    return !Number.isNaN(when) && when >= since;
  });
  const largest = rows.reduce((best, row) => (row.money.amount > best.money.amount ? row : best));
  return [
    `Total recorded financial activity: ${totalsText(rows)}`,
    `Last 30 days: ${recent.length ? totalsText(recent) : "none"}`,
    `Largest: ${largest.event.title} — ${formatNumber(largest.money.amount)} ${largest.money.currency || "TSH"}`,
  ].join("\n");
}

function totalsText(rows) {
  const totals = {};
  for (const row of rows) {
    const currency = row.money.currency || "TSH";
    totals[currency] = (totals[currency] || 0) + row.money.amount;
  }
  return Object.entries(totals)
    .map(([currency, amount]) => `${formatNumber(amount)} ${currency}`)
    .join("; ");
}

function advisorProvider() {
  return String(process.env.ADVISOR_PROVIDER || "openai").trim().toLowerCase() === "groq" ? "groq" : "openai";
}

async function completeChat(messages, systemPrompt, options = {}) {
  const temperature = options.temperature ?? 0.7;
  const provider = advisorProvider();
  try {
    const text = provider === "groq"
      ? await completeWithGroq(messages, systemPrompt, temperature)
      : await completeWithOpenAI(messages, systemPrompt, temperature);
    if (text) return text;
    throw new Error("empty advisor reply");
  } catch (err) {
    if (provider === "openai" && !isRateLimitError(err)) {
      try {
        console.error("[advisor] openai failed, trying groq:", err.message);
        const text = await completeWithGroq(messages, systemPrompt, temperature);
        if (text) return text;
      } catch (fallbackErr) {
        console.error("[advisor] groq fallback failed:", fallbackErr.message);
      }
    }
    throw httpError(BUSY, 503);
  }
}

async function completeWithOpenAI(messages, systemPrompt, temperature) {
  const key = usableKey(process.env.OPENAI_API_KEY);
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const client = new OpenAI({ apiKey: key, timeout: 20000 });
  const response = await client.chat.completions.create({
    model: FACT_MODEL,
    temperature,
    max_tokens: 800,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });
  return stripThink(response.choices?.[0]?.message?.content || "");
}

async function completeWithGroq(messages, systemPrompt, temperature) {
  const key = usableKey(process.env.GROQ_API_KEY);
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: 800,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error(`Groq advisor status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return stripThink(data.choices?.[0]?.message?.content || "");
}

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_")) return null;
  return key;
}

function isRateLimitError(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429) return true;
  return /\b429\b|rate limit/i.test(String(err?.message || ""));
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw httpError("messages is required", 400);
  }
  const cleaned = messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content.trim().slice(0, 4000) : "",
    }))
    .filter((message) => message.content);
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") {
    throw httpError("The latest message must be from you", 400);
  }
  return cleaned.slice(-12);
}

function readMoney(financials) {
  if (!financials || typeof financials !== "object" || Array.isArray(financials)) return null;
  let amount = numberOrNull(financials.amount);
  if (amount == null) amount = numberOrNull(financials.totalAmount);
  if ((amount == null || amount === 0) && Array.isArray(financials.items)) {
    amount = financials.items.reduce((sum, item) => {
      const value = numberOrNull(item?.amount);
      return value == null ? sum : sum + value;
    }, 0);
  }
  if (amount == null || amount === 0) return null;
  const raw = textOr(financials.currency, "TSH").toUpperCase();
  return { amount, currency: raw === "TZS" ? "TSH" : raw };
}

function placeName(places) {
  const list = Array.isArray(places) ? places : [];
  const named = list.find((place) => place && typeof place.name === "string" && place.name.trim());
  return named ? named.name.trim() : null;
}

function locationRef(vision) {
  const list = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  return list.find((item) => item && (item.role === "location" || item.relationship === "location")) || null;
}

function visionLocation(vision, entityNames = new Map()) {
  const place = locationRef(vision);
  if (!place) return null;
  if (typeof place.name === "string" && place.name.trim()) return place.name.trim();
  return entityNames.get(place.entityId) || null;
}

function firstLocation(events) {
  for (const event of events) {
    const name = placeName(event.places);
    if (name) return name;
  }
  return null;
}

function firstVisionLocation(visions) {
  for (const vision of visions) {
    const name = visionLocation(vision);
    if (name) return name;
  }
  return null;
}

function formatWhen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatNumber(amount) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
}

function dayIndex(length) {
  const day = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const char of day) hash = (hash * 31 + char.charCodeAt(0)) % Math.max(length, 1);
  return hash;
}

function bound(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function parseFacts(raw) {
  const text = stripThink(raw);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fenced ? fenced[1] : text).trim();
  let data = parseJson(source);
  if (!data) {
    const start = source.indexOf("[");
    const end = source.lastIndexOf("]");
    if (start !== -1 && end > start) data = parseJson(source.slice(start, end + 1));
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.facts) ? data.facts : [];
  return list.map(normalizeFact).filter(Boolean);
}

function parseJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function normalizeFact(item) {
  if (!item || typeof item !== "object") return null;
  const factType = FACT_TYPES.has(item.factType) ? item.factType : null;
  const content = bound(item.content, 100);
  const confidence = numberOrNull(item.confidence);
  if (!factType || !content || confidence == null) return null;
  const title = bound(item.suggestedEventTitle, 80);
  return {
    factType,
    content,
    confidence: Math.min(1, Math.max(0, confidence)),
    suggestedEventTitle: title,
  };
}

function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
