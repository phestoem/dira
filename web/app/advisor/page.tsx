"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { advisorChat, getAdvisorSuggestions, type AdvisorMessage } from "@/lib/api";

const FALLBACK = [
  "What should I focus on this week?",
  "Help me plan the next phase of Ntabha",
  "How am I tracking against my Tanzania timeline?",
];

export default function AdvisorPage() {
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getAdvisorSuggestions()
      .then((next) => {
        if (!cancelled && next.length) setSuggestions(next.slice(0, 3));
      })
      .catch(() => {
        /* The opening questions stay available from the page itself. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending, error]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    const next: AdvisorMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setDraft("");
    setSending(true);
    setSlow(false);
    setError(null);
    const timer = window.setTimeout(() => setSlow(true), 1500);
    try {
      const result = await advisorChat(next);
      setMessages([...next, { role: "assistant", content: result.reply }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The advisor could not answer just now.";
      setError(/taking a moment/i.test(message) ? "Taking a moment..." : message);
    } finally {
      window.clearTimeout(timer);
      setSending(false);
      setSlow(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  return (
    <div className="fixed inset-x-0 top-0 z-30 flex h-[100dvh] flex-col bg-[#0E0E0F] pb-14">
      <header className="flex items-baseline justify-between px-5 pb-3 pr-14 pt-5">
        <p className="text-[13px] tracking-[0.22em] text-[#F5F3EE]">DIRA</p>
        <p className="text-[12px] text-[#6B6963]">Life Advisor</p>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {messages.length === 0 ? (
          <p className="pt-10 text-center text-[15px] text-[#6B6963]">What&apos;s on your mind?</p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-2">
            {messages.map((message, index) =>
              message.role === "user" ? (
                <p
                  key={`${index}-${message.role}`}
                  className="ml-auto max-w-[min(90%,30rem)] text-right text-[15px] italic leading-[1.65] text-[#BAB7AE]"
                >
                  {message.content}
                </p>
              ) : (
                <div key={`${index}-${message.role}`} className="max-w-[min(100%,38rem)] text-[15px] leading-[1.7] text-[#F5F3EE]">
                  {renderResponse(message.content)}
                </div>
              ),
            )}
          </div>
        )}
        {sending ? (
          <p className="mx-auto mt-6 max-w-2xl text-[14px] text-[#6B6963]">{slow ? "Taking a moment..." : "…"}</p>
        ) : null}
        {error ? <p className="mx-auto mt-4 max-w-2xl text-[14px] text-red-300/85">{error}</p> : null}
        <div ref={bottomRef} />
      </div>

      <div className="mx-auto w-full max-w-2xl px-5 pb-3">
        {messages.length === 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.slice(0, 3).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => void send(suggestion)}
                className="rounded-full border border-[#2A2A28] px-3 py-1.5 text-left text-[12px] text-[#BAB7AE] hover:border-[#3C3489] hover:text-[#F5F3EE]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={onSubmit}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
            placeholder="Ask about your life..."
            className="w-full border-0 border-b border-[#2A2A28] bg-transparent py-3 text-[16px] text-[#F5F3EE] outline-none placeholder:text-[#6B6963] disabled:opacity-60"
          />
        </form>
      </div>
    </div>
  );
}

function renderResponse(text: string) {
  const lines = text.split("\n");
  const hasList = lines.some((line) => /^[-•*]\s/.test(line) || /^\d+\.\s/.test(line));
  const hasFinancials = /\d[\d,]+\s*(TSH|EUR|USD|KES)/i.test(text);
  const endsWithQuestion = text.trim().endsWith("?");
  const isShortAnswer = text.length < 100;

  if (hasList) return <ListResponse text={text} />;
  if (isShortAnswer) return <ShortResponse text={text} />;
  return <ParagraphResponse text={text} highlightFinancials={hasFinancials} italicizeQuestion={endsWithQuestion} />;
}

function ListResponse({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function flush() {
    if (!list) return;
    const items = list.items;
    const ordered = list.ordered;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`list-${blocks.length}`} className={`space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
        {items.map((item, index) => (
          <li key={index}>{withMoney(item)}</li>
        ))}
      </Tag>,
    );
    list = null;
  }

  for (const line of text.split("\n")) {
    const bullet = line.match(/^[-•*]\s+(.*)$/);
    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push((numbered || bullet)?.[1] || "");
    } else {
      flush();
      if (line.trim()) {
        blocks.push(
          <p key={`line-${blocks.length}`} className="whitespace-pre-wrap">
            {withMoney(line)}
          </p>,
        );
      }
    }
  }
  flush();
  return <div className="space-y-3">{blocks}</div>;
}

function ShortResponse({ text }: { text: string }) {
  return <p>{withMoney(text)}</p>;
}

function ParagraphResponse({
  text,
  highlightFinancials,
  italicizeQuestion,
}: {
  text: string;
  highlightFinancials: boolean;
  italicizeQuestion: boolean;
}) {
  let body = text.trim();
  let question = "";
  if (italicizeQuestion) {
    const match = body.match(/([^.!?\n]*\?)\s*$/);
    if (match?.index != null) {
      question = match[1].trim();
      body = body.slice(0, match.index).trim();
    }
  }
  const render = (value: string) => (highlightFinancials ? withMoney(value) : value);
  return (
    <div className="space-y-3">
      {body ? <p className="whitespace-pre-wrap">{render(body)}</p> : null}
      {question ? <p className="italic text-[#D4D0C8]">{render(question)}</p> : null}
    </div>
  );
}

function withMoney(text: string): ReactNode[] {
  const pattern = /\d[\d,]*(?:\.\d+)?\s*(?:TSH|EUR|USD|KES)/gi;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <strong key={`money-${index}`} className="font-semibold text-[#7F77DD]">
        {match[0]}
      </strong>,
    );
    index += 1;
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
