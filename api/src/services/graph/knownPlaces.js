import { prisma } from "../../prisma.js";
import { normalizeName } from "./entityResolver.js";

// Places come from the person's own records (place and property entities) plus what the model extracts from the
// message; there is no fixed list of place names in the code.
export async function knownPlacesIn(userId, text) {
  const haystack = ` ${normalizeName(text)} `;
  if (!userId || haystack.trim().length < 3) return [];
  const places = await prisma.entity.findMany({
    where: { userId, entityType: { in: ["place", "property"] }, status: { not: "archived" }, mergedIntoId: null },
    select: { name: true, aliases: true },
    take: 300,
  });
  const found = [];
  for (const place of places) {
    for (const label of [place.name, ...(place.aliases || [])]) {
      const key = normalizeName(label);
      if (key.length >= 3 && haystack.includes(` ${key} `)) {
        found.push(place.name);
        break;
      }
    }
  }
  return [...new Set(found)];
}
