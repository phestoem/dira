"use client";

import Link from "next/link";
import { Children, cloneElement, FormEvent, isValidElement, ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import QueuePanel from "@/components/QueuePanel";
import {
  archiveEvent,
  getAdvisorSuggestions,
  getQueue,
  homeConfirm,
  homeInput,
  type CommandRecord,
  type CommandResult,
  type HomeLastAction,
  type HomeResponse,
  type IntakeFinancial,
  type IntakeSpace,
  type QueueItem,
} from "@/lib/api";

const ACCEPT = ".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png";
const SPACES: Array<{ id: IntakeSpace; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "family", label: "Family" },
  { id: "professional", label: "Professional" },
  { id: "vision", label: "Vision" },
];

const FALLBACK_SUGGESTIONS = [
  "What should I focus on this week?",
  "Help me plan the next phase of what I'm building",
  "How am I tracking against my plans?",
];

type Turn = {
  id: string;
  role: "user" | "dira";
  text?: string;
  response?: HomeResponse;
  busy?: boolean;
  resolved?: boolean;
};

type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type BrowserSpeech = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export default function HomePage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<BrowserSpeech | null>(null);
  const messagesRef = useRef<Turn[]>([]);
  const lastActionRef = useRef<HomeLastAction | null>(null);
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages, busy]);

  useEffect(() => {
    let cancelled = false;
    const loadQueue = () => {
      getQueue()
        .then((items) => {
          if (!cancelled) setQueue(items);
        })
        .catch(() => {
          /* The banner stays hidden when the queue cannot be read. */
        });
    };
    loadQueue();
    const timer = window.setInterval(loadQueue, 60000);
    window.addEventListener("focus", loadQueue);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", loadQueue);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAdvisorSuggestions()
      .then((items) => {
        if (!cancelled && items.length) setSuggestions(items.slice(0, 3));
      })
      .catch(() => {
        /* The empty state keeps the built-in prompts. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(raw: string, attached = file) {
    const text = raw.trim();
    if (busy || (!text && !attached)) return;
    const history = historyFrom(messagesRef.current);
    const userTurn: Turn = {
      id: newId(),
      role: "user",
      text: [text, attached ? attached.name : ""].filter(Boolean).join("\n"),
    };
    const pending: Turn = { id: newId(), role: "dira", busy: true };
    const correcting = looksLikeCorrection(text);
    setMessages((current) => {
      const prior = correcting
        ? current.map((turn) => (turn.response?.result.confirmationRequired && !turn.resolved ? { ...turn, resolved: true } : turn))
        : current;
      return [...prior, userTurn, pending];
    });
    setInput("");
    setFile(null);
    setBusy(true);
    try {
      const response = await homeInput(text, attached, history, lastActionRef.current);
      lastActionRef.current = toLastAction(response);
      setMessages((current) => current.map((turn) => (turn.id === pending.id ? { ...turn, busy: false, response } : turn)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "DIRA couldn't take that in just now.";
      setMessages((current) =>
        current.map((turn) =>
          turn.id === pending.id
            ? { ...turn, busy: false, text: message }
            : turn,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function followUp(turnId: string, run: () => Promise<HomeResponse>) {
    if (busy) return;
    setBusy(true);
    setMessages((current) => current.map((turn) => (turn.id === turnId ? { ...turn, resolved: true } : turn)));
    const pending: Turn = { id: newId(), role: "dira", busy: true };
    setMessages((current) => [...current, pending]);
    try {
      const response = await run();
      lastActionRef.current = toLastAction(response);
      setMessages((current) => current.map((turn) => (turn.id === pending.id ? { ...turn, busy: false, response } : turn)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't finish that.";
      setMessages((current) => current.map((turn) => (turn.id === pending.id ? { ...turn, busy: false, text: message } : turn)));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function askCorrection() {
    inputRef.current?.focus();
  }

  async function undo(turn: Turn) {
    const eventId = eventIdOf(turn.response?.result.content);
    if (eventId) {
      setBusy(true);
      try {
        await archiveEvent(eventId);
        setMessages((current) =>
          current.map((item) => (item.id === turn.id ? { ...item, response: undefined, text: "Undone." } : item)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't undo that.";
        setMessages((current) => [...current, { id: newId(), role: "dira", text: message }]);
      } finally {
        setBusy(false);
      }
      return;
    }
    const sessionId = turn.response?.sessionId;
    if (sessionId && turn.response?.result.confirmationRequired && !turn.resolved) {
      await followUp(turn.id, () => homeConfirm(sessionId, false));
      return;
    }
    askCorrection();
  }

  function onVoice() {
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const recognition = createRecognizer();
    if (!recognition) {
      setMessages((current) => [
        ...current,
        { id: newId(), role: "dira", text: "Voice isn't available in this browser. Type it instead." },
      ]);
      return;
    }
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || "";
      if (transcript.trim()) {
        setInput(transcript);
        void send(transcript);
      }
    };
    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    setRecording(true);
    recognition.start();
  }

  const canSend = Boolean(input.trim() || file);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        {queue.length > 0 ? (
          <div className="sticky top-3 z-10 flex justify-center px-4">
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              className="rounded-full px-3 py-1.5 text-xs text-[#F5F3EE]"
              style={{ background: "#1A1A2E", border: "1px solid #3C3489" }}
            >
              {queue.length} {queue.length === 1 ? "item" : "items"} waiting for review
            </button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 pb-[120px] text-center">
            <CompassMark />
            <p className="mt-4 text-lg text-[#F5F3EE]">What&apos;s on your mind?</p>
            <div className="mt-6 flex max-w-md flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion, null)}
                  className="rounded-full border border-[#2A2A28] px-3 py-2 text-sm text-[#6B6963] hover:border-[#4A4A48] hover:text-[#9B9892]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="mt-6 text-xs text-[#3A3A38]">Type, attach a file, or speak</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pb-[120px] pt-8">
            {messages.map((turn) => (
              <Message
                key={turn.id}
                turn={turn}
                busy={busy}
                onConfirm={(space, occurredAt) =>
                  void followUp(turn.id, () =>
                    homeConfirm(turn.response?.sessionId || "", true, { space, occurredAt }),
                  )
                }
                onDismiss={() => void followUp(turn.id, () => homeConfirm(turn.response?.sessionId || "", false))}
                onOption={(intent) =>
                  void followUp(turn.id, () =>
                    homeConfirm(turn.response?.sessionId || "", true, { selectedOption: intent }),
                  )
                }
                onCorrect={askCorrection}
                onUndo={() => void undo(turn)}
              />
            ))}
          </div>
        )}
      </div>

      <QueuePanel
        open={queueOpen}
        items={queue}
        onClose={() => setQueueOpen(false)}
        onChanged={() => {
          getQueue().then(setQueue).catch(() => setQueue([]));
        }}
      />

      <form onSubmit={onSubmit} className="fixed inset-x-0 bottom-14 z-40 px-3 pb-3 sm:px-4">
        {file ? (
          <div className="mx-auto mb-2 flex max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#2A2A28] bg-[#1A1A18] px-3 py-1 text-xs text-[#F5F3EE]">
              {file.name}
              <button type="button" onClick={() => setFile(null)} className="text-[#6B6963]" aria-label="Remove file">
                ×
              </button>
            </span>
          </div>
        ) : null}
        <div className="mx-auto flex max-w-2xl items-center gap-1 rounded-full border border-[#2A2A28] bg-[#1A1A18] py-1.5 pl-1.5 pr-1.5 focus-within:border-[#3C3489] focus-within:shadow-[0_0_0_2px_rgba(60,52,137,0.2)] sm:gap-2 sm:py-3 sm:pl-4 sm:pr-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-[#6B6963] hover:text-[#F5F3EE]"
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (next && /\.(xlsx|xls|csv|pdf|jpe?g|png)$/i.test(next.name)) setFile(next);
              event.target.value = "";
            }}
          />
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Talk to DIRA..."
            className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-[#F5F3EE] outline-none placeholder:text-[#4A4A48]"
          />
          <button
            type="button"
            onClick={onVoice}
            aria-label={recording ? "Stop recording" : "Use voice"}
            className={`flex h-11 w-11 shrink-0 items-center justify-center hover:text-[#F5F3EE] ${recording ? "animate-pulse text-[#E84747]" : "text-[#6B6963]"}`}
          >
            <MicIcon />
          </button>
          <button
            type="submit"
            aria-label="Send"
            disabled={!canSend || busy}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#F5F3EE] disabled:cursor-default ${canSend ? "bg-[#3C3489]" : "bg-[#2A2A28]"}`}
          >
            <ArrowIcon />
          </button>
        </div>
      </form>
    </div>
  );
}

function Message({
  turn,
  busy,
  onConfirm,
  onDismiss,
  onOption,
  onCorrect,
  onUndo,
}: {
  turn: Turn;
  busy: boolean;
  onConfirm: (space: IntakeSpace, occurredAt: string | null) => void;
  onDismiss: () => void;
  onOption: (intent: string) => void;
  onCorrect: () => void;
  onUndo: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  if (turn.role === "user") {
    return (
      <p
        className="dira-in ml-auto max-w-[70%] border border-[#2A2A28] bg-[#1A1A18] px-3.5 py-2.5 text-[15px] italic leading-6 text-[#9B9892]"
        style={{ borderWidth: "0.5px", borderRadius: "18px 18px 4px 18px" }}
      >
        {turn.text}
      </p>
    );
  }
  if (turn.busy) {
    return (
      <div className="dira-in ml-4 flex items-center gap-1.5 py-2" aria-label="DIRA is thinking">
        <span className="dira-dot h-1.5 w-1.5 rounded-full bg-[#4A4A48]" />
        <span className="dira-dot h-1.5 w-1.5 rounded-full bg-[#4A4A48]" />
        <span className="dira-dot h-1.5 w-1.5 rounded-full bg-[#4A4A48]" />
      </div>
    );
  }
  if (turn.text && !turn.response) {
    return (
      <div className="dira-in ml-4 max-w-[90%]">
        <DiraMarkdown text={turn.text} />
      </div>
    );
  }
  const response = turn.response;
  if (!response) return null;
  const acted = response.routing.confidence > 0.8 && actedResult(response);
  const unsure = response.routing.confidence < 0.8 && response.result.type !== "clarification";
  return (
    <div className="dira-in my-2 ml-4 max-w-[95%]">
      <ResponseBody
        response={response}
        resolved={Boolean(turn.resolved)}
        busy={busy}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
        onOption={onOption}
      />
      {unsure && !accepted ? (
        <p className="mt-2 text-[11px] text-[#4A4A48]">
          I interpreted this as {intentPhrase(response.routing.intent)} — is that right?{" "}
          <button type="button" onClick={() => setAccepted(true)} className="underline">
            Yes
          </button>
          {" | "}
          <button type="button" onClick={onCorrect} className="underline">
            No, I meant...
          </button>
        </p>
      ) : null}
      {acted ? (
        <p className="mt-2 text-[11px] text-[#4A4A48]">
          Saved as {savedKind(response)} ·{" "}
          <button type="button" onClick={onUndo} className="underline">
            Undo
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ResponseBody({
  response,
  resolved,
  busy,
  onConfirm,
  onDismiss,
  onOption,
}: {
  response: HomeResponse;
  resolved: boolean;
  busy: boolean;
  onConfirm: (space: IntakeSpace, occurredAt: string | null) => void;
  onDismiss: () => void;
  onOption: (intent: string) => void;
}) {
  const { result } = response;
  if (result.type === "understanding") {
    const understanding = asUnderstanding(result.content);
    if (!understanding) return <DiraMarkdown text={result.confirmationText || ""} />;
    return (
      <UnderstandingCard
        content={understanding}
        prompt={result.confirmationText}
        resolved={resolved}
        busy={busy}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />
    );
  }
  if (result.type === "command_preview" || result.type === "correction_preview") {
    const command = asCommand(result.content);
    const preview = command?.preview || previewItems(result.content);
    return (
      <div>
        {result.confirmationText ? <DiraMarkdown text={result.confirmationText} /> : null}
        {preview.length ? (
          <ul className="mt-3 flex flex-col gap-2">
            {preview.map((item) => (
              <li key={item.id} className="rounded-md border border-[#2A2A28] bg-[#161614] px-3 py-2 text-sm">
                <span className="text-[#F5F3EE]">{item.title}</span>
                <span className="mt-1 block text-[#6B6963]">{item.change}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result.confirmationRequired && !resolved ? <ConfirmRow busy={busy} onConfirm={() => onConfirm("personal", null)} onDismiss={onDismiss} confirmLabel="Confirm" /> : null}
      </div>
    );
  }
  if (result.type === "clarification") {
    return (
      <div>
        <p className="text-sm leading-[1.8] text-[#F5F3EE]">Did you mean:</p>
        {!resolved ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {(response.clarificationOptions || []).map((option) => (
              <button
                key={option.intent}
                type="button"
                disabled={busy}
                onClick={() => onOption(option.intent)}
                title={option.description}
                className="rounded-full border border-[#2A2A28] bg-[#161614] px-3 py-2 text-sm text-[#9B9892] hover:border-[#3C3489] disabled:opacity-60"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (result.type === "journal_saved" && result.confirmationRequired) {
    return (
      <div>
        <DiraMarkdown text={result.confirmationText || ""} />
        {!resolved ? <ConfirmRow busy={busy} onConfirm={() => onConfirm("personal", null)} onDismiss={onDismiss} confirmLabel="Save" /> : null}
      </div>
    );
  }
  if (result.type === "journal_saved") {
    return <DiraMarkdown text="Saved ✓" />;
  }
  const answer = asAnswer(result.content);
  const reply = answer?.reply || messageOf(result.content) || result.confirmationText || "";
  return (
    <div>
      <DiraMarkdown text={reply} />
      {answer?.results?.length ? (
        <div className="mt-3 flex flex-col gap-2">
          {answer.results.map((record) => (
            <Link key={`${record.type}-${record.id}`} href={record.href} className="rounded-md border border-[#2A2A28] bg-[#161614] px-3 py-2">
              <div className="text-sm text-[#F5F3EE]">{record.title}</div>
              {record.subtitle ? <div className="mt-1 text-xs text-[#6B6963]">{record.subtitle}</div> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UnderstandingCard({
  content,
  prompt,
  resolved,
  busy,
  onConfirm,
  onDismiss,
}: {
  content: UnderstandingContent;
  prompt: string | null;
  resolved: boolean;
  busy: boolean;
  onConfirm: (space: IntakeSpace, occurredAt: string | null) => void;
  onDismiss: () => void;
}) {
  const understood = content.understood;
  const [space, setSpace] = useState<IntakeSpace>(content.suggestedSpace || "personal");
  const [occurredAt, setOccurredAt] = useState(understood.occurredAt || "");
  const financial = understood.financial;
  const spaceLabel = SPACES.find((item) => item.id === space)?.label || space;
  return (
    <div className="max-w-[480px] rounded-xl border border-[#2A2A28] bg-[#161614] p-4">
      {prompt ? <DiraMarkdown text={prompt} /> : null}
      <h2 className="mt-3 text-base font-semibold text-[#F5F3EE]">{understood.title}</h2>
      {understood.summary ? <p className="mt-1 line-clamp-2 text-sm text-[#9B9892]">{understood.summary}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {understood.contentType ? (
          <span className="rounded-full border border-[#2A2A28] px-2 py-0.5 text-[11px] uppercase tracking-wide text-[#6B6963]">
            {understood.contentType.replaceAll("_", " ")}
          </span>
        ) : null}
        <span className="rounded-full border border-[#2A2A28] px-2 py-0.5 text-[11px] text-[#6B6963]">{spaceLabel}</span>
      </div>
      {financial?.hasFinancials && financial.totalAmount != null ? (
        <p className="mt-3 text-xl font-semibold text-[#7F77DD]">
          {Number(financial.totalAmount).toLocaleString("en-US")} {financial.currency || ""}
        </p>
      ) : null}
      {understood.location ? <p className="mt-2 text-xs text-[#6B6963]">{understood.location}</p> : null}
      {content.altimetrixContext ? (
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
          <div
            style={{
              fontSize: "13px",
              color: "#9B9892",
              fontStyle: "italic",
              lineHeight: "1.6",
            }}
          >
            {content.altimetrixContext}
          </div>
        </div>
      ) : null}
      {content.duplicate ? (
        <p className="mt-3 rounded-md border border-[#EF9F27] bg-[#2A1F00] px-3 py-2 text-xs text-[#F5F3EE]">
          {content.duplicate.message}:{" "}
          <Link href={`/events/${content.duplicate.existingEventId}`} className="underline" target="_blank">
            {content.duplicate.existingTitle}
          </Link>
        </p>
      ) : null}
      <label className="mt-3 block">
        <span className="text-[11px] text-[#6B6963]">When did this happen?</span>
        <input
          type="date"
          value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)}
          className="mt-1 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-1 text-sm text-[#F5F3EE] outline-none [color-scheme:dark]"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SPACES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSpace(item.id)}
            className={`rounded-full px-2.5 py-1 text-[11px] ${space === item.id ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {!resolved ? (
        <ConfirmRow
          busy={busy}
          confirmLabel="Save"
          quietDismiss
          onConfirm={() => onConfirm(space, occurredAt || null)}
          onDismiss={onDismiss}
        />
      ) : null}
    </div>
  );
}

function ConfirmRow({
  busy,
  confirmLabel,
  quietDismiss,
  onConfirm,
  onDismiss,
}: {
  busy: boolean;
  confirmLabel: string;
  quietDismiss?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <button type="button" onClick={onConfirm} disabled={busy} className="rounded bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE] disabled:opacity-60">
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy}
        className={quietDismiss ? "px-1 py-2 text-sm text-[#6B6963] disabled:opacity-60" : "rounded border border-[#2A2A28] px-4 py-2 text-sm text-[#6B6963] disabled:opacity-60"}
      >
        Dismiss
      </button>
    </div>
  );
}

const AMOUNT = /(\d[\d,]+)\s*(TSH|EUR|USD|KES)/g;

function DiraMarkdown({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="dira-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents = {
  table: ({ children }: { children?: ReactNode }) => (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", margin: "12px 0", fontSize: 14 }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th style={{ background: "#1A1A18", border: "1px solid #2A2A28", padding: "8px 12px", color: "#F5F3EE", fontWeight: 600, textAlign: "left" }}>
      {withAmounts(children)}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td style={{ border: "1px solid #2A2A28", padding: "8px 12px", color: "#9B9892" }}>{withAmounts(children)}</td>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul style={{ paddingLeft: 20, margin: "8px 0" }}>{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol style={{ paddingLeft: 20, margin: "8px 0" }}>{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li style={{ margin: "4px 0", lineHeight: 1.6, color: "#9B9892" }}>{withAmounts(children)}</li>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p style={{ margin: "8px 0", lineHeight: 1.8, color: "#F5F3EE" }}>{withAmounts(children)}</p>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 style={{ fontSize: 18, fontWeight: 600, color: "#F5F3EE", margin: "8px 0" }}>{withAmounts(children)}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 style={{ fontSize: 16, fontWeight: 600, color: "#F5F3EE", margin: "8px 0" }}>{withAmounts(children)}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 style={{ fontSize: 14, fontWeight: 600, color: "#9B9892", margin: "8px 0" }}>{withAmounts(children)}</h3>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong style={{ color: "#F5F3EE", fontWeight: 600 }}>{withAmounts(children)}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em style={{ color: "#6B6963", fontStyle: "italic" }}>{withAmounts(children)}</em>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code style={{ background: "#1A1A18", padding: "2px 6px", borderRadius: 4, fontSize: 13, color: "#7F77DD" }}>{children}</code>
  ),
};

function withAmounts(children: ReactNode, keyPrefix = "amt"): ReactNode {
  return Children.map(children, (child, index) => {
    if (typeof child === "string") return highlightAmounts(child, `${keyPrefix}-${index}`);
    if (isValidElement<{ children?: ReactNode }>(child) && child.props.children != null) {
      return cloneElement(child, { children: withAmounts(child.props.children, `${keyPrefix}-${index}`) });
    }
    return child;
  });
}

function highlightAmounts(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(AMOUNT.source, "g");
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <span key={`${keyPrefix}-${index}`} style={{ color: "#7F77DD", fontWeight: 600 }}>
        {match[0]}
      </span>,
    );
    index += 1;
    last = match.index + match[0].length;
  }
  if (!nodes.length) return [text];
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type UnderstandingContent = {
  suggestedSpace?: IntakeSpace | null;
  altimetrixContext?: string | null;
  emotionalSignificance?: string | null;
  understood: {
    title: string;
    summary: string;
    contentType?: string;
    location: string | null;
    occurredAt?: string | null;
    people?: string[];
    financial?: IntakeFinancial;
  };
  duplicate?: {
    existingEventId: string;
    existingTitle: string;
    message: string;
  } | null;
};

function asUnderstanding(value: unknown): UnderstandingContent | null {
  if (!value || typeof value !== "object" || !("understood" in value)) return null;
  const understood = (value as { understood?: { title?: string } }).understood;
  if (!understood || typeof understood.title !== "string") return null;
  return value as UnderstandingContent;
}

function asCommand(value: unknown): CommandResult | null {
  if (!value || typeof value !== "object" || !("preview" in value)) return null;
  return value as CommandResult;
}

function asAnswer(value: unknown): { reply?: string; results?: CommandRecord[] } | null {
  if (!value || typeof value !== "object") return null;
  if (!("reply" in value) && !("results" in value)) return null;
  return value as { reply?: string; results?: CommandRecord[] };
}

function previewItems(value: unknown): Array<{ id: string; title: string; change: string }> {
  if (!value || typeof value !== "object" || !("preview" in value)) return [];
  const preview = (value as { preview?: unknown }).preview;
  if (!Array.isArray(preview)) return [];
  return preview.filter((item) => item && typeof item.title === "string") as Array<{ id: string; title: string; change: string }>;
}

function messageOf(value: unknown) {
  if (!value || typeof value !== "object" || !("message" in value)) return "";
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function looksLikeCorrection(text: string) {
  return /\b(i meant|not that|i was referring to|the previous)\b/i.test(text);
}

function historyFrom(turns: Turn[]) {
  const items: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const turn of turns) {
    if (turn.role === "user" && turn.text) items.push({ role: "user", content: turn.text });
    if (turn.role === "dira") {
      const content = diraHistoryText(turn);
      if (content) items.push({ role: "assistant", content });
    }
  }
  return items.slice(-8);
}

function diraHistoryText(turn: Turn) {
  const parts: string[] = [];
  if (turn.text) parts.push(turn.text);
  const response = turn.response;
  if (!response) return parts.join("\n").slice(0, 1200);
  const { result } = response;
  if (result.confirmationText) parts.push(result.confirmationText);
  const understanding = asUnderstanding(result.content);
  if (understanding) {
    parts.push(`Title: ${understanding.understood.title}`);
    if (understanding.understood.summary) parts.push(`Summary: ${understanding.understood.summary}`);
    if (understanding.understood.location) parts.push(`Location: ${understanding.understood.location}`);
  }
  const answer = asAnswer(result.content);
  if (answer?.reply) parts.push(answer.reply);
  const note = messageOf(result.content);
  if (note && note !== answer?.reply) parts.push(note);
  const preview = previewItems(result.content);
  if (preview.length) parts.push(preview.map((item) => `${item.title}: ${item.change}`).join("; "));
  if (result.type === "clarification" && response.clarificationOptions?.length) {
    parts.push(`Asked which was meant: ${response.clarificationOptions.map((option) => option.label).join(", ")}`);
  }
  return parts.filter(Boolean).join("\n").slice(0, 1200);
}

function toLastAction(response: HomeResponse): HomeLastAction {
  const saved = response.result.type === "saved" || (response.result.type === "journal_saved" && !response.result.confirmationRequired);
  return {
    sessionId: response.sessionId,
    intent: response.routing.intent,
    summary: response.result.confirmationText || response.routing.interpretation || messageOf(response.result.content),
    saved,
  };
}

function intentPhrase(intent: string) {
  if (intent === "intake_file") return "reading a file";
  if (intent === "intake_text") return "saving an event";
  if (intent === "question") return "a question";
  if (intent === "command") return "a change";
  if (intent === "journal") return "a journal note";
  if (intent === "correction") return "a correction";
  return "something unclear";
}

function savedKind(response: HomeResponse) {
  if (response.result.type === "journal_saved" || response.routing.intent === "journal") return "a journal note";
  if (response.routing.intent === "command" || response.routing.intent === "correction") return "a change";
  return "an event";
}

function actedResult(response: HomeResponse) {
  if (response.result.confirmationRequired) return false;
  return response.result.type === "saved" || response.result.type === "journal_saved";
}

function eventIdOf(value: unknown) {
  if (!value || typeof value !== "object" || !("eventId" in value)) return "";
  const id = (value as { eventId?: unknown }).eventId;
  return typeof id === "string" ? id : "";
}

function newId() {
  return Math.random().toString(36).slice(2);
}

function createRecognizer(): BrowserSpeech | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & {
    SpeechRecognition?: new () => BrowserSpeech;
    webkitSpeechRecognition?: new () => BrowserSpeech;
  };
  const Ctor = host.SpeechRecognition || host.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

function PaperclipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 12.5 14.8 5.7a3 3 0 1 1 4.2 4.2l-8.4 8.5a4.2 4.2 0 0 1-6-6l8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CompassMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-[#2A2A28]">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="m14.8 9.2-1.6 4.2-4.2 1.6 1.6-4.2 4.2-1.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
