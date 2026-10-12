"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getVisions,
  listEntities,
  listEvents,
  type EntityRecord,
  type IntakeSpace,
  type LifeEvent,
  type Vision,
} from "@/lib/api";

const KINDS = [
  { id: "all", label: "All" },
  { id: "events", label: "Events" },
  { id: "visions", label: "Visions" },
  { id: "entities", label: "Entities" },
] as const;

const SPACES: Array<{ id: "" | IntakeSpace; label: string }> = [
  { id: "", label: "All" },
  { id: "personal", label: "Personal" },
  { id: "family", label: "Family" },
  { id: "professional", label: "Professional" },
  { id: "vision", label: "Vision" },
];

const SPACE_LABEL: Record<string, string> = {
  personal: "Personal",
  family: "Family",
  professional: "Professional",
  vision: "Vision",
};

type Kind = (typeof KINDS)[number]["id"];

type Row =
  | { kind: "event"; date: number; event: LifeEvent }
  | { kind: "vision"; date: number; vision: Vision }
  | { kind: "entity"; date: number; entity: EntityRecord };

export default function LibraryPage() {
  const [kind, setKind] = useState<Kind>("all");
  const [space, setSpace] = useState<"" | IntakeSpace>("");
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setNeedle(search.trim()), 200);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadLibrary(kind, space, needle)
      .then((page) => {
        if (cancelled) return;
        setRows(page.rows);
        setCursor(page.cursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the library.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, space, needle]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await listEvents(space, cursor, needle);
      setRows((current) => [...current, ...page.events.map(eventRow)]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)]">
      <main className="mx-auto max-w-2xl px-6 py-8">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search everything"
          className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-sm text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
        />

        <div className="mt-5 flex flex-wrap gap-2">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setKind(item.id)}
              className={`rounded-full px-3 py-1 text-sm ${kind === item.id ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SPACES.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setSpace(item.id)}
              className={`rounded-full px-3 py-1 text-xs ${space === item.id ? "text-[#F5F3EE]" : "text-[#6B6963]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
        {loading && rows.length === 0 ? <p className="mt-8 text-sm text-[#6B6963]">Loading…</p> : null}
        {!loading && !error && rows.length === 0 ? (
          <p className="mt-8 text-sm text-[#6B6963]">Nothing here yet. Talk to DIRA and it will show up.</p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {rows.map((row) => (
            <li key={`${row.kind}-${row.kind === "event" ? row.event.id : row.kind === "vision" ? row.vision.id : row.entity.id}`}>
              {row.kind === "event" ? <EventCard event={row.event} /> : null}
              {row.kind === "vision" ? <VisionCard vision={row.vision} /> : null}
              {row.kind === "entity" ? <EntityCard entity={row.entity} /> : null}
            </li>
          ))}
        </ul>

        {cursor && (kind === "all" || kind === "events") ? (
          <button type="button" onClick={() => void loadMore()} disabled={loading} className="mt-6 text-sm text-[#6B6963] disabled:opacity-60">
            {loading ? "Loading…" : "Older"}
          </button>
        ) : null}
      </main>
    </div>
  );
}

function EventCard({ event }: { event: LifeEvent }) {
  const amount = event.financials?.amount;
  return (
    <Link href={`/events/${event.id}`} className="block rounded-lg border border-[#2A2A28] px-4 py-4 hover:border-[#3C3489]">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg text-[#F5F3EE]">{event.title}</h2>
        {typeof amount === "number" ? (
          <p className="shrink-0 text-lg text-[#F5F3EE]">{formatAmount(amount, event.financials?.currency ?? null)}</p>
        ) : null}
      </div>
      {event.understoodMeaning ? <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[#F5F3EE]/80">{event.understoodMeaning}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#6B6963]">
        <span className="rounded-full border border-[#2A2A28] px-2 py-0.5 uppercase tracking-wide">{event.eventType.replaceAll("_", " ")}</span>
        <span className="rounded-full border border-[#2A2A28] px-2 py-0.5">{SPACE_LABEL[event.space] ?? event.space}</span>
        <span>
          {event.occurredAt ? "Date" : "Added"}: {formatWhen(event.occurredAt || event.createdAt)}
        </span>
      </div>
    </Link>
  );
}

function VisionCard({ vision }: { vision: Vision }) {
  return (
    <Link href={`/visions/${vision.id}`} className="block rounded-lg border border-[#2A2A28] px-4 py-4 hover:border-[#3C3489]">
      <div className="flex items-start justify-between gap-4">
        <h2 className="flex items-center gap-2 text-lg text-[#F5F3EE]">
          <CompassIcon />
          {vision.title}
        </h2>
        <span className="shrink-0 rounded-full border border-[#2A2A28] px-2 py-0.5 text-xs text-[#6B6963]">{vision.status}</span>
      </div>
      {vision.summary ? <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[#F5F3EE]/80">{vision.summary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#6B6963]">
        <span>{SPACE_LABEL[vision.space] ?? vision.space}</span>
        {vision.location ? <span>{vision.location}</span> : null}
        <span>{formatWhen(vision.lastTouchedAt || vision.createdAt)}</span>
      </div>
    </Link>
  );
}

function EntityCard({ entity }: { entity: EntityRecord }) {
  const related = (entity.eventCount || 0) + (entity.visionCount || 0);
  return (
    <Link href={`/entities/${entity.id}`} className="block rounded-lg border border-[#2A2A28] px-4 py-4 hover:border-[#3C3489]">
      <h2 className="text-lg text-[#F5F3EE]">{entity.name}</h2>
      <p className="mt-2 text-xs text-[#6B6963]">
        {entity.entityType}
        {related ? ` · ${related} related` : ""}
      </p>
    </Link>
  );
}

async function loadLibrary(kind: Kind, space: "" | IntakeSpace, search: string) {
  const wantEvents = kind === "all" || kind === "events";
  const wantVisions = kind === "all" || kind === "visions";
  const wantEntities = kind === "entities" || (kind === "all" && search.length >= 2);
  const [eventsPage, visionsPage, entitiesPage] = await Promise.all([
    wantEvents ? listEvents(space, null, search) : Promise.resolve({ events: [], nextCursor: null }),
    wantVisions ? getVisions("") : Promise.resolve({ visions: [] }),
    wantEntities ? listEntities({ space: space || undefined, search: search || undefined }) : Promise.resolve({ entities: [] }),
  ]);
  const visions = visionsPage.visions.filter((vision) => {
    if (space && vision.space !== space) return false;
    if (!search) return true;
    const blob = `${vision.title} ${vision.summary || ""} ${vision.location || ""}`.toLowerCase();
    return blob.includes(search.toLowerCase());
  });
  const rows = [
    ...eventsPage.events.map(eventRow),
    ...visions.map(visionRow),
    ...entitiesPage.entities.map(entityRow),
  ].sort((left, right) => right.date - left.date);
  return { rows, cursor: eventsPage.nextCursor };
}

function eventRow(event: LifeEvent): Row {
  return { kind: "event", date: timeOf(event.occurredAt || event.createdAt), event };
}

function visionRow(vision: Vision): Row {
  return { kind: "vision", date: timeOf(vision.lastTouchedAt || vision.createdAt), vision };
}

function entityRow(entity: EntityRecord): Row {
  return { kind: "entity", date: timeOf(entity.createdAt), entity };
}

function timeOf(value?: string | null) {
  const date = value ? new Date(value).getTime() : 0;
  return Number.isNaN(date) ? 0 : date;
}

function formatWhen(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatAmount(amount: number, currency: string | null) {
  return `${amount.toLocaleString("en-US")} ${currency || ""}`.trim();
}

function CompassIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-[#7F77DD]">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="m14.8 9.2-1.6 4.2-4.2 1.6 1.6-4.2 4.2-1.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
