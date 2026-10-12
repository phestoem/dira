"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getVision,
  getVisionSuggestions,
  linkVisionEvent,
  updateVision,
  type Vision,
} from "@/lib/api";

const STATUSES = [
  { id: "seed", label: "Seed" },
  { id: "forming", label: "Forming" },
  { id: "active", label: "Active" },
  { id: "held", label: "Held" },
  { id: "released", label: "Released" },
];

export default function VisionDetailPage() {
  const params = useParams<{ id: string }>();
  const [vision, setVision] = useState<Vision | null>(null);
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ id: string; title: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getVision(params.id), getVisionSuggestions(params.id)])
      .then(([loaded, page]) => {
        if (cancelled) return;
        apply(loaded);
        setSuggestions(page.suggestions.slice(0, 3));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this vision.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  function apply(loaded: Vision) {
    setVision(loaded);
    setTitle(loaded.title);
    setSummary(loaded.summary ?? "");
    setNotes(loaded.notes ?? "");
  }

  async function saveTitle() {
    if (!vision) return;
    const next = title.trim();
    setEditingTitle(false);
    if (!next || next === vision.title) {
      setTitle(vision.title);
      return;
    }
    try {
      apply(await updateVision(vision.id, { title: next }));
    } catch (err) {
      setTitle(vision.title);
      setError(err instanceof Error ? err.message : "Could not save the title.");
    }
  }

  async function saveSummary() {
    if (!vision || summary.trim() === (vision.summary ?? "")) return;
    try {
      apply(await updateVision(vision.id, { summary: summary.trim() || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the summary.");
    }
  }

  async function saveNotes() {
    if (!vision || notes.trim() === (vision.notes ?? "")) return;
    try {
      apply(await updateVision(vision.id, { notes: notes.trim() || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save notes.");
    }
  }

  async function setStatus(status: string) {
    if (!vision || status === vision.status) return;
    try {
      apply(await updateVision(vision.id, { status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change status.");
    }
  }

  async function addTag() {
    if (!vision) return;
    const tag = tagDraft.trim();
    if (!tag || vision.tags.includes(tag)) {
      setTagDraft("");
      return;
    }
    try {
      apply(await updateVision(vision.id, { tags: [...vision.tags, tag] }));
      setTagDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that tag.");
    }
  }

  async function removeTag(tag: string) {
    if (!vision) return;
    try {
      apply(await updateVision(vision.id, { tags: vision.tags.filter((item) => item !== tag) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that tag.");
    }
  }

  async function remind() {
    if (!vision) return;
    const when = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    try {
      apply(await updateVision(vision.id, { nudgeAfter: when }));
      setNotice("Reminder set for 30 days.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set a reminder.");
    }
  }

  function release() {
    if (!vision) return;
    const ok = window.confirm("Release this vision? It will be archived but not deleted.");
    if (!ok) return;
    void setStatus("released");
  }

  async function linkEvent(eventId: string) {
    if (!vision) return;
    try {
      apply(await linkVisionEvent(vision.id, eventId));
      setSuggestions((current) => current.filter((item) => item.id !== eventId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link that event.");
    }
  }

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-[#2A2A28] px-6 py-4">
        <Link href="/visions" className="text-sm text-[#6B6963] hover:text-[#F5F3EE]">
          Back
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-8">
        {loading ? <p className="text-sm text-[#6B6963]">Loading…</p> : null}
        {error ? <p className="mb-4 text-sm text-red-300/85">{error}</p> : null}
        {notice ? <p className="mb-4 text-sm text-[#6B6963]">{notice}</p> : null}
        {vision ? (
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
              <h1 className="cursor-text text-3xl text-[#F5F3EE]" onClick={() => setEditingTitle(true)}>
                {vision.title}
              </h1>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {STATUSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void setStatus(item.id)}
                  className={`rounded-full px-3 py-1 text-sm ${
                    vision.status === item.id
                      ? "bg-[#3C3489] text-[#F5F3EE]"
                      : "border border-[#2A2A28] text-[#6B6963]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {vision.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => void removeTag(tag)}
                  className="rounded-full border border-[#2A2A28] px-2 py-0.5 text-xs text-[#F5F3EE]"
                >
                  {tag}
                </button>
              ))}
              <input
                value={tagDraft}
                onChange={(input) => setTagDraft(input.target.value)}
                onKeyDown={(input) => {
                  if (input.key === "Enter") {
                    input.preventDefault();
                    void addTag();
                  }
                }}
                placeholder="Add tag"
                className="bg-transparent text-xs text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
              />
            </div>

            {vision.location ? <p className="mt-4 text-sm text-[#6B6963]">{vision.location}</p> : null}
            {vision.detectedFromJournal ? (
              <p className="mt-2 text-xs text-[#6B6963]">Detected from journal</p>
            ) : null}

            <label className="mt-8 block">
              <span className="text-sm text-[#6B6963]">Summary</span>
              <textarea
                value={summary}
                onChange={(input) => setSummary(input.target.value)}
                onBlur={() => void saveSummary()}
                className="mt-2 min-h-24 w-full resize-y border border-[#2A2A28] bg-transparent p-3 text-sm text-[#F5F3EE] outline-none"
              />
            </label>

            {vision.rawContent ? (
              <details className="mt-6">
                <summary className="cursor-pointer text-sm text-[#6B6963]">What you wrote</summary>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[#F5F3EE]/80">
                  {vision.rawContent}
                </p>
              </details>
            ) : null}

            <label className="mt-8 block">
              <span className="text-sm text-[#6B6963]">Supporting notes</span>
              <textarea
                value={notes}
                onChange={(input) => setNotes(input.target.value)}
                onBlur={() => void saveNotes()}
                className="mt-2 min-h-24 w-full resize-y border border-[#2A2A28] bg-transparent p-3 text-sm text-[#F5F3EE] outline-none"
              />
            </label>

            <div className="mt-8 flex flex-wrap gap-4">
              <button type="button" onClick={() => void setStatus("active")} className="text-sm text-[#F5F3EE]">
                This is active now
              </button>
              <button type="button" onClick={release} className="text-sm text-[#6B6963]">
                Let this go
              </button>
              <button type="button" onClick={() => void remind()} className="text-sm text-[#6B6963]">
                Remind me in 30 days
              </button>
            </div>

            <section className="mt-10">
              <h2 className="text-sm text-[#6B6963]">Related events</h2>
              <ul className="mt-3 space-y-2">
                {(vision.connectedEvents || []).map((event) => (
                  <li key={event.eventId}>
                    <Link href={`/events/${event.eventId}`} className="text-sm text-[#F5F3EE] hover:underline">
                      {event.title || "Event"}
                    </Link>
                  </li>
                ))}
                {(vision.connectedEvents || []).length === 0 ? (
                  <li className="text-sm text-[#6B6963]">None yet.</li>
                ) : null}
              </ul>
            </section>

            {suggestions.length > 0 ? (
              <section className="mt-8">
                <h2 className="text-sm text-[#6B6963]">Suggested connections</h2>
                <ul className="mt-3 space-y-2">
                  {suggestions.map((event) => (
                    <li key={event.id} className="flex items-center justify-between gap-4">
                      <Link href={`/events/${event.id}`} className="text-sm text-[#F5F3EE] hover:underline">
                        {event.title}
                      </Link>
                      <button type="button" onClick={() => void linkEvent(event.id)} className="text-xs text-[#7F77DD]">
                        Link this
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        ) : null}
      </main>
    </div>
  );
}
