"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import {
  archiveEvent,
  createEntity,
  getEvent,
  linkEntity,
  listEntities,
  updateEvent,
  type EntityRecord,
  type EntityType,
  type IntakeSpace,
  type LifeEvent,
} from "@/lib/api";

const SPACES: Array<{ id: IntakeSpace; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "family", label: "Family" },
  { id: "professional", label: "Professional" },
  { id: "vision", label: "Vision" },
];

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const highlight = searchParams.get("q") || "";
  const [showFullText, setShowFullText] = useState(false);
  const [event, setEvent] = useState<LifeEvent | null>(null);
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [entityQuery, setEntityQuery] = useState("");
  const [entityHits, setEntityHits] = useState<EntityRecord[]>([]);
  const [newType, setNewType] = useState<EntityType>("person");

  useEffect(() => {
    let cancelled = false;
    getEvent(params.id)
      .then((loaded) => {
        if (cancelled) return;
        setEvent(loaded);
        setTitle(loaded.title);
        setNotes(loaded.notes ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this event.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function saveTitle() {
    if (!event) return;
    const next = title.trim();
    setEditingTitle(false);
    if (!next || next === event.title) {
      setTitle(event.title);
      return;
    }
    try {
      const updated = await updateEvent(event.id, { title: next });
      setEvent(updated);
      setTitle(updated.title);
    } catch (err) {
      setTitle(event.title);
      setError(err instanceof Error ? err.message : "Could not save the title.");
    }
  }

  async function saveNotes() {
    if (!event) return;
    const next = notes.trim();
    if (next === (event.notes ?? "")) return;
    try {
      const updated = await updateEvent(event.id, { notes: next });
      setEvent(updated);
      setNotes(updated.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save notes.");
    }
  }

  async function changeSpace(space: IntakeSpace) {
    if (!event || space === event.space) return;
    try {
      setEvent(await updateEvent(event.id, { space }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change space.");
    }
  }

  useEffect(() => {
    const needle = entityQuery.trim();
    if (!linking || needle.length < 2) {
      setEntityHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      listEntities({ search: needle })
        .then((page) => {
          if (!cancelled) setEntityHits(page.entities.slice(0, 6));
        })
        .catch(() => {
          if (!cancelled) setEntityHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [entityQuery, linking]);

  async function attachEntity(entity: EntityRecord) {
    if (!event) return;
    try {
      await linkEntity(entity.id, {
        targetId: event.id,
        targetType: "event",
        relationship: entity.entityType,
      });
      setEvent(await getEvent(event.id));
      setLinking(false);
      setEntityQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link that entity.");
    }
  }

  async function createAndLink() {
    if (!event) return;
    const name = entityQuery.trim();
    if (!name) return;
    try {
      const entity = await createEntity({ name, entityType: newType, space: event.space });
      await attachEntity(entity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that entity.");
    }
  }

  async function toggleMilestone() {
    if (!event) return;
    const next = event.altimetrixEventType === "milestone" ? null : "milestone";
    try {
      setEvent(await updateEvent(event.id, { altimetrixEventType: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this event.");
    }
  }

  async function archive() {
    if (!event) return;
    try {
      await archiveEvent(event.id);
      router.push("/events");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive.");
    }
  }

  const items = event?.financials?.items ?? [];
  const amount = event?.financials?.amount;
  const people = (event?.people ?? []).filter((person) => person.name);
  const places = (event?.places ?? []).filter((place) => place.name || place.entityId);

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-[#2A2A28] px-6 py-4">
        <Link href="/events" className="text-sm text-[#6B6963] hover:text-[#F5F3EE]">
          Back
        </Link>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        {loading ? <p className="text-sm text-[#6B6963]">Loading…</p> : null}
        {error ? <p className="mb-4 text-sm text-red-300/85">{error}</p> : null}

        {event ? (
          <article>
            {editingTitle ? (
              <input
                value={title}
                autoFocus
                onChange={(input) => setTitle(input.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(input) => {
                  if (input.key === "Enter") input.currentTarget.blur();
                }}
                className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent text-3xl text-[#F5F3EE] outline-none"
              />
            ) : (
              <h1
                className="cursor-text text-3xl leading-tight text-[#F5F3EE]"
                onClick={() => setEditingTitle(true)}
              >
                {event.title}
              </h1>
            )}

            {event.understoodMeaning ? (
              <p className="mt-4 text-[15px] leading-relaxed text-[#F5F3EE]/90">
                {event.understoodMeaning}
              </p>
            ) : null}

            <section className="mt-6">
              <button
                type="button"
                onClick={() => setShowFullText((open) => !open)}
                className="text-sm text-[#6B6963] hover:text-[#F5F3EE]"
                aria-expanded={showFullText}
              >
                Read full document {showFullText ? "▲" : "▼"}
              </button>
              {showFullText ? (
                <div className="mt-3 text-[15px] leading-relaxed text-[#F5F3EE]/90">
                  {event.fullText ? (
                    <p className="whitespace-pre-wrap">{highlightText(event.fullText, highlight)}</p>
                  ) : (
                    <p className="text-[#6B6963]">
                      Full text not available for this document (uploaded before this feature)
                    </p>
                  )}
                </div>
              ) : null}
            </section>

            <dl className="mt-6 space-y-2 text-sm text-[#6B6963]">
              <div>Type · {event.eventType.replaceAll("_", " ")}</div>
              <div>Space · {event.space}</div>
              {event.location ? <div>Place · {event.location}</div> : null}
              <div>Date · {formatWhen(event.createdAt)}</div>
              {event.source ? <div>Source · {event.source}</div> : null}
            </dl>

            {typeof amount === "number" || items.length > 0 ? (
              <section className="mt-8">
                {typeof amount === "number" ? (
                  <p className="text-3xl text-[#F5F3EE]">
                    {formatAmount(amount, event.financials?.currency ?? null)}
                  </p>
                ) : null}
                {items.length > 0 ? (
                  <table className="mt-4 w-full text-left text-sm">
                    <thead className="text-[#6B6963]">
                      <tr>
                        <th className="py-2 font-normal">Item</th>
                        <th className="py-2 font-normal">Amount</th>
                        <th className="py-2 font-normal">Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => (
                        <tr key={`${item.description}-${index}`} className="border-t border-[#2A2A28]">
                          <td className="py-2 pr-4 text-[#F5F3EE]">{item.description || "—"}</td>
                          <td className="py-2 pr-4 text-[#F5F3EE]">
                            {typeof item.amount === "number" ? formatAmount(item.amount, null) : "—"}
                          </td>
                          <td className="py-2 text-[#6B6963]">{item.currency || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </section>
            ) : null}

            {people.length > 0 || places.length > 0 ? (
              <div className="mt-6 flex flex-wrap gap-2">
                {people.map((person, index) =>
                  person.entityId ? (
                    <Link
                      key={person.entityId}
                      href={`/entities/${person.entityId}`}
                      className="rounded-full border border-[#2A2A28] px-3 py-1 text-xs text-[#F5F3EE]"
                    >
                      {person.name}
                    </Link>
                  ) : (
                    <span key={`${person.name}-${index}`} className="rounded-full border border-[#2A2A28] px-3 py-1 text-xs text-[#F5F3EE]">
                      {person.name}
                    </span>
                  ),
                )}
                {places.map((place, index) =>
                  place.entityId ? (
                    <Link
                      key={place.entityId}
                      href={`/entities/${place.entityId}`}
                      className="rounded-full border border-[#2A2A28] px-3 py-1 text-xs text-[#7F77DD]"
                    >
                      {place.name || "Place"}
                    </Link>
                  ) : (
                    <span key={`${place.name}-${index}`} className="text-xs text-[#6B6963]">
                      {place.name}
                    </span>
                  ),
                )}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button type="button" onClick={() => setLinking(true)} className="text-sm text-[#6B6963]">
                Link to entity
              </button>
              <button type="button" onClick={() => void toggleMilestone()} className="text-sm text-[#6B6963]">
                {event.altimetrixEventType === "milestone" ? "Milestone" : "Mark as milestone"}
              </button>
            </div>

            {linking ? (
              <div className="mt-4 rounded-lg border border-[#2A2A28] p-4">
                <input
                  value={entityQuery}
                  onChange={(input) => setEntityQuery(input.target.value)}
                  placeholder="Find or create an entity"
                  className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-sm text-[#F5F3EE] outline-none"
                />
                <ul className="mt-3 space-y-2">
                  {entityHits.map((entity) => (
                    <li key={entity.id}>
                      <button type="button" onClick={() => void attachEntity(entity)} className="text-sm text-[#F5F3EE]">
                        {entity.name}
                        <span className="text-[#6B6963]"> · {entity.entityType}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {(["person", "place", "project", "property", "organisation", "other"] as EntityType[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setNewType(item)}
                      className={`rounded-full px-2 py-0.5 text-xs capitalize ${
                        newType === item ? "bg-[#3C3489] text-[#F5F3EE]" : "text-[#6B6963]"
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex gap-4">
                  <button type="button" onClick={() => void createAndLink()} className="text-sm text-[#F5F3EE]">
                    Create and link
                  </button>
                  <button type="button" onClick={() => setLinking(false)} className="text-sm text-[#6B6963]">
                    Close
                  </button>
                </div>
              </div>
            ) : null}

            <label className="mt-8 block">
              <span className="text-sm text-[#6B6963]">Notes</span>
              <textarea
                value={notes}
                onChange={(input) => setNotes(input.target.value)}
                onBlur={() => void saveNotes()}
                className="mt-2 min-h-28 w-full resize-y border border-[#2A2A28] bg-transparent p-3 text-sm text-[#F5F3EE] outline-none"
              />
            </label>

            <div className="mt-6 flex flex-wrap gap-2">
              {SPACES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void changeSpace(item.id)}
                  className={`rounded-full px-3 py-1 text-sm ${
                    event.space === item.id
                      ? "bg-[#3C3489] text-[#F5F3EE]"
                      : "border border-[#2A2A28] text-[#6B6963]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void archive()}
              className="mt-16 text-sm text-[#6B6963]"
            >
              Archive
            </button>
          </article>
        ) : null}
      </main>
    </div>
  );
}

function highlightText(text: string, query: string): ReactNode {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term, index, all) => term.length >= 2 && all.findIndex((item) => item.toLowerCase() === term.toLowerCase()) === index);
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return text.split(pattern).map((part, index) =>
    terms.some((term) => part.toLowerCase() === term.toLowerCase()) ? (
      <mark key={index} className="bg-[#3C3489]/60 text-[#F5F3EE]">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatAmount(amount: number, currency: string | null) {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(amount);
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
