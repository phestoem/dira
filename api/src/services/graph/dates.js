// General date grammar: does the text state this calendar date in any common spelling?
const LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SWAHILI = ["januari", "februari", "machi", "aprili", "mei", "juni", "julai", "agosti", "septemba", "oktoba", "novemba", "desemba"];

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// "3 February 1993", "February 3rd, 1993", "3rd of Feb 1993", "1993-02-03", "03/02/1993", "3.2.1993", "tarehe 3 Februari 1993".
export function mentionsDate(text, iso) {
  if (!isIsoDate(iso)) return false;
  const [year, month, day] = iso.split("-").map(Number);
  const source = String(text || "").toLowerCase();
  const months = `(?:${[LONG[month - 1], SHORT[month - 1], SWAHILI[month - 1]].join("|")})\\.?`;
  const dd = `0?${day}(?:st|nd|rd|th)?`;
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `\\b${dd}\\s+(?:of\\s+)?${months},?\\s+${year}\\b`,
    `\\b${months}\\s+${dd},?\\s+${year}\\b`,
    `\\b${year}-${pad(month)}-${pad(day)}\\b`,
    `\\b0?${day}[/.]0?${month}[/.]${year}\\b`,
    `\\b0?${month}/0?${day}/${year}\\b`,
  ].some((pattern) => new RegExp(pattern, "i").test(source));
}

// Month names (long, short and the form used with a day, e.g. Polish "lipca") in common languages, from Intl rather
// than hand-written lists. A spelling that means different months in two languages is dropped.
const MONTH_LOCALES = ["en", "sw", "nl", "pl", "de", "fr", "es", "pt", "it", "sv", "da", "nb", "fi", "tr", "id", "ro", "hu", "cs"];
const MONTH_OF = (() => {
  const months = new Map();
  const clashes = new Set();
  const add = (word, month) => {
    const key = word.toLowerCase().replace(/\.$/, "");
    if (/\d/.test(key) || key.length < 3) return;
    if (months.has(key) && months.get(key) !== month) clashes.add(key);
    months.set(key, month);
  };
  [LONG, SHORT, SWAHILI].forEach((list) => list.forEach((word, index) => add(word, index + 1)));
  add("sept", 9);
  for (const locale of MONTH_LOCALES) {
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(Date.UTC(2001, index, 15));
      const format = (options) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
      add(format({ month: "long" }).format(date), index + 1);
      add(format({ month: "short" }).format(date), index + 1);
      add(format({ day: "numeric", month: "long" }).formatToParts(date).find((part) => part.type === "month")?.value || "", index + 1);
    }
  }
  for (const key of clashes) months.delete(key);
  return months;
})();

// Month words in every language the date grammar reads; they are dates, never names.
export const MONTH_WORDS = new Set(MONTH_OF.keys());

// Every date written in the text, normalised: full dates as YYYY-MM-DD, "March 2019" as YYYY-MM, bare years as
// YYYY. "03/04/2019" could be either order; both readings are kept in `either` and neither counts as stated.
export function datesIn(text) {
  const source = String(text || "").toLowerCase();
  const found = new Set();
  const either = [];
  const months = new Set();
  const monthOf = (word) => MONTH_OF.get(word.replace(/\.$/, "")) || null;
  const pad = (value) => String(value).padStart(2, "0");
  const iso = (year, month, dayOfMonth) => {
    const value = `${year}-${pad(month)}-${pad(dayOfMonth)}`;
    return month && isIsoDate(value) ? value : null;
  };
  const add = (year, month, dayOfMonth) => {
    const value = iso(year, month, dayOfMonth);
    if (value) found.add(value);
    return Boolean(value);
  };
  let rest = source;
  const take = (pattern, handle) => {
    rest = rest.replace(pattern, (...match) => (handle(match) ? " " : match[0]));
  };
  take(/\b(\d{1,2})(?:st|nd|rd|th)?\.?\s+(?:of\s+|de\s+)?([\p{L}.]+),?\s+(?:de\s+)?(\d{4})\b/gu, (m) => add(m[3], monthOf(m[2]), Number(m[1])));
  take(/\b([\p{L}.]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gu, (m) => add(m[3], monthOf(m[1]), Number(m[2])));
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => add(m[1], Number(m[2]), Number(m[3])));
  take(/(\d{4})\s*[년年]\s*(\d{1,2})\s*[월月]\s*(\d{1,2})\s*[일日]/g, (m) => add(m[1], Number(m[2]), Number(m[3])));
  take(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (m) => add(m[3], Number(m[2]), Number(m[1])));
  take(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m) => {
    const dayFirst = iso(m[3], Number(m[2]), Number(m[1]));
    const monthFirst = iso(m[3], Number(m[1]), Number(m[2]));
    if (dayFirst && monthFirst && dayFirst !== monthFirst) either.push([dayFirst, monthFirst]);
    else if (dayFirst || monthFirst) found.add(dayFirst || monthFirst);
    return Boolean(dayFirst || monthFirst);
  });
  take(/\b([\p{L}.]+)\s+(?:of\s+|de\s+)?(\d{4})\b/gu, (m) => {
    const month = monthOf(m[1]);
    if (month) months.add(`${m[2]}-${pad(month)}`);
    return Boolean(month);
  });
  take(/\b(\d{4})-(\d{2})\b/g, (m) => {
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12) months.add(`${m[1]}-${m[2]}`);
    return Number(m[2]) >= 1 && Number(m[2]) <= 12;
  });
  const years = new Set([...source.matchAll(/(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/g)].map((match) => match[1]));
  return { dates: [...found], either, months: [...months], years: [...years] };
}
