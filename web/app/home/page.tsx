"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  getAdvisorSuggestions,
  homeConfirm,
  homeInput,
  type CommandRecord,
  type CommandResult,
  type HomeLastAction,
  type HomeResponse,
  type IntakeFinancial,
  type IntakeSpace,
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

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages, busy]);

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
    setMessages((current) => [...current, userTurn, pending]);
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

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="font-serif text-2xl text-[#F5F3EE]">What&apos;s on your mind?</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion, null)}
                  className="rounded-full border border-[#2A2A28] px-3 py-1.5 text-sm text-[#9B9892] hover:text-[#F5F3EE]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="mt-6 text-xs text-[#6B6963]">Talk, attach a file, or use voice</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-8">
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
              />
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-[#2A2A28] bg-[#0E0E0F] px-4 py-3" style={{ borderTopWidth: "0.5px" }}>
        {file ? (
          <div className="mx-auto mb-2 flex max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#2A2A28] px-3 py-1 text-xs text-[#F5F3EE]">
              {file.name}
              <button type="button" onClick={() => setFile(null)} className="text-[#6B6963]" aria-label="Remove file">
                ×
              </button>
            </span>
          </div>
        ) : null}
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            className="flex h-10 w-10 shrink-0 items-center justify-center text-[#6B6963] hover:text-[#F5F3EE]"
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
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Talk to DIRA..."
            className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
          />
          <button
            type="button"
            onClick={onVoice}
            aria-label={recording ? "Stop recording" : "Use voice"}
            className={`flex h-10 w-10 shrink-0 items-center justify-center ${recording ? "text-[#7F77DD]" : "text-[#6B6963] hover:text-[#F5F3EE]"}`}
          >
            <MicIcon />
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
}: {
  turn: Turn;
  busy: boolean;
  onConfirm: (space: IntakeSpace, occurredAt: string | null) => void;
  onDismiss: () => void;
  onOption: (intent: string) => void;
}) {
  if (turn.role === "user") {
    return (
      <p className="max-w-[85%] self-end text-right text-[15px] italic leading-6 text-[#9B9892]">{turn.text}</p>
    );
  }
  if (turn.busy) {
    return (
      <div className="flex gap-1 py-2" aria-label="DIRA is thinking">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6B6963]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6B6963] [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6B6963] [animation-delay:300ms]" />
      </div>
    );
  }
  if (turn.text && !turn.response) {
    return <p className="max-w-[90%] text-sm leading-6 text-[#F5F3EE]">{turn.text}</p>;
  }
  const response = turn.response;
  if (!response) return null;
  return (
    <div className="max-w-[95%]">
      <ResponseBody
        response={response}
        resolved={Boolean(turn.resolved)}
        busy={busy}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
        onOption={onOption}
      />
      {response.routing.confidence < 0.8 ? (
        <p className="mt-2 text-[11px] text-[#6B6963]">
          {intentLabel(response.routing.intent)} · {Math.round(response.routing.confidence * 100)}%
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
    if (!understanding) return <p className="text-sm text-[#F5F3EE]">{result.confirmationText}</p>;
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
        {result.confirmationText ? <p className="whitespace-pre-wrap text-sm leading-6 text-[#F5F3EE]">{result.confirmationText}</p> : null}
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
        <p className="text-sm leading-6 text-[#F5F3EE]">{result.confirmationText || "I want to make sure I understand. Did you mean:"}</p>
        {!resolved ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {(response.clarificationOptions || []).map((option) => (
              <button
                key={option.intent}
                type="button"
                disabled={busy}
                onClick={() => onOption(option.intent)}
                title={option.description}
                className="rounded-full border border-[#2A2A28] px-3 py-1.5 text-sm text-[#F5F3EE] disabled:opacity-60"
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
        <p className="text-sm leading-6 text-[#F5F3EE]">{result.confirmationText}</p>
        {!resolved ? <ConfirmRow busy={busy} onConfirm={() => onConfirm("personal", null)} onDismiss={onDismiss} confirmLabel="Save" /> : null}
      </div>
    );
  }
  if (result.type === "journal_saved") {
    return <p className="text-sm text-[#F5F3EE]">Saved ✓</p>;
  }
  const answer = asAnswer(result.content);
  const reply = answer?.reply || messageOf(result.content) || result.confirmationText || "";
  return (
    <div>
      <Prose text={reply} />
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
  return (
    <div className="rounded-lg border border-[#2A2A28] bg-[#161614] px-4 py-4">
      {prompt ? <p className="text-sm leading-6 text-[#F5F3EE]">{prompt}</p> : null}
      <h2 className="mt-3 text-lg text-[#F5F3EE]">{understood.title}</h2>
      {understood.summary ? <p className="mt-2 text-sm leading-6 text-[#F5F3EE]/85">{understood.summary}</p> : null}
      {financial?.hasFinancials && financial.totalAmount != null ? (
        <p className="mt-3 text-sm text-[#7F77DD]">
          {Number(financial.totalAmount).toLocaleString("en-US")} {financial.currency || ""}
        </p>
      ) : null}
      {understood.location ? <p className="mt-2 text-xs text-[#6B6963]">{understood.location}</p> : null}
      {content.duplicate ? (
        <p className="mt-3 rounded-md border border-[#EF9F27] bg-[#2A1F00] px-3 py-2 text-xs text-[#F5F3EE]">
          {content.duplicate.message}:{" "}
          <Link href={`/events/${content.duplicate.existingEventId}`} className="underline" target="_blank">
            {content.duplicate.existingTitle}
          </Link>
        </p>
      ) : null}
      <label className="mt-4 block">
        <span className="text-xs text-[#6B6963]">When did this happen?</span>
        <input
          type="date"
          value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)}
          className="mt-2 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-1 text-sm text-[#F5F3EE] outline-none [color-scheme:dark]"
        />
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        {SPACES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSpace(item.id)}
            className={`rounded-full px-3 py-1 text-xs ${space === item.id ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {!resolved ? (
        <ConfirmRow
          busy={busy}
          confirmLabel="Confirm"
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
  onConfirm,
  onDismiss,
}: {
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-4 flex gap-2">
      <button type="button" onClick={onConfirm} disabled={busy} className="rounded bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE] disabled:opacity-60">
        {confirmLabel}
      </button>
      <button type="button" onClick={onDismiss} disabled={busy} className="rounded border border-[#2A2A28] px-4 py-2 text-sm text-[#6B6963] disabled:opacity-60">
        Dismiss
      </button>
    </div>
  );
}

function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => (
        <p key={block} className="whitespace-pre-wrap text-sm leading-6 text-[#F5F3EE]">
          {renderInline(block)}
        </p>
      ))}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <span key={index}>{part}</span>;
  });
}

type UnderstandingContent = {
  suggestedSpace?: IntakeSpace | null;
  understood: {
    title: string;
    summary: string;
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

function historyFrom(turns: Turn[]) {
  const items: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const turn of turns) {
    if (turn.role === "user" && turn.text) items.push({ role: "user", content: turn.text });
    if (turn.role === "dira" && turn.response) {
      const content = turn.response.result.confirmationText || messageOf(turn.response.result.content) || asAnswer(turn.response.result.content)?.reply || "";
      if (content) items.push({ role: "assistant", content });
    }
  }
  return items.slice(-8);
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

function intentLabel(intent: string) {
  if (intent === "intake_file") return "Reading a file";
  if (intent === "intake_text") return "Saving an event";
  if (intent === "question") return "Answering";
  if (intent === "command") return "A change";
  if (intent === "journal") return "A reflection";
  if (intent === "correction") return "A correction";
  return "Unclear";
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
