import { Resend } from "resend";
import { prisma } from "../prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BIRTHDAY_WINDOW = 60;
const EVENT_WINDOW = 30;
const APP_URL = "https://dira.qusaz.com";
const FROM = "DIRA <phesto@qusaz.com>";

export async function generateDigest(userId) {
  const today = helsinkiDate(new Date());
  const [events, pendingQueue, visions] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" } },
      select: { title: true, occurredAt: true, dueAt: true, people: true },
    }),
    prisma.inputQueue.count({
      where: { userId, processingStatus: { in: ["pending", "processing"] } },
    }),
    prisma.vision.findMany({
      where: {
        userId,
        status: { notIn: ["released", "archived"] },
        nudgeAfter: { lte: new Date() },
      },
      select: { title: true, lastTouchedAt: true, createdAt: true },
    }),
  ]);

  const upcomingBirthdays = [];
  const upcomingEvents = [];

  for (const event of events) {
    const birthday = birthdayFrom(event, today);
    if (birthday) {
      upcomingBirthdays.push(birthday);
      continue;
    }
    const upcoming = upcomingFrom(event, today);
    if (upcoming) upcomingEvents.push(upcoming);
  }

  upcomingBirthdays.sort((left, right) => left.daysAway - right.daysAway);
  upcomingEvents.sort((left, right) => left.daysAway - right.daysAway);

  const dormantVisions = visions
    .map((vision) => ({
      title: vision.title,
      daysSinceTouch: daysBetween(vision.lastTouchedAt || vision.createdAt, new Date()),
    }))
    .sort((left, right) => right.daysSinceTouch - left.daysSinceTouch);

  const digest = {
    upcomingBirthdays,
    upcomingEvents,
    pendingQueue,
    dormantVisions,
    hasAnything: false,
  };
  digest.hasAnything = Boolean(
    digest.upcomingBirthdays.length || digest.upcomingEvents.length || digest.pendingQueue || digest.dormantVisions.length,
  );
  return digest;
}

export async function sendDigestEmail(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) return { sent: false, sections: [] };
  const digest = await generateDigest(userId);
  const sections = digestSections(digest);
  if (!digest.hasAnything) return { sent: false, sections };
  const when = helsinkiDate(new Date());
  const apiKey = usableKey(process.env.RESEND_API_KEY);
  if (!apiKey) {
    const error = new Error("RESEND_API_KEY is not set");
    error.statusCode = 503;
    throw error;
  }
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to: user.email,
    subject: `DIRA — ${weekday(when)}, ${when.day} ${monthName(when.month)}`,
    html: renderDigest(digest, when),
  });
  if (error) {
    const failure = new Error(error.message || "Could not send the digest");
    failure.statusCode = 502;
    throw failure;
  }
  return { sent: true, sections };
}

export async function runScheduledDigests() {
  const now = helsinkiDate(new Date());
  const users = await prisma.user.findMany({
    where: { altimetrixUserId: { not: null } },
    select: { id: true, email: true, settings: true },
  });
  for (const user of users) {
    const settings = digestSettings(user.settings);
    if (!settings.digestEnabled) continue;
    if (Number(settings.digestTime.slice(0, 2)) !== now.hour) continue;
    try {
      const result = await sendDigestEmail(user.id);
      if (result.sent) console.log("[digest] sent to:", user.email);
      else console.log("[digest] nothing to send:", user.email);
    } catch (err) {
      console.error("[digest] failed for:", user.email, err.message);
    }
  }
}

export function digestSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const time = typeof settings.digestTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.digestTime)
    ? settings.digestTime
    : "07:00";
  return {
    digestEnabled: settings.digestEnabled !== false,
    digestTime: time,
  };
}

function digestSections(digest) {
  const sections = [];
  if (digest.upcomingBirthdays.length || digest.upcomingEvents.length) sections.push("upcoming");
  if (digest.pendingQueue) sections.push("queue");
  if (digest.dormantVisions.length) sections.push("visions");
  return sections;
}

function birthdayFrom(event, today) {
  if (!event.occurredAt || !/\bbirth/i.test(event.title || "")) return null;
  const day = calendarDay(event.occurredAt);
  if (!day) return null;
  const daysAway = daysUntilAnniversary(day.month, day.day, today);
  if (daysAway < 0 || daysAway > BIRTHDAY_WINDOW) return null;
  return {
    name: birthdayName(event),
    date: formatMonthDay(day.month, day.day),
    daysAway,
  };
}

function upcomingFrom(event, today) {
  const dated = [event.occurredAt, event.dueAt].find((value) => {
    const daysAway = daysUntilDate(value, today);
    return daysAway != null && daysAway >= 0 && daysAway <= EVENT_WINDOW;
  });
  if (!dated) return null;
  const day = calendarDay(dated);
  return {
    title: event.title,
    date: formatMonthDay(day.month, day.day),
    daysAway: daysUntilDate(dated, today),
  };
}

function birthdayName(event) {
  const people = Array.isArray(event.people) ? event.people : [];
  const named = people.find((person) => person && typeof person.name === "string" && person.name.trim());
  if (named) return named.name.trim();
  const cleaned = String(event.title || "")
    .replace(/\b(birthday|birth|born|of|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || event.title;
}

function daysUntilAnniversary(month, day, today) {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  let target = Date.UTC(today.year, month - 1, day);
  if (target < start) target = Date.UTC(today.year + 1, month - 1, day);
  return Math.round((target - start) / DAY_MS);
}

function daysUntilDate(value, today) {
  const day = calendarDay(value);
  if (!day) return null;
  const start = Date.UTC(today.year, today.month - 1, today.day);
  const target = Date.UTC(day.year, day.month - 1, day.day);
  return Math.round((target - start) / DAY_MS);
}

function calendarDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
    return { month: date.getUTCMonth() + 1, day: date.getUTCDate(), year: date.getUTCFullYear() };
  }
  return helsinkiDate(date);
}

function daysBetween(from, to) {
  const start = from instanceof Date ? from.getTime() : new Date(from).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((to.getTime() - start) / DAY_MS));
}

function helsinkiDate(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    weekday: read("weekday"),
  };
}

function weekday(when) {
  return when.weekday || "Today";
}

function monthName(month) {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1] || "";
}

function formatMonthDay(month, day) {
  return `${day} ${monthName(month)}`;
}

function renderDigest(digest, when) {
  const blocks = [];
  const upcoming = [
    ...digest.upcomingBirthdays.map((item) => `${escapeHtml(item.name)} birthday ${away(item.daysAway)} (${escapeHtml(item.date)})`),
    ...digest.upcomingEvents.filter((item) => item.daysAway <= EVENT_WINDOW).map((item) => `${escapeHtml(item.title)} ${away(item.daysAway)}`),
  ];
  if (upcoming.length) blocks.push(section("Upcoming", upcoming));
  if (digest.pendingQueue) {
    const label = digest.pendingQueue === 1 ? "1 item waiting for your review" : `${digest.pendingQueue} items waiting for your review`;
    blocks.push(section("Queue", [`${label}<br><a href="${APP_URL}/home" style="color:#7F77DD;text-decoration:none;">Open DIRA</a>`]));
  }
  if (digest.dormantVisions.length) {
    blocks.push(section("Visions", digest.dormantVisions.map((vision) => `“${escapeHtml(vision.title)}” hasn't been touched in ${vision.daysSinceTouch} days`)));
  }
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0E0E0F;">
    <div style="max-width:560px;margin:0 auto;padding:40px 28px;background:#0E0E0F;color:#F5F3EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="font-size:28px;letter-spacing:0.18em;">DIRA</div>
      <div style="margin-top:8px;color:#6B6963;font-size:13px;">${escapeHtml(weekday(when))}, ${when.day} ${escapeHtml(monthName(when.month))}</div>
      ${blocks.join("")}
      <p style="margin-top:36px;font-size:13px;line-height:1.7;">
        <a href="${APP_URL}" style="color:#7F77DD;text-decoration:none;">Open DIRA → dira.qusaz.com</a><br>
        <a href="${APP_URL}/account" style="color:#6B6963;text-decoration:none;">Turn off digest → dira.qusaz.com/account</a>
      </p>
    </div>
  </body>
</html>`;
}

function section(label, lines) {
  const items = lines.map((line) => `<p style="margin:8px 0;font-size:15px;line-height:1.6;color:#F5F3EE;">${line}</p>`).join("");
  return `<div style="margin-top:32px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#7F77DD;">${escapeHtml(label)}</div>
    ${items}
  </div>`;
}

function away(days) {
  if (days === 0) return "today";
  if (days === 1) return "in 1 day";
  return `in ${days} days`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_") || key.startsWith("re_your")) return null;
  return key;
}
