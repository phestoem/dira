import { randomUUID } from "crypto";
import OpenAI from "openai";
import { prisma } from "../prisma.js";

const MODEL = "gpt-4o-mini";
const PENDING_TTL_MS = 5 * 60 * 1000;
const pending = new Map();

const CLASSIFY_PROMPT = `You are the command interpreter for DIRA, a personal
intelligence system. The user has typed a natural
language command or question. Classify what they want.
Return JSON:
{
  intentType: 'query' | 'correction' | 'action' |
              'link' | 'search' | 'clarify',

  query: {
    entities: string[],
    filters: {
      location?: string,
      timeframe?: string,
      space?: string,
      status?: string,
      eventType?: string
    },
    aggregation?: string,
    includeRelated?: string[]
  } | null,

  correction: {
    findText: string,
    replaceText: string,
    scope: string,
    recordType: 'event' | 'entity' | 'vision' | 'all'
  } | null,

  action: {
    verb: string,
    target: string,
    value?: string
  } | null,

  confidence: number,
  needsClarification: string | null
}

Examples:
'Change Ntagha to Ntabha in Mbeya land' →
  intentType: correction
  correction: { findText: 'Ntagha', replaceText: 'Ntabha',
                scope: 'Mbeya land', recordType: 'all' }
'Which projects completed last year in Mbeya' →
  intentType: query
  query: { entities: ['projects'],
           filters: { location: 'Mbeya',
                     timeframe: 'last year',
                     status: 'completed' },
           aggregation: 'list' }
'When was I in Mbeya for Ntabha purchase,
 include Mbeya repair cost' →
  intentType: query
  query: { entities: ['Ntabha purchase', 'Mbeya repair'],
           filters: { location: 'Mbeya' },
           aggregation: 'list',
           includeRelated: ['costs', 'dates'] }
'Mark Tuliza Nafsi landscaping as complete' →
  intentType: action
  action: { verb: 'mark', target: 'Tuliza Nafsi landscaping',
            value: 'completed' }`;

const STOP = new Set([
  "the", "a", "an", "in", "on", "of", "for", "and", "or", "to", "from", "with",
  "my", "me", "i", "was", "were", "is", "are", "what", "when", "where", "which",
  "who", "how", "did", "do", "does", "include", "including", "about", "show",
  "list", "find", "events", "event", "projects", "project", "visions", "vision",
  "people", "person", "cost", "costs", "date", "dates", "last", "this", "year",
  "yesterday", "today", "completed", "complete", "active", "are", "any", "all",
  "into", "mark", "move", "change", "much", "many",
]);

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const EVENT_SELECT = {
  id: true,
  title: true,
  understoodMeaning: true,
  eventType: true,
  space: true,
  status: true,
  occurredAt: true,
  createdAt: true,
  completedAt: true,
  financials: true,
  people: true,
  places: true,
  tags: true,
  notes: true,
};

const ENTITY_SELECT = {
  id: true,
  name: true,
  entityType: true,
  description: true,
  aliases: true,
  attributes: true,
  space: true,
  status: true,
};

const VISION_SELECT = {
  id: true,
  title: true,
  summary: true,
  notes: true,
  status: true,
  space: true,
  tags: true,
  connectedEntities: true,
  attributes: true,
  lastTouchedAt: true,
};

export async function interpretCommand(input, userId) {
  const text = String(input || "").trim();
  if (!text) throw httpError("Tell DIRA what you want", 400);
  if (text.length > 2000) throw httpError("That command is too long", 400);

  const classified = await classifyIntent(text);
  console.log("[command]", classified.intentType, text.slice(0, 120));

  if (shouldClarify(classified)) {
    return {
      commandId: null,
      intentType: "clarify",
      confidence: classified.confidence,
      needsClarification: classified.needsClarification || "Which record should I use?",
      confirmationRequired: false,
    };
  }

  if (classified.intentType === "query" || classified.intentType === "search") {
    const query = classified.query || {
      entities: [text],
      filters: {},
      aggregation: "list",
      includeRelated: [],
    };
    const executed = await executeQuery(query, userId, text);
    return {
      commandId: null,
      intentType: "query",
      confidence: classified.confidence,
      needsClarification: null,
      confirmationRequired: false,
      answer: executed.summary,
      summary: executed.summary,
      results: executed.results,
      count: executed.count,
    };
  }

  if (classified.intentType === "correction") {
    const correction = normalizeCorrection(classified.correction);
    if (!correction) {
      return clarifyResult(classified.confidence, "What should I change, and what should it become?");
    }
    const previewed = await executeCorrection(correction, userId);
    if (!previewed.preview.length) {
      return {
        commandId: null,
        intentType: "correction",
        confidence: classified.confidence,
        needsClarification: `I couldn't find “${correction.findText}” in your records.`,
        confirmationRequired: false,
        preview: [],
      };
    }
    const commandId = remember(userId, {
      kind: "correction",
      correction,
      ids: previewed.preview.map((item) => item.id),
    });
    return {
      commandId,
      intentType: "correction",
      confidence: classified.confidence,
      needsClarification: null,
      confirmationRequired: true,
      preview: previewed.preview,
    };
  }

  const action = normalizeAction(classified);
  if (!action) {
    return clarifyResult(classified.confidence, classified.needsClarification || "What should I change?");
  }
  const previewed = await executeAction(action, userId);
  if (previewed.needsClarification || !previewed.preview.length) {
    return {
      commandId: null,
      intentType: classified.intentType === "link" ? "link" : "action",
      confidence: classified.confidence,
      needsClarification: previewed.needsClarification || `I couldn't find “${action.target}”.`,
      confirmationRequired: false,
      preview: [],
    };
  }
  const commandId = remember(userId, {
    kind: "action",
    plan: previewed.plan,
    ids: previewed.preview.map((item) => item.id),
  });
  return {
    commandId,
    intentType: classified.intentType === "link" ? "link" : "action",
    confidence: classified.confidence,
    needsClarification: null,
    confirmationRequired: true,
    preview: previewed.preview,
  };
}

export async function confirmCommand(commandId, confirmed, affectedIds, userId) {
  const payload = takePending(commandId, userId);
  if (!payload) throw httpError("That command expired. Ask again.", 404);
  if (confirmed !== true) return { success: true, changes: [] };

  const ids = Array.isArray(affectedIds) && affectedIds.length ? affectedIds : payload.ids;
  if (payload.kind === "correction") {
    const result = await executeCorrection_confirm(payload.correction, ids, userId);
    console.log("[command] confirmed correction:", result.changes.length);
    return result;
  }
  const result = await applyActionPlan(payload.plan, ids, userId);
  console.log("[command] confirmed action:", result.changes.length);
  return result;
}

export async function askCommand(input, userId) {
  const result = await interpretCommand(input, userId);
  if (result.answer) return result.answer;
  if (result.needsClarification) return result.needsClarification;
  if (result.preview?.length) {
    const lines = result.preview.map((item) => `${item.title}: ${item.change}`);
    return `I'll make these changes after you confirm. ${lines.join(" ")}`;
  }
  return "I couldn't answer that from your records.";
}

export async function executeQuery(query, userId, originalInput = "") {
  const filters = query?.filters && typeof query.filters === "object" ? query.filters : {};
  const entities = Array.isArray(query?.entities) ? query.entities.map((item) => String(item)) : [];
  const source = originalInput || entities.join(", ");
  const flags = queryFlags(entities, source);
  const timeframe = parseCommandTimeframe(filters.timeframe);
  const location = textOrNull(filters.location);
  const space = normalizeSpace(filters.space);
  const status = normalizeStatus(filters.status);
  const eventType = normalizeEventType(filters.eventType);
  const termGroups = termGroupsFrom(entities, location);
  const searchAll = !flags.projects && !flags.visions && !flags.people && !flags.events;
  const namedEvents = flags.events || flags.projects;
  const namedEntities = flags.people || flags.projects;
  const namedVisions = flags.visions;

  const [events, entitiesFound, visions] = await Promise.all([
    searchAll || namedEvents
      ? searchEvents(userId, {
          termGroups,
          location,
          timeframe,
          space,
          status,
          eventType,
          projectsOnly: flags.projects && !flags.events,
          allowBroad: namedEvents,
        })
      : [],
    searchAll || namedEntities
      ? searchEntities(userId, {
          termGroups,
          location,
          space,
          status: entityStatus(status),
          entityType: flags.projects ? "project" : flags.people && !searchAll ? "person" : null,
          allowBroad: namedEntities,
        })
      : [],
    searchAll || namedVisions
      ? searchVisions(userId, {
          termGroups,
          location,
          timeframe,
          space,
          status: visionStatus(status),
          allowBroad: namedVisions,
        })
      : [],
  ]);

  const highlight = [...new Set(termGroups.flat().concat(location ? [location] : []))].filter(Boolean).slice(0, 6).join(" ");
  const results = [
    ...events.map((event) => presentEventResult(event, highlight)),
    ...entitiesFound.map(presentEntityResult),
    ...visions.map(presentVisionResult),
  ];
  const totals = totalsByCurrency(events);
  const aggregation = ["list", "count", "sum"].includes(query?.aggregation) ? query.aggregation : "list";
  const summary = await summarize(source, query, results, totals, aggregation);
  console.log("[command] query results:", results.length);
  return { results, summary, count: results.length };
}

export async function executeCorrection(correction, userId) {
  const found = await collectCorrectionTargets(correction, userId);
  return {
    preview: found.map((item) => ({
      type: item.model,
      id: item.id,
      title: item.title,
      change: item.change,
    })),
    confirmationRequired: found.length > 0,
  };
}

export async function executeCorrection_confirm(correction, affectedIds, userId) {
  const wanted = new Set((affectedIds || []).filter((id) => typeof id === "string"));
  const found = await collectCorrectionTargets(correction, userId);
  const changes = [];
  for (const item of found) {
    if (wanted.size && !wanted.has(item.id)) continue;
    await prisma[item.model].update({ where: { id: item.id }, data: item.data });
    changes.push(`${item.title}: ${item.change}`);
  }
  return { success: true, changes };
}

export async function executeAction(action, userId) {
  const verb = String(action?.verb || "").toLowerCase();
  const target = textOrNull(action?.target) || "";
  const value = textOrNull(action?.value) || "";

  if (verb === "link") return planLink(userId, target, value);
  if (verb === "merge") return planMerge(userId, target, value);
  if (!target) {
    return { preview: [], plan: [], needsClarification: "What should I change?", confirmationRequired: false };
  }

  if (verb === "move") {
    const space = normalizeSpace(value);
    if (!space) {
      return {
        preview: [],
        plan: [],
        needsClarification: "Which space should I move it to? Personal, family, professional, or vision.",
        confirmationRequired: false,
      };
    }
    const matches = await findNamedRecords(userId, target, ["event", "vision", "entity"]);
    return planPatches(matches, (match) => ({
      data: { space },
      change: `Move to ${space}`,
      title: match.title,
    }));
  }

  if (verb === "archive" || verb === "delete") {
    const matches = await findNamedRecords(userId, target, ["event", "vision", "entity"]);
    return planPatches(matches, (match) => ({
      data: { status: "archived" },
      change: "Archive",
      title: match.title,
    }));
  }

  const matches = await findNamedRecords(userId, target, ["event", "vision", "entity"]);
  const usable = [];
  for (const match of matches) {
    const status = statusFor(match.model, value || "active");
    if (!status) continue;
    const data = { status };
    if (match.model === "event" && status === "completed") data.completedAt = match.record.completedAt || new Date();
    if (match.model === "vision") data.lastTouchedAt = new Date();
    usable.push({
      ...match,
      data,
      change: `Mark as ${status}`,
    });
  }
  if (!usable.length) {
    return {
      preview: [],
      plan: [],
      needsClarification: matches.length
        ? `I found “${target}”, but “${value || "that status"}” doesn't fit it.`
        : null,
      confirmationRequired: false,
    };
  }
  return {
    preview: usable.map(previewFromMatch),
    plan: usable.map(planFromMatch),
    needsClarification: null,
    confirmationRequired: true,
  };
}

async function applyActionPlan(plan, affectedIds, userId) {
  const wanted = new Set((affectedIds || []).filter((id) => typeof id === "string"));
  const changes = [];
  for (const op of plan || []) {
    if (wanted.size && !wanted.has(op.id)) continue;
    if (op.op === "patch") {
      const existing = await prisma[op.model].findFirst({ where: { id: op.recordId, userId } });
      if (!existing) continue;
      await prisma[op.model].update({ where: { id: op.recordId }, data: op.data });
      changes.push(`${op.title}: ${op.change}`);
      continue;
    }
    if (op.op === "link") {
      const [from, to] = await Promise.all([
        prisma.entity.findFirst({ where: { id: op.fromId, userId } }),
        prisma.entity.findFirst({ where: { id: op.toId, userId } }),
      ]);
      if (!from || !to || from.id === to.id) continue;
      const duplicate = await prisma.relationship.findFirst({
        where: {
          userId,
          fromEntityId: from.id,
          toEntityId: to.id,
          relationshipType: op.relationshipType,
        },
      });
      if (!duplicate) {
        await prisma.relationship.create({
          data: {
            userId,
            fromEntityId: from.id,
            toEntityId: to.id,
            relationshipType: op.relationshipType,
          },
        });
      }
      changes.push(`${from.name} → ${to.name}: ${op.change}`);
      continue;
    }
    if (op.op === "merge") {
      const [keep, drop] = await Promise.all([
        prisma.entity.findFirst({ where: { id: op.keepId, userId, status: { not: "archived" } } }),
        prisma.entity.findFirst({ where: { id: op.dropId, userId, status: { not: "archived" } } }),
      ]);
      if (!keep || !drop || keep.id === drop.id) continue;
      const aliases = [...new Set([...(keep.aliases || []), drop.name, ...(drop.aliases || [])])];
      await prisma.entity.update({ where: { id: keep.id }, data: { aliases } });
      await prisma.entity.update({ where: { id: drop.id }, data: { status: "archived" } });
      changes.push(`${op.change}`);
    }
  }
  return { success: true, changes };
}

async function classifyIntent(input) {
  const hints = hintFilters(input);
  try {
    const parsed = await classifyWithModel(input);
    return enrichClassification(parsed, hints);
  } catch (err) {
    console.error("[command] classifier fallback:", err.message);
    return heuristicClassify(input, hints);
  }
}

async function classifyWithModel(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const client = new OpenAI({ apiKey, timeout: 12000 });
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLASSIFY_PROMPT },
      { role: "user", content: input },
    ],
  });
  const parsed = parseJsonContent(response.choices?.[0]?.message?.content || "");
  if (!parsed || typeof parsed !== "object") throw new Error("The model did not return a command");
  return normalizeClassification(parsed);
}

function enrichClassification(classified, hints) {
  if (classified.intentType !== "query" && classified.intentType !== "search") return classified;
  const query = classified.query || { entities: [], filters: {}, aggregation: "list", includeRelated: [] };
  const filters = query.filters && typeof query.filters === "object" ? query.filters : {};
  query.filters = {
    location: textOrNull(filters.location) || hints.location,
    timeframe: textOrNull(filters.timeframe) || hints.timeframe,
    space: textOrNull(filters.space) || hints.space,
    status: textOrNull(filters.status) || hints.status,
    eventType: textOrNull(filters.eventType) || hints.eventType,
  };
  if (!Array.isArray(query.entities) || query.entities.length === 0) query.entities = hints.entities;
  if (!query.aggregation) query.aggregation = hints.aggregation;
  if (!Array.isArray(query.includeRelated) || query.includeRelated.length === 0) {
    query.includeRelated = hints.includeRelated;
  }
  classified.query = query;
  return classified;
}

function heuristicClassify(input, hints) {
  const trimmed = input.trim();
  const change = trimmed.match(/^change\s+(.+?)\s+to\s+(.+?)(?:\s+in\s+(.+))?$/i);
  if (change) {
    return {
      intentType: "correction",
      query: null,
      correction: {
        findText: change[1].trim(),
        replaceText: change[2].trim(),
        scope: change[3] ? change[3].trim() : "all",
        recordType: "all",
      },
      action: null,
      confidence: 0.62,
      needsClarification: null,
    };
  }
  const mark = trimmed.match(/^mark\s+(.+?)\s+as\s+(.+)$/i);
  if (mark) return actionIntent("mark", mark[1], mark[2]);
  const move = trimmed.match(/^move\s+(.+?)\s+to\s+(.+)$/i);
  if (move) return actionIntent("move", move[1], move[2]);
  const archive = trimmed.match(/^(archive|delete)\s+(.+)$/i);
  if (archive) return actionIntent(archive[1].toLowerCase() === "delete" ? "delete" : "archive", archive[2], "");
  const link = trimmed.match(/^link\s+(.+?)\s+(?:to|and|with)\s+(.+?)(?:\s+as\s+(.+))?$/i);
  if (link) return actionIntent("link", `${link[1].trim()} to ${link[2].trim()}`, link[3] || "related");
  const merge = trimmed.match(/^merge\s+(.+?)\s+into\s+(.+)$/i);
  if (merge) return actionIntent("merge", merge[1], merge[2]);

  return {
    intentType: "query",
    query: {
      entities: hints.entities.length ? hints.entities : [trimmed],
      filters: {
        location: hints.location,
        timeframe: hints.timeframe,
        space: hints.space,
        status: hints.status,
        eventType: hints.eventType,
      },
      aggregation: hints.aggregation,
      includeRelated: hints.includeRelated,
    },
    correction: null,
    action: null,
    confidence: 0.45,
    needsClarification: null,
  };
}

function actionIntent(verb, target, value) {
  return {
    intentType: verb === "link" ? "link" : "action",
    query: null,
    correction: null,
    action: { verb, target: String(target || "").trim(), value: String(value || "").trim() },
    confidence: 0.62,
    needsClarification: null,
  };
}

async function summarize(source, query, results, totals, aggregation) {
  const compact = results.slice(0, 12).map((result) => ({
    type: result.type,
    title: result.title,
    when: result.when,
    location: result.location,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    detail: result.subtitle,
  }));
  const totalText = Object.entries(totals)
    .map(([currency, amount]) => formatAmount(amount, currency))
    .join(", ");
  const related = Array.isArray(query?.includeRelated) ? query.includeRelated.filter(Boolean).join(", ") : "";
  const prompt = `Answer this query in 2-3 sentences based on these records: ${source}
Classified query: ${JSON.stringify(query)}
Records found: ${JSON.stringify(compact)}
Count: ${results.length}
Totals: ${totalText || "none"}
Aggregation: ${aggregation}
${related ? `Also mention: ${related}` : ""}
Be specific — include dates, amounts, locations.
If nothing was found, say so in one sentence.`;

  try {
    const text = await completeRaw(prompt, "", { temperature: 0.3, max_tokens: 300 });
    if (text) return clipWords(text, 120);
  } catch (err) {
    console.error("[command] summary fallback:", err.message);
  }
  return fallbackSummary(results, totals, aggregation);
}

async function completeRaw(prompt, _unused, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const client = new OpenAI({ apiKey, timeout: 8000 });
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 300,
    messages: [
      { role: "system", content: "Answer in plain text. No JSON." },
      { role: "user", content: prompt },
    ],
  });
  return String(response.choices?.[0]?.message?.content || "").trim();
}

function fallbackSummary(results, totals, aggregation) {
  if (!results.length) return "I don't have a record that matches that.";
  if (aggregation === "count") {
    return results.length === 1 ? `I found 1 record: ${results[0].title}.` : `I found ${results.length} records.`;
  }
  const lead = results.slice(0, 3).map((result) => {
    const bits = [result.title];
    if (result.when) bits.push(result.when);
    if (result.location) bits.push(result.location);
    if (result.amount != null) bits.push(formatAmount(result.amount, result.currency));
    return bits.join(", ");
  });
  const totalText = Object.entries(totals)
    .map(([currency, amount]) => formatAmount(amount, currency))
    .join(", ");
  const sentence = results.length === 1
    ? lead[0]
    : `I found ${results.length} records. ${lead.join(". ")}.`;
  return totalText ? `${sentence} Combined: ${totalText}.` : sentence;
}

async function searchEvents(userId, options) {
  if (!hasQueryConstraint(options) && !options.allowBroad) return [];
  return prisma.event.findMany({
    where: {
      userId,
      ...statusWhere(options.status),
      ...(options.space ? { space: options.space } : {}),
      ...(options.eventType ? { eventType: options.eventType } : {}),
      ...andWhere([
        termFilter("event", options.termGroups, options.location),
        timeframeWhere(options.timeframe, "occurredAt"),
        options.projectsOnly ? projectFilter() : null,
      ]),
    },
    select: EVENT_SELECT,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: 20,
  });
}

async function searchEntities(userId, options) {
  if (!hasQueryConstraint(options) && !options.entityType && !options.allowBroad) return [];
  return prisma.entity.findMany({
    where: {
      userId,
      ...statusWhere(options.status),
      ...(options.space ? { space: options.space } : {}),
      ...(options.entityType ? { entityType: options.entityType } : {}),
      ...andWhere([termFilter("entity", options.termGroups, options.location)]),
    },
    select: ENTITY_SELECT,
    orderBy: { name: "asc" },
    take: 20,
  });
}

async function searchVisions(userId, options) {
  if (!hasQueryConstraint(options) && !options.allowBroad) return [];
  return prisma.vision.findMany({
    where: {
      userId,
      ...statusWhere(options.status),
      ...(options.space ? { space: options.space } : {}),
      ...andWhere([
        termFilter("vision", options.termGroups, options.location),
        timeframeWhere(options.timeframe, "lastTouchedAt"),
      ]),
    },
    select: VISION_SELECT,
    orderBy: { lastTouchedAt: "desc" },
    take: 20,
  });
}

function hasQueryConstraint(options) {
  return Boolean(
    options.termGroups?.length ||
      options.location ||
      options.timeframe ||
      options.status ||
      options.space ||
      options.eventType ||
      options.projectsOnly,
  );
}

function statusWhere(status) {
  if (status === "archived") return { status: "archived" };
  if (status) return { status };
  return { status: { not: "archived" } };
}

function timeframeWhere(timeframe, field) {
  if (!timeframe) return null;
  const range = { gte: timeframe.start, lt: timeframe.end };
  return {
    OR: [
      { [field]: range },
      { AND: [{ [field]: null }, { createdAt: range }] },
    ],
  };
}

function termFilter(kind, termGroups, location) {
  const parts = [];
  if (location) parts.push(wordMatch(kind, location));
  if (termGroups?.length) {
    parts.push({
      OR: termGroups.map((words) => ({
        AND: words.map((word) => wordMatch(kind, word)),
      })),
    });
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { AND: parts };
}

function projectFilter() {
  return {
    OR: [
      { eventType: "project_update" },
      { title: { contains: "project", mode: "insensitive" } },
      { understoodMeaning: { contains: "project", mode: "insensitive" } },
      { tags: { hasSome: ["project", "Project"] } },
    ],
  };
}

function andWhere(parts) {
  const and = parts.filter(Boolean);
  return and.length ? { AND: and } : {};
}

function wordMatch(kind, word) {
  const forms = matchForms(word);
  if (kind === "event") {
    return {
      OR: [
        { title: { contains: word, mode: "insensitive" } },
        { understoodMeaning: { contains: word, mode: "insensitive" } },
        { notes: { contains: word, mode: "insensitive" } },
        { fullText: { contains: word, mode: "insensitive" } },
        ...forms.map((form) => ({ places: { string_contains: form } })),
        ...forms.map((form) => ({ people: { string_contains: form } })),
        ...forms.map((form) => ({ financials: { string_contains: form } })),
        { tags: { hasSome: forms } },
      ],
    };
  }
  if (kind === "entity") {
    return {
      OR: [
        { name: { contains: word, mode: "insensitive" } },
        { description: { contains: word, mode: "insensitive" } },
        { aliases: { hasSome: forms } },
        ...forms.map((form) => ({ attributes: { string_contains: form } })),
      ],
    };
  }
  return {
    OR: [
      { title: { contains: word, mode: "insensitive" } },
      { summary: { contains: word, mode: "insensitive" } },
      { notes: { contains: word, mode: "insensitive" } },
      { tags: { hasSome: forms } },
      ...forms.map((form) => ({ connectedEntities: { string_contains: form } })),
    ],
  };
}

function matchForms(word) {
  const value = String(word || "").trim();
  const lower = value.toLowerCase();
  const titled = lower ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : value;
  return [...new Set([value, lower, titled, value.toUpperCase()].filter(Boolean))];
}

async function loadInOrder(model, userId, rows, select) {
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const records = await prisma[model].findMany({ where: { userId, id: { in: ids } }, select });
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function collectCorrectionTargets(correction, userId) {
  const types = recordTypes(correction.recordType);
  const words = scopeWords(correction.scope);
  const groups = await Promise.all(
    types.map(async (model) => {
      const ids = await idsContaining(model, userId, correction.findText);
      const select = model === "event" ? EVENT_SELECT : model === "entity" ? ENTITY_SELECT : VISION_SELECT;
      const records = await loadInOrder(model, userId, ids.map((id) => ({ id })), select);
      return records
        .filter((record) => matchesScope(record, words))
        .map((record) => replacementFor(model, record, correction.findText, correction.replaceText))
        .filter(Boolean);
    }),
  );
  return groups.flat();
}

async function idsContaining(model, userId, needle) {
  return findMatchingIds(model, userId, [needle], 40);
}

function replacementFor(model, record, findText, replaceText) {
  const next = {};
  const fields = [];
  if (model === "event") {
    assignIfChanged(next, fields, record, "title", replaceValue(record.title, findText, replaceText));
    assignIfChanged(next, fields, record, "understoodMeaning", replaceValue(record.understoodMeaning, findText, replaceText));
    assignIfChanged(next, fields, record, "notes", replaceValue(record.notes, findText, replaceText));
    assignIfChanged(next, fields, record, "people", replaceDeep(record.people, findText, replaceText));
    assignIfChanged(next, fields, record, "places", replaceDeep(record.places, findText, replaceText));
    assignIfChanged(next, fields, record, "financials", replaceDeep(record.financials, findText, replaceText));
    assignIfChanged(next, fields, record, "tags", replaceDeep(record.tags, findText, replaceText));
  } else if (model === "entity") {
    assignIfChanged(next, fields, record, "name", replaceValue(record.name, findText, replaceText));
    assignIfChanged(next, fields, record, "description", replaceValue(record.description, findText, replaceText));
    assignIfChanged(next, fields, record, "aliases", replaceDeep(record.aliases, findText, replaceText));
    assignIfChanged(next, fields, record, "attributes", replaceDeep(record.attributes, findText, replaceText));
  } else {
    assignIfChanged(next, fields, record, "title", replaceValue(record.title, findText, replaceText));
    assignIfChanged(next, fields, record, "summary", replaceValue(record.summary, findText, replaceText));
    assignIfChanged(next, fields, record, "notes", replaceValue(record.notes, findText, replaceText));
    assignIfChanged(next, fields, record, "tags", replaceDeep(record.tags, findText, replaceText));
    assignIfChanged(next, fields, record, "connectedEntities", replaceDeep(record.connectedEntities, findText, replaceText));
    assignIfChanged(next, fields, record, "attributes", replaceDeep(record.attributes, findText, replaceText));
  }
  if (!fields.length) return null;
  const title = model === "entity" ? record.name : record.title;
  return {
    model,
    id: record.id,
    title,
    change: `${findText} → ${replaceText} in ${fields.join(", ")}`,
    data: next,
  };
}

async function findNamedRecords(userId, target, models) {
  const groups = await Promise.all(models.map((model) => searchNamed(userId, target, model)));
  const scored = groups.flat().filter((item) => item.score >= 40);
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter((item) => item.score >= top - 15).slice(0, 5);
}

async function searchNamed(userId, target, model) {
  const words = significantWords(target);
  if (!words.length) return [];
  const ids = await idsMatchingWords(model, userId, words);
  const select = model === "event" ? EVENT_SELECT : model === "entity" ? ENTITY_SELECT : VISION_SELECT;
  const records = await loadInOrder(model, userId, ids.map((id) => ({ id })), select);
  return records.map((record) => {
    const title = model === "entity" ? record.name : record.title;
    return { model, id: record.id, title, record, score: scoreName(title, target) };
  });
}

async function idsMatchingWords(model, userId, words) {
  return findMatchingIds(model, userId, words, 20);
}

async function findMatchingIds(model, userId, words, take) {
  const rows = await prisma[model].findMany({
    where: {
      userId,
      status: { not: "archived" },
      AND: words.map((word) => wordMatch(model, word)),
    },
    select: { id: true },
    take,
  });
  return rows.map((row) => row.id);
}

async function planLink(userId, target, value) {
  const pair = splitPair(target);
  if (!pair) {
    return {
      preview: [],
      plan: [],
      needsClarification: "Which two records should I link?",
      confirmationRequired: false,
    };
  }
  const [from, to] = await Promise.all([
    findBestEntity(userId, pair[0]),
    findBestEntity(userId, pair[1]),
  ]);
  if (!from || !to) {
    return {
      preview: [],
      plan: [],
      needsClarification: "I need both people or places to already exist before I can link them.",
      confirmationRequired: false,
    };
  }
  if (from.id === to.id) {
    return {
      preview: [],
      plan: [],
      needsClarification: "Those look like the same record.",
      confirmationRequired: false,
    };
  }
  const relationshipType = (value || "related").slice(0, 40);
  const id = `${from.id}:${to.id}`;
  return {
    preview: [{
      type: "relationship",
      id,
      title: `${from.name} → ${to.name}`,
      change: `Link as ${relationshipType}`,
    }],
    plan: [{
      op: "link",
      id,
      fromId: from.id,
      toId: to.id,
      relationshipType,
      change: `Link as ${relationshipType}`,
    }],
    needsClarification: null,
    confirmationRequired: true,
  };
}

async function planMerge(userId, target, value) {
  const pair = splitPair(`${target} into ${value}`) || splitPair(target);
  const keepName = pair ? pair[1] : value;
  const dropName = pair ? pair[0] : target;
  if (!keepName || !dropName) {
    return {
      preview: [],
      plan: [],
      needsClarification: "Which record should I merge, and which name should I keep?",
      confirmationRequired: false,
    };
  }
  const [drop, keep] = await Promise.all([
    findBestEntity(userId, dropName),
    findBestEntity(userId, keepName),
  ]);
  if (!drop || !keep) {
    return {
      preview: [],
      plan: [],
      needsClarification: "I couldn't find both records to merge.",
      confirmationRequired: false,
    };
  }
  if (drop.id === keep.id) {
    return {
      preview: [],
      plan: [],
      needsClarification: "Those look like the same record.",
      confirmationRequired: false,
    };
  }
  const id = `${drop.id}:${keep.id}`;
  const change = `Merge ${drop.name} into ${keep.name} and archive ${drop.name}`;
  return {
    preview: [{ type: "entity", id, title: keep.name, change }],
    plan: [{ op: "merge", id, keepId: keep.id, dropId: drop.id, change }],
    needsClarification: null,
    confirmationRequired: true,
  };
}

async function findBestEntity(userId, name) {
  const matches = await findNamedRecords(userId, name, ["entity"]);
  return matches[0]?.record || null;
}

function planPatches(matches, build) {
  if (!matches.length) {
    return { preview: [], plan: [], needsClarification: null, confirmationRequired: false };
  }
  const prepared = matches.map((match) => ({ ...match, ...build(match) }));
  return {
    preview: prepared.map(previewFromMatch),
    plan: prepared.map(planFromMatch),
    needsClarification: null,
    confirmationRequired: true,
  };
}

function previewFromMatch(match) {
  return { type: match.model, id: match.id, title: match.title, change: match.change };
}

function planFromMatch(match) {
  return {
    op: "patch",
    id: match.id,
    model: match.model,
    recordId: match.id,
    title: match.title,
    change: match.change,
    data: match.data,
  };
}

export function parseCommandTimeframe(phrase, now = new Date()) {
  const text = String(phrase || "").trim().toLowerCase();
  if (!text) return null;
  if (text === "yesterday") return dayRange(addDays(startOfDay(now), -1));
  if (text === "today") return dayRange(startOfDay(now));
  if (text === "last year") return yearRange(now.getFullYear() - 1);
  if (text === "this year") return yearRange(now.getFullYear());
  if (/^(19|20)\d{2}$/.test(text)) return yearRange(Number(text));

  const monthYear = text.match(/^([a-z]+)\s+((?:19|20)\d{2})$/);
  if (monthYear && monthYear[1] in MONTHS) {
    return monthRange(Number(monthYear[2]), MONTHS[monthYear[1]]);
  }
  if (text in MONTHS) return monthRange(now.getFullYear(), MONTHS[text]);
  return null;
}

function hintFilters(input) {
  const text = input.toLowerCase();
  const locationMatch = input.match(/\bin\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/);
  const known = input.match(/\b(Tanzania|Zanzibar|Mbeya|Dar|Helsinki|Finland|Jambiani|Arusha|Nairobi|Ntabha)\b/i);
  return {
    location: locationMatch?.[1] || known?.[1] || null,
    timeframe: detectTimeframe(text),
    space: ["personal", "family", "professional", "vision"].find((space) => new RegExp(`\\b${space}\\b`).test(text)) || null,
    status: detectStatus(text),
    eventType: null,
    aggregation: /\bhow many\b|\bcount\b/.test(text) ? "count" : /\b(total|sum|combined)\b/.test(text) ? "sum" : "list",
    includeRelated: [
      /\b(cost|costs|amount|amounts)\b/.test(text) ? "costs" : null,
      /\b(date|dates|when)\b/.test(text) ? "dates" : null,
    ].filter(Boolean),
    entities: hintEntities(input),
  };
}

function detectTimeframe(text) {
  if (text.includes("yesterday")) return "yesterday";
  if (/\btoday\b/.test(text)) return "today";
  if (text.includes("last year")) return "last year";
  if (text.includes("this year")) return "this year";
  const monthYear = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+((?:19|20)\d{2})\b/);
  if (monthYear) return `${monthYear[1]} ${monthYear[2]}`;
  const year = text.match(/\b((?:19|20)\d{2})\b/);
  if (year) return year[1];
  const month = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (month) return month[1];
  return null;
}

function detectStatus(text) {
  if (/\b(completed|complete|done)\b/.test(text)) return "completed";
  if (/\barchived?\b/.test(text)) return "archived";
  if (/\bcancelled\b|\bcanceled\b/.test(text)) return "cancelled";
  if (/\bactive\b/.test(text)) return "active";
  return null;
}

function hintEntities(input) {
  const stripped = input
    .replace(/\b(last year|this year|yesterday|today)\b/gi, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(19|20)\d{2}\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, " ");
  const chunks = stripped.split(/\s*(?:,|;|\band\b|\binclude\b|\bincluding\b)\s*/i);
  const entities = [];
  for (const chunk of chunks) {
    const words = chunk.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const kept = words.filter((word) => word.length >= 3 && !STOP.has(word.toLowerCase()));
    if (kept.length) entities.push(kept.join(" "));
  }
  return entities.slice(0, 6);
}

function queryFlags(entities, source) {
  const blob = `${entities.join(" ")} ${source}`.toLowerCase();
  return {
    projects: /\bprojects?\b/.test(blob),
    visions: /\bvisions?\b/.test(blob),
    people: /\b(people|person|persons)\b/.test(blob),
    events: /\bevents?\b/.test(blob),
  };
}

function termGroupsFrom(entities, location) {
  const locationKey = (location || "").toLowerCase();
  const groups = [];
  for (const entity of entities) {
    const words = significantWords(entity).filter((word) => word.toLowerCase() !== locationKey);
    if (words.length) groups.push(words);
  }
  return groups.slice(0, 6);
}

function significantWords(value) {
  return (String(value).match(/[A-Za-z][A-Za-z'-]*/g) || [])
    .filter((word) => word.length >= 3 && !STOP.has(word.toLowerCase()));
}

function presentEventResult(event, highlight = "") {
  const financials = isPlainObject(event.financials) ? event.financials : {};
  const amount = numberOrNull(financials.amount);
  const currency = textOrNull(financials.currency);
  const location = placeName(event.places);
  const when = formatWhen(event.occurredAt || event.createdAt);
  const query = highlight ? `?q=${encodeURIComponent(highlight)}` : "";
  return {
    type: "event",
    id: event.id,
    title: event.title,
    subtitle: [when, location, amount != null ? formatAmount(amount, currency) : null].filter(Boolean).join(" · ") || event.status,
    href: `/events/${event.id}${query}`,
    status: event.status,
    space: event.space,
    location,
    when,
    amount,
    currency,
    occurredAt: event.occurredAt,
  };
}

function presentEntityResult(entity) {
  return {
    type: "entity",
    id: entity.id,
    title: entity.name,
    subtitle: [entity.entityType, entity.status].filter(Boolean).join(" · "),
    href: `/entities/${entity.id}`,
    status: entity.status,
    space: entity.space,
    location: null,
    when: null,
    amount: null,
    currency: null,
  };
}

function presentVisionResult(vision) {
  const location = visionLocation(vision);
  return {
    type: "vision",
    id: vision.id,
    title: vision.title,
    subtitle: [vision.status, location].filter(Boolean).join(" · "),
    href: `/visions/${vision.id}`,
    status: vision.status,
    space: vision.space,
    location,
    when: formatWhen(vision.lastTouchedAt),
    amount: null,
    currency: null,
  };
}

function totalsByCurrency(events) {
  const totals = {};
  for (const event of events) {
    const financials = isPlainObject(event.financials) ? event.financials : {};
    const amount = numberOrNull(financials.amount);
    if (amount == null) continue;
    const currency = textOrNull(financials.currency) || "TSH";
    totals[currency] = (totals[currency] || 0) + amount;
  }
  return totals;
}

function normalizeClassification(parsed) {
  const allowed = new Set(["query", "correction", "action", "link", "search", "clarify"]);
  const intentType = allowed.has(parsed.intentType) ? parsed.intentType : "query";
  return {
    intentType,
    query: isPlainObject(parsed.query) ? parsed.query : null,
    correction: isPlainObject(parsed.correction) ? parsed.correction : null,
    action: isPlainObject(parsed.action) ? parsed.action : null,
    confidence: clampConfidence(parsed.confidence),
    needsClarification: cleanClarification(parsed.needsClarification),
  };
}

function normalizeCorrection(correction) {
  if (!correction) return null;
  const findText = textOrNull(correction.findText);
  const replaceText = typeof correction.replaceText === "string" ? correction.replaceText.trim() : "";
  if (!findText || findText.length < 2 || !replaceText || findText.toLowerCase() === replaceText.toLowerCase()) {
    return null;
  }
  return {
    findText,
    replaceText,
    scope: textOrNull(correction.scope) || "all",
    recordType: textOrNull(correction.recordType) || "all",
  };
}

function normalizeAction(classified) {
  if (classified.intentType === "link") {
    const action = classified.action || {};
    const target = textOrNull(action.target) || "";
    return { verb: "link", target, value: textOrNull(action.value) || "related" };
  }
  const action = classified.action;
  if (!action) return null;
  const verb = String(action.verb || "").toLowerCase();
  if (!["mark", "move", "archive", "link", "merge", "delete"].includes(verb)) return null;
  return { verb, target: textOrNull(action.target) || "", value: textOrNull(action.value) || "" };
}

function shouldClarify(classified) {
  if (classified.intentType === "clarify") return true;
  if (!classified.needsClarification) return false;
  return classified.confidence < 0.4 && classified.intentType !== "query" && classified.intentType !== "search";
}

function clarifyResult(confidence, question) {
  return {
    commandId: null,
    intentType: "clarify",
    confidence,
    needsClarification: question,
    confirmationRequired: false,
  };
}

function remember(userId, payload) {
  sweep();
  const commandId = randomUUID();
  pending.set(commandId, { userId, expiresAt: Date.now() + PENDING_TTL_MS, payload });
  return commandId;
}

function takePending(commandId, userId) {
  sweep();
  const entry = pending.get(commandId);
  if (!entry || entry.userId !== userId) return null;
  pending.delete(commandId);
  return entry.payload;
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

function recordTypes(value) {
  const text = String(value || "all").toLowerCase();
  if (text === "event" || text === "events") return ["event"];
  if (text === "entity" || text === "entities") return ["entity"];
  if (text === "vision" || text === "visions") return ["vision"];
  return ["event", "entity", "vision"];
}

function scopeWords(scope) {
  if (!scope || scope.toLowerCase() === "all") return [];
  return scope
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function matchesScope(record, words) {
  if (!words.length) return true;
  const blob = JSON.stringify(record).toLowerCase();
  return words.every((word) => blob.includes(word));
}

function assignIfChanged(next, fields, record, field, value) {
  if (JSON.stringify(value) === JSON.stringify(record[field])) return;
  next[field] = value;
  fields.push(field);
}

function replaceValue(value, findText, replaceText) {
  if (typeof value !== "string") return value;
  return value.replace(new RegExp(escapeRegExp(findText), "gi"), () => replaceText);
}

function replaceDeep(value, findText, replaceText) {
  if (typeof value === "string") return replaceValue(value, findText, replaceText);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, findText, replaceText));
  if (isPlainObject(value)) {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = replaceDeep(item, findText, replaceText);
    return next;
  }
  return value;
}

function statusFor(model, value) {
  const aliases = {
    complete: "completed",
    completed: "completed",
    done: "completed",
    finished: "completed",
    active: "active",
    cancel: "cancelled",
    cancelled: "cancelled",
    canceled: "cancelled",
    dormant: "dormant",
    archive: "archived",
    archived: "archived",
    release: "released",
    released: "released",
    seed: "seed",
    forming: "forming",
    held: "held",
  };
  let status = aliases[String(value || "").toLowerCase()] || String(value || "").toLowerCase();
  if (model === "vision" && status === "completed") status = "active";
  if (model === "entity" && (status === "completed" || status === "cancelled")) status = "dormant";
  const allowed = {
    event: ["active", "completed", "cancelled", "dormant", "archived"],
    vision: ["seed", "forming", "held", "active", "released", "archived"],
    entity: ["active", "dormant", "archived"],
  };
  return allowed[model]?.includes(status) ? status : null;
}

function entityStatus(status) {
  if (status === "active" || status === "dormant" || status === "archived") return status;
  return null;
}

function visionStatus(status) {
  if (["seed", "forming", "held", "active", "released", "archived"].includes(status)) return status;
  return null;
}

function normalizeSpace(value) {
  const text = String(value || "").toLowerCase();
  return ["personal", "family", "professional", "vision"].includes(text) ? text : null;
}

function normalizeStatus(value) {
  const text = String(value || "").toLowerCase();
  const map = {
    complete: "completed",
    completed: "completed",
    done: "completed",
    active: "active",
    cancelled: "cancelled",
    canceled: "cancelled",
    dormant: "dormant",
    archived: "archived",
  };
  return map[text] || null;
}

function normalizeEventType(value) {
  const text = String(value || "").toLowerCase();
  if (text === "project") return "project_update";
  const allowed = ["project_update", "financial", "personal", "family", "commitment", "milestone", "setback", "social", "health"];
  return allowed.includes(text) ? text : null;
}

function scoreName(name, target) {
  const left = String(name || "").toLowerCase();
  const right = String(target || "").toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;
  const words = significantWords(right);
  if (!words.length) return 0;
  const hits = words.filter((word) => left.includes(word.toLowerCase())).length;
  return Math.round((hits / words.length) * 60);
}

function splitPair(text) {
  const match = String(text || "").match(/^(.+?)\s+(?:to|and|with|into)\s+(.+)$/i);
  if (!match) return null;
  return [match[1].trim(), match[2].trim()];
}

function placeName(places) {
  const list = Array.isArray(places) ? places : [];
  const named = list.find((place) => place && typeof place.name === "string" && place.name.trim());
  return named ? named.name.trim() : null;
}

function visionLocation(vision) {
  const list = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  const place = list.find((item) => item && (item.role === "location" || item.relationship === "location") && item.name);
  return place?.name ? String(place.name) : null;
}

function formatWhen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatAmount(amount, currency) {
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
  return currency ? `${formatted} ${currency}` : formatted;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dayRange(start) {
  return { start, end: addDays(start, 1) };
}

function yearRange(year) {
  return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}

function monthRange(year, month) {
  return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
}

function clipWords(text, max) {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  return `${words.slice(0, max).join(" ")}…`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonContent(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : String(text);
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function cleanClarification(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampConfidence(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
