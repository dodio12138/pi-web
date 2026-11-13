// The Atlas data model (docs: Pi Book Atlas development guide §5–§8).
//
// Every object carries a stable id that has no meaning of its own (renaming a
// book or a tag never changes it), a schema_version, a revision that rises by
// one on every change, timestamps, source references and a verification
// state. Validation returns a list of problems instead of throwing, so a tool
// or the UI can say exactly which field is wrong.

import { CLC_MAX_CODES, CLC_SCHEME, clcCandidates, clcClassOf } from "./clc";

export const SCHEMA_VERSION = 1;

export const VERIFICATION = ["pending", "partial", "verified"] as const;
export type Verification = (typeof VERIFICATION)[number];

export const NODE_TYPES = ["concept", "claim", "method", "skill", "question", "example"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TAG_TYPES = ["domain", "topic", "question", "method"] as const;
export type TagType = (typeof TAG_TYPES)[number];

export const TAG_STATUS = ["active", "merged", "archived"] as const;
export type TagStatus = (typeof TAG_STATUS)[number];

/** How central a tag is to what it is bound to: core outranks discussed outranks mentioned. */
export const COVERAGE = ["core", "discussed", "mentioned"] as const;
export type Coverage = (typeof COVERAGE)[number];

/** Who assigned a tag: a person, a check against sources, or the model's inference. */
export const ASSIGNED_BY = ["human", "source_checked", "ai_inference"] as const;
export type AssignedBy = (typeof ASSIGNED_BY)[number];

/** Whose view a piece of knowledge is (§8): never promoted by a person merely agreeing with it. */
export const ATTRIBUTION = ["author_claim", "quoted", "later_interpretation", "ai_synthesis", "user_understanding", "game_setting"] as const;
export type Attribution = (typeof ATTRIBUTION)[number];

/**
 * Relations between knowledge, kept few so each is easy to choose:
 * supports / refutes (a qualification is a refutes with a note "限定：…") /
 * answers (a claim answering a question) / explains (definitions, examples
 * and applications too) / requires (what must be understood first) /
 * develops (builds on: intellectual lineage) / related_to (the fallback,
 * comparisons too; symmetric).
 */
export const KNOWLEDGE_RELATIONS = ["supports", "refutes", "answers", "explains", "requires", "develops", "related_to"] as const;
/** From a book to knowledge: expounds (also first statements and adoptions), criticizes, mentions; studied_in is added for a book's own session. */
export const BOOK_RELATIONS = ["expounds", "criticizes", "mentions", "studied_in"] as const;
/**
 * Types from before the relation set was trimmed. Files that use them stay
 * valid and show under the type they fold into; new relations cannot use them.
 */
export const LEGACY_RELATIONS = {
  defines: "explains",
  exemplifies: "explains",
  applies_to: "explains",
  qualifies: "refutes",
  compares: "related_to",
  introduces: "expounds",
  adopts: "expounds",
} as const;
export type LegacyRelationType = keyof typeof LEGACY_RELATIONS;
export const RELATION_TYPES = [...KNOWLEDGE_RELATIONS, ...BOOK_RELATIONS, ...(Object.keys(LEGACY_RELATIONS) as LegacyRelationType[])] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
/** Book relations, legacy ones included: they start at a book. */
export const FROM_BOOK_RELATIONS: readonly RelationType[] = [...BOOK_RELATIONS, "introduces", "adopts"];
export const SYMMETRIC_RELATIONS: ReadonlySet<RelationType> = new Set(["related_to", "compares"]);
/** The type a relation shows as: itself, or what a legacy type folds into. */
export function canonicalRelation(type: string): string {
  return (LEGACY_RELATIONS as Record<string, string>)[type] ?? type;
}

export const SOURCE_KINDS = ["bibliographic", "conversation", "web", "user_note", "book_text", "research", "model_explanation"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** How precisely a source locates what it supports; quotes need page-level locators (§8). */
export const GRANULARITY = ["none", "work", "chapter", "section", "page", "message"] as const;
export type Granularity = (typeof GRANULARITY)[number];

export interface Common {
  id: string;
  schema_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  source_refs: string[];
  verification: Verification;
}

export interface TagBinding {
  tag_id: string;
  coverage: Coverage;
  assigned_by: AssignedBy;
  source_refs: string[];
  reason?: string;
}

/** Where a book's table of contents came from: typed or pasted by the user, found on the web, or recalled by the model (unchecked). */
export const OUTLINE_SOURCES = ["user", "web", "model"] as const;
export type OutlineSource = (typeof OUTLINE_SOURCES)[number];
export const OUTLINE_LEVELS = ["part", "chapter", "section"] as const;
export type OutlineLevel = (typeof OUTLINE_LEVELS)[number];

/** One entry of a table of contents, in reading order. `id` is short and stable ("p1", "c2", "s12") so knowledge can point at it. */
export interface OutlineItem {
  id: string;
  title: string;
  level: OutlineLevel;
  /** The part a chapter is in, the chapter a section is in; null at the top. */
  parent: string | null;
}

export interface BookOutline {
  source: OutlineSource;
  /** What the source was, e.g. "用户贴的目录" or a URL. */
  note?: string;
  items: OutlineItem[];
}

export interface Book extends Common {
  title: string;
  authors: string[];
  /** Year of first publication, negative for BCE; absent when unknown. Game packs filter on it. */
  published_year?: number | null;
  /** Ids in other systems, e.g. `book_atlas` for the 文脉 workbench, namespaced by the key. */
  external_ids: Record<string, string>;
  classification: { scheme_id: string | null; scheme_version: string | null; codes: string[] };
  tag_bindings: TagBinding[];
  entry_questions: string[];
  /** The table of contents: the spine of the book's graph. Absent until someone supplies it. */
  outline?: BookOutline | null;
  /** The workbench's descriptive attributes, kept as they were (§6.2, §13). */
  description_profile?: Record<string, unknown>;
  archived?: boolean;
  /** Markdown after the front matter. */
  body: string;
}

export interface KnowledgeNode extends Common {
  type: NodeType;
  title: string;
  summary: string;
  aliases: string[];
  tag_bindings: TagBinding[];
  attribution: Attribution;
  archived?: boolean;
  body: string;
}

export interface Tag {
  id: string;
  schema_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  type: TagType;
  name: string;
  definition: string;
  aliases: string[];
  parent_ids: string[];
  status: TagStatus;
  /** Set when merged: bindings and lookups follow it to the surviving tag. */
  redirect_to: string | null;
  /** Ids merged into this tag, kept as the migration record. */
  merged_from?: string[];
}

export interface Relation extends Common {
  from_id: string;
  to_id: string;
  type: RelationType;
  /** What the relation is about, e.g. "work" for a whole book. */
  scope?: string;
  attribution: Attribution;
  note?: string;
  archived?: boolean;
}

export interface SourceLocator {
  session_id?: string;
  branch_id?: string;
  message_id?: string;
  chapter?: string;
  section?: string;
  page?: string;
}

export interface Source {
  id: string;
  schema_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  kind: SourceKind;
  title: string;
  url?: string;
  edition?: string;
  locator?: SourceLocator;
  granularity: Granularity;
  verification: Verification;
}

export interface AtlasMeta {
  schema_version: number;
  atlas_id: string;
  /** Rises by one with every committed patch. */
  workspace_revision: number;
  created_at: string;
  config: Record<string, unknown>;
}

export type ObjectKind = "book" | "node" | "tag" | "relation" | "source";
export type AtlasObject = Book | KnowledgeNode | Tag | Relation | Source;

/** Id prefixes: readable at a glance, never parsed for meaning beyond the kind. */
export const ID_PREFIX: Record<ObjectKind, string> = {
  book: "book",
  node: "node",
  tag: "tag",
  relation: "rel",
  source: "src",
};

export function kindOfId(id: string): ObjectKind | null {
  const prefix = id.split("-", 1)[0];
  for (const [kind, p] of Object.entries(ID_PREFIX)) if (p === prefix) return kind as ObjectKind;
  return null;
}

export interface Problem {
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Validation. Each validator checks shape and allowed values of one object;
// references between objects are checked by the store, which sees them all.

const ID_PATTERN = /^[a-z]+-[a-z0-9][a-z0-9-]{2,80}$/;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: Record<string, unknown>, key: string, problems: Problem[], { optional = false, nonEmpty = true } = {}) {
  const value = obj[key];
  if (value === undefined && optional) return;
  if (typeof value !== "string" || (nonEmpty && value.trim() === "")) problems.push({ path: key, message: nonEmpty ? "must be a non-empty string" : "must be a string" });
}

function strList(obj: Record<string, unknown>, key: string, problems: Problem[]) {
  const value = obj[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) problems.push({ path: key, message: "must be a list of strings" });
}

function oneOf<T extends string>(obj: Record<string, unknown>, key: string, allowed: readonly T[], problems: Problem[], { optional = false } = {}) {
  const value = obj[key];
  if (value === undefined && optional) return;
  if (!allowed.includes(value as T)) problems.push({ path: key, message: `must be one of ${allowed.join(", ")}` });
}

function common(obj: Record<string, unknown>, kind: ObjectKind, problems: Problem[]) {
  if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id) || kindOfId(obj.id) !== kind) {
    problems.push({ path: "id", message: `must be a ${ID_PREFIX[kind]}-… id (lowercase letters, digits, dashes)` });
  }
  if (obj.schema_version !== SCHEMA_VERSION) problems.push({ path: "schema_version", message: `must be ${SCHEMA_VERSION}` });
  if (!Number.isInteger(obj.revision) || (obj.revision as number) < 1) problems.push({ path: "revision", message: "must be an integer ≥ 1" });
  for (const key of ["created_at", "updated_at"]) {
    if (typeof obj[key] !== "string" || Number.isNaN(Date.parse(obj[key] as string))) problems.push({ path: key, message: "must be an ISO 8601 time" });
  }
}

function withSources(obj: Record<string, unknown>, problems: Problem[]) {
  strList(obj, "source_refs", problems);
  oneOf(obj, "verification", VERIFICATION, problems);
}

function tagBindings(obj: Record<string, unknown>, problems: Problem[]) {
  const value = obj.tag_bindings;
  if (!Array.isArray(value)) {
    problems.push({ path: "tag_bindings", message: "must be a list" });
    return;
  }
  const seen = new Set<string>();
  value.forEach((binding, index) => {
    const at = `tag_bindings[${index}]`;
    if (!isRecord(binding)) {
      problems.push({ path: at, message: "must be an object" });
      return;
    }
    const inner: Problem[] = [];
    str(binding, "tag_id", inner);
    oneOf(binding, "coverage", COVERAGE, inner);
    oneOf(binding, "assigned_by", ASSIGNED_BY, inner);
    strList(binding, "source_refs", inner);
    str(binding, "reason", inner, { optional: true, nonEmpty: false });
    for (const problem of inner) problems.push({ path: `${at}.${problem.path}`, message: problem.message });
    if (typeof binding.tag_id === "string") {
      if (seen.has(binding.tag_id)) problems.push({ path: `${at}.tag_id`, message: "is bound twice" });
      seen.add(binding.tag_id);
    }
  });
}

const OUTLINE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const PARENT_LEVEL: Record<OutlineLevel, OutlineLevel[]> = { part: [], chapter: ["part"], section: ["chapter", "part"] };

function outlineProblems(outline: unknown, problems: Problem[]) {
  if (!isRecord(outline)) { problems.push({ path: "outline", message: "must be { source, items[] } or null" }); return; }
  if (!(OUTLINE_SOURCES as readonly unknown[]).includes(outline.source)) problems.push({ path: "outline.source", message: `must be one of ${OUTLINE_SOURCES.join(", ")}` });
  if (outline.note !== undefined && typeof outline.note !== "string") problems.push({ path: "outline.note", message: "must be a string" });
  if (!Array.isArray(outline.items)) { problems.push({ path: "outline.items", message: "must be a list" }); return; }
  const seen = new Map<string, OutlineLevel>();
  outline.items.forEach((item, i) => {
    const at = `outline.items[${i}]`;
    if (!isRecord(item)) { problems.push({ path: at, message: "must be { id, title, level, parent }" }); return; }
    const id = item.id;
    if (typeof id !== "string" || !OUTLINE_ID.test(id)) problems.push({ path: `${at}.id`, message: 'a short id: letters, digits, "-", "_" or "." (e.g. "c2")' });
    else if (seen.has(id)) problems.push({ path: `${at}.id`, message: `"${id}" is used twice` });
    if (typeof item.title !== "string" || !item.title.trim()) problems.push({ path: `${at}.title`, message: "must not be empty" });
    const level = item.level as OutlineLevel;
    if (!(OUTLINE_LEVELS as readonly unknown[]).includes(level)) problems.push({ path: `${at}.level`, message: `must be one of ${OUTLINE_LEVELS.join(", ")}` });
    const parent = item.parent ?? null;
    if (parent !== null) {
      // Parents come first, in reading order, and a chapter sits in a part, a section in a chapter (or a part).
      const parentLevel = typeof parent === "string" ? seen.get(parent) : undefined;
      if (!parentLevel) problems.push({ path: `${at}.parent`, message: `"${String(parent)}" is not an earlier entry` });
      else if (PARENT_LEVEL[level] && !PARENT_LEVEL[level].includes(parentLevel)) problems.push({ path: `${at}.parent`, message: `a ${level} cannot sit in a ${parentLevel}` });
    }
    if (typeof id === "string" && (OUTLINE_LEVELS as readonly unknown[]).includes(level)) seen.set(id, level);
  });
}

const VALIDATORS: Record<ObjectKind, (obj: Record<string, unknown>, problems: Problem[]) => void> = {
  book(obj, problems) {
    common(obj, "book", problems);
    withSources(obj, problems);
    str(obj, "title", problems);
    strList(obj, "authors", problems);
    if (obj.published_year != null && !Number.isInteger(obj.published_year)) problems.push({ path: "published_year", message: "must be a whole year (negative for BCE) or null" });
    if (!isRecord(obj.external_ids) || Object.values(obj.external_ids).some((v) => typeof v !== "string")) {
      problems.push({ path: "external_ids", message: "must map names to string ids" });
    }
    const c = obj.classification;
    if (!isRecord(c) || !(c.scheme_id === null || typeof c.scheme_id === "string") || !(c.scheme_version === null || typeof c.scheme_version === "string") || !Array.isArray(c.codes)) {
      problems.push({ path: "classification", message: "must be { scheme_id, scheme_version, codes[] } (null when unknown)" });
    } else if (c.codes.length > 0 && !c.scheme_id) {
      problems.push({ path: "classification.codes", message: "need a scheme_id: a code means nothing outside its scheme" });
    } else if (c.scheme_id === CLC_SCHEME) {
      // 中图法: one main second-level class first, at most two others.
      if (c.codes.length > CLC_MAX_CODES) problems.push({ path: "classification.codes", message: `at most ${CLC_MAX_CODES} classes: the main one first` });
      c.codes.forEach((code, i) => {
        if (typeof code !== "string" || !clcClassOf(code)) {
          const near = typeof code === "string" ? clcCandidates(code) : [];
          problems.push({ path: `classification.codes.${i}`, message: `"${String(code)}" is not a 中图法 second-level class${near.length ? `; under ${String(code).charAt(0).toUpperCase()}: ${near.join("；")}` : ""}` });
        }
      });
    }
    tagBindings(obj, problems);
    strList(obj, "entry_questions", problems);
    if (obj.outline != null) outlineProblems(obj.outline, problems);
    if (obj.description_profile !== undefined && !isRecord(obj.description_profile)) problems.push({ path: "description_profile", message: "must be an object" });
    if (typeof obj.body !== "string") problems.push({ path: "body", message: "must be a string" });
  },
  node(obj, problems) {
    common(obj, "node", problems);
    withSources(obj, problems);
    oneOf(obj, "type", NODE_TYPES, problems);
    str(obj, "title", problems);
    str(obj, "summary", problems, { nonEmpty: false });
    strList(obj, "aliases", problems);
    tagBindings(obj, problems);
    oneOf(obj, "attribution", ATTRIBUTION, problems);
    if (typeof obj.body !== "string") problems.push({ path: "body", message: "must be a string" });
  },
  tag(obj, problems) {
    if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id) || kindOfId(obj.id) !== "tag") problems.push({ path: "id", message: "must be a tag-… id" });
    if (obj.schema_version !== SCHEMA_VERSION) problems.push({ path: "schema_version", message: `must be ${SCHEMA_VERSION}` });
    if (!Number.isInteger(obj.revision) || (obj.revision as number) < 1) problems.push({ path: "revision", message: "must be an integer ≥ 1" });
    oneOf(obj, "type", TAG_TYPES, problems);
    str(obj, "name", problems);
    str(obj, "definition", problems, { nonEmpty: false });
    strList(obj, "aliases", problems);
    strList(obj, "parent_ids", problems);
    oneOf(obj, "status", TAG_STATUS, problems);
    if (!(obj.redirect_to === null || typeof obj.redirect_to === "string")) problems.push({ path: "redirect_to", message: "must be a tag id or null" });
    if (obj.status === "merged" && !obj.redirect_to) problems.push({ path: "redirect_to", message: "a merged tag must redirect to the tag it was merged into" });
    if (obj.status !== "merged" && obj.redirect_to) problems.push({ path: "redirect_to", message: "only a merged tag redirects" });
  },
  relation(obj, problems) {
    common(obj, "relation", problems);
    withSources(obj, problems);
    str(obj, "from_id", problems);
    str(obj, "to_id", problems);
    oneOf(obj, "type", RELATION_TYPES, problems);
    oneOf(obj, "attribution", ATTRIBUTION, problems);
    str(obj, "scope", problems, { optional: true });
    str(obj, "note", problems, { optional: true, nonEmpty: false });
    if (obj.from_id === obj.to_id) problems.push({ path: "to_id", message: "a relation needs two different ends" });
    if ((FROM_BOOK_RELATIONS as readonly string[]).includes(obj.type as string) && kindOfId(String(obj.from_id)) !== "book") {
      problems.push({ path: "from_id", message: `${obj.type} starts at a book` });
    }
  },
  source(obj, problems) {
    if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id) || kindOfId(obj.id) !== "source") problems.push({ path: "id", message: "must be a src-… id" });
    if (obj.schema_version !== SCHEMA_VERSION) problems.push({ path: "schema_version", message: `must be ${SCHEMA_VERSION}` });
    if (!Number.isInteger(obj.revision) || (obj.revision as number) < 1) problems.push({ path: "revision", message: "must be an integer ≥ 1" });
    oneOf(obj, "kind", SOURCE_KINDS, problems);
    str(obj, "title", problems);
    str(obj, "url", problems, { optional: true });
    // A web source is only as good as the page it points at.
    if (obj.kind === "web" && (typeof obj.url !== "string" || !/^https?:\/\//i.test(obj.url))) problems.push({ path: "url", message: "a web source needs the page's http(s) address" });
    oneOf(obj, "granularity", GRANULARITY, problems);
    oneOf(obj, "verification", VERIFICATION, problems);
    if (obj.locator !== undefined && !isRecord(obj.locator)) problems.push({ path: "locator", message: "must be an object" });
    // A page or chapter locator is what lets a source back a quote (§8): it must say where.
    if ((obj.granularity === "page" || obj.granularity === "chapter" || obj.granularity === "section") && !isRecord(obj.locator)) {
      problems.push({ path: "locator", message: `${obj.granularity}-level sources need a locator` });
    }
    if (obj.granularity === "message" && (!isRecord(obj.locator) || typeof obj.locator.message_id !== "string")) {
      problems.push({ path: "locator.message_id", message: "message-level sources need the message id" });
    }
  },
};

export function validateObject(kind: ObjectKind, value: unknown): Problem[] {
  if (!isRecord(value)) return [{ path: "", message: "must be an object" }];
  const problems: Problem[] = [];
  VALIDATORS[kind](value, problems);
  return problems;
}
