import { readFile } from "fs/promises";
import { extname } from "path";
import XLSX from "xlsx";
import { PDFParse } from "pdf-parse";

const CURRENCY_CODES = ["TSH", "TZS", "KES", "EUR", "USD", "GBP", "UGX", "RWF"];
const CURRENCY_TOKEN =
  /\b(TSH|TZS|KES|EUR|USD|GBP|UGX|RWF)\b|[$€£]/i;

const HEADER_HINTS = {
  currency: /amount|cost|price|total|paid|fee|budget|balance|currency|sum/,
  date: /date|due|when|day|issued|period/,
  person: /name|person|who|contact|client|owner|vendor|paid\s*by|from|to/,
  category: /category|type|kind|class|group|status/,
};

/**
 * Read a spreadsheet or CSV into sheets, detected column types, and a text form
 * the context engine can reason about.
 */
export function extractFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const currencies = new Set();
  const dateColumns = [];
  const personColumns = [];
  const categoryColumns = [];

  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: null,
      raw: true,
    });
    const headers = readHeaders(sheet, rows);
    const detectedTypes = {};

    for (const header of headers) {
      const values = rows.map((row) => row[header]);
      const type = detectColumnType(header, values);
      detectedTypes[header] = type;
      const label = `${name}.${header}`;
      if (type === "currency") {
        currencyCodesIn(header, values).forEach((code) => currencies.add(code));
      }
      if (type === "date") dateColumns.push(label);
      if (type === "person") personColumns.push(label);
      if (type === "category") categoryColumns.push(label);
    }

    return {
      name,
      headers,
      rows: rows.map(serializeRow),
      detectedTypes,
    };
  });

  const rowCount = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  const summary = {
    sheetNames: sheets.map((sheet) => sheet.name),
    rowCount,
    currencies: [...currencies],
    dateColumns,
    personColumns,
    categoryColumns,
  };

  return {
    sheets,
    summary,
    rawText: renderSheets(sheets, summary),
  };
}

export function extractFromCsv(filePath) {
  return extractFromExcel(filePath);
}

export async function extractFromPdf(filePath) {
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const parsed = await parser.getText();
    const text = (parsed.text || "").replace(/\n*-- \d+ of \d+ --\n*/g, "\n").trim();
    return {
      text,
      pageCount: parsed.total ?? null,
      rawText: text,
      summary: text.slice(0, 600),
    };
  } finally {
    await parser.destroy();
  }
}

export async function extractFromImage(filePath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const buffer = await readFile(filePath);
  const base64Image = buffer.toString("base64");
  const mimeType = mimeFromImagePath(filePath);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
            {
              type: "text",
              text: "Extract all text, numbers, and structure from this image. If it is a handwritten list, table, or receipt, extract it as structured data. Return as JSON with fields: type, title, items, totals, notes, people, dates",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI vision failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content?.trim() || "";
  const parsed = parseJsonContent(text);
  const structured =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { type: "image", notes: text };

  return {
    ...structured,
    rawText: JSON.stringify(structured),
  };
}

function readHeaders(sheet, rows) {
  const fromRows = rows.length > 0 ? Object.keys(rows[0]) : [];
  if (fromRows.length > 0) return fromRows;
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    headers.push(cell ? String(cell.v) : `column_${col + 1}`);
  }
  return headers;
}

function detectColumnType(header, values) {
  const label = String(header || "").toLowerCase();
  const sample = values.filter((value) => value !== null && value !== undefined && value !== "").slice(0, 40);

  if (HEADER_HINTS.category.test(label)) return "category";
  if (HEADER_HINTS.date.test(label) || majority(sample, isDateValue)) return "date";
  if (HEADER_HINTS.currency.test(label) || sample.some((value) => CURRENCY_TOKEN.test(String(value)))) {
    return "currency";
  }
  if (HEADER_HINTS.person.test(label)) return "person";
  if (sample.length > 0 && majority(sample, looksLikeName)) return "person";
  if (sample.length > 0 && majority(sample, isNumberValue)) return "number";
  return "text";
}

function currencyCodesIn(header, values) {
  const found = new Set();
  const blob = [header, ...values.slice(0, 40).map((value) => String(value ?? ""))].join(" ");
  for (const code of CURRENCY_CODES) {
    if (new RegExp(`\\b${code}\\b`, "i").test(blob)) {
      found.add(code === "TZS" ? "TSH" : code);
    }
  }
  if (/\$/.test(blob)) found.add("USD");
  if (/€/.test(blob)) found.add("EUR");
  if (/£/.test(blob)) found.add("GBP");
  return found;
}

function majority(values, predicate) {
  if (values.length === 0) return false;
  const hits = values.filter(predicate).length;
  return hits / values.length >= 0.6;
}

function isDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value);
}

function isNumberValue(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return /^-?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d+)?$/.test(String(value).trim());
}

function looksLikeName(value) {
  const text = String(value).trim();
  if (text.length < 3 || text.length > 60) return false;
  if (/\d/.test(text)) return false;
  const parts = text.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => /^[A-Z][a-z'’-]+$/.test(part));
}

function serializeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function renderSheets(sheets, summary) {
  const blocks = [
    `Sheets: ${summary.sheetNames.join(", ") || "(none)"}`,
    `Rows: ${summary.rowCount}`,
    `Currencies: ${summary.currencies.join(", ") || "(none)"}`,
  ];

  for (const sheet of sheets) {
    blocks.push(
      [
        `Sheet: ${sheet.name}`,
        `Headers: ${sheet.headers.join(", ")}`,
        `Detected: ${JSON.stringify(sheet.detectedTypes)}`,
        `Rows: ${JSON.stringify(sheet.rows)}`,
      ].join("\n"),
    );
  }

  return blocks.join("\n\n");
}

function mimeFromImagePath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function parseJsonContent(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
