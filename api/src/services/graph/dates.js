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

// Month words in every language the date grammar reads; they are dates, never names.
export const MONTH_WORDS = new Set([...LONG, ...SHORT, ...SWAHILI, "sept"]);

// Every full date written in the text, as YYYY-MM-DD, and every bare year.
export function datesIn(text) {
  const source = String(text || "").toLowerCase();
  const found = new Set();
  const monthOf = (word) => {
    const key = word.replace(/\.$/, "");
    for (const list of [LONG, SHORT, SWAHILI]) {
      const index = list.indexOf(key);
      if (index >= 0) return index + 1;
    }
    return key === "sept" ? 9 : null;
  };
  const pad = (value) => String(value).padStart(2, "0");
  const add = (year, month, dayOfMonth) => {
    const iso = `${year}-${pad(month)}-${pad(dayOfMonth)}`;
    if (month && isIsoDate(iso)) found.add(iso);
  };
  for (const match of source.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([\p{L}.]+),?\s+(\d{4})\b/gu)) add(match[3], monthOf(match[2]), Number(match[1]));
  for (const match of source.matchAll(/\b([\p{L}.]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gu)) add(match[3], monthOf(match[1]), Number(match[2]));
  for (const match of source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(match[1], Number(match[2]), Number(match[3]));
  const years = new Set([...source.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((match) => match[1]));
  return { dates: [...found], years: [...years] };
}
