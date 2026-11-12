import { kindOfId, type Book, type KnowledgeNode, type Relation, type Source, type Tag } from "./schema";
import { search } from "./search";
import type { AtlasStore } from "./store";
import { resolveTag } from "./tags";

// atlas_read and atlas_get_context (§10, §12.2). Both answer in plain data a
// model can read: objects with their tags by name, relations with the other
// end's title, and each source's kind and verification, so the model can tell
// a checked author's claim from its own earlier synthesis.

export interface RelationView {
  id: string;
  type: Relation["type"];
  direction: "out" | "in";
  other_id: string;
  other_title: string;
  attribution: Relation["attribution"];
  verification: Relation["verification"];
}

export interface ObjectView {
  object: Record<string, unknown>;
  tags: { id: string; name: string; coverage: string }[];
  relations: RelationView[];
  sources: Pick<Source, "id" | "kind" | "title" | "granularity" | "verification" | "url" | "locator">[];
}

function titleOf(store: AtlasStore, id: string): string {
  const obj = store.get(id) as { title?: string; name?: string } | undefined;
  return obj?.title ?? obj?.name ?? id;
}

function relationViews(store: AtlasStore, id: string): RelationView[] {
  return store.relationsOf(id).map((r) => {
    const out = r.from_id === id;
    const other = out ? r.to_id : r.from_id;
    return { id: r.id, type: r.type, direction: out ? "out" : "in", other_id: other, other_title: titleOf(store, other), attribution: r.attribution, verification: r.verification };
  });
}

function sourceViews(store: AtlasStore, refs: string[]): ObjectView["sources"] {
  return refs.map((ref) => store.sources.get(ref)).filter((s): s is Source => Boolean(s))
    .map(({ id, kind, title, granularity, verification, url, locator }) => ({ id, kind, title, granularity, verification, url, locator }));
}

export function describe(store: AtlasStore, id: string): ObjectView | null {
  const obj = store.get(id);
  if (!obj) return null;
  const kind = kindOfId(obj.id);
  const bindings = (obj as Book | KnowledgeNode).tag_bindings ?? [];
  const tags = bindings.map((b) => ({ id: b.tag_id, name: resolveTag(store.tags, b.tag_id)?.name ?? b.tag_id, coverage: b.coverage }));
  const refs = new Set<string>((obj as { source_refs?: string[] }).source_refs ?? []);
  for (const b of bindings) for (const ref of b.source_refs) refs.add(ref);
  let extra: Record<string, unknown> = {};
  if (kind === "tag") {
    const tag = obj as Tag;
    const boundTo = [...store.books.values(), ...store.nodes.values()].filter((o) => !o.archived && o.tag_bindings.some((b) => resolveTag(store.tags, b.tag_id)?.id === tag.id));
    extra = { bound_to: boundTo.map((o) => ({ id: o.id, title: o.title })), parents: tag.parent_ids.map((p) => ({ id: p, name: titleOf(store, p) })) };
  }
  return {
    object: { ...obj, ...extra },
    tags,
    relations: kind === "book" || kind === "node" ? relationViews(store, obj.id) : [],
    sources: sourceViews(store, [...refs]),
  };
}

export interface ContextRequest {
  question?: string;
  /** Nodes or books the user selected: always included in full. */
  selected_ids?: string[];
  book_id?: string;
  /** Rough size limit in characters for the summaries (default 4000). */
  budget_chars?: number;
  limit?: number;
}

export interface ContextPack {
  question: string | null;
  selected: ObjectView[];
  related: { id: string; kind: string; title: string; summary: string; verification: string; attribution?: string; matched: string[] }[];
  books: { id: string; title: string; authors: string[]; tags: string[] }[];
  relations: { from: string; type: string; to: string; verification: string }[];
  open_questions: { id: string; title: string }[];
  truncated: boolean;
  /** How to fetch anything cut here. */
  more: string;
}

export function buildContext(store: AtlasStore, request: ContextRequest): ContextPack {
  const budget = request.budget_chars ?? 4000;
  const selected = (request.selected_ids ?? []).map((id) => describe(store, id)).filter((v): v is ObjectView => Boolean(v));
  const selectedIds = new Set(selected.map((v) => String(v.object.id)));
  const hits = request.question?.trim()
    ? search(store, request.question, { kinds: ["node", "book"], book_id: request.book_id, expand_neighbors: true, limit: request.limit ?? 12 })
    : request.book_id ? search(store, "", { kinds: ["node"], book_id: request.book_id, limit: request.limit ?? 12 }) : [];

  const pack: ContextPack = { question: request.question ?? null, selected, related: [], books: [], relations: [], open_questions: [], truncated: false, more: "Call atlas_read with an id for the full object, its relations and sources." };
  let used = JSON.stringify(selected).length;
  const ids = new Set(selectedIds);
  for (const hit of hits) {
    if (selectedIds.has(hit.id)) continue;
    if (hit.kind === "book") {
      const book = store.books.get(hit.id)!;
      pack.books.push({ id: book.id, title: book.title, authors: book.authors, tags: book.tag_bindings.map((b) => resolveTag(store.tags, b.tag_id)?.name ?? b.tag_id) });
      ids.add(book.id);
      continue;
    }
    const node = store.nodes.get(hit.id)!;
    const entry = { id: node.id, kind: node.type, title: node.title, summary: node.summary, verification: node.verification, attribution: node.attribution, matched: hit.reasons };
    const size = JSON.stringify(entry).length;
    if (used + size > budget) {
      pack.truncated = true;
      break;
    }
    used += size;
    pack.related.push(entry);
    ids.add(node.id);
  }
  // Books behind the knowledge in view, and the relations among what is in view.
  for (const id of [...ids]) {
    for (const relation of store.relationsOf(id)) {
      const other = relation.from_id === id ? relation.to_id : relation.from_id;
      if (kindOfId(other) === "book" && !pack.books.some((b) => b.id === other)) {
        const book = store.books.get(other);
        if (book && !book.archived) pack.books.push({ id: book.id, title: book.title, authors: book.authors, tags: book.tag_bindings.map((b) => resolveTag(store.tags, b.tag_id)?.name ?? b.tag_id) });
      }
      if (ids.has(other) && !pack.relations.some((r) => r.from === relation.from_id && r.to === relation.to_id && r.type === relation.type)) {
        pack.relations.push({ from: relation.from_id, type: relation.type, to: relation.to_id, verification: relation.verification });
      }
    }
  }
  pack.open_questions = pack.related.filter((r) => r.kind === "question").map(({ id, title }) => ({ id, title }));
  return pack;
}
