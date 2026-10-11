Create the foundation for DIRA — a personal intelligence 
system. DIRA is not a task manager. It is a context-first
system that understands any input in any format and builds
a living picture of a person's life across four layers:
operations, visions, relationships, and inner life.

Stack: Node.js (ESM), Fastify, Prisma, PostgreSQL.
Pattern: matches the existing QUSAZ projects 
(Altimetrix, Maarifa) — same folder structure,
same deployment approach.

## REPO STRUCTURE

dira/
  api/
    src/
      index.js
      routes/
      services/
      plugins/
    prisma/
      schema.prisma
    .env.example
    package.json
  web/
    (Next.js 14 — scaffold only, no pages yet)
  deploy.sh
  README.md

## THE DATA LAYER — prisma/schema.prisma

This is the most important part. Design it carefully.

### Core philosophy:
- Minimum hard-coded structure
- Everything connects to everything via a graph
- AI fills in meaning, humans confirm
- Four spaces: personal, family, professional, vision

### Models:

#### User
id, email, handle, name
createdAt, lastActiveAt
altimetrixUserId String? (bridge to Altimetrix)
settings Json @default("{}")

#### Entity
The universal node in the life graph.
Everything is an Entity — a person, a place,
a project, an organisation, a property.

id String @id @default(uuid())
userId String
entityType String // person | place | project | 
                  // organisation | property | other
name String
aliases String[] // other names this entity goes by
description String? // AI-generated summary
attributes Json @default("{}") // flexible key-value
space String @default("personal") 
             // personal | family | professional | vision
status String @default("active") 
              // active | dormant | archived
embedding Unsupported("vector(1536)")? // for semantic search
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt

@@map("entities")

#### Event  
Something that happened, is happening, or needs to happen.
The primary unit of the operations layer.

id String @id @default(uuid())
userId String
title String
rawInput String? // verbatim original (message, note, etc.)
understoodMeaning String? // AI interpretation
eventType String // project_update | financial | 
                 // personal | family | commitment |
                 // milestone | setback | social | health
space String @default("personal")
status String @default("active")
             // active | completed | cancelled | dormant
urgency Float @default(0.5) // 0-1
emotionalWeight Float @default(0.5) // 0-1
occurredAt DateTime?
dueAt DateTime?
completedAt DateTime?
source String? // whatsapp | email | voice | manual | file
rawSourceRef String? // reference to original source
financials Json @default("{}") 
  // { amount, currency, direction, parties, transfers }
people Json @default("[]") 
  // [{ entityId, role }]
places Json @default("[]")
  // [{ entityId, role }]
tags String[]
attachments Json @default("[]")
  // [{ type, path, understoodContent }]
sentToAltimetrix Boolean @default(false)
altimetrixEventType String? // life event type for Altimetrix
notes String?
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt

@@map("events")

#### Vision
Something imagined, planned, or held for the future.
Not a project — a direction.

id String @id @default(uuid())
userId String
title String
summary String? // AI-generated or user-written
status String @default("seed")
              // seed | forming | held | active | 
              // released | archived
rawContent String? // everything dropped into it
tags String[]
embedding Unsupported("vector(1536)")?
inspirations Json @default("[]") 
  // [{ type, path, understoodContent }]
connectedEntities Json @default("[]")
  // [{ entityId, relationship }]
connectedEvents Json @default("[]")
  // [{ eventId, relationship }]
connectedVisions Json @default("[]")
  // [{ visionId, relationship }]
lastTouchedAt DateTime @default(now())
nudgeAfter DateTime? // when to check in next
nudgeCount Int @default(0)
altimetrixNotified Boolean @default(false)
space String @default("personal")
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt

@@map("visions")

#### DiaryEntry
The personal, sensitive inner life layer.
Sealed from operations. Only Altimetrix can 
read this with explicit permission.

id String @id @default(uuid())
userId String
rawContent String // encrypted
understoodThemes String[] // health | relationship | 
                          // emotion | finance | social
people Json @default("[]") // people mentioned
emotionalTone String? // positive | neutral | heavy | mixed
isPrivate Boolean @default(true)
sharedWithAltimetrix Boolean @default(false)
occurredAt DateTime @default(now())
createdAt DateTime @default(now())

@@map("diary_entries")

#### Relationship
A connection between any two entities in the graph.
Typed, weighted, directional.

id String @id @default(uuid())
userId String
fromEntityId String
toEntityId String
relationshipType String 
  // supervises | funds | manages | knows | 
  // family | owns | works_at | contributes_to
strength Float @default(0.5) // 0-1
notes String?
createdAt DateTime @default(now())

@@map("relationships")

#### LifeEvent
Significant events sent to Altimetrix.
The bridge between DIRA and Altimetrix.

id String @id @default(uuid())
userId String
eventId String? // reference to source Event
eventType String 
  // milestone | stuck | decision | commitment |
  // pattern | achievement | setback | relationship_shift
title String
context String? // 1-2 sentence description
linkedGoal String?
people Json @default("[]")
space String
reflectionHint String?
processedByAltimetrix Boolean @default(false)
sentAt DateTime @default(now())

@@map("life_events")

#### InputQueue
Every raw input that comes in, before processing.
The intake point for any format from any source.

id String @id @default(uuid())
userId String
rawContent String // verbatim, encrypted if sensitive
contentType String 
  // text | file | voice | image | url | forward
source String 
  // whatsapp | email | manual | upload | voice
mimeType String?
filePath String?
processingStatus String @default("pending")
  // pending | processing | understood | failed | dismissed
understoodAs String? // what the AI decided this is
resultEntityId String? // what was created
resultEventId String?
resultVisionId String?
resultDiaryId String?
error String?
createdAt DateTime @default(now())
processedAt DateTime?

@@map("input_queue")

### Database setup

Use database name: dira
User: dira_user
Match the pattern from Altimetrix and Maarifa.

Generate migration: initial_schema

### API foundation

Create api/src/index.js with:
- Fastify server on port 4800
  (4700 is Altimetrix, 4800 is DIRA)
- Health check: GET /health
- Register @fastify/cors globally via fastify-plugin
- JWT auth plugin (same pattern as Altimetrix)
- Logging same as Altimetrix

Create api/.env.example:
DATABASE_URL=postgresql://dira_user:password@localhost:5432/dira
JWT_SECRET=your_jwt_secret
PORT=4800
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
ALTIMETRIX_API_URL=http://localhost:4700
ALTIMETRIX_WEBHOOK_SECRET=shared_secret_for_bridge

### deploy.sh

Same pattern as Altimetrix and Maarifa:
- git pull
- npm install in api/ and web/
- prisma migrate deploy
- systemd restart dira-api and dira-web

Report when complete. This is the foundation 
everything else builds on — get the schema right.
