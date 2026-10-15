"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createGraphRelationship, getFamily, type FamilyPerson, type FamilyTree } from "@/lib/api";

const LINKS = [
  { id: "parent_of", label: "Parent" },
  { id: "child_of", label: "Child" },
  { id: "spouse_of", label: "Spouse" },
  { id: "sibling_of", label: "Sibling" },
];

export default function FamilyPage() {
  const [tree, setTree] = useState<FamilyTree | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("parent_of");
  const [error, setError] = useState<string | null>(null);

  function load() {
    getFamily()
      .then(setTree)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the family."));
  }

  useEffect(load, []);

  async function addMember() {
    if (!tree?.self || !name.trim()) return;
    const parent = kind === "parent_of";
    const child = kind === "child_of";
    await createGraphRelationship({
      fromName: parent ? name.trim() : tree.self.name,
      toName: parent ? tree.self.name : name.trim(),
      type: parent || child ? "parent_of" : kind,
      fromType: "person",
      toType: "person",
    });
    setName("");
    setOpen(false);
    load();
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)]">
      <main className="mx-auto max-w-2xl px-6 py-8">
        <Link href="/library" className="text-sm text-[#6B6963]">
          Library
        </Link>
        <h1 className="mt-4 text-3xl text-[#F5F3EE]">Family</h1>
        {error ? <p className="mt-4 text-sm text-red-300/85">{error}</p> : null}
        {tree ? (
          <div className="mt-8 space-y-6 text-center">
            <Row people={tree.grandparents} />
            <Row people={tree.parents} />
            <Row people={[tree.self, ...tree.spouse, ...tree.siblings].filter(Boolean) as FamilyPerson[]} highlight={tree.self?.id} />
            <Row people={tree.children} />
            <Row people={tree.grandchildren} />
          </div>
        ) : null}
        <button type="button" onClick={() => setOpen(true)} className="mt-8 text-sm text-[#7F77DD]">
          Add family member
        </button>
        {open ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void addMember();
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              className="w-full border border-[#2A2A28] bg-transparent px-3 py-2 text-sm text-[#F5F3EE] outline-none"
            />
            <select value={kind} onChange={(event) => setKind(event.target.value)} className="w-full border border-[#2A2A28] bg-[#161614] px-3 py-2 text-sm text-[#F5F3EE]">
              {LINKS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-full bg-[#3C3489] px-4 py-2 text-sm text-[#F5F3EE]">
              Save
            </button>
          </form>
        ) : null}
      </main>
    </div>
  );
}

function Row({ people, highlight }: { people: FamilyPerson[]; highlight?: string }) {
  if (!people.length) return null;
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {people.map((person) => (
        <Link
          key={person.id}
          href={`/entities/${person.id}`}
          className="min-w-28 rounded-lg border border-[#2A2A28] px-3 py-3 text-sm"
          style={{ color: person.deathDate ? "#6B6963" : "#F5F3EE", borderColor: person.id === highlight ? "#7F77DD" : "#2A2A28" }}
        >
          <span className="block">{person.name}</span>
          <span className="mt-1 block text-xs text-[#6B6963]">
            {person.birthDate ? new Date(person.birthDate).getUTCFullYear() : ""}
            {person.deathDate ? ` – ${new Date(person.deathDate).getUTCFullYear()}` : ""}
          </span>
        </Link>
      ))}
    </div>
  );
}
