"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  confirmGraphRelationship,
  createGraphRelationship,
  getEntity,
  getGraphEntity,
  getGraphTypes,
  listEntities,
  mergeGraphEntities,
  rejectGraphRelationship,
  updateEntity,
  type EntityRecord,
  type GraphNeighbor,
} from "@/lib/api";

export default function EntityDetailPage() {
  const params = useParams<{ id: string }>();
  const [entity, setEntity] = useState<EntityRecord | null>(null);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [attributes, setAttributes] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [neighbors, setNeighbors] = useState<GraphNeighbor[]>([]);
  const [money, setMoney] = useState<Array<{ name: string; currency: string; total: number; count: number }>>([]);
  const [timeline, setTimeline] = useState<Array<{ kind: string; id: string; title: string; at: string | null }>>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getEntity(params.id), getGraphEntity(params.id)])
      .then(([loaded, detail]) => {
        if (cancelled) return;
        apply(loaded);
        setNeighbors(detail.neighbors);
        setMoney(detail.money);
        setTimeline(detail.timeline);
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

            <Connections
              entity={entity}
              neighbors={neighbors}
              money={money}
              timeline={timeline}
              onChange={() => {
                getGraphEntity(entity.id).then((detail) => {
                  setNeighbors(detail.neighbors);
                  setMoney(detail.money);
                  setTimeline(detail.timeline);
                }).catch(() => undefined);
              }}
            />
          </article>
        ) : null}
      </main>
    </div>
  );
}

const CATEGORY_COLOR: Record<string, string> = {
  family: "#D4A5E8",
  ownership: "#7F77DD",
  work: "#8FB3D9",
  project: "#8FB3D9",
  location: "#9BC59D",
  financial: "#E8C27A",
  social: "#9B9892",
};

function Connections({
  entity,
  neighbors,
  money,
  timeline,
  onChange,
}: {
  entity: EntityRecord;
  neighbors: GraphNeighbor[];
  money: Array<{ name: string; currency: string; total: number; count: number }>;
  timeline: Array<{ kind: string; id: string; title: string; at: string | null }>;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [types, setTypes] = useState<Array<{ type: string; phrase: string }>>([]);
  const [type, setType] = useState("related_to");
  const [target, setTarget] = useState("");
  const [mergeName, setMergeName] = useState("");
  const groups = new Map<string, GraphNeighbor[]>();
  for (const neighbor of neighbors) {
    const list = groups.get(neighbor.category) || [];
    list.push(neighbor);
    groups.set(neighbor.category, list);
  }

  useEffect(() => {
    if (!adding) return;
    getGraphTypes().then((page) => setTypes(page.types)).catch(() => undefined);
  }, [adding]);

  return (
    <section className="mt-10">
      <h2 className="text-sm text-[#6B6963]">Connections</h2>
      {Array.from(groups.entries()).map(([category, rows]) => (
        <div key={category} className="mt-4">
          <p className="text-xs capitalize" style={{ color: CATEGORY_COLOR[category] || "#9B9892" }}>
            {category}
          </p>
          <ul className="mt-2 space-y-2">
            {rows.map((row) => (
              <li key={row.edgeId} className={`text-sm ${row.validTo ? "text-[#6B6963]" : "text-[#F5F3EE]"}`}>
                {row.displayType} → {row.node.kind === "entity" ? (
                  <Link href={`/entities/${row.node.id}`} className="hover:underline">{row.node.name}</Link>
                ) : row.node.name}
                {row.validFrom ? ` · since ${row.validFrom.slice(0, 4)}` : ""}
                {row.validTo ? ` · ended ${row.validTo.slice(0, 10)}` : ""}
                {row.status === "suggested" ? (
                  <span className="ml-2 text-xs">
                    <button type="button" className="text-[#7F77DD]" onClick={() => void confirmGraphRelationship(row.edgeId).then(onChange)}>Confirm</button>
                    {" · "}
                    <button type="button" className="text-[#6B6963]" onClick={() => void rejectGraphRelationship(row.edgeId).then(onChange)}>Reject</button>
                  </span>
                ) : (
                  <button type="button" className="ml-2 text-xs text-[#6B6963]" onClick={() => void rejectGraphRelationship(row.edgeId).then(onChange)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <button type="button" className="mt-4 text-sm text-[#7F77DD]" onClick={() => setAdding((value) => !value)}>
        + Add connection
      </button>
      {adding ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createGraphRelationship({ fromName: entity.name, toName: target, type, fromType: entity.entityType, toType: "person" }).then(() => {
              setTarget("");
              onChange();
            });
          }}
        >
          <select value={type} onChange={(event) => setType(event.target.value)} className="w-full border border-[#2A2A28] bg-[#161614] px-2 py-2 text-sm text-[#F5F3EE]">
            {types.map((item) => (
              <option key={item.type} value={item.type}>{item.phrase}</option>
            ))}
          </select>
          <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Person or place" className="w-full border border-[#2A2A28] bg-transparent px-2 py-2 text-sm text-[#F5F3EE] outline-none" />
          <button type="submit" className="text-sm text-[#F5F3EE]">Save</button>
        </form>
      ) : null}
      <form
        className="mt-6 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void listEntities({ search: mergeName }).then((page) => {
            const match = page.entities.find((item) => item.id !== entity.id);
            if (match) return mergeGraphEntities(entity.id, match.id);
            return null;
          });
        }}
      >
        <input value={mergeName} onChange={(event) => setMergeName(event.target.value)} placeholder="Merge with…" className="flex-1 border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent text-sm text-[#F5F3EE] outline-none" />
        <button type="submit" className="text-sm text-[#6B6963]">Merge</button>
      </form>
      {money.length ? (
        <div className="mt-6">
          <h3 className="text-sm" style={{ color: CATEGORY_COLOR.financial }}>Money</h3>
          <ul className="mt-2 space-y-1 text-sm text-[#F5F3EE]">
            {money.map((row) => (
              <li key={`${row.name}-${row.currency}`}>{row.total} {row.currency} · {row.count} · {row.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-6">
        <h3 className="text-sm text-[#6B6963]">Timeline</h3>
        <ul className="mt-2 space-y-1 text-sm text-[#F5F3EE]">
          {timeline.map((point) => (
            <li key={`${point.kind}-${point.id}`}>{point.at ? point.at.slice(0, 10) : "Undated"} · {point.title}</li>
          ))}
          {timeline.length === 0 ? <li className="text-[#6B6963]">None yet.</li> : null}
        </ul>
      </div>
    </section>
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
