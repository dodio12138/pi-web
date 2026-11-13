import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

function library(store) {
  const result = store.applyPatch(patch([
    { op: "create_tag", ref: "$pol", fields: { type: "domain", name: "政治哲学" } },
    { op: "create_source", ref: "$talk", fields: { kind: "conversation", title: "对话", granularity: "message", locator: { session_id: "s1", message_id: "m1" } } },
    { op: "create_book", ref: "$lev", fields: { title: "利维坦", authors: ["霍布斯"], classification: { scheme_id: "clc", scheme_version: "5", codes: ["D0"] }, entry_questions: ["为什么要服从国家？"] } },
    { op: "create_book", ref: "$loc", fields: { title: "政府论", authors: ["洛克"] } },
    { op: "create_book", ref: "$cyb", fields: { title: "控制论", authors: ["维纳"] } },
    { op: "create_node", ref: "$state", fields: { type: "concept", title: "自然状态", summary: "没有共同权力时的处境", attribution: "ai_synthesis", source_refs: ["$talk"],
      tag_bindings: [{ tag_id: "$pol", coverage: "core", assigned_by: "human", source_refs: [] }] } },
    { op: "create_node", ref: "$contract", fields: { type: "concept", title: "社会契约", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$right", fields: { type: "claim", title: "抵抗权", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$fb", fields: { type: "concept", title: "负反馈", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$state", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$loc", to_id: "$state", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$contract", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$contract", to_id: "$right", type: "explains", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$cyb", to_id: "$fb", type: "expounds", attribution: "ai_synthesis" } },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.created;
}

const ids = (graph) => graph.cards.map((c) => c.id).sort();

test("a book's view: the book and what it relates to, with what more lies beyond", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  const graph = core.buildGraph(store, { view: "book", book_id: c.$lev });
  assert.equal(graph.key, `book:${c.$lev}`);
  assert.deepEqual(ids(graph), [c.$lev, c.$state, c.$contract].sort());
  assert.equal(graph.edges.length, 2);
  const book = graph.cards.find((x) => x.id === c.$lev);
  assert.equal(book.subtitle, "霍布斯 · D0 政治学、政治理论");
  assert.equal(book.summary, "为什么要服从国家？");
  assert.equal(graph.cards.find((x) => x.id === c.$contract).more, 1, "抵抗权 is one step further");
  assert.equal(graph.cards.find((x) => x.id === c.$state).more, 1, "政府论 also expounds it");

  const opened = core.buildGraph(store, { view: "book", book_id: c.$lev, expand: [c.$contract] });
  assert.ok(ids(opened).includes(c.$right));
  assert.ok(opened.edges.some((e) => e.type === "explains" && e.from === c.$contract && e.to === c.$right));
});

test("conversation, cross-book and search views; tags filter knowledge, hidden cards leave one view", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  assert.deepEqual(ids(core.buildGraph(store, { view: "session", session_id: "s1" })), [c.$state]);
  assert.deepEqual(ids(core.buildGraph(store, { view: "cross" })), [c.$lev, c.$loc, c.$state].sort());
  assert.ok(ids(core.buildGraph(store, { view: "search", q: "负反馈" })).includes(c.$fb));

  const tagged = core.buildGraph(store, { view: "book", book_id: c.$lev, tag_ids: [c.$pol] });
  assert.deepEqual(ids(tagged), [c.$lev, c.$state].sort(), "the book stays; only tagged knowledge");
  const hidden = core.buildGraph(store, { view: "book", book_id: c.$lev, hidden: [c.$contract] });
  assert.deepEqual(ids(hidden), [c.$lev, c.$state].sort());
  assert.ok(store.nodes.get(c.$contract), "hiding a card deletes nothing");

  store.applyPatch(patch([{ op: "archive", id: c.$state }]));
  assert.deepEqual(ids(core.buildGraph(store, { view: "book", book_id: c.$lev })), [c.$lev, c.$contract].sort());
});

test("books and tags for the bars", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  const books = core.listBooks(store);
  assert.equal(books.length, 3);
  assert.deepEqual(books.find((b) => b.id === c.$lev).classes, ["D0 政治学、政治理论"]);
  assert.deepEqual(core.listTags(store).map((t) => [t.name, t.count]), [["政治哲学", 1]]);
});

test("layout: hand-placed positions and per-view hidden cards persist apart from knowledge", (t) => {
  const { store, root } = scratchAtlas(t);
  const c = library(store);
  const revision = store.meta.workspace_revision;
  const view = `book:${c.$lev}`;
  core.updateLayout(root, { view, positions: { [c.$state]: { x: 10.4, y: -20.6 } }, hide: { view: "cross", ids: [c.$loc] } });
  core.updateLayout(root, { view: "cross", positions: { [c.$state]: { x: 500, y: 0 } } });
  let layout = core.readLayout(root);
  assert.deepEqual(layout.positions[view][c.$state], { x: 10, y: -21 });
  assert.deepEqual(layout.positions.cross[c.$state], { x: 500, y: 0 }, "each view keeps its own arrangement");
  assert.deepEqual(layout.hidden.cross, [c.$loc]);
  assert.equal(store.meta.workspace_revision, revision, "moving a card is not a knowledge change");

  // Editing the node leaves its card where it is.
  store.applyPatch(patch([{ op: "update_node", id: c.$state, changes: { summary: "新的概括" } }]));
  assert.deepEqual(core.readLayout(root).positions[view][c.$state], { x: 10, y: -21 });

  core.updateLayout(root, { view, positions: { [c.$state]: null }, show: { view: "cross", ids: [c.$loc] } });
  core.updateLayout(root, { view: "cross", positions: { [c.$state]: null } });
  layout = core.readLayout(root);
  assert.deepEqual(layout.positions, {});
  assert.deepEqual(layout.hidden, {});

  writeFileSync(join(root, core.LAYOUT_FILE), "{ broken");
  assert.deepEqual(core.readLayout(root).positions, {});
  assert.ok(readdirSync(root).some((f) => f.startsWith("layout.json.broken-")), "a broken layout is kept aside");
  assert.ok(!existsSync(join(root, core.LAYOUT_FILE)));
});
