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
