import { AsyncLocalStorage } from "async_hooks";
import { appendFile } from "fs/promises";

// Token and latency logging (docs/PERSONAL_SCOPE.md section 6). Model calls are measured at fetch, so the OpenAI SDK
// (which reads globalThis.fetch when a client is made) and the direct Groq/OpenAI fetches are all covered without
// touching them. Nothing from prompts or answers is kept: only counts, model names, timings, the route pattern and
// the function that made the call.
//
// - one "[tokens]" line per request that used a model, plus one per call that finished after its request answered
//   (background work such as extraction or vision detection);
// - DIRA_TOKEN_LOG=<file>: the same as JSON lines;
// - daily totals (in DIRA_TIME_ZONE, default Europe/Helsinki) logged when the day changes and shown in /health.

const store = new AsyncLocalStorage();
const TIME_ZONE = process.env.DIRA_TIME_ZONE || "Europe/Helsinki";

// A model call is a request to a provider's default host or under a configured base URL (OPENAI_BASE_URL,
// GROQ_BASE_URL), so a stub or proxy on a shared host only counts for its model paths.
function modelUrl(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input?.url || String(input));
    const href = url.href;
    const under = (base) => {
      if (!base) return false;
      const prefix = String(base).replace(/\/$/, "");
      return href === prefix || href.startsWith(`${prefix}/`);
    };
    let provider = null;
    if (url.host === "api.groq.com" || under(process.env.GROQ_BASE_URL)) provider = "groq";
    else if (url.host === "api.openai.com" || under(process.env.OPENAI_BASE_URL)) provider = "openai";
    if (!provider) return null;
    return { provider, endpoint: url.pathname.split("/").filter(Boolean).slice(-2).join("/") };
  } catch {
    return null;
  }
}

// The first frame in our own code (not this file, not node_modules, not Node internals), e.g.
// "intentRouter.js:routeWithModel". Async stack traces carry it through the OpenAI SDK's awaits.
function callerOf(stack) {
  for (const line of String(stack || "").split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("/metrics.js") || line.includes("node:")) continue;
    const match = line.match(/at (?:async )?(?:([\w$.<>]+) )?\(?(?:file:\/\/)?[^()]*\/([^/():]+\.m?js):\d+/);
    if (match) return `${match[2]}:${(match[1] || "anonymous").replace(/^Object\./, "")}`;
  }
  return "unknown";
}

function requestModel(init) {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body).model || null : null;
  } catch {
    return null;
  }
}

function usageOf(data) {
  const usage = data?.usage;
  if (!usage) return { input: null, cached: null, output: null, reasoning: null };
  return {
    input: usage.prompt_tokens ?? usage.input_tokens ?? null,
    cached: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
    output: usage.completion_tokens ?? usage.output_tokens ?? null,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function measuredFetch(input, init) {
  const target = modelUrl(input);
  if (!target) return originalFetch(input, init);
  const caller = callerOf(new Error().stack);
  const startedAt = Date.now();
  const call = { ...target, model: requestModel(init), caller, status: null, ms: null, input: null, cached: null, output: null, reasoning: null };
  try {
    const response = await originalFetch(input, init);
    call.status = response.status;
    if ((response.headers.get("content-type") || "").includes("json")) {
      try {
        const data = await response.clone().json();
        Object.assign(call, usageOf(data));
        if (data?.model) call.model = data.model;
      } catch {
        // Not JSON after all; the call is still counted.
      }
    }
    call.ms = Date.now() - startedAt;
    record(call);
    return response;
  } catch (err) {
    call.status = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network";
    call.ms = Date.now() - startedAt;
    record(call);
    throw err;
  }
};

function record(call) {
  addToDay(call);
  const state = store.getStore();
  if (state && !state.finished) {
    state.calls.push(call);
    return;
  }
  // Outside a request, or after it answered: its own line.
  emit({ kind: "background", route: state?.route || null, ms: call.ms, calls: [call] });
}

// Fastify: call from an onRequest hook; the rest of the request runs inside this measurement.
export function startRequest(request, done) {
  const state = { route: null, method: request.method, startedAt: Date.now(), calls: [], finished: false };
  request.diraMetrics = state;
  store.run(state, done);
}

// Fastify: call from an onResponse hook.
export function finishRequest(request, reply) {
  const state = request.diraMetrics;
  if (!state) return;
  state.finished = true;
  if (!state.calls.length) return;
  state.route = request.routeOptions?.url || request.routerPath || "unknown";
  dayTotals().requests += 1;
  emit({ kind: "request", route: `${state.method} ${state.route}`, status: reply.statusCode, ms: Date.now() - state.startedAt, calls: state.calls });
}

export function totalsOf(calls) {
  const sum = (field) => calls.reduce((total, call) => total + (Number(call[field]) || 0), 0);
  return { calls: calls.length, input: sum("input"), cached: sum("cached"), output: sum("output"), reasoning: sum("reasoning") };
}

function emit(entry) {
  const totals = totalsOf(entry.calls);
  const parts = entry.calls.map((call) =>
    `${call.provider}/${call.model || "?"} ${call.caller} in=${call.input ?? "?"} cached=${call.cached ?? "?"} out=${call.output ?? "?"} reasoning=${call.reasoning ?? "?"} ${call.ms}ms ${call.status}`,
  );
  console.log(
    `[tokens] ${entry.kind === "request" ? `${entry.route} ${entry.status}` : `background${entry.route ? ` after ${entry.route}` : ""}`}` +
      ` ${entry.ms}ms calls=${totals.calls} in=${totals.input} cached=${totals.cached} out=${totals.output} reasoning=${totals.reasoning}` +
      (parts.length ? ` | ${parts.join(" | ")}` : ""),
  );
  writeLine({ at: new Date().toISOString(), ...entry, totals });
}

function writeLine(entry) {
  const file = process.env.DIRA_TOKEN_LOG;
  if (!file) return;
  appendFile(file, `${JSON.stringify(entry)}\n`).catch((err) => console.error("[tokens] could not write", file, err.message));
}

// Daily totals.
let today = null;
let yesterday = null;

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function emptyDay(day) {
  return { day, requests: 0, calls: 0, failed: 0, input: 0, cached: 0, output: 0, reasoning: 0, byModel: {} };
}

function dayTotals() {
  const day = dayKey();
  if (!today) today = emptyDay(day);
  if (today.day !== day) {
    if (today.calls) {
      console.log(`[tokens] day ${today.day} total requests=${today.requests} calls=${today.calls} failed=${today.failed} in=${today.input} cached=${today.cached} out=${today.output} reasoning=${today.reasoning} ${JSON.stringify(today.byModel)}`);
      writeLine({ at: new Date().toISOString(), kind: "day", ...today });
    }
    yesterday = today;
    today = emptyDay(day);
  }
  return today;
}

function addToDay(call) {
  const day = dayTotals();
  const ok = typeof call.status === "number" && call.status < 400;
  day.calls += 1;
  if (!ok) day.failed += 1;
  const key = `${call.provider}/${call.model || "?"}`;
  const model = (day.byModel[key] ||= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });
  model.calls += 1;
  for (const field of ["input", "cached", "output", "reasoning"]) {
    const value = Number(call[field]) || 0;
    day[field] += value;
    model[field] += value;
  }
}

// For /health: today's and yesterday's totals (since this process started).
export function tokenTotals() {
  dayTotals();
  return { timeZone: TIME_ZONE, today, yesterday };
}

// The day total is also written when the day changes with no traffic.
setInterval(() => dayTotals(), 10 * 60 * 1000).unref();
