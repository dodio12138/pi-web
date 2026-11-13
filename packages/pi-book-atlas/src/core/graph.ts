// The part of the library a canvas shows. A canvas never shows everything:
// it shows one book's knowledge, one conversation's, the knowledge shared by
// several books, or a search, and the user expands from there one relation
// at a time (§4).

import { clcLabel, CLC_SCHEME } from "./clc";
import { search } from "./search";
import type { AtlasStore } from "./store";
import { resolveTag } from "./tags";
import { kindOfId, type Book, type KnowledgeNode, type Relation } from "./schema";

export type GraphViewKind = "book" | "session" | "cross" | "search";

export interface GraphRequest {
  view: GraphViewKind;
  book_id?: string;
  session_id?: string;
  /** Search words, for the search view. */
  q?: string;
  /** Only knowledge carrying all of these tags (books in view stay). */
  tag_ids?: string[];
  /** Cards whose neighbours the user opened. */
  expand?: string[];
  /** Ids in the view's hidden list. */
  hidden?: string[];
  /** At most this many cards (default 120). */
  limit?: number;
}

export interface GraphCard {
  id: string;
  kind: "book" | "node";
  /** The node type, or "book". */
  type: string;
  title: string;
  summary: string;
  tags: string[];
  verification: string;
  attribution: string | null;
  /** For books: authors and the 中图法 label of the main class. */
  subtitle: string;
  revision: number;
  updated_at: string;
  /** Neighbours not on the canvas: something to expand. */
  more: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  attribution: string;
  note: string | null;
}

export interface Graph {
  key: string;
  cards: GraphCard[];
  edges: GraphEdge[];
  truncated: boolean;
  revision: number;
}

/** The key layouts and hidden lists are stored under. */
export function graphKey(request: Pick<GraphRequest, "view" | "book_id" | "session_id">): string {
  if (request.view === "book") return `book:${request.book_id ?? ""}`;
  if (request.view === "session") return `session:${request.session_id ?? ""}`;
  return request.view;
}

type Item = Book | KnowledgeNode;

export function buildGraph(store: AtlasStore, request: GraphRequest): Graph {
  const limit = request.limit ?? 120;
  const live = (id: string): Item | null => {
    const obj = store.books.get(id) ?? store.nodes.get(id);
    return obj && !obj.archived ? obj : null;
  };
  const neighbours = (id: string): string[] => store.relationsOf(id).map((r) => (r.from_id === id ? r.to_id : r.from_id)).filter((other) => live(other));

  const ids = new Set<string>();
  const pinned = new Set<string>(); // never filtered out by tags
  switch (request.view) {
    case "book": {
      const book = request.book_id ? live(request.book_id) : null;
      if (book) {
        ids.add(book.id);
        pinned.add(book.id);
        for (const other of neighbours(book.id)) ids.add(other);
      }
      break;
    }
    case "session": {
      const sid = request.session_id;
      if (!sid) break;
      const cited = new Set([...store.sources.values()].filter((s) => s.kind === "conversation" && s.locator?.session_id === sid).map((s) => s.id));
      const cites = (refs: string[] | undefined) => (refs ?? []).some((ref) => cited.has(ref));
      for (const obj of [...store.books.values(), ...store.nodes.values()]) {
        if (obj.archived) continue;
        if (cites(obj.source_refs) || obj.tag_bindings.some((b) => cites(b.source_refs))) ids.add(obj.id);
      }
      for (const relation of store.relations.values()) {
        if (relation.archived || !cites(relation.source_refs)) continue;
        if (live(relation.from_id)) ids.add(relation.from_id);
        if (live(relation.to_id)) ids.add(relation.to_id);
      }
      break;
    }
    case "cross": {
      // Knowledge more than one book leads to, and those books.
      for (const node of store.nodes.values()) {
        if (node.archived) continue;
        const books = neighbours(node.id).filter((other) => kindOfId(other) === "book");
        if (new Set(books).size < 2) continue;
        ids.add(node.id);
        for (const b of books) { ids.add(b); pinned.add(b); }
      }
      break;
    }
    case "search": {
      const hits = search(store, request.q ?? "", { kinds: ["book", "node"], tag_ids: request.tag_ids, limit: Math.min(limit, 40) });
      for (const hit of hits) ids.add(hit.id);
      break;
    }
  }
  for (const id of request.expand ?? []) {
    if (!live(id)) continue;
    ids.add(id);
    for (const other of neighbours(id)) ids.add(other);
  }

  const tagFilter = (request.tag_ids ?? []).map((id) => resolveTag(store.tags, id)?.id ?? id);
  const hasTags = (obj: Item) => tagFilter.every((tagId) => obj.tag_bindings.some((b) => resolveTag(store.tags, b.tag_id)?.id === tagId));
  const hidden = new Set(request.hidden ?? []);

  let chosen = [...ids].map(live).filter((obj): obj is Item => Boolean(obj))
    .filter((obj) => !hidden.has(obj.id))
    .filter((obj) => pinned.has(obj.id) || (request.expand ?? []).includes(obj.id) || hasTags(obj));
  const truncated = chosen.length > limit;
  if (truncated) {
    // Keep the anchors, then the most recently changed.
    chosen = chosen.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  }
  const onCanvas = new Set(chosen.map((obj) => obj.id));

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const id of onCanvas) {
    for (const relation of store.relationsOf(id) as Relation[]) {
      if (seen.has(relation.id) || !onCanvas.has(relation.from_id) || !onCanvas.has(relation.to_id)) continue;
      seen.add(relation.id);
      edges.push({ id: relation.id, from: relation.from_id, to: relation.to_id, type: relation.type, attribution: relation.attribution, note: relation.note ?? null });
    }
  }

  const cards: GraphCard[] = chosen.map((obj) => {
    const isBook = kindOfId(obj.id) === "book";
    const book = obj as Book;
    const node = obj as KnowledgeNode;
    const mainClass = isBook && book.classification.scheme_id === CLC_SCHEME && book.classification.codes[0] ? clcLabel(book.classification.codes[0]) : null;
    return {
      id: obj.id,
      kind: isBook ? "book" : "node",
      type: isBook ? "book" : node.type,
      title: obj.title,
      summary: isBook ? (book.entry_questions[0] ?? "") : node.summary,
      tags: obj.tag_bindings.filter((b) => b.coverage !== "mentioned").map((b) => resolveTag(store.tags, b.tag_id)?.name ?? b.tag_id),
      verification: obj.verification,
      attribution: isBook ? null : node.attribution,
      subtitle: isBook ? [book.authors.join("、"), mainClass].filter(Boolean).join(" · ") : "",
      revision: obj.revision,
      updated_at: obj.updated_at,
      more: neighbours(obj.id).filter((other) => !onCanvas.has(other)).length,
    };
  });

  return { key: graphKey(request), cards, edges, truncated, revision: store.meta.workspace_revision };
}

/** The books, for the books bar: title, authors, main class, core tags, how much knowledge. */
export function listBooks(store: AtlasStore) {
  return [...store.books.values()].filter((b) => !b.archived).map((book) => ({
    id: book.id,
    title: book.title,
    authors: book.authors,
    classes: book.classification.scheme_id === CLC_SCHEME ? book.classification.codes.map((c) => clcLabel(c) ?? c) : book.classification.codes,
    tags: book.tag_bindings.filter((b) => b.coverage === "core").map((b) => resolveTag(store.tags, b.tag_id)?.name ?? b.tag_id),
    knowledge: store.relationsOf(book.id).length,
    updated_at: book.updated_at,
  })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Active tags with how many live objects carry each, for the tag filter. */
export function listTags(store: AtlasStore) {
  const counts = new Map<string, number>();
  for (const obj of [...store.books.values(), ...store.nodes.values()]) {
    if (obj.archived) continue;
    for (const b of obj.tag_bindings) {
      const id = resolveTag(store.tags, b.tag_id)?.id;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...store.tags.values()].filter((t) => t.status === "active")
    .map((t) => ({ id: t.id, name: t.name, type: t.type, aliases: t.aliases, count: counts.get(t.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
