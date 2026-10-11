# DIRA

DIRA is a personal intelligence system. It is not a task manager. It takes input in any format and builds a living picture of a person's life across four layers: operations, visions, relationships, and inner life.

This repository is the foundation: a Fastify API, a Prisma schema for the life graph, and a Next.js 14 scaffold with no product pages yet.

## Prerequisites

- **Node.js** 20 or newer
- **Docker** (for local PostgreSQL with pgvector)

## Getting started

1. Clone the repository and enter the project root.
2. Copy the API environment template and adjust secrets as needed:
   - `cp api/.env.example api/.env`
3. Start PostgreSQL: `docker compose up -d`. Compose uses image **`pgvector/pgvector:pg15`** (the Prisma schema enables the `vector` extension). Credentials match `api/.env.example` (`dira_user` / `password`, database `dira`, host port **`5432`**).
4. Install dependencies:
   - `cd api && npm install`
   - `cd ../web && npm install`
5. From `api/`, apply the schema: `npx prisma migrate deploy` (or `npx prisma migrate dev` while developing).
6. Run the API in development: `cd api && npm run dev`.

## Ports

- **API:** [http://localhost:4800](http://localhost:4800) — health check at `/health`
- **Altimetrix** stays on port 4700. DIRA talks to it through `ALTIMETRIX_API_URL`.

## Data model

The graph is deliberately small. Eight models, four spaces (`personal`, `family`, `professional`, `vision`), and strings instead of enums so new kinds of things do not need a migration.

| Model | Role |
| --- | --- |
| `User` | The person. `altimetrixUserId` is the bridge to Altimetrix. |
| `Entity` | Any node: person, place, project, organisation, property, or other. |
| `Event` | Operations. Something that happened, is happening, or needs to happen. |
| `Vision` | A direction being held, not a project. |
| `DiaryEntry` | Inner life. Sealed. Altimetrix can read a row only when `sharedWithAltimetrix` is true. `rawContent` is stored encrypted. |
| `Relationship` | A typed, weighted, directional edge between two entities. |
| `LifeEvent` | A significant moment sent to Altimetrix. |
| `InputQueue` | Raw intake, any format, before it is understood. |

People, places, and cross-links on events and visions are JSON (`[{ entityId, role }]`, `[{ entityId, relationship }]`) so the AI can propose structure before a human confirms it. Foreign keys are reserved for ownership (`userId`) and for edges that must stay consistent (`Relationship`, `LifeEvent.eventId`, intake results).

## Deploy

`deploy.sh` follows the Altimetrix host layout: pull in `/opt/qusaz/dira`, install, `prisma migrate deploy`, build the web app, then restart `dira-api` and `dira-web`.
