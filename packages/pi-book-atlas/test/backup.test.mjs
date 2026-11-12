import assert from "node:assert/strict";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

function seed(store) {
  const result = store.applyPatch(patch([
    { op: "create_source", ref: "$s", fields: { kind: "bibliographic", title: "书目", granularity: "work" } },
    { op: "create_tag", ref: "$a", fields: { type: "topic", name: "自然法" } },
    { op: "create_tag", ref: "$b", fields: { type: "topic", name: "自然法学说" } },
    { op: "create_book", ref: "$book", fields: { title: "自然社会", authors: ["李猛"], source_refs: ["$s"], tag_bindings: [{ tag_id: "$a", coverage: "core", assigned_by: "human", source_refs: ["$s"] }] } },
    { op: "create_node", ref: "$n", fields: { type: "concept", title: "自然状态", attribution: "ai_synthesis", body: "正文" } },
    { op: "create_relation", fields: { from_id: "$book", to_id: "$n", type: "expounds", attribution: "ai_synthesis" } },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  // A merged tag travels in the backup as it is: merged, redirecting.
  assert.equal(store.applyPatch(patch([{ op: "merge_tags", from_ids: [result.created.$b], into_id: result.created.$a }])).ok, true);
  return result.created;
}

test("a backup restores into an empty library exactly, merged tags included", (t) => {
  const source = scratchAtlas(t);
  const ids = seed(source.store);
  const backup = core.exportBackup(source.store);
  const target = scratchAtlas(t);
  const report = core.importBackup(target.store, JSON.parse(JSON.stringify(backup)));
  assert.equal(report.patch.ok, true, JSON.stringify(report));
  assert.deepEqual(report.added, { book: 1, node: 1, tag: 2, relation: 1, source: 1 });
  assert.deepEqual([report.reused, report.conflicts, report.invalid_refs], [[], [], []]);
  const restored = core.exportBackup(target.store);
  for (const key of ["books", "nodes", "tags", "relations", "sources"]) assert.deepEqual(restored[key], backup[key], key);
  assert.equal(target.store.get(ids.$b).id, ids.$a, "the merged tag still redirects");
});

test("importing the same backup again changes nothing: everything is reused", (t) => {
  const source = scratchAtlas(t);
  seed(source.store);
  const backup = core.exportBackup(source.store);
  const target = scratchAtlas(t);
  core.importBackup(target.store, backup);
  const revision = target.store.meta.workspace_revision;
  const again = core.importBackup(target.store, backup);
  assert.equal(again.reused.length, 6);
  assert.equal(again.patch, undefined);
  assert.equal(target.store.meta.workspace_revision, revision);
});

test("an object that differs under the same id is a conflict and is not overwritten", (t) => {
  const source = scratchAtlas(t);
  const ids = seed(source.store);
  const backup = core.exportBackup(source.store);
  const target = scratchAtlas(t);
  core.importBackup(target.store, backup);
  target.store.applyPatch(patch([{ op: "update_node", id: ids.$n, changes: { body: "本地改过的正文" } }]));
  const report = core.importBackup(target.store, backup);
  assert.deepEqual(report.conflicts.map((c) => c.id), [ids.$n]);
  assert.equal(target.store.nodes.get(ids.$n).body, "本地改过的正文");
});

test("unresolvable references are reported, and what depends on a dropped object is dropped too", (t) => {
  const source = scratchAtlas(t);
  const ids = seed(source.store);
  const backup = core.exportBackup(source.store);
  backup.sources = []; // the book cites it; the relation hangs on the book
  backup.books[0].mystery_field = "from a newer version";
  const target = scratchAtlas(t);
  const report = core.importBackup(target.store, backup, { dryRun: true });
  const dropped = report.invalid_refs.map((r) => r.id).sort();
  assert.deepEqual(dropped, [ids.$book, backup.relations[0].id].sort());
  assert.deepEqual(report.unmapped_fields, [{ id: ids.$book, fields: ["mystery_field"] }]);
  assert.equal(report.added.node, 1);
  assert.equal(target.store.nodes.size, 0, "a dry run writes nothing");
});

test("only Atlas backups of a known schema are accepted", (t) => {
  const { store } = scratchAtlas(t);
  assert.throws(() => core.importBackup(store, { format: "something-else" }), /Not a pi-book-atlas-backup/);
  assert.throws(() => core.importBackup(store, { format: core.BACKUP_FORMAT, schema_version: 99 }), /not supported/);
});
