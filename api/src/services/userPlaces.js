// The user's own place names, from their place entities, so code that spots places in text needs no list of real
// places in source. Cached for a few minutes per user.
import { prisma } from "../prisma.js";

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function userPlaceNames(userId) {
  if (!userId) return [];
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const rows = await prisma.entity.findMany({
    where: { userId, entityType: "place", status: { not: "archived" } },
    select: { name: true, aliases: true },
  });
  const names = [...new Set(rows.flatMap((row) => [row.name, ...(row.aliases || [])]).map((name) => String(name || "").trim()).filter((name) => name.length >= 3))];
  cache.set(userId, { at: Date.now(), names });
  return names;
}

// The known places a text mentions, in the order they appear (whole words, any case).
export function placesIn(text, names) {
  const source = String(text || "");
  const found = [];
  for (const name of names || []) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").exec(source);
    if (match) found.push({ name, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.name);
}
