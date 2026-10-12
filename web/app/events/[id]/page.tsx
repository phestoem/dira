"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  archiveEvent,
  getEvent,
  updateEvent,
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
  const router = useRouter();
  const [event, setEvent] = useState<LifeEvent | null>(null);
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
  const people = (event?.people ?? [])
    .map((person) => person.name)
    .filter((name): name is string => Boolean(name));

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

            {people.length > 0 ? (
              <p className="mt-6 text-sm text-[#F5F3EE]/80">{people.join(", ")}</p>
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
