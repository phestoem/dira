-- When a shared journal entry reached Altimetrix (null: sealed, or not sent yet).
ALTER TABLE "diary_entries" ADD COLUMN "sentToAltimetrixAt" TIMESTAMP(3);
