"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  confirmCommand,
  interpretCommand,
  type CommandResult,
} from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

const EXAMPLES = [
  "Change Ntagha to Ntabha in Mbeya land",
  "Which events are in Zanzibar?",
  "Mark Tuliza Nafsi fence as active",
  "When did I buy land in Ntabha?",
];

export default function CommandBar() {
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  openRef.current = open;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  useEffect(() => {
    if (pathname === "/advisor") return;
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (openRef.current) reset();
        else setOpen(true);
      } else if (event.key === "Escape" && openRef.current) {
        reset();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  function reset() {
    requestRef.current += 1;
    setOpen(false);
    setInput("");
    setError(null);
    setResult(null);
    setDone(null);
    setLoading(false);
  }

  function close() {
    reset();
  }

  async function run(value: string) {
    const text = value.trim();
    if (!text || loading) return;
    if (!getAccessToken()) {
      setInput(text);
      setError("Sign in to use commands.");
      setOpen(true);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setInput(text);
    setLoading(true);
    setError(null);
    setDone(null);
    setResult(null);
    try {
      const next = await interpretCommand(text);
      if (requestRef.current !== requestId) return;
      setResult(next);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "Could not run that command.");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void run(input);
  }

  async function onConfirm() {
    if (!result?.commandId || loading) return;
    setLoading(true);
    setError(null);
    try {
      const ids = (result.preview || []).map((item) => item.id);
      const confirmed = await confirmCommand(result.commandId, ids, true);
      setDone(confirmed.changes);
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply that command.");
    } finally {
      setLoading(false);
    }
  }

  async function onCancel() {
    const commandId = result?.commandId;
    setResult(null);
    setError(null);
    if (!commandId) return;
    try {
      await confirmCommand(commandId, [], false);
    } catch {
      /* The preview is already dismissed. */
    }
  }

  if (pathname === "/advisor") return null;

  return (
    <>
      {open ? null : (
        <button
          type="button"
          aria-label="Open command bar"
          onClick={() => setOpen(true)}
          className="fixed inset-x-0 bottom-14 z-[60] flex h-12 items-center gap-3 border-t border-[#2A2A28] bg-[#161614] px-4 text-left"
          style={{ borderTopWidth: "0.5px" }}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3C3489] text-sm text-[#F5F3EE]">
            /
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-[#6B6963]">
            Ask anything or give a command...
          </span>
          <span className="shrink-0 text-[10px] text-[#6B6963]">Ctrl K</span>
        </button>
      )}
      {open ? (
        <div
          className="fixed inset-0 z-[80] bg-[#0E0E0F] px-4 pt-4"
          onClick={close}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command"
            className="mx-auto flex max-h-[calc(100dvh-5.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2A2A28] bg-[#161614]"
            onClick={(event) => event.stopPropagation()}
          >
            <form onSubmit={onSubmit} className="flex items-center gap-2 border-b border-[#2A2A28] p-3">
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask anything or give a command..."
                aria-label="Ask anything or give a command"
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent px-1 py-2 text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
              />
              <button type="button" onClick={close} className="shrink-0 px-2 text-xs text-[#6B6963]">
                Close
              </button>
            </form>

            <div className="overflow-y-auto px-4 py-3">
              {!input.trim() && !result && !done ? (
                <div className="flex flex-col gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => void run(example)}
                      className="rounded-md px-2 py-2 text-left text-sm text-[#6B6963] hover:bg-[#0E0E0F] hover:text-[#F5F3EE]"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              ) : null}

              {loading ? <p className="text-sm text-[#6B6963]">Looking through your records...</p> : null}
              {error ? <p className="text-sm text-[#F5F3EE]">{error}</p> : null}

              {result?.needsClarification && !result.confirmationRequired ? (
                <p className="text-sm leading-6 text-[#F5F3EE]">{result.needsClarification}</p>
              ) : null}

              {result?.answer ? (
                <div>
                  <p className="text-sm leading-6 text-[#F5F3EE]">{result.answer}</p>
                  {result.results?.length ? (
                    <div className="mt-3 flex flex-col gap-2">
                      {result.results.map((record) => (
                        <Link
                          key={`${record.type}-${record.id}`}
                          href={record.href}
                          onClick={close}
                          className="rounded-md border border-[#2A2A28] bg-[#0E0E0F] px-3 py-2"
                        >
                          <div className="text-sm text-[#F5F3EE]">{record.title}</div>
                          {record.subtitle ? (
                            <div className="mt-1 text-xs text-[#6B6963]">{record.subtitle}</div>
                          ) : null}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {result?.confirmationRequired && result.preview?.length ? (
                <div>
                  <p className="text-sm text-[#F5F3EE]">I&apos;ll make these changes:</p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {result.preview.map((item) => (
                      <li key={item.id} className="rounded-md border border-[#2A2A28] bg-[#0E0E0F] px-3 py-2 text-sm">
                        <span className="text-[#F5F3EE]">{item.title}</span>
                        <span className="mt-1 block text-[#6B6963]">{item.change}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void onConfirm()}
                      disabled={loading}
                      className="rounded bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE] disabled:opacity-60"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => void onCancel()}
                      disabled={loading}
                      className="rounded border border-[#2A2A28] px-4 py-2 text-sm text-[#6B6963]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {done ? (
                <div>
                  <p className="text-sm text-[#F5F3EE]">Done.</p>
                  {done.length ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {done.map((change) => (
                        <li key={change} className="text-sm text-[#6B6963]">
                          {change}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-[#6B6963]">Nothing needed changing.</p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
