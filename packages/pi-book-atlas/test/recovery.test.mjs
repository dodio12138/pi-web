import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { core, patch, restart, scratchAtlas } from "./helpers.mjs";

// A change that touches several files is all-or-nothing across a crash (§11,
// acceptance 8): restarting gives the whole old version or the whole new one.

class Crash extends Error {}

function seed(store) {
  const result = store.applyPatch(patch([
    { op: "create_tag", ref: "$t", fields: { type: "topic", name: "反馈" } },
    { op: "create_node", ref: "$n", fields: { type: "concept", title: "负反馈", summary: "旧的解释", attribution: "ai_synthesis", tag_bindings: [{ tag_id: "$t", coverage: "core", assigned_by: "human", source_refs: [] }] } },
  ]));
  assert.equal(result.ok, true);
  return result.created;
}

/** A change across four files: a node, a new node, tags.json and relations.json (plus atlas.json). */
function bigChange(ids) {
  return patch([
    { op: "update_node", id: ids.$n, changes: { summary: "新的解释" } },
    { op: "create_node", ref: "$m", fields: { type: "concept", title: "正反馈", attribution: "ai_synthesis" } },
    { op: "update_tag", id: ids.$t, changes: { definition: "控制理论里的反馈" } },
    { op: "create_relation", fields: { from_id: ids.$n, to_id: "$m", type: "related_to", attribution: "ai_synthesis" } },
  ]);
}

function snapshot(store) {
  return { ...core.exportBackup(store), exported_at: "" };
}

const tempFiles = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(dir, name.name));
      else if (name.name.includes(".atlas-tmp-")) found.push(name.name);
    }
  };
  walk(root);
  return found;
};

test("a crash before the commit record leaves the whole old version", (t) => {
  const { store, openStore, root } = scratchAtlas(t);
  const ids = seed(store);
  const before = snapshot(store);
  store.commitHooks = { beforeCommit: () => { throw new Crash("power cut"); } };
  assert.throws(() => store.applyPatch(bigChange(ids)), Crash);
  assert.ok(tempFiles(root).length > 0, "the crash left temporary files behind");
  // The process "dies": its memory never saw the change.
  store.commitHooks = {};

  const { store: again, report } = restart(store, openStore);
  assert.deepEqual(report.recovered, []);
  assert.ok(report.discarded_temp.length > 0);
  assert.deepEqual(tempFiles(root), []);
  assert.deepEqual(snapshot(again), before);
});

for (const renamedBeforeCrash of [0, 1, 3]) {
  test(`a crash after the commit record, ${renamedBeforeCrash} file(s) into the renames, finishes the whole new version`, (t) => {
    const { store, openStore, root } = scratchAtlas(t);
    const ids = seed(store);
    store.commitHooks = { afterCommitRecord: (renamed) => { if (renamed > renamedBeforeCrash) throw new Crash("power cut"); } };
    if (renamedBeforeCrash === 0) store.commitHooks = { afterCommitRecord: () => { throw new Crash("power cut"); } };
    assert.throws(() => store.applyPatch(bigChange(ids)), Crash);
    store.commitHooks = {};
    assert.equal(readdirSync(join(root, "journal")).filter((n) => n.startsWith("tx-")).length, 1, "the commit record is there");

    const { store: again, report } = restart(store, openStore);
    assert.equal(report.recovered.length, 1);
    assert.deepEqual(tempFiles(root), []);
    assert.equal(again.nodes.get(ids.$n).summary, "新的解释");
    assert.equal(again.tags.get(ids.$t).definition, "控制理论里的反馈");
    assert.equal(again.nodes.size, 2);
    assert.equal(again.relations.size, 1);
    assert.equal(again.meta.workspace_revision, 2);
    assert.deepEqual(report.problems, []);
  });
}

test("a half-written commit record (crash while writing it) is no commit at all", (t) => {
  const { store, openStore, root } = scratchAtlas(t);
  const ids = seed(store);
  const before = snapshot(store);
  store.commitHooks = { beforeCommit: () => { throw new Crash(); } };
  assert.throws(() => store.applyPatch(bigChange(ids)), Crash);
  store.commitHooks = {};
  // What a torn write of the record would leave, had it not been atomic.
  writeFileSync(join(root, "journal", "tx-torn.json"), '{"txid":"torn","writes":[{"pa');

  const { store: again } = restart(store, openStore);
  assert.deepEqual(snapshot(again), before);
  assert.equal(existsSync(join(root, "journal", "tx-torn.json")), false);
});

test("single files are replaced atomically: a reader never sees a partial file", (t) => {
  const { root } = scratchAtlas(t, { open: false });
  const path = join(root, "x.json");
  core.writeFileAtomic(path, "first");
  core.writeFileAtomic(path, "second");
  assert.equal(readFileSync(path, "utf8"), "second");
  assert.deepEqual(readdirSync(root), ["x.json"]);
});
