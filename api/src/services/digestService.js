import { Resend } from "resend";
import { prisma } from "../prisma.js";
import { amountText } from "./savedSummary.js";
import { missing } from "./timeline.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_URL = "https://dira.qusaz.com";
// The digest's sender is configuration, not code: DIGEST_FROM in .env (an address on the verified sending domain).
const FROM = process.env.DIGEST_FROM || "DIRA <dira@qusaz.com>";

export async function generateDigest(userId) {
  const today = helsinkiDate(new Date());
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const memory = digestMemory(user?.settings);
  const yesterday = shiftDay(today, -1);
  const yesterdayStart = startOfHelsinkiDay(yesterday.year, yesterday.month, yesterday.day);
  const todayStart = startOfHelsinkiDay(today.year, today.month, today.day);
  const [events, pendingQueue, visions, yesterdayEvents, yesterdayVisions, people] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" } },
      select: { id: true, title: true, status: true, eventType: true, rawInput: true, understoodMeaning: true, occurredAt: true, datePrecision: true, dueAt: true, endsAt: true, financials: true, people: true, createdAt: true },
    }),
    prisma.inputQueue.count({
      where: {
        userId,
        processingStatus: { in: ["pending", "processing"] },
        ...(memory.lastDigestSent ? { createdAt: { gt: memory.lastDigestSent } } : {}),
      },
    }),
    prisma.vision.findMany({
      where: {
        userId,
        status: { notIn: ["released", "archived"] },
        nudgeAfter: { lte: new Date() },
      },
      select: { id: true, title: true, lastTouchedAt: true, createdAt: true, connectedEvents: true, connectedEntities: true },
    }),
    prisma.event.findMany({
      where: {
        userId,
        status: { not: "archived" },
        createdAt: { gte: yesterdayStart, lt: todayStart },
      },
      select: { id: true, title: true },
    }),
    prisma.vision.findMany({
      where: {
        userId,
        status: { notIn: ["released", "archived"] },
        createdAt: { gte: yesterdayStart, lt: todayStart },
      },
      select: { title: true },
    }),
    prisma.entity.findMany({
      where: { userId, entityType: "person", status: { not: "archived" }, birthDate: { not: null } },
      select: { id: true, name: true, birthDate: true, deathDate: true, attributes: true, entityType: true },
    }),
  ]);

  const upcomingBirthdays = [];
  const upcomingEvents = [];
  const memorials = [];
  const mentions = { birthdayIds: [], eventIds: [], memorialIds: [] };
  const namedBirthdays = new Set();

  for (const person of people) {
    if (person.deathDate) continue;
    const birthday = birthdayFromEntity(person, today, memory.birthdayIds);
    if (!birthday) continue;
    upcomingBirthdays.push(birthday);
    mentions.birthdayIds.push(birthday.mark);
    namedBirthdays.add(person.name.toLowerCase());
  }

  for (const event of events) {
    const birthday = birthdayFrom(event, today, memory.birthdayIds);
    if (birthday && !namedBirthdays.has(String(birthday.name || "").toLowerCase())) {
      upcomingBirthdays.push(birthday);
      mentions.birthdayIds.push(birthday.mark);
      continue;
    }
  }
  const comingUp = comingUpFrom(events, today);
  const openPayments = openPaymentsFrom(events, today);

  upcomingBirthdays.sort((left, right) => left.daysAway - right.daysAway);
  upcomingEvents.sort((left, right) => left.daysAway - right.daysAway);

  const dormantVisions = quietVisions(visions, events, new Date());

  // Yesterday is the person's own activity: records saved from something they sent (an input row points at them).
  // Records written by one-offs and backfills have no input row and are left out.
  const sent = yesterdayEvents.length
    ? await prisma.inputQueue.findMany({ where: { userId, resultEventId: { in: yesterdayEvents.map((event) => event.id) } }, select: { resultEventId: true } })
    : [];
  const yesterdayActivity = [
    ...ownRecords(yesterdayEvents, sent.map((row) => row.resultEventId)).map((event) => ({ title: event.title, kind: "event" })),
    ...yesterdayVisions.map((vision) => ({ title: vision.title, kind: "vision" })),
  ];

  const family = await familyIds(userId);
  for (const person of people) {
    if (!person.deathDate || !family.has(person.id)) continue;
    const day = calendarDay(person.deathDate);
    if (!day) continue;
    const daysAway = daysUntilAnniversary(day.month, day.day, today);
    if (daysAway !== 0) continue;
    const key = `${person.id}:${today.year}:memorial`;
    if (memory.memorialIds.has(key)) continue;
    const years = today.year - day.year;
    memorials.push({ name: person.name, years: Math.max(years, 0), mark: key });
    mentions.memorialIds.push(key);
  }

  const assets = await prisma.entity.findMany({
    where: { userId, entityType: { in: ["asset", "vehicle", "document"] }, status: { not: "archived" } },
    select: { id: true, name: true, attributes: true },
  });
  for (const asset of assets) {
    const expiry = asset.attributes?.expiry || asset.attributes?.expiresAt;
    const day = calendarDay(expiry);
    if (!day) continue;
    const daysAway = daysUntilDate(expiry, today);
    if (daysAway == null || daysAway < 0 || daysAway > 3) continue;
    const stage = eventStage(daysAway, memory.eventIds, asset.id, today.year);
    if (!stage) continue;
    upcomingEvents.push({ title: `${asset.name} renewal`, date: formatMonthDay(day.month, day.day), daysAway, mark: stage });
    mentions.eventIds.push(stage);
  }

  const digest = {
    comingUp,
    openPayments,
    upcomingBirthdays,
    upcomingEvents,
    memorials,
    pendingQueue,
    dormantVisions,
    yesterday: yesterdayActivity,
    hasAnything: false,
    mentions,
  };
  digest.hasAnything = Boolean(
    digest.comingUp.length
    || digest.openPayments.length
    || digest.upcomingBirthdays.length
    || digest.upcomingEvents.length
    || digest.pendingQueue
    || digest.dormantVisions.length
    || digest.yesterday.length
    || digest.memorials.length,
  );
  for (const item of [...upcomingBirthdays, ...upcomingEvents, ...memorials]) delete item.mark;
  return digest;
}

export async function sendDigestEmail(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) return { sent: false, sections: [] };
  const digest = await generateDigest(userId);
  const sections = digestSections(digest);
  if (!digest.hasAnything) {
    console.log(`[digest] nothing new for ${user.email}, skipping`);
    return { sent: false, sections };
  }
  if (process.env.NODE_ENV === "development") {
    console.log(`[digest] development: not sending to ${user.email} (${sections.join(", ")})`);
    return { sent: false, sections };
  }
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
  await rememberDigest(user, digest);
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

function digestMemory(settings) {
  const value = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const content = value.lastDigestContent && typeof value.lastDigestContent === "object" ? value.lastDigestContent : {};
  const sent = value.lastDigestSent ? new Date(value.lastDigestSent) : null;
  return {
    lastDigestSent: sent && !Number.isNaN(sent.getTime()) ? sent : null,
    birthdayIds: new Set(stringList(content.birthdayIds)),
    eventIds: new Set(stringList(content.eventIds)),
    memorialIds: new Set(stringList(content.memorialIds)),
  };
}

async function rememberDigest(user, digest) {
  const current = user.settings && typeof user.settings === "object" && !Array.isArray(user.settings) ? user.settings : {};
  const previous = digestMemory(current);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      settings: {
        ...current,
        lastDigestSent: new Date().toISOString(),
        lastDigestContent: {
          birthdayIds: [...new Set([...previous.birthdayIds, ...digest.mentions.birthdayIds])],
          eventIds: [...new Set([...previous.eventIds, ...digest.mentions.eventIds])],
          memorialIds: [...new Set([...previous.memorialIds, ...(digest.mentions.memorialIds || [])])],
        },
      },
    },
  });
}

function digestSections(digest) {
  const sections = [];
  if (digest.comingUp.length || digest.upcomingBirthdays.length || digest.upcomingEvents.length) sections.push("coming up");
  if (digest.openPayments.length) sections.push("payments");
  if (digest.pendingQueue) sections.push("queue");
  if (digest.dormantVisions.length) sections.push("visions");
  if (digest.yesterday.length) sections.push("yesterday");
  return sections;
}

function birthdayFromEntity(person, today, mentioned) {
  const day = calendarDay(person.birthDate);
  if (!day) return null;
  const daysAway = daysUntilAnniversary(day.month, day.day, today);
  const stage = birthdayStage(daysAway, mentioned, person.id, anniversaryYear(day.month, day.day, today));
  if (!stage) return null;
  return { name: person.name, date: formatMonthDay(day.month, day.day), daysAway, mark: stage };
}

async function familyIds(userId) {
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true } });
  if (!self) return new Set();
  const edges = await prisma.relationship.findMany({
    where: { userId, status: "confirmed", category: "family", type: { in: ["parent_of", "spouse_of", "child_of"] } },
    select: { fromId: true, toId: true, type: true },
  });
  const ids = new Set();
  for (const edge of edges) {
    if (edge.fromId === self.id || edge.toId === self.id) ids.add(edge.fromId === self.id ? edge.toId : edge.fromId);
  }
  return ids;
}

function birthdayFrom(event, today, mentioned) {
  if (!event.occurredAt || !/\bbirth/i.test(event.title || "")) return null;
  const day = calendarDay(event.occurredAt);
  if (!day) return null;
  const daysAway = daysUntilAnniversary(day.month, day.day, today);
  const stage = birthdayStage(daysAway, mentioned, event.id, anniversaryYear(day.month, day.day, today));
  if (!stage) return null;
  return {
    name: birthdayName(event),
    date: formatMonthDay(day.month, day.day),
    daysAway,
    mark: stage,
  };
}

const CLOSED = new Set(["completed", "cancelled", "archived"]);
const TRIP = /\b(trip|travel|flight|journey|safari|visit)\b/i;
const WORK = /\b(renovation|construction|building|build|fence|uzio|landscaping|works|repair|installation|house)\b/i;
const projectIds = (event) => (Array.isArray(event.people) ? event.people : []).filter((ref) => ref?.role === "project" && ref.entityId).map((ref) => ref.entityId);
const utcDay = (today) => new Date(Date.UTC(today.year, today.month - 1, today.day));

// The next date of an open record within 30 days: its start, or its due date. A month-only date counts from the
// first of the month and is shown without a day.
function nextDate(event, today) {
  const options = [[event.occurredAt, event.datePrecision], [event.dueAt, null]]
    .map(([value, precision]) => {
      if (!value) return null;
      if (precision === "month") {
        const day = calendarDay(value);
        const sameOrLater = day && (day.year > today.year || (day.year === today.year && day.month >= today.month));
        return sameOrLater ? { value, precision, daysAway: Math.max(0, daysUntilDate(value, today)) } : null;
      }
      const daysAway = daysUntilDate(value, today);
      return daysAway != null && daysAway >= 0 ? { value, precision: null, daysAway } : null;
    })
    .filter((item) => item && item.daysAway <= 30)
    .sort((left, right) => left.daysAway - right.daysAway);
  return options[0] || null;
}

// "Coming up": open records dated in the next 30 days, soonest first, with days left and what is not on record yet
// (for a trip or building work: the record itself, records of the same project, and for a trip, trip records near it).
export function comingUpFrom(events, today) {
  const open = events.filter((event) => !CLOSED.has(event.status));
  const out = [];
  for (const event of open) {
    const next = nextDate(event, today);
    if (!next) continue;
    const title = String(event.title || "");
    const kind = TRIP.test(title) ? "trip" : WORK.test(title) ? "work" : null;
    let notRecorded = [];
    if (kind) {
      const projects = new Set(projectIds(event));
      const at = new Date(next.value).getTime();
      const related = open.filter((other) => other.id === event.id
        || projectIds(other).some((id) => projects.has(id))
        || (kind === "trip" && TRIP.test(String(other.title || "")) && other.occurredAt && Math.abs(new Date(other.occurredAt).getTime() - at) <= 30 * DAY_MS));
      notRecorded = missing(kind, related, utcDay(today));
    }
    const day = calendarDay(next.value);
    out.push({
      title,
      date: next.precision === "month" ? `${monthName(day.month)} ${day.year}` : formatMonthDay(day.month, day.day),
      daysAway: next.daysAway,
      monthOnly: next.precision === "month",
      notRecorded,
    });
  }
  return out.sort((left, right) => left.daysAway - right.daysAway || left.title.localeCompare(right.title));
}

// Open payments this month: records with an amount to pay (not income) that are due this month, or planned or
// promised (a commitment) with a date this month, and are not completed or cancelled.
export function openPaymentsFrom(events, today) {
  const inMonth = (value) => {
    const day = value ? calendarDay(value) : null;
    return Boolean(day && day.year === today.year && day.month === today.month);
  };
  return events
    .filter((event) => !CLOSED.has(event.status) && amountText(event.financials) && event.financials?.direction !== "income")
    .filter((event) => inMonth(event.dueAt) || ((event.status === "planned" || event.eventType === "commitment") && inMonth(event.occurredAt)))
    .map((event) => {
      const when = inMonth(event.dueAt) ? event.dueAt : event.occurredAt;
      const day = calendarDay(when);
      return { title: event.title, amount: amountText(event.financials), date: formatMonthDay(day.month, day.day), daysAway: daysUntilDate(when, today) };
    })
    .sort((left, right) => left.daysAway - right.daysAway);
}

// A vision is nudged only after 14 or more days with nothing new: no touch, and no record linked to it (directly
// or through its project) saved in that time.
export function quietVisions(visions, events, now) {
  return visions
    .map((vision) => {
      const eventIds = new Set((Array.isArray(vision.connectedEvents) ? vision.connectedEvents : []).map((ref) => ref?.eventId).filter(Boolean));
      const entityIds = new Set((Array.isArray(vision.connectedEntities) ? vision.connectedEntities : []).map((ref) => ref?.entityId).filter(Boolean));
      const linked = events.filter((event) => eventIds.has(event.id) || projectIds(event).some((id) => entityIds.has(id)));
      const times = [vision.lastTouchedAt, vision.createdAt, ...linked.map((event) => event.createdAt)].map((value) => (value ? new Date(value).getTime() : NaN)).filter(Number.isFinite);
      const days = daysBetween(new Date(Math.max(...times)), now);
      return { title: vision.title, daysSinceTouch: days, quietFor: quietFor(days) };
    })
    .filter((vision) => vision.daysSinceTouch >= 14)
    .sort((left, right) => right.daysSinceTouch - left.daysSinceTouch);
}

// "2 weeks", "5 weeks", "2 months", "over a year": never a count of days.
export function quietFor(days) {
  if (days < 60) return `${Math.floor(days / 7)} weeks`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  return "over a year";
}

export function ownRecords(events, sentIds) {
  const sent = new Set(sentIds);
  return events.filter((event) => sent.has(event.id));
}

function birthdayStage(daysAway, mentioned, id, year) {
  if (daysAway === 0) return mark(mentioned, id, year, "0");
  if (daysAway === 1) return mark(mentioned, id, year, "1");
  if (daysAway > 1 && daysAway <= 7) return mark(mentioned, id, year, "7");
  if (daysAway === 30) return mark(mentioned, id, year, "30");
  return null;
}

function eventStage(daysAway, mentioned, id, year) {
  if (daysAway === 0) return mark(mentioned, id, year, "0");
  if (daysAway === 1) return mark(mentioned, id, year, "1");
  if (daysAway > 1 && daysAway <= 3) return mark(mentioned, id, year, "3");
  return null;
}

function mark(mentioned, id, year, stage) {
  const key = `${id}:${year}:${stage}`;
  return mentioned.has(key) ? null : key;
}

function anniversaryYear(month, day, today) {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  const target = Date.UTC(today.year, month - 1, day);
  return target >= start ? today.year : today.year + 1;
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

export function renderDigest(digest, when) {
  const blocks = [];
  const upcoming = [
    ...(digest.comingUp || []).map((item) => comingUpLine(item)),
    ...digest.upcomingBirthdays.map((item) => birthdayLine(item)),
    ...(digest.memorials || []).map((item) => `Today marks ${item.years} years since ${escapeHtml(item.name)} passed`),
    ...digest.upcomingEvents.map((item) => `${escapeHtml(item.title)} ${away(item.daysAway)}`),
  ];
  if (upcoming.length) blocks.push(section("Coming up", upcoming));
  // Said even when there are none, so "none open" is not mistaken for "not checked".
  const payments = digest.openPayments || [];
  blocks.push(section(`Payments in ${monthName(when.month)}`, payments.length
    ? payments.map((item) => `${escapeHtml(item.title)}: ${escapeHtml(item.amount)}, ${item.daysAway < 0 ? `was due ${escapeHtml(item.date)}` : `due ${escapeHtml(item.date)} (${away(item.daysAway)})`}`)
    : ["No open payments on record."]));
  if (digest.pendingQueue) {
    const label = digest.pendingQueue === 1 ? "1 item waiting for your review" : `${digest.pendingQueue} items waiting for your review`;
    blocks.push(section("Queue", [`${label}<br><a href="${APP_URL}/home" style="color:#7F77DD;text-decoration:none;">Open DIRA</a>`]));
  }
  if (digest.dormantVisions.length) {
    blocks.push(section("Visions", digest.dormantVisions.map((vision) => `Nothing new on “${escapeHtml(vision.title)}” for ${escapeHtml(vision.quietFor)}. Anything to add?`)));
  }
  if (digest.yesterday.length) {
    blocks.push(section("Yesterday", digest.yesterday.map((item) => escapeHtml(item.title))));
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

function comingUpLine(item) {
  const when = item.monthOnly
    ? `${escapeHtml(item.date)} (no day recorded)`
    : `${escapeHtml(item.date)}, ${item.daysAway === 0 ? "today" : item.daysAway === 1 ? "tomorrow" : `${item.daysAway} days left`}`;
  const gaps = item.notRecorded?.length ? `<br><span style="color:#6B6963;font-size:13px;">Not recorded yet: ${escapeHtml(item.notRecorded.join(", "))}</span>` : "";
  return `${escapeHtml(item.title)}: ${when}${gaps}`;
}

function birthdayLine(item) {
  const name = escapeHtml(item.name);
  if (item.daysAway === 0) return `${name}'s birthday is today`;
  if (item.daysAway === 1) return `${name}'s birthday is tomorrow (${escapeHtml(item.date)})`;
  return `${name} birthday ${away(item.daysAway)} (${escapeHtml(item.date)})`;
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

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function shiftDay(today, delta) {
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function startOfHelsinkiDay(year, month, day) {
  for (const offset of [2, 3]) {
    const date = new Date(Date.UTC(year, month - 1, day, -offset, 0, 0));
    const parts = helsinkiDate(date);
    if (parts.year === year && parts.month === month && parts.day === day && parts.hour === 0) return date;
  }
  return new Date(Date.UTC(year, month - 1, day, -3, 0, 0));
}

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_") || key.startsWith("re_your")) return null;
  return key;
}
