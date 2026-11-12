import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { core, patch, restart, scratchAtlas } from "./helpers.mjs";

/** A book bound to a tag, with its source: the smallest useful library. */
function seed(store) {
  const result = store.applyPatch(patch([
    { op: "create_source", ref: "$conv", fields: { kind: "conversation", title: "讨论：自然状态", granularity: "message", locator: { session_id: "s1", message_id: "m1" } } },
    { op: "create_tag", ref: "$natlaw", fields: { type: "topic", name: "自然法", aliases: ["natural law"], definition: "自然法相关讨论的入口" } },
    { op: "create_tag", ref: "$polphil", fields: { type: "domain", name: "政治哲学" } },
    {
      op: "create_book", ref: "$book", fields: {
        title: "自然社会：自然法与现代道德世界的形成", authors: ["李猛"],
        tag_bindings: [
          { tag_id: "$natlaw", coverage: "core", assigned_by: "ai_inference", source_refs: ["$conv"], reason: "根据讨论生成的候选索引" },
          { tag_id: "$polphil", coverage: "discussed", assigned_by: "ai_inference", source_refs: [] },
        ],
        entry_questions: ["自由个人如何建立共同生活的秩序？"],
        source_refs: ["$conv"],
        body: "# 学习入口\n\n本记录展示索引格式。",
      },
    },
    { op: "create_node", ref: "$state", fields: { type: "concept", title: "自然状态", summary: "政府出现之前人们的处境", attribution: "ai_synthesis", source_refs: ["$conv"], tag_bindings: [{ tag_id: "$natlaw", coverage: "core", assigned_by: "ai_inference", source_refs: [] }], body: "## 定义\n\n没有共同权威时人们彼此的关系。" } },
    { op: "create_relation", fields: { from_id: "$book", to_id: "$state", type: "expounds", attribution: "ai_synthesis", scope: "work", source_refs: ["$conv"] } },
  ], { idempotency_key: "seed" }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.created;
}

test("a patch creates linked objects through $refs, and a restart reads back the same library", (t) => {
  const { store, openStore, root } = scratchAtlas(t);
  const ids = seed(store);
  assert.match(ids.$book, /^book-/);
  assert.equal(store.meta.workspace_revision, 1);
  const before = core.exportBackup(store);

  const { store: again, report } = restart(store, openStore);
  assert.deepEqual(report.problems, []);
  const after = core.exportBackup(again);
  assert.deepEqual({ ...after, exported_at: "" }, { ...before, exported_at: "" });

  // Plain files a person can read: Markdown with front matter, JSON lists.
  const book = readFileSync(join(root, "books", `${ids.$book}.md`), "utf8");
  assert.match(book, /^---\nschema_version: 1\nid: book-/);
  assert.match(book, /title: 自然社会：自然法与现代道德世界的形成/);
  assert.match(book, /\n---\n\n# 学习入口\n/);
  assert.equal(JSON.parse(readFileSync(join(root, "tags.json"), "utf8")).length, 2);
});

test("books are found by tag, the same way for any caller, and aliases find the same tag", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  for (const query of ["自然法", "natural law", "Natural  Law"]) {
    const hits = core.search(store, query, { kinds: ["book"] });
    assert.equal(hits[0]?.id, ids.$book, query);
    assert.ok(hits[0].reasons.some((r) => r.startsWith("tag: 自然法 (core)")), JSON.stringify(hits[0]));
  }
  const filtered = core.search(store, "", { kinds: ["book"], tag_ids: [ids.$polphil] });
  assert.deepEqual(filtered.map((h) => h.id), [ids.$book]);
});

test("an alias or name already in use is that tag: no duplicate tag is created", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const result = store.applyPatch(patch([{ op: "create_tag", fields: { type: "topic", name: "Natural Law" } }]));
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].kind, "duplicate");
  assert.equal(result.conflicts[0].existing_id, ids.$natlaw);
  assert.equal(store.tags.size, 2);
});

test("asking about a concept again updates its node: a second node with the same title is refused", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const twin = store.applyPatch(patch([{ op: "create_node", fields: { type: "concept", title: "自然状态", attribution: "ai_synthesis" } }]));
  assert.equal(twin.ok, false);
  assert.equal(twin.conflicts[0].existing_id, ids.$state);

  const update = store.applyPatch(patch([{ op: "update_node", id: ids.$state, changes: { summary: "本轮讨论形成的解释" } }], { expected_revisions: { [ids.$state]: 1 } }));
  assert.equal(update.ok, true);
  assert.deepEqual(update.changed, [{ id: ids.$state, revision: 2 }]);
  assert.equal(store.nodes.get(ids.$state).summary, "本轮讨论形成的解释");
});

test("a stale expected revision rejects the whole patch and writes nothing", (t) => {
  const { store, root } = scratchAtlas(t);
  const ids = seed(store);
  store.applyPatch(patch([{ op: "update_node", id: ids.$state, changes: { summary: "第一次修改" } }]));
  const before = readFileSync(join(root, "nodes", `${ids.$state}.md`), "utf8");
  const result = store.applyPatch(patch([
    { op: "update_node", id: ids.$state, changes: { summary: "基于旧版本的修改" } },
    { op: "create_node", fields: { type: "concept", title: "社会契约", attribution: "ai_synthesis" } },
  ], { expected_revisions: { [ids.$state]: 1 } }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts.map((c) => [c.kind, c.expected, c.actual]), [["revision", 1, 2]]);
  assert.equal(readFileSync(join(root, "nodes", `${ids.$state}.md`), "utf8"), before);
  assert.equal(store.nodes.size, 1);
});

test("the same idempotency key replays its first result; with another payload it is a conflict", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const request = patch([{ op: "update_node", id: ids.$state, changes: { summary: "一次" } }], { idempotency_key: "s1:m2:extract-v1" });
  const first = store.applyPatch(request);
  const again = store.applyPatch(request);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.changed, first.changed);
  assert.equal(store.nodes.get(ids.$state).revision, 2, "the replay changed nothing");

  const other = store.applyPatch({ ...request, operations: [{ op: "update_node", id: ids.$state, changes: { summary: "两次" } }] });
  assert.equal(other.ok, false);
  assert.equal(other.conflicts[0].kind, "idempotency");
});

test("idempotency survives a restart: a retried message after reconnecting is not stored twice", (t) => {
  const { store, openStore } = scratchAtlas(t);
  seed(store);
  const { store: again } = restart(store, openStore);
  const replay = again.applyPatch(patch([{ op: "create_source", fields: { kind: "web", title: "x", granularity: "none" } }], { idempotency_key: "seed" }));
  assert.equal(replay.ok, false, "same key, different payload");
  assert.equal(again.sources.size, 1);
});

test("references are checked: unknown tags, sources and relation ends are named in the errors", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const result = store.applyPatch(patch([
    { op: "bind_tag", target_id: ids.$state, binding: { tag_id: "tag-0000000000000", coverage: "core", assigned_by: "human" } },
    { op: "create_relation", fields: { from_id: ids.$state, to_id: "node-0000000000000", type: "supports", attribution: "user_understanding" } },
    { op: "update_node", id: ids.$state, changes: { source_refs: ["src-0000000000000"] } },
  ]));
  assert.equal(result.ok, false);
  const messages = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
  assert.match(messages, /unknown tag tag-0000000000000/);
  assert.match(messages, /unknown node node-0000000000000/);
  assert.match(messages, /unknown source src-0000000000000/);
});

test("book-to-knowledge relations start at a book, and a relation is not stored twice (either way round when symmetric)", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const wrongEnd = store.applyPatch(patch([{ op: "create_relation", fields: { from_id: ids.$state, to_id: ids.$book, type: "expounds", attribution: "ai_synthesis" } }]));
  assert.equal(wrongEnd.ok, false);
  assert.ok(wrongEnd.errors.some((e) => /starts at a book/.test(e.message)));

  const node = store.applyPatch(patch([{ op: "create_node", ref: "$c", fields: { type: "concept", title: "社会契约", attribution: "ai_synthesis" } }]));
  const c = node.created.$c;
  assert.equal(store.applyPatch(patch([{ op: "create_relation", fields: { from_id: ids.$state, to_id: c, type: "related_to", attribution: "ai_synthesis" } }])).ok, true);
  const reversed = store.applyPatch(patch([{ op: "create_relation", fields: { from_id: c, to_id: ids.$state, type: "related_to", attribution: "ai_synthesis" } }]));
  assert.equal(reversed.ok, false);
  assert.equal(reversed.conflicts[0].kind, "duplicate");
  // supports has a direction: the reverse is a different claim.
  assert.equal(store.applyPatch(patch([{ op: "create_relation", fields: { from_id: c, to_id: ids.$state, type: "supports", attribution: "ai_synthesis" } }])).ok, true);
});

test("merging tags moves every binding, keeps the strongest coverage, and the old id redirects", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  const made = store.applyPatch(patch([
    { op: "create_tag", ref: "$nl2", fields: { type: "topic", name: "自然法理论" } },
    { op: "create_tag", ref: "$child", fields: { type: "topic", name: "格劳秀斯", parent_ids: ["$nl2"] } },
    { op: "bind_tag", target_id: ids.$book, binding: { tag_id: "$nl2", coverage: "mentioned", assigned_by: "human" } },
  ]));
  assert.equal(made.ok, true, JSON.stringify(made));
  const { $nl2, $child } = made.created;

  const merged = store.applyPatch(patch([{ op: "merge_tags", from_ids: [$nl2], into_id: ids.$natlaw }]));
  assert.equal(merged.ok, true, JSON.stringify(merged));
  const book = store.books.get(ids.$book);
  const natlaw = book.tag_bindings.filter((b) => b.tag_id === ids.$natlaw);
  assert.equal(natlaw.length, 1, "one binding per tag");
  assert.equal(natlaw[0].coverage, "core", "the stronger coverage wins");
  assert.ok(!book.tag_bindings.some((b) => b.tag_id === $nl2));
  assert.equal(store.tags.get($nl2).status, "merged");
  assert.equal(store.get($nl2).id, ids.$natlaw, "the old id redirects");
  assert.deepEqual(store.tags.get($child).parent_ids, [ids.$natlaw]);
  assert.ok(store.tags.get(ids.$natlaw).aliases.includes("自然法理论"));
  assert.deepEqual(store.tags.get(ids.$natlaw).merged_from, [$nl2]);
  // Searching by the old name finds the survivor's books.
  assert.equal(core.search(store, "自然法理论", { kinds: ["book"] })[0]?.id, ids.$book);
});

test("tag parents never form a cycle", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  assert.equal(store.applyPatch(patch([{ op: "update_tag", id: ids.$natlaw, changes: { parent_ids: [ids.$polphil] } }])).ok, true);
  const cycle = store.applyPatch(patch([{ op: "update_tag", id: ids.$polphil, changes: { parent_ids: [ids.$natlaw] } }]));
  assert.equal(cycle.ok, false);
  assert.ok(cycle.errors.some((e) => /own ancestor/.test(e.message)));
});

test("archiving keeps the file and every reference; default search leaves it out", (t) => {
  const { store, root } = scratchAtlas(t);
  const ids = seed(store);
  assert.equal(store.applyPatch(patch([{ op: "archive", id: ids.$state }])).ok, true);
  assert.ok(readFileSync(join(root, "nodes", `${ids.$state}.md`), "utf8").includes("archived: true"));
  assert.equal(store.relationsOf(ids.$book).length, 1);
  assert.equal(core.search(store, "自然状态", { kinds: ["node"] }).length, 0);
  assert.equal(core.search(store, "自然状态", { kinds: ["node"], include_archived: true })[0]?.id, ids.$state);
  assert.equal(store.applyPatch(patch([{ op: "restore", id: ids.$state }])).ok, true);
  assert.equal(store.nodes.get(ids.$state).archived, undefined);
});

test("a file broken by hand is reported and left alone, never overwritten from memory", (t) => {
  const { store, openStore, root } = scratchAtlas(t);
  const ids = seed(store);
  const path = join(root, "nodes", `${ids.$state}.md`);
  const broken = readFileSync(path, "utf8").replace("type: concept", "type: theory");
  writeFileSync(path, broken);

  const { store: again, report } = restart(store, openStore);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].file, /nodes\//);
  assert.match(report.problems[0].problems[0].path, /^type/);
  const refused = again.applyPatch(patch([{ op: "update_node", id: ids.$state, changes: { summary: "x" } }]));
  assert.equal(refused.ok, false);
  assert.equal(refused.conflicts[0].kind, "invalid_file");
  // Other changes still go through, and the broken file is untouched.
  assert.equal(again.applyPatch(patch([{ op: "update_book", id: ids.$book, changes: { body: "改过" } }])).ok, true);
  assert.equal(readFileSync(path, "utf8"), broken);

  // Fixed by hand, then reloaded: back in the library.
  writeFileSync(path, broken.replace("type: theory", "type: concept"));
  assert.deepEqual(again.reload(), []);
  assert.equal(again.nodes.get(ids.$state).title, "自然状态");
});

test("outside edits to a Markdown file are picked up on reload", (t) => {
  const { store, root } = scratchAtlas(t);
  const ids = seed(store);
  const path = join(root, "nodes", `${ids.$state}.md`);
  writeFileSync(path, readFileSync(path, "utf8").replace("没有共同权威时人们彼此的关系。", "用户亲手改写的定义。"));
  store.reload();
  assert.match(store.nodes.get(ids.$state).body, /用户亲手改写的定义/);
  assert.equal(core.search(store, "亲手改写", { kinds: ["node"] })[0]?.id, ids.$state);
});

test("protected fields cannot be changed through a patch", (t) => {
  const { store } = scratchAtlas(t);
  const ids = seed(store);
  for (const field of ["id", "revision", "created_at"]) {
    const result = store.applyPatch(patch([{ op: "update_node", id: ids.$state, changes: { [field]: "x" } }]));
    assert.equal(result.ok, false, field);
  }
});

test("one process shares one store per folder; another live process is refused, a dead one's lock is taken over", (t) => {
  const { store, openStore, root } = scratchAtlas(t);
  assert.equal(openStore().store, store, "same folder, same store");
  store.close();

  const lock = join(root, ".atlas.lock");
  const host = hostname();
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, host, started_at: "2026-11-12T00:00:00Z" }));
  assert.throws(() => openStore({ create: false }), (error) => error instanceof core.LockError);

  writeFileSync(lock, JSON.stringify({ pid: 999999, host, started_at: "2026-11-12T00:00:00Z" }));
  const { store: taken } = openStore({ create: false });
  assert.ok(taken);
});

