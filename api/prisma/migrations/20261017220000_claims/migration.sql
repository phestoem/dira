-- Knowledge layer: one claim store (docs/knowledge-layer.md). Additive; nothing existing changes.

CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "objectId" TEXT,
    "value" TEXT,
    "label" TEXT,
    "amount" DECIMAL(20,2),
    "currency" TEXT,
    "contextId" TEXT,
    "date" TIMESTAMP(3),
    "datePrecision" TEXT,
    "until" TIMESTAMP(3),
    "untilPrecision" TEXT,
    "status" TEXT NOT NULL DEFAULT 'stated',
    "supersedesId" TEXT,
    "evidence" TEXT,
    "eventId" TEXT,
    "source" TEXT,
    "sourceRef" TEXT,
    "extractor" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claims_userId_subjectId_idx" ON "claims"("userId", "subjectId");
CREATE INDEX "claims_userId_objectId_idx" ON "claims"("userId", "objectId");
CREATE INDEX "claims_userId_predicate_idx" ON "claims"("userId", "predicate");
CREATE INDEX "claims_userId_status_idx" ON "claims"("userId", "status");
CREATE INDEX "claims_eventId_idx" ON "claims"("eventId");

ALTER TABLE "claims" ADD CONSTRAINT "claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
