-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "altimetrixUserId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "space" TEXT NOT NULL DEFAULT 'personal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rawInput" TEXT,
    "understoodMeaning" TEXT,
    "eventType" TEXT NOT NULL,
    "space" TEXT NOT NULL DEFAULT 'personal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "urgency" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "emotionalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "occurredAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "source" TEXT,
    "rawSourceRef" TEXT,
    "financials" JSONB NOT NULL DEFAULT '{}',
    "people" JSONB NOT NULL DEFAULT '[]',
    "places" JSONB NOT NULL DEFAULT '[]',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "sentToAltimetrix" BOOLEAN NOT NULL DEFAULT false,
    "altimetrixEventType" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'seed',
    "rawContent" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" vector(1536),
    "inspirations" JSONB NOT NULL DEFAULT '[]',
    "connectedEntities" JSONB NOT NULL DEFAULT '[]',
    "connectedEvents" JSONB NOT NULL DEFAULT '[]',
    "connectedVisions" JSONB NOT NULL DEFAULT '[]',
    "lastTouchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nudgeAfter" TIMESTAMP(3),
    "nudgeCount" INTEGER NOT NULL DEFAULT 0,
    "altimetrixNotified" BOOLEAN NOT NULL DEFAULT false,
    "space" TEXT NOT NULL DEFAULT 'personal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diary_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawContent" TEXT NOT NULL,
    "understoodThemes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "people" JSONB NOT NULL DEFAULT '[]',
    "emotionalTone" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "sharedWithAltimetrix" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diary_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "life_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "context" TEXT,
    "linkedGoal" TEXT,
    "people" JSONB NOT NULL DEFAULT '[]',
    "space" TEXT NOT NULL,
    "reflectionHint" TEXT,
    "processedByAltimetrix" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "life_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_queue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawContent" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mimeType" TEXT,
    "filePath" TEXT,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "understoodAs" TEXT,
    "resultEntityId" TEXT,
    "resultEventId" TEXT,
    "resultVisionId" TEXT,
    "resultDiaryId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "input_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "users_altimetrixUserId_key" ON "users"("altimetrixUserId");

-- CreateIndex
CREATE INDEX "entities_userId_space_status_idx" ON "entities"("userId", "space", "status");

-- CreateIndex
CREATE INDEX "entities_userId_entityType_idx" ON "entities"("userId", "entityType");

-- CreateIndex
CREATE INDEX "events_userId_space_status_idx" ON "events"("userId", "space", "status");

-- CreateIndex
CREATE INDEX "events_userId_eventType_idx" ON "events"("userId", "eventType");

-- CreateIndex
CREATE INDEX "events_userId_dueAt_idx" ON "events"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "events_sentToAltimetrix_idx" ON "events"("sentToAltimetrix");

-- CreateIndex
CREATE INDEX "visions_userId_space_status_idx" ON "visions"("userId", "space", "status");

-- CreateIndex
CREATE INDEX "visions_userId_nudgeAfter_idx" ON "visions"("userId", "nudgeAfter");

-- CreateIndex
CREATE INDEX "diary_entries_userId_occurredAt_idx" ON "diary_entries"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "diary_entries_userId_sharedWithAltimetrix_idx" ON "diary_entries"("userId", "sharedWithAltimetrix");

-- CreateIndex
CREATE INDEX "relationships_userId_relationshipType_idx" ON "relationships"("userId", "relationshipType");

-- CreateIndex
CREATE INDEX "relationships_fromEntityId_idx" ON "relationships"("fromEntityId");

-- CreateIndex
CREATE INDEX "relationships_toEntityId_idx" ON "relationships"("toEntityId");

-- CreateIndex
CREATE INDEX "life_events_userId_processedByAltimetrix_idx" ON "life_events"("userId", "processedByAltimetrix");

-- CreateIndex
CREATE INDEX "life_events_eventId_idx" ON "life_events"("eventId");

-- CreateIndex
CREATE INDEX "input_queue_userId_processingStatus_idx" ON "input_queue"("userId", "processingStatus");

-- CreateIndex
CREATE INDEX "input_queue_createdAt_idx" ON "input_queue"("createdAt");

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visions" ADD CONSTRAINT "visions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "life_events" ADD CONSTRAINT "life_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "life_events" ADD CONSTRAINT "life_events_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_queue" ADD CONSTRAINT "input_queue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_queue" ADD CONSTRAINT "input_queue_resultEntityId_fkey" FOREIGN KEY ("resultEntityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_queue" ADD CONSTRAINT "input_queue_resultEventId_fkey" FOREIGN KEY ("resultEventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_queue" ADD CONSTRAINT "input_queue_resultVisionId_fkey" FOREIGN KEY ("resultVisionId") REFERENCES "visions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_queue" ADD CONSTRAINT "input_queue_resultDiaryId_fkey" FOREIGN KEY ("resultDiaryId") REFERENCES "diary_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

