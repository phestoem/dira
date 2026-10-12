"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  confirmIntake,
  dismissIntake,
  getStats,
  submitText,
  uploadFile,
  type IntakeResult,
  type IntakeSpace,
} from "@/lib/api";

const SPACES: Array<{ id: IntakeSpace; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "family", label: "Family" },
  { id: "professional", label: "Professional" },
  { id: "vision", label: "Vision" },
];

const ACCEPT = ".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png";

export default function IntakePage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [space, setSpace] = useState<IntakeSpace>("personal");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<"file" | "text">("file");
  const [text, setText] = useState("");
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const [savedSpace, setSavedSpace] = useState<IntakeSpace>("personal");
  const [readyForMore, setReadyForMore] = useState(false);
  const [stats, setStats] = useState<{ events: number; visions: number; entities: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStats()
      .then((counts) => {
        if (!cancelled) setStats(counts);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  function reset() {
    setFileName(null);
    setText("");
    setResult(null);
    setSpace("personal");
    setAnswer("");
    setError(null);
    setSaved(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    if (!file || loading || saving) return;
    const allowed = /\.(xlsx|xls|csv|pdf|jpe?g|png)$/i.test(file.name);
    if (!allowed) {
      setError("Use an Excel, CSV, PDF, or image file.");
      return;
    }

    setError(null);
    setSaved(false);
    setResult(null);
    setAnswer("");
    setSpace("personal");
    setFileName(file.name);
    setLoading(true);
    try {
      const understanding = await uploadFile(file);
      setResult(understanding);
    } catch (err) {
      setFileName(null);
      setError(err instanceof Error ? err.message : "Could not read this file.");
    } finally {
      setLoading(false);
    }
  }

  async function onText() {
    const content = text.trim();
    if (content.length < 10 || loading || saving) return;
    setError(null);
    setSaved(false);
    setResult(null);
    setAnswer("");
    setSpace("personal");
    setFileName(null);
    setLoading(true);
    try {
      setResult(await submitText(content));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this.");
    } finally {
      setLoading(false);
    }
  }

  async function onConfirm() {
    if (!result || saving) return;
    setSaving(true);
    setError(null);
    try {
      const note = answer.trim();
      const corrections = note
        ? { summary: `${result.understood.summary}\n\n${note}` }
        : undefined;
      const title = result.understood.title;
      const chosen = space;
      await confirmIntake(result.queueId, space, corrections);
      reset();
      setSaved(true);
      setSavedTitle(title);
      setSavedSpace(chosen);
      setReadyForMore(false);
      window.setTimeout(() => {
        setSaved(false);
        setSavedTitle(null);
        setReadyForMore(true);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function onDismiss() {
    if (!result || saving) return;
    setSaving(true);
    setError(null);
    try {
      await dismissIntake(result.queueId);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dismiss.");
    } finally {
      setSaving(false);
    }
  }

  const understood = result?.understood;
  const financial = understood?.financial;
  const showMoney = Boolean(financial?.hasFinancials);

  return (
    <div className="min-h-[100dvh]">
      <header className="flex items-center justify-between border-b border-[#2A2A28] px-6 py-4">
        <p className="text-sm tracking-[0.22em] text-[#F5F3EE]">DIRA</p>
        <nav className="flex gap-4 text-sm text-[#6B6963]">
          <Link href="/events" className="hover:text-[#F5F3EE]">Events</Link>
          <Link href="/journal" className="hover:text-[#F5F3EE]">Journal</Link>
        </nav>
      </header>

      <main className="mx-auto grid max-w-5xl gap-8 px-6 py-10 lg:grid-cols-2">
        <section>
          {stats ? (
            <p className="mb-4 text-xs text-[#6B6963]">
              <Link href="/events" className="hover:text-[#F5F3EE]">{stats.events} Events</Link>
              {" · "}
              <Link href="/visions" className="hover:text-[#F5F3EE]">{stats.visions} Visions</Link>
              {" · "}
              <Link href="/entities" className="hover:text-[#F5F3EE]">{stats.entities} Entities</Link>
            </p>
          ) : null}
          <div className="mb-4 flex gap-2">
            {(["file", "text"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded-full px-3 py-1 text-sm ${
                  tab === item ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"
                }`}
              >
                {item === "file" ? "File" : "Text / Message"}
              </button>
            ))}
          </div>

          {tab === "text" ? (
            <div>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={loading || saving}
                placeholder={"Paste a WhatsApp message, write a note, describe what happened..."}
                className="min-h-72 w-full resize-y rounded-lg border border-[#2A2A28] bg-transparent p-4 text-[15px] leading-relaxed text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
              />
              <p className="mt-2 text-sm text-[#6B6963]">Swahili or English, any format</p>
              <button
                type="button"
                onClick={() => void onText()}
                disabled={loading || saving || text.trim().length < 10}
                className="mt-4 rounded bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE] disabled:opacity-60"
              >
                {loading ? "Reading…" : "Understand this"}
              </button>
              {error ? <p className="mt-4 text-sm text-red-300/85">{error}</p> : null}
            </div>
          ) : (
          <>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void onFile(event.dataTransfer.files?.[0]);
            }}
            className={`flex min-h-72 w-full flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center ${
              dragging ? "border-[#3C3489]" : "border-[#2A2A28]"
            } disabled:opacity-60`}
          >
            <UploadIcon />
            <p className="mt-4 text-[#F5F3EE]">
              {loading
                ? "Reading the file…"
                : readyForMore
                  ? "Drop another file or write a note"
                  : "Drop a file or click to upload"}
            </p>
            <p className="mt-2 text-sm text-[#6B6963]">Excel, CSV, PDF, images</p>
            {fileName ? <p className="mt-4 text-sm text-[#F5F3EE]/80">{fileName}</p> : null}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          {error ? <p className="mt-4 text-sm text-red-300/85">{error}</p> : null}
          </>
          )}
        </section>

        <section className="min-h-72">
          {saved && savedTitle ? (
            <p className="text-[#F5F3EE]">
              Saved. {savedTitle} added to your {savedSpace} events.
            </p>
          ) : null}

          {!result && !saved ? (
            <p className="text-sm text-[#6B6963]">
              {readyForMore ? "Drop another file or write a note" : "What DIRA understands will appear here."}
            </p>
          ) : null}

          {understood ? (
            <div>
              <h1 className="text-3xl leading-tight text-[#F5F3EE]">{understood.title}</h1>
              <p className="mt-4 text-[15px] leading-relaxed text-[#F5F3EE]/90">
                {understood.summary}
              </p>
              <p className="mt-4 inline-block rounded-full border border-[#2A2A28] px-3 py-1 text-xs uppercase tracking-wide text-[#6B6963]">
                {understood.contentType.replaceAll("_", " ")}
              </p>

              {understood.location ? (
                <p className="mt-4 text-sm text-[#F5F3EE]/80">{understood.location}</p>
              ) : null}

              {showMoney && financial ? (
                <div className="mt-6">
                  {typeof financial.totalAmount === "number" ? (
                    <p className="text-2xl text-[#F5F3EE]">
                      {formatAmount(financial.totalAmount, financial.currency)}
                    </p>
                  ) : (
                    <p className="text-sm text-[#6B6963]">No total amount</p>
                  )}
                  <p className="mt-1 text-sm text-[#6B6963]">
                    {financial.items.length} line {financial.items.length === 1 ? "item" : "items"}
                  </p>
                </div>
              ) : null}

              {understood.people.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {understood.people.map((name) => {
                    const match = result?.matchingEntities.find(
                      (entity) => entity.name.toLowerCase() === name.toLowerCase(),
                    );
                    const className = "rounded-full border border-[#2A2A28] px-3 py-1 text-xs text-[#F5F3EE]";
                    return match ? (
                      <Link key={name} href={`/entities/${match.id}`} className={className}>
                        {name}
                      </Link>
                    ) : (
                      <span key={name} className={className} title="Becomes an entity when you confirm">
                        {name}
                      </span>
                    );
                  })}
                </div>
              ) : null}

              <div className="mt-6">
                <div className="h-1 w-full max-w-40 overflow-hidden rounded bg-[#2A2A28]">
                  <div
                    className="h-full bg-[#3C3489]"
                    style={{ width: `${Math.round(understood.confidence * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-[#6B6963]">
                  {Math.round(understood.confidence * 100)}% confidence
                </p>
              </div>

              {result?.needsClarification ? (
                <label className="mt-6 block">
                  <span className="text-sm text-[#F5F3EE]/90">{result.needsClarification}</span>
                  <input
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    className="mt-3 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-[#F5F3EE] outline-none"
                  />
                </label>
              ) : null}

              <div className="mt-8 flex flex-wrap gap-2">
                {SPACES.map((item) => {
                  const selected = space === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSpace(item.id)}
                      className={`rounded-full px-3 py-1 text-sm ${
                        selected
                          ? "bg-[#3C3489] text-[#F5F3EE]"
                          : "border border-[#2A2A28] text-[#6B6963]"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-8 flex items-center gap-6">
                <button
                  type="button"
                  onClick={() => void onConfirm()}
                  disabled={saving}
                  className="rounded bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE] disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Confirm and save"}
                </button>
                <button
                  type="button"
                  onClick={() => void onDismiss()}
                  disabled={saving}
                  className="text-sm text-[#6B6963] disabled:opacity-60"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function formatAmount(amount: number, currency: string | null) {
  const formatted = new Intl.NumberFormat("en", {
    maximumFractionDigits: 2,
  }).format(amount);
  return currency ? `${formatted} ${currency}` : formatted;
}

function UploadIcon() {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      className="text-[#6B6963]"
    >
      <path
        d="M18 23V8M18 8l-5 5M18 8l5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 22v4a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
