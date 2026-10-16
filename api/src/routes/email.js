import { createHmac, timingSafeEqual } from "crypto";
import { Readable } from "stream";
import { mkdir, writeFile } from "fs/promises";
import { prisma } from "../prisma.js";
import { isSignificantEvent, sendLifeEvent } from "../services/altimetrixBridge.js";
import { createEventFromUnderstanding, understandFile, understandText } from "../services/contextEngine.js";
import { extractAndLinkEntities } from "./entities.js";

const UPLOAD_DIR = "/tmp/dira-uploads";
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export default async function emailRoutes(fastify) {
  fastify.addHook("preParsing", async (request, _reply, payload) => {
    const chunks = [];
    for await (const chunk of payload) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    request.rawBody = raw.toString("utf8");
    return Readable.from(raw);
  });

  fastify.post("/email/inbound", { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    if (!authorized(request)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const email = await normalizeEmail(request.body || {});
      const user = await identifyUser(email);
      if (!user) {
        console.log("[email-intake] unknown sender:", email.from || "(none)");
        return { received: true };
      }
      if (email.id && (await alreadyQueued(user.id, email.id))) {
        console.log("[email-intake] duplicate:", email.id);
        return { received: true, queued: 0 };
      }

      const staged = await stageEmail(user.id, email);
      console.log("[email-intake] from:", email.from, "queued:", staged.length, "items");
      setImmediate(() => {
        understandStaged(user.id, staged).catch((err) => {
          console.error("[email-intake] understand failed:", err.message);
        });
      });
      return { received: true, queued: staged.length };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Could not receive email" });
    }
  });
}

function authorized(request) {
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV === "production";
  const headerSecret = request.headers["x-webhook-secret"];
  const querySecret = request.query?.secret;
  const provided = typeof headerSecret === "string" ? headerSecret : querySecret;
  if (typeof provided === "string" && safeEqual(provided, expected)) return true;
  return verifySvix(request, expected);
}

function verifySvix(request, secret) {
  const id = request.headers["svix-id"];
  const timestamp = request.headers["svix-timestamp"];
  const signature = request.headers["svix-signature"];
  const raw = request.rawBody;
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || !raw) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) return false;
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(encoded, "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return signature.split(" ").some((part) => {
    const value = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    return safeEqual(value, expected);
  });
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function normalizeEmail(body) {
  if (body?.type === "email.received" && body.data?.email_id) {
    const received = await fetchReceivedEmail(body.data.email_id);
    const data = received || body.data;
    return {
      id: body.data.email_id,
      from: textOf(data.from || body.data.from),
      to: textOf(data.to || body.data.to),
      subject: textOf(data.subject || body.data.subject),
      text: typeof data.text === "string" ? data.text : "",
      html: typeof data.html === "string" ? data.html : "",
      replyTo: addressList(data.reply_to),
      attachments: attachmentList(data.attachments || body.data.attachments, body.data.email_id),
    };
  }

  return {
    id: typeof body.messageId === "string" ? body.messageId : "",
    from: textOf(body.from),
    to: textOf(body.to),
    subject: textOf(body.subject),
    text: typeof body.text === "string" ? body.text : "",
    html: typeof body.html === "string" ? body.html : "",
    replyTo: addressList(body.replyTo || body.reply_to),
    attachments: directAttachments(body.attachments),
  };
}

function attachmentList(value, emailId) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      filename: textOf(item.filename) || "attachment",
      contentType: textOf(item.content_type || item.contentType) || "application/octet-stream",
      contentDisposition: textOf(item.content_disposition || item.contentDisposition),
      size: Number(item.size) || 0,
      buffer: null,
      resend: item.id && emailId ? { emailId, attachmentId: String(item.id) } : null,
    }));
}

function directAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const content = typeof item.content === "string" ? item.content : "";
      const buffer = content ? Buffer.from(content, "base64") : Buffer.alloc(0);
      return {
        filename: textOf(item.filename) || "attachment",
        contentType: textOf(item.contentType || item.content_type) || "application/octet-stream",
        contentDisposition: textOf(item.contentDisposition || item.content_disposition),
        size: buffer.length,
        buffer,
        resend: null,
      };
    });
}

async function fetchReceivedEmail(emailId) {
  const key = usableResendKey();
  if (!key) {
    console.error("[email-intake] RESEND_API_KEY is missing, so the email body cannot be loaded");
    return null;
  }
  const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Resend receiving status ${response.status}`);
  }
  return response.json();
}

async function identifyUser(email) {
  const sender = emailAddress(email.from);
  const direct = sender ? await prisma.user.findFirst({ where: { email: sender } }) : null;
  if (direct) return direct;

  const allowed = sender ? await userAllowing(sender) : null;
  if (allowed) return allowed;

  const body = `${email.text || ""}\n${htmlToText(email.html || "")}`;
  const candidates = [...new Set([...email.replyTo, ...forwardedAddresses(body)])];
  for (const address of candidates) {
    if (address === sender) continue;
    const forwarded = await prisma.user.findFirst({ where: { email: address } });
    if (forwarded) return forwarded;
    const allowedForward = await userAllowing(address);
    if (allowedForward) return allowedForward;
  }
  return null;
}

async function userAllowing(address) {
  try {
    return await prisma.user.findFirst({
      where: {
        settings: {
          path: ["forwardingEmails"],
          array_contains: address,
        },
      },
    });
  } catch (err) {
    console.error("[email-intake] forwarding list lookup failed:", err.message);
    return null;
  }
}

async function alreadyQueued(userId, emailId) {
  const found = await prisma.inputQueue.findFirst({
    where: {
      userId,
      source: "email",
      rawContent: { startsWith: `email-id:${emailId}` },
    },
    select: { id: true },
  });
  return Boolean(found);
}

async function stageEmail(userId, email) {
  const marker = email.id ? `email-id:${email.id}\n` : "";
  const content = `Subject: ${email.subject || "(no subject)"}\n\n${email.text || htmlToText(email.html)}`.trim();
  const staged = [];

  for (const attachment of email.attachments) {
    if (skipAttachment(attachment)) continue;
    const saved = attachment.buffer ? await writeAttachment(attachment.buffer, attachment.filename) : null;
    const queue = await prisma.inputQueue.create({
      data: {
        userId,
        rawContent: `${marker}Attachment: ${attachment.filename}`,
        contentType: attachment.contentType.startsWith("image/") ? "image" : "file",
        source: "email",
        mimeType: attachment.contentType,
        filePath: saved,
        processingStatus: "pending",
      },
    });
    staged.push({
      id: queue.id,
      kind: "file",
      filePath: saved,
      mimeType: attachment.contentType,
      filename: attachment.filename,
      resend: attachment.resend,
    });
  }

  if (content.length > 20) {
    const queue = await prisma.inputQueue.create({
      data: {
        userId,
        rawContent: `${marker}${content}`.slice(0, 100000),
        contentType: "text",
        source: "email",
        processingStatus: "pending",
      },
    });
    staged.push({ id: queue.id, kind: "text", content: content.slice(0, 20000) });
  }

  return staged;
}

function skipAttachment(attachment) {
  if (attachment.size > MAX_ATTACHMENT) {
    console.log("[email-intake] skipping large attachment:", attachment.filename, attachment.size);
    return true;
  }
  const inlineImage = attachment.contentDisposition.toLowerCase() === "inline" && attachment.contentType.startsWith("image/");
  if (inlineImage) {
    console.log("[email-intake] skipping inline image:", attachment.filename);
    return true;
  }
  if (!attachment.buffer && !attachment.resend) return true;
  return false;
}

async function writeAttachment(buffer, filename) {
  if (buffer.length > MAX_ATTACHMENT) {
    console.log("[email-intake] skipping large attachment:", filename, buffer.length);
    return null;
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = `${UPLOAD_DIR}/email-${Date.now()}-${safeFilename(filename)}`;
  await writeFile(filePath, buffer);
  return filePath;
}

async function understandStaged(userId, staged) {
  for (const item of staged) {
    try {
      if (item.kind === "file") {
        const filePath = item.filePath || (await downloadResendAttachment(item));
        if (!filePath) {
          await markFailed(item.id, "Attachment was not saved");
          continue;
        }
        if (!item.filePath) {
          await prisma.inputQueue.update({ where: { id: item.id }, data: { filePath } });
        }
        const result = await understandFile(filePath, item.mimeType, userId);
        await storeUnderstanding(item.id, result);
        await maybeAutoSave(userId, item.id, result);
        continue;
      }
      const result = await understandText(item.content, userId);
      await storeUnderstanding(item.id, result);
      await maybeAutoSave(userId, item.id, result);
    } catch (err) {
      console.error("[email-intake] item failed:", err.message);
      await markFailed(item.id, err.message);
    }
  }
}

async function downloadResendAttachment(item) {
  if (!item.resend) return null;
  const key = usableResendKey();
  if (!key) return null;
  const metaResponse = await fetch(
    `https://api.resend.com/emails/receiving/${item.resend.emailId}/attachments/${item.resend.attachmentId}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
  );
  if (!metaResponse.ok) throw new Error(`Resend attachment status ${metaResponse.status}`);
  const meta = await metaResponse.json();
  if (Number(meta.size) > MAX_ATTACHMENT) {
    console.log("[email-intake] skipping large attachment:", meta.filename || item.filename, meta.size);
    return null;
  }
  if (!meta.download_url) return null;
  const fileResponse = await fetch(meta.download_url, { signal: AbortSignal.timeout(20000) });
  if (!fileResponse.ok) throw new Error(`Attachment download status ${fileResponse.status}`);
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  return writeAttachment(buffer, meta.filename || item.filename);
}

async function storeUnderstanding(queueId, result) {
  await prisma.inputQueue.update({
    where: { id: queueId },
    data: {
      processingStatus: "processing",
      understoodAs: JSON.stringify({
        understood: result.understood,
        suggestedSpace: result.suggestedSpace,
        suggestedEventType: result.suggestedEventType,
        fullText: typeof result.fullText === "string" && result.fullText.trim() ? result.fullText : null,
        sourceFile: typeof result.sourceFile === "string" && result.sourceFile.trim() ? result.sourceFile : null,
      }),
      error: result.understood?.needsClarification || null,
    },
  });
}

async function maybeAutoSave(userId, queueId, result) {
  if (!isRoutineReceipt(result)) return;
  const understood = {
    ...result.understood,
    space: result.suggestedSpace,
    eventType: result.suggestedEventType,
  };
  const queue = await prisma.inputQueue.findFirst({ where: { id: queueId, userId } });
  try {
    const event = await createEventFromUnderstanding(userId, understood, null, true, queueId, {
      fullText: typeof result.fullText === "string" ? result.fullText : null,
      sourceFile: typeof result.sourceFile === "string" ? result.sourceFile : queue?.filePath || null,
    });
    console.log("[email-intake] auto-saved receipt:", event.title);
    setImmediate(() => {
      extractAndLinkEntities(event, userId, understood).catch((err) => {
        console.error("[entity-extract] failed:", err.message);
      });
    });
    setImmediate(async () => {
      try {
        if (!isSignificantEvent(event)) return;
        const user = await prisma.user.findUnique({ where: { id: userId } });
        await sendLifeEvent(event, userId, user);
      } catch (err) {
        console.error("[bridge] error:", err.message);
      }
    });
  } catch (err) {
    console.error("[email-intake] auto-save left for review:", err.message);
  }
}

function isRoutineReceipt(result) {
  const understood = result?.understood;
  if (!understood || understood.needsClarification || result.duplicate) return false;
  if (Number(understood.confidence) < 0.9) return false;
  if (understood.contentType !== "cost_tracking" && understood.contentType !== "budget") return false;
  const financial = understood.financial;
  return Boolean(financial && (financial.hasFinancials || financial.totalAmount));
}

async function markFailed(queueId, message) {
  await prisma.inputQueue.update({
    where: { id: queueId },
    data: {
      processingStatus: "failed",
      error: String(message || "Understanding failed").slice(0, 500),
      processedAt: new Date(),
    },
  });
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function forwardedAddresses(text) {
  const found = [];
  const pattern = /(?:^|\n)\s*From:\s*(.+)/gi;
  let match = pattern.exec(text);
  while (match) {
    const address = emailAddress(match[1]);
    if (address) found.push(address);
    match = pattern.exec(text);
  }
  return found.slice(0, 5);
}

function addressList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.map((item) => emailAddress(item)).filter(Boolean);
}

function emailAddress(value) {
  const match = String(value || "").match(EMAIL_ADDRESS);
  return match ? match[0].toLowerCase() : "";
}

function textOf(value) {
  if (Array.isArray(value)) return value.map((item) => textOf(item)).filter(Boolean).join(", ");
  return typeof value === "string" ? value.trim() : "";
}

function safeFilename(filename) {
  const cleaned = String(filename || "attachment").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return cleaned || "attachment";
}

function usableResendKey() {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.startsWith("your_") || key.startsWith("re_your")) return "";
  return key;
}
