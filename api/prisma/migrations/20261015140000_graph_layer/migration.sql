-- Graph layer: polymorphic relationship edges and richer entity identity.

ALTER TABLE "entities" ADD COLUMN "isSelf" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "entities" ADD COLUMN "kind" TEXT;
ALTER TABLE "entities" ADD COLUMN "birthDate" TIMESTAMP(3);
ALTER TABLE "entities" ADD COLUMN "deathDate" TIMESTAMP(3);
ALTER TABLE "entities" ADD COLUMN "normalizedName" TEXT;
ALTER TABLE "entities" ADD COLUMN "mergedIntoId" TEXT;

CREATE INDEX "entities_userId_normalizedName_idx" ON "entities"("userId", "normalizedName");
CREATE INDEX "entities_userId_isSelf_idx" ON "entities"("userId", "isSelf");

ALTER TABLE "relationships" DROP CONSTRAINT "relationships_fromEntityId_fkey";
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_toEntityId_fkey";
DROP INDEX "relationships_userId_relationshipType_idx";
DROP INDEX "relationships_fromEntityId_idx";
DROP INDEX "relationships_toEntityId_idx";

ALTER TABLE "relationships" ADD COLUMN "fromKind" TEXT;
ALTER TABLE "relationships" ADD COLUMN "fromId" TEXT;
ALTER TABLE "relationships" ADD COLUMN "toKind" TEXT;
ALTER TABLE "relationships" ADD COLUMN "toId" TEXT;
ALTER TABLE "relationships" ADD COLUMN "type" TEXT;
ALTER TABLE "relationships" ADD COLUMN "label" TEXT;
ALTER TABLE "relationships" ADD COLUMN "category" TEXT;
ALTER TABLE "relationships" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'suggested';
ALTER TABLE "relationships" ADD COLUMN "source" TEXT;
ALTER TABLE "relationships" ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "relationships" ADD COLUMN "validFrom" TIMESTAMP(3);
ALTER TABLE "relationships" ADD COLUMN "validTo" TIMESTAMP(3);
ALTER TABLE "relationships" ADD COLUMN "evidenceEventId" TEXT;
ALTER TABLE "relationships" ADD COLUMN "evidenceText" TEXT;
ALTER TABLE "relationships" ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "relationships" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "relationships"
SET
  "fromKind" = 'entity',
  "fromId" = "fromEntityId",
  "toKind" = 'entity',
  "toId" = "toEntityId",
  "type" = "relationshipType",
  "label" = "notes",
  "category" = 'other',
  "status" = 'confirmed',
  "source" = 'user';

ALTER TABLE "relationships" DROP COLUMN "fromEntityId";
ALTER TABLE "relationships" DROP COLUMN "toEntityId";
ALTER TABLE "relationships" DROP COLUMN "relationshipType";
ALTER TABLE "relationships" DROP COLUMN "notes";

ALTER TABLE "relationships" ALTER COLUMN "fromKind" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "fromId" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "toKind" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "toId" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "type" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "relationships" ALTER COLUMN "source" SET NOT NULL;

CREATE UNIQUE INDEX "relationships_userId_fromKind_fromId_type_toKind_toId_key"
  ON "relationships"("userId", "fromKind", "fromId", "type", "toKind", "toId");
CREATE INDEX "relationships_userId_fromKind_fromId_idx" ON "relationships"("userId", "fromKind", "fromId");
CREATE INDEX "relationships_userId_toKind_toId_idx" ON "relationships"("userId", "toKind", "toId");
CREATE INDEX "relationships_userId_status_idx" ON "relationships"("userId", "status");
CREATE INDEX "relationships_userId_category_idx" ON "relationships"("userId", "category");
