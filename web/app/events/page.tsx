"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listEvents, type IntakeSpace, type LifeEvent } from "@/lib/api";

const FILTERS: Array<{ id: "" | IntakeSpace; label: string }> = [
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

export default function EventsPage() {
  const [space, setSpace] = useState<"" | IntakeSpace>("");
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEvents(space)
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load events.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [space]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await listEvents(space, cursor);
      setEvents((current) => [...current, ...page.events]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load events.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh]">
      <header className="flex items-center justify-between border-b border-[#2A2A28] px-6 py-4">
        <Link href="/intake" className="text-sm tracking-[0.22em] text-[#F5F3EE]">
          DIRA
        </Link>
        <Link href="/intake" className="text-sm text-[#F5F3EE]">
          New +
        </Link>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setSpace(item.id)}
              className={`rounded-full px-3 py-1 text-sm ${
                space === item.id
                  ? "bg-[#3C3489] text-[#F5F3EE]"
                  : "border border-[#2A2A28] text-[#6B6963]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
        {loading && events.length === 0 ? (
          <p className="mt-8 text-sm text-[#6B6963]">Loading…</p>
        ) : null}
        {!loading && !error && events.length === 0 ? (
          <p className="mt-8 text-sm text-[#6B6963]">Nothing saved yet.</p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {events.map((event) => {
            const amount = event.financials?.amount;
            return (
              <li key={event.id}>
                <Link
                  href={`/events/${event.id}`}
                  className="block rounded-lg border border-[#2A2A28] px-4 py-4 hover:border-[#3C3489]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <h2 className="text-lg text-[#F5F3EE]">{event.title}</h2>
                    {typeof amount === "number" ? (
                      <p className="shrink-0 text-lg text-[#F5F3EE]">
                        {formatAmount(amount, event.financials?.currency ?? null)}
                      </p>
                    ) : null}
                  </div>
                  {event.understoodMeaning ? (
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[#F5F3EE]/80">
                      {event.understoodMeaning}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#6B6963]">
                    <span className="rounded-full border border-[#2A2A28] px-2 py-0.5 uppercase tracking-wide">
                      {event.eventType.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-full border border-[#2A2A28] px-2 py-0.5">
                      {SPACE_LABEL[event.space] ?? event.space}
                    </span>
                    {event.location ? <span>{event.location}</span> : null}
                    <span>{formatWhen(event.createdAt)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>

        {cursor ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="mt-6 text-sm text-[#6B6963] disabled:opacity-60"
          >
            {loading ? "Loading…" : "Older"}
          </button>
        ) : null}
      </main>
    </div>
  );
}

function formatAmount(amount: number, currency: string | null) {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(amount);
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
