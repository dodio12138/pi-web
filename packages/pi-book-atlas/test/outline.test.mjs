import assert from "node:assert/strict";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

// 李猛《自然社会》, as the user pasted it (abridged).
export const NATURAL_SOCIETY = {
  source: "user",
  note: "用户提供的目录",
  items: [
    { id: "intro", title: "导论 鲁滨逊的世界", level: "chapter", parent: null },
    { id: "p1", title: "上篇 自然状态", level: "part", parent: null },
    { id: "c1", title: "第一章 从政治到社会", level: "chapter", parent: "p1" },
    { id: "c2", title: "第二章 霍布斯", level: "chapter", parent: "p1" },
    { id: "s5", title: "被抛者的世界", level: "section", parent: "c2" },
    { id: "c3", title: "第三章 非社会的社会性", level: "chapter", parent: "p1" },
    { id: "p2", title: "中篇 自然法权", level: "part", parent: null },
    { id: "c4", title: "第四章 自然法谱系", level: "chapter", parent: "p2" },
    { id: "c5", title: "第五章 自然法的危机", level: "chapter", parent: "p2" },
    { id: "p3", title: "下篇 政治社会", level: "part", parent: null },
    { id: "c6", title: "第六章 人为的国家", level: "chapter", parent: "p3" },
    { id: "c7", title: "第七章 信托与革命", level: "chapter", parent: "p3" },
    { id: "s30", title: "回到自然状态？", level: "section", parent: "c7" },
  ],
};

test("an outline is checked: short unique ids, earlier parents of the right level", () => {
  const now = "2026-11-13T00:00:00.000Z";
  const book = { schema_version: 1, revision: 1, created_at: now, updated_at: now, source_refs: [], verification: "pending",
    id: "book-abc123def", title: "自然社会", authors: [], external_ids: {}, tag_bindings: [], entry_questions: [], body: "",
    classification: { scheme_id: null, scheme_version: null, codes: [] } };
  assert.deepEqual(core.validateObject("book", { ...book, outline: NATURAL_SOCIETY }), []);
  const bad = { source: "guess", items: [
    { id: "c1", title: "一", level: "chapter", parent: "p9" },
    { id: "c1", title: "", level: "chapter", parent: null },
    { id: "第二章", title: "二", level: "chapter", parent: null },
    { id: "s1", title: "节", level: "section", parent: null },
    { id: "p1", title: "篇", level: "part", parent: "s1" },
  ] };
  assert.deepEqual(core.validateObject("book", { ...book, outline: bad }).map((p) => p.path), [
    "outline.source", "outline.items[0].parent", "outline.items[1].id", "outline.items[1].title", "outline.items[2].id", "outline.items[4].parent",
  ]);
});

test("the spine: one column per part, loose chapters in their own column, sections inside chapters", () => {
  const columns = core.outlineColumns(NATURAL_SOCIETY);
  assert.deepEqual(columns.map((c) => [c.id, c.chapters.map((ch) => ch.id)]), [
    [null, ["intro"]], ["p1", ["c1", "c2", "c3"]], ["p2", ["c4", "c5"]], ["p3", ["c6", "c7"]],
  ]);
  assert.deepEqual(columns[1].chapters[1].sections, [{ id: "s5", title: "被抛者的世界" }]);
  assert.equal(core.chapterOf(NATURAL_SOCIETY, "s30"), "c7");
  assert.equal(core.chapterOf(NATURAL_SOCIETY, "c4"), "c4");
  assert.equal(core.chapterOf(NATURAL_SOCIETY, "nope"), null);
  assert.match(core.outlinePrompt(NATURAL_SOCIETY), /^Table of contents \(from the user: 用户提供的目录\):\n  intro 导论[\s\S]*\n    s5 被抛者的世界/);
});

test("the outline is stored on the card and survives a restart", (t) => {
  const { store, openStore } = scratchAtlas(t);
  const made = store.applyPatch(patch([{ op: "create_book", ref: "$b", fields: { title: "自然社会", authors: ["李猛"], outline: NATURAL_SOCIETY } }]));
  assert.equal(made.ok, true, JSON.stringify(made));
  store.close();
  const { store: again } = openStore({ create: false });
  assert.deepEqual(again.books.get(made.created.$b).outline, NATURAL_SOCIETY);
  const fixed = again.applyPatch(patch([{ op: "update_book", id: made.created.$b, changes: { outline: { ...NATURAL_SOCIETY, source: "web" } } }]));
  assert.equal(fixed.ok, true);
  assert.equal(again.books.get(made.created.$b).outline.source, "web");
});

test("a book's view carries its spine and places knowledge at the entry its relation names", (t) => {
  const { store } = scratchAtlas(t);
  const made = store.applyPatch(patch([
    { op: "create_book", ref: "$b", fields: { title: "自然社会", authors: ["李猛"], outline: NATURAL_SOCIETY } },
    { op: "create_node", ref: "$state", fields: { type: "concept", title: "自然状态", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$back", fields: { type: "concept", title: "回到自然状态", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$kant", fields: { type: "claim", title: "康德的出处", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$b", to_id: "$state", type: "expounds", attribution: "ai_synthesis", scope: "s5" } },
    { op: "create_relation", fields: { from_id: "$b", to_id: "$back", type: "expounds", attribution: "ai_synthesis", scope: "s30" } },
    { op: "create_relation", fields: { from_id: "$b", to_id: "$kant", type: "studied_in", attribution: "ai_synthesis" } },
  ]));
  assert.equal(made.ok, true, JSON.stringify(made));
  const graph = core.buildGraph(store, { view: "book", book_id: made.created.$b });
  assert.equal(graph.outline.columns.length, 4);
  const card = (id) => graph.cards.find((c) => c.id === id);
  assert.deepEqual([card(made.created.$state).chapter, card(made.created.$state).place], ["c2", "s5"]);
  assert.equal(card(made.created.$back).chapter, "c7");
  assert.equal(card(made.created.$kant).chapter, null, "no entry named: a supplement");
  assert.equal(core.buildGraph(store, { view: "cross" }).outline, null);
});
