import { kindOfId, type Book, type KnowledgeNode, type ObjectKind } from "./schema";
import type { AtlasStore } from "./store";
import { coverageRank, findTagsByLabel, normalizeLabel, resolveTag } from "./tags";

// First-version search (§12.1): exact id, title, tags and aliases, entry
// questions, then words in the text, optionally widened by relations. Chinese
// has no spaces, so text is indexed as single characters and character pairs;
// Latin text and numbers as words. Filters apply before ranking, and every hit
// says what it matched.

export interface SearchOptions {
  kinds?: ObjectKind[];
  /** Only objects bound to every one of these tags (merged ids are followed). */
  tag_ids?: string[];
  /** Only nodes related to this book (and the book itself). */
  book_id?: string;
  include_archived?: boolean;
  /** Add objects one relation away from the hits, ranked below them. */
  expand_neighbors?: boolean;
  limit?: number;
}

export interface SearchHit {
  id: string;
  kind: ObjectKind;
  title: string;
  score: number;
  reasons: string[];
}

const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = normalizeLabel(text);
  let run = "";
  const flushRun = () => {
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let latin = "";
    for (const char of word) {
      if (HAN.test(char)) {
        if (latin) { tokens.push(latin); latin = ""; }
        run += char;
      } else {
        if (run) flushRun();
        latin += char;
      }
    }
    if (latin) tokens.push(latin);
    if (run) flushRun();
  }
  return tokens;
}

interface Entry {
  id: string;
  kind: ObjectKind;
  title: string;
  labels: string[];
  questions: string[];
  text: Set<string>;
  coverage: Map<string, number>;
  archived: boolean;
}

const indexes = new WeakMap<AtlasStore, { version: number; entries: Entry[] }>();

function buildIndex(store: AtlasStore): Entry[] {
  const entries: Entry[] = [];
  const bound = (obj: Book | KnowledgeNode) => {
    const coverage = new Map<string, number>();
    for (const binding of obj.tag_bindings) {
      const live = resolveTag(store.tags, binding.tag_id);
      if (live) coverage.set(live.id, Math.min(coverage.get(live.id) ?? 9, coverageRank(binding.coverage)));
    }
    return coverage;
  };
  for (const book of store.books.values()) {
    entries.push({
      id: book.id, kind: "book", title: book.title,
      labels: [book.title, ...Object.values(book.external_ids)],
      questions: book.entry_questions,
      text: new Set(tokenize([book.title, book.authors.join(" "), book.entry_questions.join(" "), book.body].join("\n"))),
      coverage: bound(book), archived: Boolean(book.archived),
    });
  }
  for (const node of store.nodes.values()) {
    entries.push({
      id: node.id, kind: "node", title: node.title,
      labels: [node.title, ...node.aliases],
      questions: node.type === "question" ? [node.title] : [],
      text: new Set(tokenize([node.title, node.aliases.join(" "), node.summary, node.body].join("\n"))),
      coverage: bound(node), archived: Boolean(node.archived),
    });
  }
  for (const tag of store.tags.values()) {
    if (tag.status === "merged") continue;
    entries.push({
      id: tag.id, kind: "tag", title: tag.name,
      labels: [tag.name, ...tag.aliases],
      questions: tag.type === "question" ? [tag.name] : [],
      text: new Set(tokenize([tag.name, tag.aliases.join(" "), tag.definition].join("\n"))),
      coverage: new Map(), archived: tag.status === "archived",
    });
  }
  return entries;
}

function entriesOf(store: AtlasStore): Entry[] {
  const cached = indexes.get(store);
  if (cached && cached.version === store.version) return cached.entries;
  const entries = buildIndex(store);
  indexes.set(store, { version: store.version, entries });
  return entries;
}

const COVERAGE_WEIGHT = [1, 0.6, 0.3]; // core, discussed, mentioned
const COVERAGE_NAME = ["core", "discussed", "mentioned"];

export function search(store: AtlasStore, query: string, options: SearchOptions = {}): SearchHit[] {
  const kinds = new Set(options.kinds ?? ["book", "node", "tag"]);
  const limit = options.limit ?? 20;
  const wanted = normalizeLabel(query);
  const queryTokens = [...new Set(tokenize(query))];
  const filterTags = (options.tag_ids ?? []).map((id) => resolveTag(store.tags, id)?.id ?? id);
  let bookScope: Set<string> | null = null;
  if (options.book_id) {
    bookScope = new Set([options.book_id]);
    for (const relation of store.relationsOf(options.book_id)) bookScope.add(relation.from_id === options.book_id ? relation.to_id : relation.from_id);
  }
  // A query that names a tag finds what is bound to it, ranked by coverage:
  // by its exact name, or by mentioning it in a sentence ("自然法讲了什么").
  const namedTags = wanted ? [...new Map([...findTagsByLabel(store.tags, query), ...[...store.tags.values()].filter((tag) => tag.status === "active"
    && [tag.name, ...tag.aliases].some((label) => normalizeLabel(label).length >= 2 && wanted.includes(normalizeLabel(label))))].map((tag) => [tag.id, tag])).values()] : [];

  const hits = new Map<string, SearchHit>();
  for (const entry of entriesOf(store)) {
    if (!kinds.has(entry.kind)) continue;
    if (entry.archived && !options.include_archived) continue;
    if (filterTags.some((tagId) => !entry.coverage.has(tagId))) continue;
    if (bookScope && !bookScope.has(entry.id)) continue;

    let score = 0;
    const reasons: string[] = [];
    if (!wanted) {
      score = 1;
      reasons.push("filter");
    } else {
      if (entry.id === query.trim()) { score += 1000; reasons.push("id"); }
      const label = entry.labels.find((l) => normalizeLabel(l) === wanted);
      if (label !== undefined) {
        const isTitle = normalizeLabel(entry.title) === wanted;
        score += isTitle ? 300 : 250;
        reasons.push(isTitle ? "title" : `alias: ${label}`);
      } else {
        // Questions are sentences: "自然状态是什么" names the node 自然状态.
        const mentioned = entry.labels.filter((l) => normalizeLabel(l).length >= 2 && wanted.includes(normalizeLabel(l)))
          .sort((a, b) => b.length - a.length)[0];
        if (mentioned) { score += 200; reasons.push(`mentions: ${mentioned}`); }
      }
      for (const tag of namedTags) {
        const rank = entry.coverage.get(tag.id);
        if (rank !== undefined) {
          score += 120 * COVERAGE_WEIGHT[rank];
          reasons.push(`tag: ${tag.name} (${COVERAGE_NAME[rank]})`);
        }
      }
      const question = entry.questions.find((q) => normalizeLabel(q) === wanted || normalizeLabel(q).includes(wanted));
      if (question) { score += 150; reasons.push(`question: ${question}`); }
      if (label === undefined && wanted.length > 1 && normalizeLabel(entry.title).includes(wanted)) { score += 100; reasons.push("title contains"); }
      if (queryTokens.length > 0) {
        const overlap = queryTokens.filter((t) => entry.text.has(t)).length / queryTokens.length;
        // Below a third of the query's characters in common is noise for short Chinese queries.
        if (overlap >= 0.34) { score += Math.round(60 * overlap); reasons.push(`text ${Math.round(overlap * 100)}%`); }
      }
    }
    if (score > 0) hits.set(entry.id, { id: entry.id, kind: entry.kind, title: entry.title, score, reasons });
  }

  if (options.expand_neighbors) {
    for (const hit of [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit)) {
      for (const relation of store.relationsOf(hit.id)) {
        const otherId = relation.from_id === hit.id ? relation.to_id : relation.from_id;
        const kind = kindOfId(otherId);
        if (!kind || !kinds.has(kind) || hits.has(otherId)) continue;
        const other = kind === "book" ? store.books.get(otherId) : store.nodes.get(otherId);
        if (!other || (other.archived && !options.include_archived)) continue;
        hits.set(otherId, { id: otherId, kind, title: other.title, score: Math.round(hit.score * 0.3), reasons: [`${relation.type} ${hit.title}`] });
      }
    }
  }

  return [...hits.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
