"use client";

import { useState } from "react";
import { confirmQueueItem, dismissQueueItem, type IntakeSpace, type QueueItem } from "@/lib/api";

const SPACES: Array<{ id: IntakeSpace; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "family", label: "Family" },
  { id: "professional", label: "Professional" },
  { id: "vision", label: "Vision" },
];

export default function QueuePanel({
  open,
  items,
  onClose,
  onChanged,
}: {
  open: boolean;
  items: QueueItem[];
  onClose: () => void;
  onChanged: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-14 z-50 flex max-h-[70vh] flex-col rounded-t-2xl border border-[#2A2A28] bg-[#0E0E0F]">
      <div className="flex items-center justify-between border-b border-[#2A2A28] px-4 py-3">
        <div>
          <p className="text-sm text-[#F5F3EE]">Waiting for review</p>
          <p className="text-[11px] text-[#6B6963]">{items.length}</p>
        </div>
        <button type="button" onClick={onClose} className="px-2 text-lg text-[#6B6963]" aria-label="Close review">
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#6B6963]">You&apos;re all caught up</p>
        ) : (
          <div className="mx-auto flex max-w-[480px] flex-col gap-3">
            {items.map((item) => (
              <QueueCard key={item.id} item={item} onChanged={onChanged} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QueueCard({ item, onChanged }: { item: QueueItem; onChanged: () => void }) {
  const [space, setSpace] = useState<IntakeSpace>(knownSpace(item.suggestedSpace));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (!item.ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await confirmQueueItem(item.id, space);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await dismissQueueItem(item.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't dismiss that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#2A2A28] bg-[#161614] p-4">
      <span className="rounded-full border border-[#2A2A28] px-2 py-0.5 text-[11px] uppercase tracking-wide text-[#6B6963]">
        {sourceLabel(item.source)}
      </span>
      <h2 className="mt-3 text-base font-semibold text-[#F5F3EE]">{item.ready ? item.title : "Reading this email"}</h2>
      {item.summary ? <p className="mt-1 line-clamp-2 text-sm text-[#9B9892]">{item.summary}</p> : null}
      {item.needsClarification ? <p className="mt-2 text-xs text-[#EF9F27]">{item.needsClarification}</p> : null}
      {item.altimetrixContext ? (
        <div
          style={{
            background: "#1A1A2E",
            border: "1px solid #3C3489",
            borderRadius: "8px",
            padding: "12px 14px",
            marginTop: "12px",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              color: "#7F77DD",
              fontWeight: 600,
              marginBottom: "6px",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            From Altimetrix
          </div>
          <div style={{ fontSize: "13px", color: "#9B9892", fontStyle: "italic", lineHeight: "1.6" }}>{item.altimetrixContext}</div>
        </div>
      ) : null}
      {item.ready ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SPACES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setSpace(option.id)}
              className={`rounded-full px-2.5 py-1 text-[11px] ${space === option.id ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-[#EF9F27]">{error}</p> : null}
      <div className="mt-3 flex items-center gap-4">
        {item.ready ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            className="rounded-md bg-[#3C3489] px-3 py-1.5 text-sm text-[#F5F3EE] disabled:opacity-60"
          >
            Confirm
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void dismiss()} className="text-sm text-[#6B6963] disabled:opacity-60">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function sourceLabel(source: string) {
  if (source === "email") return "Email";
  if (source === "manual") return "Manual";
  if (source === "upload") return "Upload";
  return source || "Item";
}

function knownSpace(value: string | null): IntakeSpace {
  if (value === "family" || value === "professional" || value === "vision" || value === "personal") return value;
  return "personal";
}
