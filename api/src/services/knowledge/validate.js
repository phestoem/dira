// General invariants for extracted claims, the same for every domain: the evidence is in the text, names come from
// the text or the user's records, and amounts are amounts the text states. A claim that breaks one is dropped with
// the reason, so the harness can count where facts were lost.
import { normalizeName } from "../graph/entityResolver.js";

const tokens = (text) => normalizeName(text).split(" ").filter(Boolean);

const SCALE = { k: 1e3, thousand: 1e3, elfu: 1e3, mil: 1e3, m: 1e6, mn: 1e6, million: 1e6, millions: 1e6, milioni: 1e6, milhao: 1e6, milhoes: 1e6, bn: 1e9, billion: 1e9 };

// Every amount written in the text, in any common format: 1,750,000 · 1.750.000 · 1 750 000 · 1.75 million · 450k ·
// R$ 55.000,00 (decimal comma).
export function amountsIn(text) {
  const flat = String(text || "").normalize("NFD").replace(/\p{M}/gu, "");
  const found = [];
  const pattern = /(\d{1,3}(?:[,\s. '’]\d{3})+|\d+)(?:[.,](\d{1,2}|\d+))?\s*(thousand|millions|million|milioni|milhoes|milhao|billion|elfu|mil|mn|bn|k|m)?(?![\p{L}\d])/giu;
  for (const match of flat.matchAll(pattern)) {
    const whole = Number(match[1].replace(/[^\d]/g, ""));
    const number = match[2] ? Number(`${whole}.${match[2]}`) : whole;
    found.push(number * (SCALE[(match[3] || "").toLowerCase()] || 1));
    if (match[2]) found.push(whole * (SCALE[(match[3] || "").toLowerCase()] || 1));
  }
  return found;
}

const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005);

export function validateClaims(claims, text, { known = [], selfName = "" } = {}) {
  const words = new Set(tokens(text));
  const knownWords = new Set(known.flatMap(tokens));
  const amounts = amountsIn(text);
  const kept = [];
  const dropped = [];
  for (const claim of claims) {
    const reason = problem(claim);
    if (reason) dropped.push({ claim, reason });
    else kept.push(claim);
  }
  return { kept, dropped };

  function nameProblem(entity) {
    if (!entity || entity === "me") return null;
    const parts = tokens(entity.name);
    if (!parts.length) return "empty-name";
    if (tokens(selfName).join(" ") === parts.join(" ")) return null;
    const seen = (word) => words.has(word) || knownWords.has(word);
    // A person is named by their first name in the text or the records; a thing by any word of its name.
    if (entity.type === "person" ? !seen(parts[0]) : !parts.some(seen)) return "name-not-in-text";
    return null;
  }

  function problem(claim) {
    const evidence = tokens(claim.evidence);
    if (!evidence.length || evidence.filter((word) => words.has(word)).length / evidence.length < 0.7) return "evidence-not-in-text";
    for (const entity of [claim.subject, claim.object, claim.context]) {
      const reason = nameProblem(entity);
      if (reason) return reason;
    }
    if (claim.amount != null && !amounts.some((value) => near(value, Number(claim.amount)))) return "amount-not-in-text";
    return null;
  }
}
