// One structured model call for the knowledge layer: a JSON schema in, parsed JSON and token usage out.

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_")) return null;
  return key;
}

const reasoning = (model) => /^(gpt-5|o\d)/.test(model);

// Token use of one call. Input, cached, output and reasoning are the API's counts. The API gives one input total,
// so it is split over the prompt's parts by their share of the characters sent: instruction (system prompt and
// schema), each named part of the user message, and other (headers and framing). The split is an estimate.
export function callTokens({ name, model, usage, system, schema, user, parts = {} }) {
  const input = usage?.prompt_tokens ?? null;
  const tokens = {
    call: name,
    model,
    input,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    output: usage?.completion_tokens ?? null,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  const chars = { instruction: system.length + JSON.stringify(schema).length };
  for (const [part, text] of Object.entries(parts)) chars[part] = String(text || "").length;
  chars.other = Math.max(0, user.length - Object.entries(parts).reduce((sum, [, text]) => sum + String(text || "").length, 0));
  const total = Object.values(chars).reduce((sum, count) => sum + count, 0);
  const split = {};
  for (const [part, count] of Object.entries(chars)) split[part] = input == null || !total ? null : Math.round((input * count) / total);
  return { ...tokens, split, chars };
}

export async function jsonCall({ model, system, user, schema, name, parts = {}, timeoutMs = 30000 }) {
  const key = usableKey(process.env.OPENAI_API_KEY);
  if (!key) throw new Error("OpenAI key is not configured");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      // Reasoning models (gpt-5*, o*) take an effort instead of a temperature.
      ...(reasoning(model) ? { reasoning_effort: process.env.KNOWLEDGE_REASONING_EFFORT || "low" } : { temperature: 0 }),
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(reasoning(model) ? timeoutMs * 3 : timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`OpenAI ${name} status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const usage = data.usage || null;
  return { json: JSON.parse(String(data.choices?.[0]?.message?.content || "{}")), usage, model, tokens: callTokens({ name, model, usage, system, schema, user, parts }) };
}
