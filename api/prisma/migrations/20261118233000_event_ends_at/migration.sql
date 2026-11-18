-- Last day of an event that spans days (a trip, a stay); null for a single day.
ALTER TABLE "events" ADD COLUMN "endsAt" TIMESTAMP(3);
