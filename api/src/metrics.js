import { AsyncLocalStorage } from "async_hooks";

// Per-request measurements for evaluation: model calls made while answering, time taken, and which path answered.
// Model calls are counted at fetch, so every provider client and helper is included without touching them.
const store = new AsyncLocalStorage();
const MODEL_HOSTS = new Set(["api.openai.com", "api.groq.com"]);

const originalFetch = globalThis.fetch;
globalThis.fetch = async function countedFetch(input, init) {
  const metrics = store.getStore();
  if (metrics) {
    try {
      const host = new URL(typeof input === "string" ? input : input?.url || String(input)).host;
      if (MODEL_HOSTS.has(host)) metrics.modelCalls += 1;
    } catch {
      // Not a URL we can read; not a model call.
    }
  }
  return originalFetch(input, init);
};

// Runs the rest of the request inside its own measurement.
export function withMetrics(next) {
  store.run({ startedAt: Date.now(), modelCalls: 0, path: null }, next);
}

// "recorded", "model", "tools", "fallback": what produced the answer.
export function notePath(path, extra = {}) {
  const metrics = store.getStore();
  if (metrics) Object.assign(metrics, { path, ...extra });
}

export function currentMetrics() {
  const metrics = store.getStore();
  if (!metrics) return null;
  const { startedAt, ...rest } = metrics;
  return { ...rest, ms: Date.now() - startedAt };
}
