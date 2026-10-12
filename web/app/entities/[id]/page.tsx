"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getEntity, getEntityGraph, updateEntity, type EntityGraph, type EntityRecord } from "@/lib/api";

export default function EntityDetailPage() {
  const params = useParams<{ id: string }>();
  const [entity, setEntity] = useState<EntityRecord | null>(null);
  const [graph, setGraph] = useState<EntityGraph | null>(null);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [attributes, setAttributes] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getEntity(params.id), getEntityGraph(params.id)])
      .then(([loaded, links]) => {
        if (cancelled) return;
        apply(loaded);
        setGraph(links);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this entity.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  function apply(loaded: EntityRecord) {
    setEntity(loaded);
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    setAliases(loaded.aliases.join(", "));
    setAttributes(attributeRows(loaded.attributes));
  }

  async function saveName() {
    if (!entity) return;
    const next = name.trim();
    setEditingName(false);
    if (!next || next === entity.name) {
      setName(entity.name);
      return;
    }
    try {
      apply(await updateEntity(entity.id, { name: next }));
    } catch (err) {
      setName(entity.name);
      setError(err instanceof Error ? err.message : "Could not save the name.");
    }
  }

  async function saveDescription() {
    if (!entity) return;
    const next = description.trim();
    if (next === (entity.description ?? "")) return;
    try {
      apply(await updateEntity(entity.id, { description: next || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the description.");
    }
  }

  async function saveAliases() {
    if (!entity) return;
    const next = aliases.split(",").map((item) => item.trim()).filter(Boolean);
    if (next.join("|") === entity.aliases.join("|")) return;
    try {
      apply(await updateEntity(entity.id, { aliases: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save aliases.");
    }
  }

  async function saveAttributes(rows: Array<{ key: string; value: string }>) {
    if (!entity) return;
    const attributesObject: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) attributesObject[key] = row.value;
    }
    try {
      apply(await updateEntity(entity.id, { attributes: attributesObject }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save attributes.");
    }
  }

  const entityLinks = (graph?.relationships || []).filter((item) => item.type === "entity");

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-[#2A2A28] px-6 py-4">
        <Link href="/entities" className="text-sm text-[#6B6963] hover:text-[#F5F3EE]">
          Back
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-8">
        {loading ? <p className="text-sm text-[#6B6963]">Loading…</p> : null}
        {error ? <p className="mb-4 text-sm text-red-300/85">{error}</p> : null}
        {entity ? (
          <article>
            {editingName ? (
              <input
                value={name}
                autoFocus
                onChange={(input) => setName(input.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(input) => {
                  if (input.key === "Enter") input.currentTarget.blur();
                }}
                className="w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent text-3xl text-[#F5F3EE] outline-none"
              />
            ) : (
              <h1 className="cursor-text text-3xl text-[#F5F3EE]" onClick={() => setEditingName(true)}>
                {entity.name}
              </h1>
            )}
            <p className="mt-3 inline-block rounded-full border border-[#2A2A28] px-2 py-0.5 text-xs capitalize text-[#6B6963]">
              {entity.entityType}
            </p>

            <label className="mt-8 block">
              <span className="text-sm text-[#6B6963]">Description</span>
              <textarea
                value={description}
                onChange={(input) => setDescription(input.target.value)}
                onBlur={() => void saveDescription()}
                className="mt-2 min-h-24 w-full resize-y border border-[#2A2A28] bg-transparent p-3 text-sm text-[#F5F3EE] outline-none"
              />
            </label>

            <section className="mt-8">
              <p className="text-sm text-[#6B6963]">Attributes</p>
              <div className="mt-3 space-y-2">
                {attributes.map((row, index) => (
                  <div key={index} className="grid grid-cols-2 gap-2">
                    <input
                      value={row.key}
                      onChange={(input) => {
                        const next = attributes.slice();
                        next[index] = { ...row, key: input.target.value };
                        setAttributes(next);
                      }}
                      onBlur={() => void saveAttributes(attributes)}
                      placeholder="Key"
                      className="border border-[#2A2A28] bg-transparent px-2 py-1 text-sm text-[#F5F3EE] outline-none"
                    />
                    <input
                      value={row.value}
                      onChange={(input) => {
                        const next = attributes.slice();
                        next[index] = { ...row, value: input.target.value };
                        setAttributes(next);
                      }}
                      onBlur={() => void saveAttributes(attributes)}
                      placeholder="Value"
                      className="border border-[#2A2A28] bg-transparent px-2 py-1 text-sm text-[#F5F3EE] outline-none"
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setAttributes((current) => [...current, { key: "", value: "" }])}
                className="mt-3 text-sm text-[#6B6963]"
              >
                Add attribute
              </button>
            </section>

            <label className="mt-8 block">
              <span className="text-sm text-[#6B6963]">Aliases</span>
              <input
                value={aliases}
                onChange={(input) => setAliases(input.target.value)}
                onBlur={() => void saveAliases()}
                placeholder="Comma-separated"
                className="mt-2 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-sm text-[#F5F3EE] outline-none"
              />
            </label>

            <section className="mt-10">
              <h2 className="text-sm text-[#6B6963]">Related events</h2>
              <ul className="mt-3 space-y-2">
                {(entity.events || []).map((event) => (
                  <li key={event.id}>
                    <Link href={`/events/${event.id}`} className="text-sm text-[#F5F3EE] hover:underline">
                      {event.title}
                    </Link>
                  </li>
                ))}
                {(entity.events || []).length === 0 ? <li className="text-sm text-[#6B6963]">None yet.</li> : null}
              </ul>
            </section>

            <section className="mt-8">
              <h2 className="text-sm text-[#6B6963]">Related visions</h2>
              <ul className="mt-3 space-y-2">
                {(entity.visions || []).map((vision) => (
                  <li key={vision.id}>
                    <Link href={`/visions/${vision.id}`} className="text-sm text-[#F5F3EE] hover:underline">
                      {vision.title}
                    </Link>
                  </li>
                ))}
                {(entity.visions || []).length === 0 ? <li className="text-sm text-[#6B6963]">None yet.</li> : null}
              </ul>
            </section>

            <section className="mt-8">
              <h2 className="text-sm text-[#6B6963]">Relationships</h2>
              <ul className="mt-3 space-y-2">
                {entityLinks.map((item) => (
                  <li key={`${item.target.id}-${item.relationship}`} className="text-sm text-[#F5F3EE]">
                    <Link href={`/entities/${item.target.id}`} className="hover:underline">
                      {item.target.name}
                    </Link>
                    <span className="text-[#6B6963]"> · {item.relationship}</span>
                  </li>
                ))}
                {entityLinks.length === 0 ? <li className="text-sm text-[#6B6963]">None yet.</li> : null}
              </ul>
            </section>
          </article>
        ) : null}
      </main>
    </div>
  );
}

function attributeRows(attributes: Record<string, unknown>) {
  return Object.entries(attributes || {})
    .filter(([key]) => key !== "lastNudge")
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
}
