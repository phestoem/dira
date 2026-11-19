-- How exact occurredAt is: null = the day, "month" = only the month is known (occurredAt is its first day).
ALTER TABLE "events" ADD COLUMN "datePrecision" TEXT;
