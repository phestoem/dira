// What went wrong with a model call, what to tell the user, and each provider's last success and failure for
// /health. A failed model call must never lose a save or leave a question without a reply.

const state = { openai: { lastOkAt: null, lastError: null }, groq: { lastOkAt: null, lastError: null } };

// no_credit: the account has no credit left (retrying will not help); rate_limit: too many calls right now;
// auth: the key is missing or rejected; timeout; unavailable: anything else (5xx, network, bad reply).
export function modelErrorKind(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  const code = String(err?.code || err?.error?.code || err?.error?.type || "");
  const text = `${code} ${String(err?.message || "")}`;
  if (/insufficient_quota|credit_balance|no credits|billing|quota/i.test(text)) return "no_credit";
  if (status === 429 || /\b429\b|rate limit/i.test(text)) return "rate_limit";
  if (status === 401 || status === 403 || /api key|not set|not configured|unauthori[sz]ed|\b40[13]\b/i.test(text)) return "auth";
  if (/timeout|timed out|abort/i.test(text) || err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return "unavailable";
}

const MESSAGES = {
  no_credit: "AI answers are paused: the model account has no credit left. Your saved records still work.",
  rate_limit: "DIRA is busy right now. Send that again in a minute.",
  auth: "AI answers are unavailable: the model key is missing or was rejected. Your saved records still work.",
  timeout: "The AI took too long to answer. Send that again.",
  unavailable: "AI answers are unavailable right now. Your saved records still work.",
};

export function modelErrorMessage(kind) {
  return MESSAGES[kind] || MESSAGES.unavailable;
}

export function recordModelOk(provider) {
  if (state[provider]) state[provider].lastOkAt = new Date().toISOString();
}

export function recordModelError(provider, err, where = "") {
  const kind = modelErrorKind(err);
  if (state[provider]) state[provider].lastError = { kind, where, at: new Date().toISOString() };
  return kind;
}

// For /health: per provider, last success, last failure and whether the last call failed. No secrets.
export function modelStatus() {
  const out = {};
  for (const [provider, { lastOkAt, lastError }] of Object.entries(state)) {
    const failing = Boolean(lastError && (!lastOkAt || lastError.at > lastOkAt));
    out[provider] = { ok: !failing, lastOkAt, lastError };
  }
  return out;
}

// An error that means "no model could answer", carrying its kind so callers can answer without the model.
export function modelUnavailable(kind, cause) {
  const error = new Error(modelErrorMessage(kind));
  error.statusCode = 503;
  error.modelUnavailable = true;
  error.modelKind = kind;
  error.cause = cause;
  return error;
}

// Endpoints, overridable so dev can point them at a local stub when testing failures.
export function groqChatUrl() {
  return `${String(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "")}/chat/completions`;
}

export function openaiChatUrl() {
  return `${String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
}
