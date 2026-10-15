"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  confirmGraphRelationship,
  getFamily,
  getGraphSubgraph,
  getGraphSuggestions,
  listEntities,
  mergeGraphEntities,
  rejectGraphRelationship,
  separateGraphEntities,
  type EntityRecord,
  type FamilyPerson,
  type GraphSuggestion,
  type ReviewAsset,
  type ReviewPerson,
} from "@/lib/api";

const COLOR: Record<string, string> = {
  family: "#D4A5E8",
  ownership: "#7F77DD",
  work: "#8FB3D9",
  project: "#8FB3D9",
  location: "#9BC59D",
  financial: "#E8C27A",
  social: "#9B9892",
  other: "#9B9892",
};

export function PeoplePanel() {
  const [family, setFamily] = useState<FamilyPerson[]>([]);
  const [work, setWork] = useState<EntityRecord[]>([]);
  const [others, setOthers] = useState<EntityRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getFamily(), listEntities({ entityType: "person" })])
      .then(([tree, page]) => {
        const familyIds = new Set(
          [tree.self, ...tree.spouse, ...tree.parents, ...tree.grandparents, ...tree.siblings, ...tree.children, ...tree.grandchildren]
            .filter(Boolean)
            .map((person) => person!.id),
        );
        setFamily(
          [tree.self, ...tree.spouse, ...tree.parents, ...tree.siblings, ...tree.children].filter(Boolean) as FamilyPerson[],
        );
        setWork(page.entities.filter((entity) => !familyIds.has(entity.id) && /work|contractor|caretaker/.test(entity.kind || "")));
        setOthers(page.entities.filter((entity) => !familyIds.has(entity.id) && !/work|contractor|caretaker/.test(entity.kind || "")));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load people."));
  }, []);

  if (error) return <p className="mt-6 text-sm text-red-300/85">{error}</p>;
  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-[#6B6963]">
        <Link href="/family" className="text-[#7F77DD]">
          Open the family tree
        </Link>
      </p>
      <Group title="Family" people={family} />
      <EntityGroup title="Work & Projects" entities={work} />
      <EntityGroup title="Others" entities={others} />
    </div>
  );
}

export function PlacesPanel() {
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  useEffect(() => {
    listEntities()
      .then((page) => setEntities(page.entities.filter((entity) => ["place", "property", "asset", "vehicle", "document"].includes(entity.entityType))))
      .catch(() => setEntities([]));
  }, []);
  return <EntityGroup title="Places & Assets" entities={entities} />;
}

export function GraphPanel() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getGraphSubgraph(undefined, 2)
      .then((graph) => {
        const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
        setLines(graph.edges.slice(0, 40).map((edge) => `${names.get(edge.fromId) || "Someone"} → ${edge.type.replaceAll("_", " ")} → ${names.get(edge.toId) || "someone"}`));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the graph."));
  }, []);
  if (error) return <p className="mt-6 text-sm text-red-300/85">{error}</p>;
  if (!lines.length) return <p className="mt-6 text-sm text-[#6B6963]">No confirmed connections yet.</p>;
  return (
    <ul className="mt-6 space-y-2">
      {lines.map((line) => (
        <li key={line} className="text-sm text-[#F5F3EE]">
          {line}
        </li>
      ))}
    </ul>
  );
}

export function ReviewPanel() {
  const [relationships, setRelationships] = useState<GraphSuggestion[]>([]);
  const [family, setFamily] = useState<{ title: string; people: ReviewPerson[] } | null>(null);
  const [assets, setAssets] = useState<{ title: string; items: ReviewAsset[] } | null>(null);
  const [duplicates, setDuplicates] = useState<Array<{ left: { id: string; name: string }; right: { id: string; name: string } }>>([]);
  const [conflicts, setConflicts] = useState<GraphSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    getGraphSuggestions()
      .then((page) => {
        setRelationships(page.relationships);
        setFamily(page.family);
        setAssets(page.assets);
        setDuplicates(page.duplicates);
        setConflicts(page.conflicts);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load review."));
  }

  useEffect(load, []);

  if (error) return <p className="mt-6 text-sm text-red-300/85">{error}</p>;
  return (
    <div className="mt-6 space-y-6">
      {family ? (
        <section className="rounded-lg border border-[#2A2A28] px-3 py-3">
          <h2 className="text-sm" style={{ color: COLOR.family }}>{family.title}</h2>
          <ul className="mt-3 space-y-3">
            {["spouse", "parent", "child", "sibling", "relative"].map((relation) => {
              const people = family.people.filter((person) => person.relation === relation);
              if (!people.length) return null;
              return (
                <li key={relation}>
                  <p className="text-xs uppercase tracking-wide text-[#6B6963]">{relation}</p>
                  <ul className="mt-1 space-y-2 border-l border-[#2A2A28] pl-3">
                    {people.map((person) => (
                      <li key={person.edgeId} className="text-sm text-[#F5F3EE]">
                        {person.name}
                        <div className="mt-1 flex gap-3 text-xs">
                          <button type="button" className="text-[#7F77DD]" onClick={() => void confirmGraphRelationship(person.edgeId).then(load)}>Confirm</button>
                          <button type="button" className="text-[#6B6963]" onClick={() => void rejectGraphRelationship(person.edgeId).then(load)}>Reject</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {assets ? (
        <section className="rounded-lg border border-[#2A2A28] px-3 py-3">
          <h2 className="text-sm" style={{ color: COLOR.ownership }}>{assets.title}</h2>
          <ul className="mt-3 space-y-2">
            {assets.items.map((item) => (
              <li key={item.edgeId} className="text-sm text-[#F5F3EE]">
                {item.name}
                <span className="text-[#6B6963]"> · {item.relation}</span>
                <div className="mt-1 flex gap-3 text-xs">
                  <button type="button" className="text-[#7F77DD]" onClick={() => void confirmGraphRelationship(item.edgeId).then(load)}>Confirm</button>
                  <button type="button" className="text-[#6B6963]" onClick={() => void rejectGraphRelationship(item.edgeId).then(load)}>Reject</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h2 className="text-sm text-[#6B6963]">Suggested connections</h2>
        <ul className="mt-3 space-y-2">
          {relationships.map((edge) => (
            <li key={edge.id} className="rounded-lg border border-[#2A2A28] px-3 py-3 text-sm">
              <span style={{ color: COLOR[edge.category] || "#F5F3EE" }}>
                {edge.fromName} → {edge.type.replaceAll("_", " ")} → {edge.toName}
              </span>
              {edge.fromJournal ? <span className="ml-2 text-xs text-[#6B6963]">from your journal</span> : null}
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" className="text-[#7F77DD]" onClick={() => void confirmGraphRelationship(edge.id).then(load)}>
                  Confirm
                </button>
                <button type="button" className="text-[#6B6963]" onClick={() => void rejectGraphRelationship(edge.id).then(load)}>
                  Reject
                </button>
              </div>
            </li>
          ))}
          {relationships.length === 0 ? <li className="text-sm text-[#6B6963]">None waiting.</li> : null}
        </ul>
      </section>
      <section>
        <h2 className="text-sm text-[#6B6963]">Possible duplicates</h2>
        <ul className="mt-3 space-y-2">
          {duplicates.map((pair) => (
            <li key={`${pair.left.id}-${pair.right.id}`} className="text-sm text-[#F5F3EE]">
              {pair.left.name} and {pair.right.name}
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" className="text-[#7F77DD]" onClick={() => void mergeGraphEntities(pair.left.id, pair.right.id).then(load)}>
                  Merge
                </button>
                <button type="button" className="text-[#6B6963]" onClick={() => void separateGraphEntities(pair.left.id, pair.right.id).then(load)}>
                  Keep separate
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-sm text-[#6B6963]">Conflicts</h2>
        <ul className="mt-3 space-y-2">
          {conflicts.map((edge) => (
            <li key={edge.id} className="text-sm text-[#F5F3EE]">
              {edge.evidenceText || `Records disagree on ${edge.fromName}.`}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Group({ title, people }: { title: string; people: FamilyPerson[] }) {
  return (
    <section>
      <h2 className="text-sm" style={{ color: COLOR.family }}>
        {title}
      </h2>
      <ul className="mt-2 space-y-2">
        {people.map((person) => (
          <li key={person.id}>
            <Link href={`/entities/${person.id}`} className={`text-sm ${person.deathDate ? "text-[#6B6963]" : "text-[#F5F3EE]"}`}>
              {person.name}
              {person.birthDate ? ` · ${new Date(person.birthDate).getUTCFullYear()}` : ""}
              {person.deathDate ? ` – ${new Date(person.deathDate).getUTCFullYear()}` : ""}
            </Link>
          </li>
        ))}
        {people.length === 0 ? <li className="text-sm text-[#6B6963]">None yet.</li> : null}
      </ul>
    </section>
  );
}

function EntityGroup({ title, entities }: { title: string; entities: EntityRecord[] }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm text-[#8FB3D9]">{title}</h2>
      <ul className="mt-2 space-y-2">
        {entities.map((entity) => (
          <li key={entity.id}>
            <Link href={`/entities/${entity.id}`} className={`text-sm ${entity.deathDate ? "text-[#6B6963]" : "text-[#F5F3EE]"}`}>
              {entity.name}
              <span className="text-[#6B6963]"> · {entity.entityType}</span>
            </Link>
          </li>
        ))}
        {entities.length === 0 ? <li className="text-sm text-[#6B6963]">None yet.</li> : null}
      </ul>
    </section>
  );
}
