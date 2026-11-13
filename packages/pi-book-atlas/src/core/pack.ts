// Packs for other applications and games (§15): an offline JSON file with the
// books, knowledge, tags and relations, indexed by the same tag ids the
// library uses, so another system finds the same material for the same tag.
//
// A pack never carries the person: no conversations (no session or message
// ids, no chat text), no canvas layout, no local paths, and by default not the
// user's own understanding. What it keeps is where knowledge comes from: each
// item says whether it is related reading, a paraphrase of a view, or a
// quotation, and what kind of source backs it and how well checked it is.

import { clcLabel, CLC_SCHEME } from "./clc";
import type { AtlasStore } from "./store";
import { resolveTag } from "./tags";
import { kindOfId, type Book, type KnowledgeNode, type Relation, type Source } from "./schema";

export const PACK_FORMAT = "pi-book-atlas/pack";
export const PACK_SCHEMA_VERSION = 1;

/** For a game set in a given world and time (§15). Unknown dates or provenance are never allowed. */
export interface GameFilter {
  /** Only books first published in or before this year (negative for BCE). Books without a year are left out. */
  until_year?: number;
  /** Only these books, e.g. the ones a character has read. */
  book_ids?: string[];
}

export interface PackOptions {
  /** Only books and knowledge carrying at least one of these tags (with their tag's children). */
  tag_ids?: string[];
  /** Include knowledge attributed to the user's own understanding (default: no). */
  include_user_notes?: boolean;
  game?: GameFilter;
  title?: string;
}

/** How an item may be used in an answer. */
export type PackUse = "reading" | "paraphrase" | "quotation" | "setting";

export interface PackTagRef { tag_id: string; coverage: string }
export interface PackSource { kind: string; title: string | null; granularity: string; verification: string; locator?: { chapter?: string; section?: string; page?: string }; url?: string }

export interface PackBook {
  id: string; title: string; authors: string[]; published_year: number | null;
  classification: { scheme_id: string | null; codes: string[]; labels: string[] };
  tags: PackTagRef[]; entry_questions: string[]; body: string; verification: string; use: "reading";
}
export interface PackNode {
  id: string; type: string; title: string; summary: string; aliases: string[]; body: string;
  attribution: string; verification: string; use: PackUse;
  tags: PackTagRef[];
  /** Books this knowledge comes from or is discussed in, with how. */
  books: { book_id: string; relation: string }[];
  sources: PackSource[];
}
export interface PackRelation { id: string; from_id: string; to_id: string; type: string; attribution: string; note: string | null }
export interface PackTag { id: string; type: string; name: string; aliases: string[]; definition: string; parent_ids: string[] }

export interface AtlasPack {
  format: typeof PACK_FORMAT;
  schema_version: number;
  exported_at: string;
  title: string | null;
  source: { atlas_id: string; workspace_revision: number };
  filters: { tag_ids: string[]; include_user_notes: boolean; game: GameFilter | null };
  tags: PackTag[];
  books: PackBook[];
  nodes: PackNode[];
  relations: PackRelation[];
  /** tag id → what carries it, strongest coverage first. Merged tag ids point to the surviving tag. */
  tag_index: Record<string, { books: string[]; nodes: string[] }>;
  /** Merged tag id → surviving tag id, so old ids still resolve. */
  tag_redirects: Record<string, string>;
  counts: { books: number; nodes: number; relations: number; tags: number };
  excluded: { conversations: true; layout: true; user_notes: boolean; archived: true; outside_game: number };
}

const COVERAGE_ORDER: Record<string, number> = { core: 0, discussed: 1, mentioned: 2 };

function sourceView(source: Source): PackSource {
  const view: PackSource = { kind: source.kind, title: source.kind === "conversation" ? null : source.title, granularity: source.granularity === "message" ? "none" : source.granularity, verification: source.verification };
  // Only places in a published work travel; a conversation's session and message ids never do.
  if (source.kind !== "conversation" && source.locator) {
    const { chapter, section, page } = source.locator;
    if (chapter || section || page) view.locator = { ...(chapter ? { chapter } : {}), ...(section ? { section } : {}), ...(page ? { page } : {}) };
  }
  if (source.url && /^https?:\/\//i.test(source.url)) view.url = source.url;
  return view;
}

/** A quotation only when it is attributed as one and a checked source places it in the text. */
function useOf(node: KnowledgeNode, sources: Source[]): PackUse {
  if (node.attribution === "game_setting") return "setting";
  if (node.attribution === "quoted" && sources.some((s) => s.kind === "book_text" && s.verification === "verified" && ["page", "section", "chapter"].includes(s.granularity))) return "quotation";
  return "paraphrase";
}

export function exportPack(store: AtlasStore, options: PackOptions = {}, now: () => string = () => new Date().toISOString()): AtlasPack {
  const live = (id: string) => resolveTag(store.tags, id)?.id ?? null;
  // A tag filter includes the tags under it.
  let wanted: Set<string> | null = null;
  if (options.tag_ids?.length) {
    wanted = new Set(options.tag_ids.map(live).filter((id): id is string => Boolean(id)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const tag of store.tags.values()) {
        if (tag.status === "active" && !wanted.has(tag.id) && tag.parent_ids.some((p) => wanted!.has(live(p) ?? p))) { wanted.add(tag.id); grew = true; }
      }
    }
  }
  const carries = (obj: Book | KnowledgeNode) => !wanted || obj.tag_bindings.some((b) => wanted!.has(live(b.tag_id) ?? b.tag_id));

  const game = options.game ?? null;
  let outsideGame = 0;
  const inGame = (book: Book) => {
    if (!game) return true;
    if (game.book_ids && !game.book_ids.includes(book.id)) return false;
    if (game.until_year !== undefined && (book.published_year == null || book.published_year > game.until_year)) return false;
    return true;
  };

  const books = [...store.books.values()].filter((b) => !b.archived && carries(b));
  const bookIds = new Set<string>();
  for (const book of books) {
    if (inGame(book)) bookIds.add(book.id);
    else outsideGame += 1;
  }

  const bookLinks = (nodeId: string) => store.relationsOf(nodeId)
    .map((r) => ({ book_id: r.from_id === nodeId ? r.to_id : r.from_id, relation: r.type }))
    .filter((link) => kindOfId(link.book_id) === "book");

  const nodes: KnowledgeNode[] = [];
  for (const node of store.nodes.values()) {
    if (node.archived) continue;
    if (node.attribution === "user_understanding" && !options.include_user_notes) continue;
    const links = bookLinks(node.id);
    if (!carries(node) && !links.some((l) => bookIds.has(l.book_id))) continue;
    // In a game, knowledge must reach the world through an allowed book.
    if (game && !links.some((l) => bookIds.has(l.book_id))) { outsideGame += 1; continue; }
    nodes.push(node);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const kept = (id: string) => bookIds.has(id) || nodeIds.has(id);

  const relations: Relation[] = [...store.relations.values()].filter((r) => !r.archived && kept(r.from_id) && kept(r.to_id));

  const tagRefs = (obj: Book | KnowledgeNode): PackTagRef[] => {
    const best = new Map<string, string>();
    for (const b of obj.tag_bindings) {
      const id = live(b.tag_id);
      if (!id) continue;
      const prev = best.get(id);
      if (!prev || COVERAGE_ORDER[b.coverage] < COVERAGE_ORDER[prev]) best.set(id, b.coverage);
    }
    return [...best].map(([tag_id, coverage]) => ({ tag_id, coverage })).sort((a, b) => COVERAGE_ORDER[a.coverage] - COVERAGE_ORDER[b.coverage]);
  };
  const sourcesOf = (obj: Book | KnowledgeNode): Source[] => {
    const refs = new Set(obj.source_refs);
    for (const b of obj.tag_bindings) for (const ref of b.source_refs) refs.add(ref);
    return [...refs].map((ref) => store.sources.get(ref)).filter((s): s is Source => Boolean(s));
  };

  const packBooks: PackBook[] = books.filter((b) => bookIds.has(b.id)).map((book) => ({
    id: book.id, title: book.title, authors: book.authors, published_year: book.published_year ?? null,
    classification: {
      scheme_id: book.classification.scheme_id,
      codes: book.classification.codes,
      labels: book.classification.scheme_id === CLC_SCHEME ? book.classification.codes.map((c) => clcLabel(c) ?? c) : [],
    },
    tags: tagRefs(book), entry_questions: book.entry_questions, body: book.body, verification: book.verification, use: "reading",
  }));
  const packNodes: PackNode[] = nodes.map((node) => {
    const sources = sourcesOf(node);
    return {
      id: node.id, type: node.type, title: node.title, summary: node.summary, aliases: node.aliases, body: node.body,
      attribution: node.attribution, verification: node.verification, use: useOf(node, sources),
      tags: tagRefs(node),
      books: bookLinks(node.id).filter((l) => bookIds.has(l.book_id)),
      sources: sources.map(sourceView),
    };
  });

  const usedTags = new Set<string>();
  for (const item of [...packBooks, ...packNodes]) for (const t of item.tags) usedTags.add(t.tag_id);
  // Keep ancestors so the hierarchy reads the same outside.
  for (const id of [...usedTags]) {
    const stack = [id];
    while (stack.length) {
      const tag = store.tags.get(stack.pop()!);
      for (const p of tag?.parent_ids ?? []) {
        const pid = live(p);
        if (pid && !usedTags.has(pid)) { usedTags.add(pid); stack.push(pid); }
      }
    }
  }
  const tags: PackTag[] = [...usedTags].map((id) => store.tags.get(id)!).filter(Boolean).map((t) => ({
    id: t.id, type: t.type, name: t.name, aliases: t.aliases, definition: t.definition, parent_ids: t.parent_ids.map((p) => live(p) ?? p),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const tagIndex: AtlasPack["tag_index"] = {};
  const add = (tag: PackTagRef, kind: "books" | "nodes", id: string) => {
    (tagIndex[tag.tag_id] ??= { books: [], nodes: [] })[kind].push(id);
  };
  const byCoverage = <T extends { tags: PackTagRef[] }>(items: T[], tagId: string) => items
    .map((item) => ({ item, rank: COVERAGE_ORDER[item.tags.find((t) => t.tag_id === tagId)?.coverage ?? "mentioned"] }))
    .sort((a, b) => a.rank - b.rank).map((x) => x.item);
  for (const book of packBooks) for (const t of book.tags) add(t, "books", book.id);
  for (const node of packNodes) for (const t of node.tags) add(t, "nodes", node.id);
  for (const [tagId, entry] of Object.entries(tagIndex)) {
    entry.books = byCoverage(entry.books.map((id) => packBooks.find((b) => b.id === id)!), tagId).map((b) => b.id);
    entry.nodes = byCoverage(entry.nodes.map((id) => packNodes.find((n) => n.id === id)!), tagId).map((n) => n.id);
  }
  const redirects: Record<string, string> = {};
  for (const tag of store.tags.values()) {
    if (tag.status === "merged") {
      const target = live(tag.id);
      if (target && usedTags.has(target)) redirects[tag.id] = target;
    }
  }

  return {
    format: PACK_FORMAT,
    schema_version: PACK_SCHEMA_VERSION,
    exported_at: now(),
    title: options.title ?? null,
    source: { atlas_id: store.meta.atlas_id, workspace_revision: store.meta.workspace_revision },
    filters: { tag_ids: options.tag_ids ?? [], include_user_notes: Boolean(options.include_user_notes), game },
    tags,
    books: packBooks,
    nodes: packNodes,
    relations: relations.map((r) => ({ id: r.id, from_id: r.from_id, to_id: r.to_id, type: r.type, attribution: r.attribution, note: r.note ?? null })),
    tag_index: tagIndex,
    tag_redirects: redirects,
    counts: { books: packBooks.length, nodes: packNodes.length, relations: relations.length, tags: tags.length },
    excluded: { conversations: true, layout: true, user_notes: !options.include_user_notes, archived: true, outside_game: outsideGame },
  };
}

/**
 * What an outside system does with a pack: find material by tag id, alias or
 * name, books as related reading, knowledge as paraphrase, quotation or setting.
 */
export function lookupPack(pack: AtlasPack, tag: string) {
  const norm = (s: string) => s.trim().toLowerCase();
  const id = pack.tag_redirects[tag] ?? pack.tags.find((t) => t.id === tag || norm(t.name) === norm(tag) || t.aliases.some((a) => norm(a) === norm(tag)))?.id;
  const entry = id ? pack.tag_index[id] : undefined;
  if (!id || !entry) return { tag_id: id ?? null, reading: [], paraphrases: [], quotations: [], settings: [] };
  const nodes = entry.nodes.map((n) => pack.nodes.find((x) => x.id === n)!);
  return {
    tag_id: id,
    reading: entry.books.map((b) => pack.books.find((x) => x.id === b)!),
    paraphrases: nodes.filter((n) => n.use === "paraphrase"),
    quotations: nodes.filter((n) => n.use === "quotation"),
    settings: nodes.filter((n) => n.use === "setting"),
  };
}
