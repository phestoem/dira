-- Remember which records have already been extracted into the graph,
-- so a rebuild can resume after a rate limit.

ALTER TABLE "events" ADD COLUMN "graphExtractedAt" TIMESTAMP(3);
ALTER TABLE "visions" ADD COLUMN "graphExtractedAt" TIMESTAMP(3);
ALTER TABLE "diary_entries" ADD COLUMN "graphExtractedAt" TIMESTAMP(3);
