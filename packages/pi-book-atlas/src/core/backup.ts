import { kindOfId, SCHEMA_VERSION, type AtlasObject, type Book, type KnowledgeNode, type ObjectKind, type Relation, type Source, type Tag } from "./schema";
import type { AtlasStore, Operation, PatchResult } from "./store";

// Backups of a library in one JSON file, and importing them (§11, §13). Import
// keeps every id and revision: the same backup imported twice changes nothing
// the second time. Its report says what was added, what was already there,
// what clashed with a different object under the same id, which references
// could not be resolved, and which fields this version does not know.

export const BACKUP_FORMAT = "pi-book-atlas-backup";

export interface AtlasBackup {
  format: typeof BACKUP_FORMAT;
  schema_version: number;
  exported_at: string;
  atlas_id: string;
  workspace_revision: number;
  books: Book[];
  nodes: KnowledgeNode[];
  tags: Tag[];
  relations: Relation[];
  sources: Source[];
}

export function exportBackup(store: AtlasStore): AtlasBackup {
  const byId = <T extends { id: string }>(map: Map<string, T>) => [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    atlas_id: store.meta.atlas_id,
    workspace_revision: store.meta.workspace_revision,
    books: byId(store.books),
    nodes: byId(store.nodes),
    tags: byId(store.tags),
    relations: byId(store.relations),
    sources: byId(store.sources),
  };
}

export interface ImportReport {
  added: Record<ObjectKind, number>;
  reused: string[];
  conflicts: { id: string; reason: string }[];
  invalid_refs: { id: string; ref: string; reason: string }[];
  unmapped_fields: { id: string; fields: string[] }[];
  /** The commit's result; absent for a dry run or when nothing was new. */
  patch?: PatchResult;
}

const KNOWN_FIELDS: Record<ObjectKind, Set<string>> = {
  book: new Set(["id", "schema_version", "revision", "created_at", "updated_at", "source_refs", "verification", "title", "authors", "external_ids", "classification", "tag_bindings", "entry_questions", "description_profile", "archived", "body"]),
  node: new Set(["id", "schema_version", "revision", "created_at", "updated_at", "source_refs", "verification", "type", "title", "summary", "aliases", "tag_bindings", "attribution", "archived", "body"]),
  tag: new Set(["id", "schema_version", "revision", "created_at", "updated_at", "type", "name", "definition", "aliases", "parent_ids", "status", "redirect_to", "merged_from"]),
  relation: new Set(["id", "schema_version", "revision", "created_at", "updated_at", "source_refs", "verification", "from_id", "to_id", "type", "scope", "attribution", "note", "archived"]),
  source: new Set(["id", "schema_version", "revision", "created_at", "updated_at", "kind", "title", "url", "edition", "locator", "granularity", "verification"]),
};

function sameContent(a: AtlasObject, b: AtlasObject): boolean {
  const norm = (o: AtlasObject) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y))));
  return norm(a) === norm(b);
}

/** What an object points at, for checking before import. */
function referencesOf(obj: AtlasObject): string[] {
  const refs: string[] = [];
  const o = obj as unknown as Record<string, unknown>;
  if (Array.isArray(o.source_refs)) refs.push(...(o.source_refs as string[]));
  if (Array.isArray(o.tag_bindings)) for (const b of o.tag_bindings as { tag_id: string; source_refs: string[] }[]) refs.push(b.tag_id, ...b.source_refs);
  if (Array.isArray(o.parent_ids)) refs.push(...(o.parent_ids as string[]));
  if (typeof o.redirect_to === "string") refs.push(o.redirect_to);
  if (typeof o.from_id === "string") refs.push(o.from_id);
  if (typeof o.to_id === "string") refs.push(o.to_id);
  return refs;
}

export function importBackup(store: AtlasStore, backup: AtlasBackup, { dryRun = false } = {}): ImportReport {
  if (backup?.format !== BACKUP_FORMAT) throw new Error(`Not a ${BACKUP_FORMAT} file`);
  if (backup.schema_version !== SCHEMA_VERSION) throw new Error(`Backup schema ${backup.schema_version} is not supported (${SCHEMA_VERSION})`);
  const report: ImportReport = { added: { book: 0, node: 0, tag: 0, relation: 0, source: 0 }, reused: [], conflicts: [], invalid_refs: [], unmapped_fields: [] };

  // Sources first, relations last: what an object points at is imported before it.
  const incoming: AtlasObject[] = [...backup.sources, ...backup.tags, ...backup.books, ...backup.nodes, ...backup.relations];
  const kept = new Map<string, AtlasObject>();
  for (const obj of incoming) {
    const kind = kindOfId(obj.id);
    if (!kind) {
      report.conflicts.push({ id: String(obj.id), reason: "unknown id kind" });
      continue;
    }
    const extra = Object.keys(obj).filter((key) => !KNOWN_FIELDS[kind].has(key));
    if (extra.length > 0) report.unmapped_fields.push({ id: obj.id, fields: extra });
    const existing = store.get(obj.id);
    // store.get follows tag redirects; compare with the stored object itself.
    const stored = kind === "tag" ? store.tags.get(obj.id) : existing;
    if (stored) {
      if (sameContent(stored, obj)) report.reused.push(obj.id);
      else report.conflicts.push({ id: obj.id, reason: `a different ${kind} already has this id (revision ${(stored as { revision: number }).revision} here, ${(obj as { revision: number }).revision} in the backup)` });
      continue;
    }
    kept.set(obj.id, obj);
  }

  // Drop objects whose references resolve nowhere, repeatedly: dropping one may orphan another.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const [id, obj] of kept) {
      const missing = referencesOf(obj).find((ref) => !kept.has(ref) && !store.get(ref) && !store.tags.has(ref));
      if (missing) {
        report.invalid_refs.push({ id, ref: missing, reason: `${missing} is neither in the backup nor in the library` });
        kept.delete(id);
        dropped = true;
      }
    }
  }

  for (const obj of kept.values()) report.added[kindOfId(obj.id)!] += 1;
  if (dryRun || kept.size === 0) return report;
  const operations: Operation[] = [...kept.values()].map((object) => ({ op: "import_object", object }));
  report.patch = store.applyPatch({ schema_version: SCHEMA_VERSION, idempotency_key: `import:${backup.atlas_id}:${backup.exported_at}`, operations });
  return report;
}
