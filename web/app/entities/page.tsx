"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { listEntities, type EntityRecord } from "@/lib/api";

const FILTERS = [
  { id: "", label: "All" },
  { id: "person", label: "People" },
  { id: "place", label: "Places" },
  { id: "property", label: "Properties" },
  { id: "project", label: "Projects" },
] as const;

function EntitiesDirectory() {
  const params = useSearchParams();
  const initial = params.get("search") || "";
  const [search, setSearch] = useState(initial);
  const [type, setType] = useState("");
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSearch(initial);
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = setTimeout(() => {
      listEntities({ entityType: type, search: search.trim() })
        .then((page) => {
          if (!cancelled) setEntities(page.entities);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Could not load entities.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search, type]);

  return (
    <div className="min-h-[100dvh]">
      <main className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-[15px] text-[#F5F3EE]">Entities</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          className="mt-6 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-sm text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
        />
        <div className="mt-6 flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.id || "all"}
              type="button"
              onClick={() => setType(item.id)}
              className={`rounded-full px-3 py-1 text-sm ${
                type === item.id ? "bg-[#3C3489] text-[#F5F3EE]" : "border border-[#2A2A28] text-[#6B6963]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
        {loading && entities.length === 0 ? <p className="mt-8 text-sm text-[#6B6963]">Loading…</p> : null}
        {!loading && !error && entities.length === 0 ? (
          <p className="mt-8 max-w-sm text-sm leading-relaxed text-[#6B6963]">
            People, places, and projects you mention will appear here as DIRA learns about your world.
          </p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {entities.map((entity) => (
            <li key={entity.id}>
              <Link
                href={`/entities/${entity.id}`}
                className="block rounded-lg border border-[#2A2A28] px-4 py-4 hover:border-[#3C3489]"
              >
                <div className="flex items-start justify-between gap-4">
                  <h2 className="flex items-center gap-2 text-lg text-[#F5F3EE]">
                    <TypeIcon type={entity.entityType} />
                    {entity.name}
                  </h2>
                  <span className="shrink-0 rounded-full border border-[#2A2A28] px-2 py-0.5 text-xs capitalize text-[#6B6963]">
                    {entity.entityType}
                  </span>
                </div>
                {entity.description ? (
                  <p className="mt-2 truncate text-sm text-[#F5F3EE]/80">{entity.description}</p>
                ) : null}
                <p className="mt-3 text-xs text-[#6B6963]">
                  {entity.eventCount ?? 0} events · {entity.visionCount ?? 0} visions
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

export default function EntitiesPage() {
  return (
    <Suspense fallback={<p className="px-6 py-8 text-sm text-[#6B6963]">Loading…</p>}>
      <EntitiesDirectory />
    </Suspense>
  );
}

function TypeIcon({ type }: { type: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-[#6B6963]">
      {type === "person" ? (
        <>
          <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 19c1.2-2.6 3-4 6-4s4.8 1.4 6 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : null}
      {type === "place" || type === "property" ? (
        <path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10Z" stroke="currentColor" strokeWidth="1.5" />
      ) : null}
      {type === "project" ? (
        <path d="M4 7h16v12H4V7Zm4-3h8v3H8V4Z" stroke="currentColor" strokeWidth="1.5" />
      ) : null}
      {type !== "person" && type !== "place" && type !== "property" && type !== "project" ? (
        <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.5" />
      ) : null}
    </svg>
  );
}
