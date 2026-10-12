import OpenAI from "openai";
import { prisma } from "../prisma.js";

const MODEL = "gpt-4o-mini";
const NUDGE_PROMPT = `Write one gentle sentence asking about this vision. Reference its title and what it's about. Sound like a thoughtful friend, not a system. Max 30 words. Return JSON: { "message": string }`;

export async function checkAndSendNudges(userId) {
  const due = await prisma.vision.findMany({
    where: {
      userId,
      nudgeAfter: { lte: new Date() },
      status: { notIn: ["released", "archived"] },
    },
    orderBy: { nudgeAfter: "asc" },
    take: 8,
  });

  const nudges = [];
  for (const vision of due) {
    try {
      const message = await writeNudge(vision);
      const current = isPlainObject(vision.attributes) ? vision.attributes : {};
      await prisma.vision.update({
        where: { id: vision.id },
        data: {
          attributes: {
            ...current,
            lastNudge: { message, sentAt: new Date().toISOString() },
          },
          nudgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          nudgeCount: { increment: 1 },
        },
      });
      console.log("[nudge] vision:", vision.title);
      nudges.push({ visionId: vision.id, title: vision.title, nudgeMessage: message });
    } catch (err) {
      console.error("[nudge] failed:", vision.title, err.message);
    }
  }
  return nudges;
}

async function writeNudge(vision) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: NUDGE_PROMPT },
      {
        role: "user",
        content: `Title: ${vision.title}\nAbout: ${vision.summary || "No summary yet."}`,
      },
    ],
  });
  const text = response.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const message = typeof parsed?.message === "string" ? parsed.message.trim() : "";
  if (!message) throw new Error("The model did not return a nudge");
  return message.split(/\s+/).slice(0, 30).join(" ");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
