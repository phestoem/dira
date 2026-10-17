// The only routing decision: does a message tell DIRA something (statement), ask something (question), or both
// (mixed)? Statements are always stored, so when in doubt the answer is statement, and a model failure never drops
// a message.
import { jsonCall } from "./model.js";
import { routerModel } from "./settings.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "question"],
  properties: {
    kind: { type: "string", enum: ["statement", "question", "mixed"] },
    // The question to answer, in the user's words; empty for a statement.
    question: { type: "string" },
  },
};

const SYSTEM = `You sort messages a person sends to their personal record keeper.
- statement: the message tells something about their life, people, work, money, property, documents, projects, dates, plans, decisions, or corrects something said before. Requests to note, remember or record something are statements.
- question: the message only asks for information, or is a greeting, thanks or acknowledgement with nothing to record.
- mixed: the message tells something AND asks something.
If unsure between statement and question, choose statement. For question and mixed, copy the question part into "question" (resolve nothing, keep the user's words); otherwise leave it empty.`;

// Without the model: a single sentence ending in "?" is a question; "?" elsewhere makes it mixed; else statement.
export function fallbackKind(text) {
  const sentences = String(text).split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const asks = sentences.filter((part) => part.endsWith("?"));
  if (!asks.length) return { kind: "statement", question: "" };
  if (asks.length === sentences.length) return { kind: "question", question: text.trim() };
  return { kind: "mixed", question: asks.join(" ") };
}

export async function classify(text, history = []) {
  const recent = history.slice(-4).map((turn) => `${turn.role}: ${String(turn.content || "").slice(0, 300)}`).join("\n");
  try {
    const { json } = await jsonCall({
      model: routerModel(),
      name: "route",
      schema: SCHEMA,
      system: SYSTEM,
      user: `${recent ? `Recent conversation:\n${recent}\n\n` : ""}Message:\n${text}`,
      timeoutMs: 12000,
    });
    if (!["statement", "question", "mixed"].includes(json.kind)) return { ...fallbackKind(text), fallback: true };
    return { kind: json.kind, question: json.kind === "statement" ? "" : json.question || text };
  } catch (err) {
    console.error("[knowledge] router fallback:", err.message);
    return { ...fallbackKind(text), fallback: true };
  }
}
