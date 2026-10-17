// One structured model call for the knowledge layer: a JSON schema in, parsed JSON and token usage out.

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_")) return null;
  return key;
}

const reasoning = (model) => /^(gpt-5|o\d)/.test(model);

export async function jsonCall({ model, system, user, schema, name, timeoutMs = 30000 }) {
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
  return { json: JSON.parse(String(data.choices?.[0]?.message?.content || "{}")), usage: data.usage || null, model };
}
