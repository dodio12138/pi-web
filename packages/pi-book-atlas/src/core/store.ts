import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { parseFrontMatter, serializeFrontMatter } from "./frontmatter";
import { newId, nowIso } from "./ids";
import {
  BOOK_RELATIONS,
  kindOfId,
  SCHEMA_VERSION,
  SYMMETRIC_RELATIONS,
  validateObject,
  type AtlasMeta,
  type AtlasObject,
  type Book,
  type KnowledgeNode,
  type ObjectKind,
  type Problem,
  type Relation,
  type Source,
  type Tag,
  type TagBinding,
} from "./schema";
import { acquireLock, AtlasStorage, type FileWrite } from "./storage";
import { findTagsByLabel, migrateBindings, normalizeLabel, resolveTag, wouldCycle } from "./tags";

// The Atlas store: one per library folder per process. It loads the folder,
// answers reads from memory, and commits patches (§10): every change from the
// Agent or the UI goes through applyPatch(), which checks revisions, applies
// the operations to a draft, validates every reference, writes all touched
// files in one transaction, and only then swaps in the new state.

// ---------------------------------------------------------------------------
// Patch protocol

export type Operation =
  | { op: "create_book"; ref?: string; fields: Partial<Book> & { title: string } }
  | { op: "update_book"; id: string; changes: Partial<Book> }
  | { op: "create_node"; ref?: string; fields: Partial<KnowledgeNode> & { type: KnowledgeNode["type"]; title: string; attribution: KnowledgeNode["attribution"] }; allow_duplicate_title?: boolean }
  | { op: "update_node"; id: string; changes: Partial<KnowledgeNode> }
  | { op: "create_tag"; ref?: string; fields: Partial<Tag> & { type: Tag["type"]; name: string } }
  | { op: "update_tag"; id: string; changes: Partial<Tag> }
  | { op: "merge_tags"; from_ids: string[]; into_id: string }
  | { op: "create_relation"; ref?: string; fields: Partial<Relation> & { from_id: string; to_id: string; type: Relation["type"]; attribution: Relation["attribution"] } }
  | { op: "update_relation"; id: string; changes: Partial<Relation> }
  | { op: "create_source"; ref?: string; fields: Partial<Source> & { kind: Source["kind"]; title: string } }
  | { op: "update_source"; id: string; changes: Partial<Source> }
  | { op: "bind_tag"; target_id: string; binding: Omit<TagBinding, "source_refs"> & { source_refs?: string[] } }
  | { op: "unbind_tag"; target_id: string; tag_id: string }
  | { op: "archive"; id: string }
  | { op: "restore"; id: string }
  /** Backup import only: inserts a complete object as it was exported, revision and state included. */
  | { op: "import_object"; object: AtlasObject };

export interface PatchRequest {
  schema_version: number;
  request_id?: string;
  /** Same key + same payload returns the first result; same key + another payload is a conflict. */
  idempotency_key?: string;
  /** The workspace revision the caller read; informational, conflicts come from expected_revisions. */
  workspace_revision?: number;
  /** Object revisions the caller based its changes on. A mismatch rejects the whole patch. */
  expected_revisions?: Record<string, number>;
  operations: Operation[];
  /** Conversation messages the change came from, recorded with the result. */
  source_message_ids?: string[];
}

export interface PatchConflict {
  id?: string;
  kind: "revision" | "duplicate" | "idempotency" | "invalid_file";
  message: string;
  expected?: number;
  actual?: number;
  existing_id?: string;
}

export type PatchResult =
  | {
    ok: true;
    workspace_revision: number;
    /** `$ref` → new id, for objects the patch created. */
    created: Record<string, string>;
    changed: { id: string; revision: number }[];
    warnings: string[];
    replayed?: boolean;
  }
  | { ok: false; errors: (Problem & { id?: string; op?: number })[]; conflicts: PatchConflict[] };

const PROTECTED_FIELDS = new Set(["id", "schema_version", "revision", "created_at", "updated_at"]);

// ---------------------------------------------------------------------------
// Files

const BOOK_KEYS = ["schema_version", "id", "revision", "title", "authors", "published_year", "external_ids", "classification", "tag_bindings", "entry_questions", "verification", "source_refs", "description_profile", "archived", "created_at", "updated_at"];
const NODE_KEYS = ["schema_version", "id", "revision", "type", "title", "summary", "aliases", "tag_bindings", "attribution", "verification", "source_refs", "archived", "created_at", "updated_at"];

function ordered(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  for (const [key, value] of Object.entries(obj)) if (!(key in out) && key !== "body" && value !== undefined) out[key] = value;
  return out;
}

function hashPayload(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

const clone = <T>(value: T): T => structuredClone(value);

interface IdempotencyEntry {
  hash: string;
  result: PatchResult;
  at: string;
}

const IDEMPOTENCY_KEEP = 2000;

export interface LoadProblem {
  file: string;
  problems: Problem[];
}

export interface OpenReport {
  recovered: string[];
  discarded_temp: string[];
  problems: LoadProblem[];
}

// ---------------------------------------------------------------------------

// One store per library folder per process, even when this module is loaded
// more than once: pi loads extensions through its own module loader, and the
// pi-web routes import the same code through their bundle. Both must share the
// writer, or the second would find the folder locked by its own process.
const STORES_KEY = Symbol.for("pi-book-atlas.stores");
const stores: Map<string, AtlasStore> = ((globalThis as Record<symbol, unknown>)[STORES_KEY] ??= new Map()) as Map<string, AtlasStore>;

export class AtlasStore {
  readonly storage: AtlasStorage;
  meta!: AtlasMeta;
  books = new Map<string, Book>();
  nodes = new Map<string, KnowledgeNode>();
  tags = new Map<string, Tag>();
  relations = new Map<string, Relation>();
  sources = new Map<string, Source>();
  /** Files that failed to parse or validate: left on disk untouched, their ids locked against patches. */
  problems: LoadProblem[] = [];
  private brokenIds = new Set<string>();
  private idempotency = new Map<string, IdempotencyEntry>();
  private release: () => void;
  /** Bumped on every load or commit; the search index rebuilds when it changes. */
  version = 0;
  /** Test hooks into the commit, to simulate a crash at chosen points. */
  commitHooks: Parameters<AtlasStorage["commit"]>[1] = {};

  private constructor(readonly root: string, release: () => void) {
    this.storage = new AtlasStorage(root);
    this.release = release;
  }

  /**
   * Opens (or with `create`, initializes) the library at `root`. Within one
   * process the same folder gives the same store, so every session writes
   * through one coordinator; another process holding the folder is refused.
   */
  static open(root: string, { create = false }: { create?: boolean } = {}): { store: AtlasStore; report: OpenReport } {
    if (!existsSync(root)) {
      if (!create) throw new Error(`No Atlas library at ${root}`);
      mkdirSync(root, { recursive: true });
    }
    const key = realpathSync(root);
    const existing = stores.get(key);
    if (existing) return { store: existing, report: { recovered: [], discarded_temp: [], problems: existing.problems } };
    const release = acquireLock(key);
    try {
      const store = new AtlasStore(key, release);
      const recovery = store.storage.recover();
      store.load({ create });
      stores.set(key, store);
      return { store, report: { recovered: recovery.completed, discarded_temp: recovery.discardedTemp, problems: store.problems } };
    } catch (error) {
      release();
      throw error;
    }
  }

  close(): void {
    stores.delete(this.root);
    this.release();
  }

  // ---- loading -------------------------------------------------------------

  private load({ create }: { create: boolean }) {
    const metaText = this.storage.read("atlas.json");
    if (metaText === null) {
      if (!create) throw new Error(`${this.root} is not an Atlas library (no atlas.json)`);
      this.meta = { schema_version: SCHEMA_VERSION, atlas_id: newId("source").replace(/^src-/, "atlas-"), workspace_revision: 0, created_at: nowIso(), config: {} };
      this.storage.commit([
        { path: "atlas.json", content: `${JSON.stringify(this.meta, null, 2)}\n` },
        { path: "tags.json", content: "[]\n" },
        { path: "relations.json", content: "[]\n" },
        { path: "sources.json", content: "[]\n" },
      ]);
    } else {
      this.meta = JSON.parse(metaText) as AtlasMeta;
      if (this.meta.schema_version !== SCHEMA_VERSION) throw new Error(`Atlas schema ${this.meta.schema_version} is not supported by this version (${SCHEMA_VERSION})`);
    }
    this.problems = [];
    this.brokenIds = new Set();
    this.books = this.loadMarkdown<Book>("books", "book");
    this.nodes = this.loadMarkdown<KnowledgeNode>("nodes", "node");
    this.tags = this.loadList<Tag>("tags.json", "tag");
    this.relations = this.loadList<Relation>("relations.json", "relation");
    this.sources = this.loadList<Source>("sources.json", "source");
    const idem = this.storage.read("journal/idempotency.json");
    this.idempotency = new Map(idem ? Object.entries(JSON.parse(idem) as Record<string, IdempotencyEntry>) : []);
    this.version += 1;
  }

  /** Re-reads the folder after outside edits (a person editing Markdown). Invalid files stay as they are. */
  reload(): LoadProblem[] {
    this.load({ create: false });
    return this.problems;
  }

  private loadMarkdown<T extends Book | KnowledgeNode>(dir: string, kind: "book" | "node"): Map<string, T> {
    const out = new Map<string, T>();
    for (const file of this.storage.list(dir, ".md")) {
      const fileId = file.slice(dir.length + 1, -3);
      try {
        const { data, body } = parseFrontMatter(this.storage.read(file)!);
        const obj = { ...data, body } as unknown as T;
        if (kind === "node") {
          (obj as KnowledgeNode).aliases ??= [];
          (obj as KnowledgeNode).summary ??= "";
        }
        const problems = validateObject(kind, obj);
        if (obj.id !== fileId) problems.push({ path: "id", message: `does not match the file name (${fileId})` });
        if (problems.length > 0) {
          this.problems.push({ file, problems });
          this.brokenIds.add(fileId);
          continue;
        }
        out.set(obj.id, obj);
      } catch (error) {
        this.problems.push({ file, problems: [{ path: "", message: (error as Error).message }] });
        this.brokenIds.add(fileId);
      }
    }
    return out;
  }

  private loadList<T extends Tag | Relation | Source>(file: string, kind: ObjectKind): Map<string, T> {
    const out = new Map<string, T>();
    const text = this.storage.read(file);
    if (text === null) return out;
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch (error) {
      this.problems.push({ file, problems: [{ path: "", message: (error as Error).message }] });
      this.brokenIds.add(file);
      return out;
    }
    if (!Array.isArray(list)) {
      this.problems.push({ file, problems: [{ path: "", message: "must be a JSON list" }] });
      this.brokenIds.add(file);
      return out;
    }
    list.forEach((item, index) => {
      const problems = validateObject(kind, item);
      if (problems.length > 0) {
        this.problems.push({ file, problems: problems.map((p) => ({ path: `[${index}].${p.path}`, message: p.message })) });
        this.brokenIds.add(file);
        return;
      }
      out.set((item as T).id, item as T);
    });
    return out;
  }

  // ---- reads ---------------------------------------------------------------

  get(id: string): AtlasObject | undefined {
    switch (kindOfId(id)) {
      case "book": return this.books.get(id);
      case "node": return this.nodes.get(id);
      case "tag": return resolveTag(this.tags, id) ?? undefined;
      case "relation": return this.relations.get(id);
      case "source": return this.sources.get(id);
      default: return undefined;
    }
  }

  /** Relations touching an object, both directions; archived ones only on request. */
  relationsOf(id: string, { includeArchived = false } = {}): Relation[] {
    return [...this.relations.values()].filter((r) => (r.from_id === id || r.to_id === id) && (includeArchived || !r.archived));
  }

  // ---- writes --------------------------------------------------------------

  applyPatch(request: PatchRequest): PatchResult {
    const errors: (Problem & { id?: string; op?: number })[] = [];
    const conflicts: PatchConflict[] = [];
    if (request.schema_version !== SCHEMA_VERSION) return { ok: false, errors: [{ path: "schema_version", message: `must be ${SCHEMA_VERSION}` }], conflicts };
    if (!Array.isArray(request.operations) || request.operations.length === 0) return { ok: false, errors: [{ path: "operations", message: "must be a non-empty list" }], conflicts };

    // Idempotency: the same request again returns its first result, unchanged.
    const payloadHash = hashPayload({ operations: request.operations, expected_revisions: request.expected_revisions ?? {} });
    if (request.idempotency_key) {
      const seen = this.idempotency.get(request.idempotency_key);
      if (seen) {
        if (seen.hash === payloadHash) return seen.result.ok ? { ...seen.result, replayed: true } : seen.result;
        return { ok: false, errors, conflicts: [{ kind: "idempotency", message: `Idempotency key ${request.idempotency_key} was used for a different patch` }] };
      }
    }

    for (const [id, expected] of Object.entries(request.expected_revisions ?? {})) {
      const actual = this.revisionOf(id);
      if (actual !== expected) conflicts.push({ id, kind: "revision", expected, actual, message: actual === undefined ? `${id} does not exist` : `${id} is at revision ${actual}, not ${expected}` });
    }
    if (conflicts.length > 0) return { ok: false, errors, conflicts };

    const draft = new Draft(this);
    const now = nowIso();
    const warnings: string[] = [];
    request.operations.forEach((operation, index) => {
      try {
        draft.apply(operation, now, warnings);
      } catch (error) {
        if (error instanceof PatchError) {
          if (error.conflict) conflicts.push(error.conflict);
          else errors.push({ op: index, path: error.path, message: error.message, id: error.id });
        } else {
          errors.push({ op: index, path: "", message: (error as Error).message });
        }
      }
    });
    if (errors.length === 0 && conflicts.length === 0) errors.push(...draft.validate());
    if (errors.length > 0 || conflicts.length > 0) return { ok: false, errors, conflicts };

    const changed = draft.changedIds();
    if (changed.length === 0) {
      return { ok: true, workspace_revision: this.meta.workspace_revision, created: draft.created, changed: [], warnings: [...warnings, "Nothing changed"] };
    }
    const meta: AtlasMeta = { ...this.meta, workspace_revision: this.meta.workspace_revision + 1 };
    const result: PatchResult = {
      ok: true,
      workspace_revision: meta.workspace_revision,
      created: draft.created,
      changed: changed.map((id) => ({ id, revision: draft.revisionOf(id)! })),
      warnings,
    };
    const idempotency = new Map(this.idempotency);
    if (request.idempotency_key) {
      idempotency.set(request.idempotency_key, { hash: payloadHash, result, at: now });
      while (idempotency.size > IDEMPOTENCY_KEEP) idempotency.delete(idempotency.keys().next().value!);
    }

    this.storage.commit([...draft.fileWrites(), { path: "atlas.json", content: `${JSON.stringify(meta, null, 2)}\n` }, {
      path: "journal/idempotency.json",
      content: `${JSON.stringify(Object.fromEntries(idempotency), null, 2)}\n`,
    }], this.commitHooks);
    // On disk: now the memory follows.
    draft.install();
    this.meta = meta;
    this.idempotency = idempotency;
    this.version += 1;
    return result;
  }

  /** @internal */
  isBroken(id: string): boolean {
    return this.brokenIds.has(id);
  }

  /** @internal */
  brokenListFile(kind: ObjectKind): string | null {
    const file = kind === "tag" ? "tags.json" : kind === "relation" ? "relations.json" : kind === "source" ? "sources.json" : null;
    return file && this.brokenIds.has(file) ? file : null;
  }

  revisionOf(id: string): number | undefined {
    const kind = kindOfId(id);
    const map = kind ? mapFor(this, kind) : undefined;
    return (map?.get(id) as { revision?: number } | undefined)?.revision;
  }
}

function mapFor(holder: { books: Map<string, Book>; nodes: Map<string, KnowledgeNode>; tags: Map<string, Tag>; relations: Map<string, Relation>; sources: Map<string, Source> }, kind: ObjectKind): Map<string, AtlasObject> {
  switch (kind) {
    case "book": return holder.books as Map<string, AtlasObject>;
    case "node": return holder.nodes as Map<string, AtlasObject>;
    case "tag": return holder.tags as Map<string, AtlasObject>;
    case "relation": return holder.relations as Map<string, AtlasObject>;
    case "source": return holder.sources as Map<string, AtlasObject>;
  }
}

class PatchError extends Error {
  constructor(message: string, readonly path = "", readonly id?: string, readonly conflict?: PatchConflict) {
    super(message);
  }
}

/**
 * A patch's working copy: maps that start as the store's and copy an object on
 * first write. Nothing reaches the store until install().
 */
class Draft {
  books: Map<string, Book>;
  nodes: Map<string, KnowledgeNode>;
  tags: Map<string, Tag>;
  relations: Map<string, Relation>;
  sources: Map<string, Source>;
  created: Record<string, string> = {};
  private touched = new Set<string>();
  private listTouched = new Set<ObjectKind>();

  constructor(private store: AtlasStore) {
    this.books = new Map(store.books);
    this.nodes = new Map(store.nodes);
    this.tags = new Map(store.tags);
    this.relations = new Map(store.relations);
    this.sources = new Map(store.sources);
  }

  revisionOf(id: string): number | undefined {
    const kind = kindOfId(id);
    return kind ? (mapFor(this, kind).get(id) as { revision?: number } | undefined)?.revision : undefined;
  }

  /** `$name` → the id created under that ref earlier in this patch. */
  private ref(value: string): string {
    if (!value.startsWith("$")) return value;
    const id = this.created[value];
    if (!id) throw new PatchError(`Unknown reference ${value}: create it earlier in the same patch`);
    return id;
  }

  private refs(values: string[] | undefined): string[] {
    return (values ?? []).map((v) => this.ref(v));
  }

  private bindings(values: TagBinding[] | undefined, warnings: string[]): TagBinding[] {
    return (values ?? []).map((binding) => {
      const tagId = this.ref(binding.tag_id);
      const live = resolveTag(this.tags, tagId);
      if (live && live.id !== tagId) warnings.push(`${tagId} was merged into ${live.id}: bound to ${live.id}`);
      return { ...binding, tag_id: live?.id ?? tagId, source_refs: this.refs(binding.source_refs) };
    });
  }

  private writable<T extends AtlasObject>(id: string): T {
    const kind = kindOfId(id);
    if (!kind) throw new PatchError(`Unknown id ${id}`, "id", id);
    if (this.store.isBroken(id) || this.store.brokenListFile(kind)) {
      throw new PatchError("", "", id, { id, kind: "invalid_file", message: `${id} is in a file with errors; fix the file before changing it` });
    }
    const map = mapFor(this, kind);
    const current = map.get(id);
    if (!current) throw new PatchError(`${id} does not exist`, "id", id);
    if (!this.touched.has(id)) {
      const copy = clone(current);
      map.set(id, copy);
      this.touched.add(id);
      if (kind === "tag" || kind === "relation" || kind === "source") this.listTouched.add(kind);
      return copy as T;
    }
    return current as T;
  }

  private insert(kind: ObjectKind, obj: AtlasObject, ref?: string) {
    if (this.store.brokenListFile(kind)) {
      throw new PatchError("", "", obj.id, { kind: "invalid_file", message: `${this.store.brokenListFile(kind)} has errors; fix it before adding to it` });
    }
    const map = mapFor(this, kind);
    if (map.has(obj.id)) throw new PatchError(`${obj.id} already exists`, "id", obj.id);
    map.set(obj.id, obj);
    this.touched.add(obj.id);
    if (kind === "tag" || kind === "relation" || kind === "source") this.listTouched.add(kind);
    if (ref) {
      if (!ref.startsWith("$")) throw new PatchError(`ref must start with $ (got ${ref})`, "ref");
      if (this.created[ref]) throw new PatchError(`ref ${ref} is used twice`, "ref");
      this.created[ref] = obj.id;
    }
  }

  private update<T extends AtlasObject>(id: string, changes: Partial<T>, now: string, warnings: string[]): T {
    const target = this.writable<T>(this.ref(id));
    for (const [key, value] of Object.entries(changes)) {
      if (PROTECTED_FIELDS.has(key)) throw new PatchError(`${key} cannot be changed`, key, target.id);
      if (key === "tag_bindings") (target as unknown as Book).tag_bindings = this.bindings(value as TagBinding[], warnings);
      else if (key === "source_refs" || key === "parent_ids") (target as unknown as Record<string, unknown>)[key] = this.refs(value as string[]);
      else if ((key === "from_id" || key === "to_id" || key === "redirect_to") && typeof value === "string") (target as unknown as Record<string, unknown>)[key] = this.ref(value);
      else (target as unknown as Record<string, unknown>)[key] = value;
    }
    this.bump(target, now);
    return target;
  }

  private bump(target: AtlasObject, now: string) {
    const original = this.store.revisionOf(target.id);
    target.revision = (original ?? 0) + 1;
    target.updated_at = now;
  }

  apply(operation: Operation, now: string, warnings: string[]) {
    const base = { schema_version: SCHEMA_VERSION, revision: 1, created_at: now, updated_at: now };
    switch (operation.op) {
      case "create_book": {
        const f = operation.fields;
        const book: Book = {
          ...base,
          id: f.id ?? newId("book"),
          title: f.title,
          authors: f.authors ?? [],
          ...(f.published_year != null ? { published_year: f.published_year } : {}),
          external_ids: f.external_ids ?? {},
          classification: f.classification ?? { scheme_id: null, scheme_version: null, codes: [] },
          tag_bindings: this.bindings(f.tag_bindings, warnings),
          entry_questions: f.entry_questions ?? [],
          ...(f.description_profile ? { description_profile: f.description_profile } : {}),
          verification: f.verification ?? "pending",
          source_refs: this.refs(f.source_refs),
          body: f.body ?? "",
        };
        // One record per work (§6.1): the same title by the same authors is the same book.
        const twin = [...this.books.values()].find((b) => !b.archived && normalizeLabel(b.title) === normalizeLabel(book.title)
          && normalizeLabel(b.authors.join("|")) === normalizeLabel(book.authors.join("|")));
        if (twin) throw new PatchError("", "", undefined, { kind: "duplicate", existing_id: twin.id, message: `"${book.title}" already exists as ${twin.id}` });
        this.insert("book", book, operation.ref);
        return;
      }
      case "update_book":
        this.update<Book>(operation.id, operation.changes, now, warnings);
        return;
      case "create_node": {
        const f = operation.fields;
        const node: KnowledgeNode = {
          ...base,
          id: f.id ?? newId("node"),
          type: f.type,
          title: f.title,
          summary: f.summary ?? "",
          aliases: f.aliases ?? [],
          tag_bindings: this.bindings(f.tag_bindings, warnings),
          attribution: f.attribution,
          verification: f.verification ?? "pending",
          source_refs: this.refs(f.source_refs),
          body: f.body ?? "",
        };
        // Asking about a concept again updates its node rather than adding a twin (§17.3).
        if (!operation.allow_duplicate_title) {
          const wanted = normalizeLabel(node.title);
          const twin = [...this.nodes.values()].find((n) => !n.archived && n.type === node.type
            && (normalizeLabel(n.title) === wanted || n.aliases.some((a) => normalizeLabel(a) === wanted)));
          if (twin) throw new PatchError("", "", undefined, { kind: "duplicate", existing_id: twin.id, message: `A ${node.type} "${node.title}" already exists as ${twin.id}: update it, or pass allow_duplicate_title` });
        }
        this.insert("node", node, operation.ref);
        return;
      }
      case "update_node":
        this.update<KnowledgeNode>(operation.id, operation.changes, now, warnings);
        return;
      case "create_tag": {
        const f = operation.fields;
        const tag: Tag = {
          id: f.id ?? newId("tag"),
          schema_version: SCHEMA_VERSION,
          revision: 1,
          created_at: now,
          updated_at: now,
          type: f.type,
          name: f.name,
          definition: f.definition ?? "",
          aliases: f.aliases ?? [],
          parent_ids: this.refs(f.parent_ids),
          status: "active",
          redirect_to: null,
        };
        // Search before creating (§7.2 rule 4): an existing name or alias is that tag.
        for (const label of [tag.name, ...tag.aliases]) {
          const existing = findTagsByLabel(this.tags, label)[0];
          if (existing) throw new PatchError("", "", undefined, { kind: "duplicate", existing_id: existing.id, message: `"${label}" is already ${existing.id} (${existing.name})` });
        }
        this.insert("tag", tag, operation.ref);
        return;
      }
      case "update_tag": {
        if ("status" in operation.changes || "redirect_to" in operation.changes) throw new PatchError("status and redirect_to change only through merge_tags or archive", "changes");
        this.update<Tag>(operation.id, operation.changes, now, warnings);
        return;
      }
      case "merge_tags": {
        const into = resolveTag(this.tags, this.ref(operation.into_id));
        if (!into || into.status !== "active") throw new PatchError(`${operation.into_id} is not a live tag`, "into_id");
        const fromIds = new Set(operation.from_ids.map((id) => this.ref(id)));
        if (fromIds.has(into.id)) throw new PatchError("a tag cannot be merged into itself", "from_ids");
        const survivor = this.writable<Tag>(into.id);
        for (const id of fromIds) {
          const from = this.writable<Tag>(id);
          if (from.status !== "active") throw new PatchError(`${id} is ${from.status}`, "from_ids", id);
          survivor.aliases = [...new Set([...survivor.aliases, from.name, ...from.aliases].filter((a) => normalizeLabel(a) !== normalizeLabel(survivor.name)))];
          survivor.merged_from = [...new Set([...(survivor.merged_from ?? []), id])];
          from.status = "merged";
          from.redirect_to = survivor.id;
          this.bump(from, now);
          // Children of the merged tag now hang under the survivor.
          for (const tag of [...this.tags.values()]) {
            if (tag.parent_ids.includes(id)) {
              const child = this.writable<Tag>(tag.id);
              child.parent_ids = [...new Set(child.parent_ids.map((p) => (p === id ? survivor.id : p)))].filter((p) => p !== child.id);
              this.bump(child, now);
            }
          }
        }
        this.bump(survivor, now);
        // Every binding moves over: books and nodes keep their tags under the surviving id.
        for (const kind of ["book", "node"] as const) {
          for (const obj of [...mapFor(this, kind).values()] as (Book | KnowledgeNode)[]) {
            const moved = migrateBindings(obj.tag_bindings, fromIds, survivor.id);
            if (moved) {
              const target = this.writable<Book | KnowledgeNode>(obj.id);
              target.tag_bindings = moved;
              this.bump(target, now);
            }
          }
        }
        return;
      }
      case "create_relation": {
        const f = operation.fields;
        const relation: Relation = {
          ...base,
          id: f.id ?? newId("relation"),
          from_id: this.ref(f.from_id),
          to_id: this.ref(f.to_id),
          type: f.type,
          attribution: f.attribution,
          verification: f.verification ?? "pending",
          source_refs: this.refs(f.source_refs),
          ...(f.scope ? { scope: f.scope } : {}),
          ...(f.note ? { note: f.note } : {}),
        };
        const symmetric = SYMMETRIC_RELATIONS.has(relation.type);
        const twin = [...this.relations.values()].find((r) => !r.archived && r.type === relation.type
          && ((r.from_id === relation.from_id && r.to_id === relation.to_id) || (symmetric && r.from_id === relation.to_id && r.to_id === relation.from_id)));
        if (twin) throw new PatchError("", "", undefined, { kind: "duplicate", existing_id: twin.id, message: `This ${relation.type} relation already exists as ${twin.id}` });
        this.insert("relation", relation, operation.ref);
        return;
      }
      case "update_relation":
        this.update<Relation>(operation.id, operation.changes, now, warnings);
        return;
      case "create_source": {
        const f = operation.fields;
        const source: Source = {
          id: f.id ?? newId("source"),
          schema_version: SCHEMA_VERSION,
          revision: 1,
          created_at: now,
          updated_at: now,
          kind: f.kind,
          title: f.title,
          ...(f.url ? { url: f.url } : {}),
          ...(f.edition ? { edition: f.edition } : {}),
          ...(f.locator ? { locator: f.locator } : {}),
          granularity: f.granularity ?? "none",
          verification: f.verification ?? "pending",
        };
        this.insert("source", source, operation.ref);
        return;
      }
      case "update_source":
        this.update<Source>(operation.id, operation.changes, now, warnings);
        return;
      case "bind_tag": {
        const targetId = this.ref(operation.target_id);
        const targetKind = kindOfId(targetId);
        if (targetKind !== "book" && targetKind !== "node") throw new PatchError("only books and nodes carry tags", "target_id", targetId);
        const target = this.writable<Book | KnowledgeNode>(targetId);
        const [binding] = this.bindings([{ ...operation.binding, source_refs: operation.binding.source_refs ?? [] }], warnings);
        target.tag_bindings = [...target.tag_bindings.filter((b) => b.tag_id !== binding.tag_id), binding];
        this.bump(target, now);
        return;
      }
      case "unbind_tag": {
        const targetId = this.ref(operation.target_id);
        const targetKind = kindOfId(targetId);
        if (targetKind !== "book" && targetKind !== "node") throw new PatchError("only books and nodes carry tags", "target_id", targetId);
        const target = this.writable<Book | KnowledgeNode>(targetId);
        const tagId = resolveTag(this.tags, this.ref(operation.tag_id))?.id ?? operation.tag_id;
        target.tag_bindings = target.tag_bindings.filter((b) => b.tag_id !== tagId);
        this.bump(target, now);
        return;
      }
      case "archive":
      case "restore": {
        const id = this.ref(operation.id);
        const kind = kindOfId(id);
        if (kind === "tag") {
          const tag = this.writable<Tag>(id);
          if (tag.status === "merged") throw new PatchError("a merged tag stays merged", "id", id);
          tag.status = operation.op === "archive" ? "archived" : "active";
          this.bump(tag, now);
          return;
        }
        if (kind !== "book" && kind !== "node" && kind !== "relation") throw new PatchError(`${id} cannot be archived`, "id", id);
        const target = this.writable<Book | KnowledgeNode | Relation>(id);
        // Archiving keeps the file and every reference to it (§11): it only leaves default views.
        if (operation.op === "archive") target.archived = true;
        else delete target.archived;
        this.bump(target, now);
        return;
      }
      case "import_object": {
        const kind = kindOfId(operation.object.id);
        if (!kind) throw new PatchError(`Unknown id ${operation.object.id}`, "object.id");
        const problems = validateObject(kind, operation.object);
        if (problems.length > 0) throw new PatchError(`${problems[0].path}: ${problems[0].message}`, `object.${problems[0].path}`, operation.object.id);
        this.insert(kind, clone(operation.object));
        return;
      }
      default:
        throw new PatchError(`Unknown operation ${(operation as { op?: string }).op}`, "op");
    }
  }

  /** Shape of every touched object, and every reference it makes. */
  validate(): (Problem & { id?: string })[] {
    const problems: (Problem & { id?: string })[] = [];
    const add = (id: string, path: string, message: string) => problems.push({ id, path, message });
    for (const id of this.touched) {
      const kind = kindOfId(id)!;
      const obj = mapFor(this, kind).get(id)!;
      for (const p of validateObject(kind, obj)) add(id, p.path, p.message);
      const sourceRefs = (obj as { source_refs?: string[] }).source_refs ?? [];
      sourceRefs.forEach((ref, i) => { if (!this.sources.has(ref)) add(id, `source_refs[${i}]`, `unknown source ${ref}`); });
      for (const [i, binding] of ((obj as Book).tag_bindings ?? []).entries()) {
        const tag = this.tags.get(binding.tag_id);
        if (!tag) add(id, `tag_bindings[${i}].tag_id`, `unknown tag ${binding.tag_id}`);
        else if (tag.status !== "active") add(id, `tag_bindings[${i}].tag_id`, `${tag.id} is ${tag.status}`);
        binding.source_refs.forEach((ref, j) => { if (!this.sources.has(ref)) add(id, `tag_bindings[${i}].source_refs[${j}]`, `unknown source ${ref}`); });
      }
      if (kind === "tag") {
        const tag = obj as Tag;
        tag.parent_ids.forEach((parent, i) => {
          const p = this.tags.get(parent);
          if (!p) add(id, `parent_ids[${i}]`, `unknown tag ${parent}`);
          else if (p.status !== "active") add(id, `parent_ids[${i}]`, `${parent} is ${p.status}`);
        });
        if (wouldCycle(this.tags, tag.id, tag.parent_ids)) add(id, "parent_ids", "would make the tag its own ancestor");
        if (tag.status === "active") {
          for (const label of [tag.name, ...tag.aliases]) {
            const clash = findTagsByLabel(this.tags, label).find((other) => other.id !== tag.id);
            if (clash) add(id, "name", `"${label}" is already used by ${clash.id}`);
          }
        }
      }
      if (kind === "relation") {
        const relation = obj as Relation;
        for (const end of ["from_id", "to_id"] as const) {
          const endKind = kindOfId(relation[end]);
          if (endKind !== "book" && endKind !== "node") add(id, end, "a relation joins books and nodes");
          else if (!mapFor(this, endKind).has(relation[end])) add(id, end, `unknown ${endKind} ${relation[end]}`);
        }
        if ((BOOK_RELATIONS as readonly string[]).includes(relation.type) && kindOfId(relation.to_id) !== "node") add(id, "to_id", `${relation.type} points at a node`);
      }
    }
    return problems;
  }

  changedIds(): string[] {
    return [...this.touched].filter((id) => {
      const kind = kindOfId(id)!;
      const before = mapFor(this.store, kind).get(id);
      const after = mapFor(this, kind).get(id);
      if (!before) return true;
      const strip = (o: AtlasObject) => ({ ...o, revision: 0, updated_at: "" });
      return hashPayload(strip(before)) !== hashPayload(strip(after!));
    });
  }

  fileWrites(): FileWrite[] {
    const writes: FileWrite[] = [];
    const changed = new Set(this.changedIds());
    for (const id of changed) {
      const kind = kindOfId(id)!;
      if (kind === "book") {
        const book = this.books.get(id)!;
        writes.push({ path: `books/${id}.md`, content: serializeFrontMatter(ordered(book as unknown as Record<string, unknown>, BOOK_KEYS), book.body) });
      } else if (kind === "node") {
        const node = this.nodes.get(id)!;
        writes.push({ path: `nodes/${id}.md`, content: serializeFrontMatter(ordered(node as unknown as Record<string, unknown>, NODE_KEYS), node.body) });
      }
    }
    const lists: [ObjectKind, string][] = [["tag", "tags.json"], ["relation", "relations.json"], ["source", "sources.json"]];
    for (const [kind, file] of lists) {
      if (![...changed].some((id) => kindOfId(id) === kind)) continue;
      const items = [...mapFor(this, kind).values()].sort((a, b) => a.id.localeCompare(b.id));
      writes.push({ path: file, content: `${JSON.stringify(items, null, 2)}\n` });
    }
    return writes;
  }

  install() {
    const changed = new Set(this.changedIds());
    for (const kind of ["book", "node", "tag", "relation", "source"] as const) {
      const target = mapFor(this.store, kind);
      for (const [id, obj] of mapFor(this, kind)) if (changed.has(id)) target.set(id, obj);
    }
  }
}

export function openAtlas(root: string, options?: { create?: boolean }) {
  return AtlasStore.open(root, options);
}
