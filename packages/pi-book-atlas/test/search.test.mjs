import assert from "node:assert/strict";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

// A small fixed library: two books, a few nodes, tags of each kind (§17: test
// retrieval on a fixed sample, not only that fields exist).
function library(store) {
  const result = store.applyPatch(patch([
    { op: "create_tag", ref: "$pol", fields: { type: "domain", name: "政治哲学" } },
    { op: "create_tag", ref: "$ctl", fields: { type: "domain", name: "控制理论" } },
    { op: "create_tag", ref: "$obl", fields: { type: "topic", name: "政治义务", parent_ids: ["$pol"] } },
    { op: "create_tag", ref: "$why", fields: { type: "question", name: "为什么要服从国家" } },
    { op: "create_tag", ref: "$fb", fields: { type: "topic", name: "反馈", aliases: ["feedback"] } },
    { op: "create_book", ref: "$lev", fields: { title: "利维坦", authors: ["霍布斯"], entry_questions: ["为什么要服从国家？"], tag_bindings: [
      { tag_id: "$pol", coverage: "core", assigned_by: "human", source_refs: [] },
      { tag_id: "$obl", coverage: "core", assigned_by: "ai_inference", source_refs: [] },
    ] } },
    { op: "create_book", ref: "$cyb", fields: { title: "控制论", authors: ["维纳"], tag_bindings: [
      { tag_id: "$ctl", coverage: "core", assigned_by: "human", source_refs: [] },
      { tag_id: "$fb", coverage: "core", assigned_by: "human", source_refs: [] },
      { tag_id: "$pol", coverage: "mentioned", assigned_by: "ai_inference", source_refs: [] },
    ] } },
    { op: "create_node", ref: "$state", fields: { type: "concept", title: "自然状态", aliases: ["state of nature"], summary: "没有共同权力时人人相互为敌的处境", attribution: "ai_synthesis", body: "霍布斯认为自然状态中人的生活孤独、贫困、卑污、残忍而短寿。" } },
    { op: "create_node", ref: "$contract", fields: { type: "concept", title: "社会契约", summary: "人们相互约定让渡权利以建立国家", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$neg", fields: { type: "concept", title: "负反馈", summary: "输出回送并抑制偏差，使系统稳定", attribution: "ai_synthesis", tag_bindings: [{ tag_id: "$fb", coverage: "core", assigned_by: "human", source_refs: [] }] } },
    { op: "create_node", ref: "$q", fields: { type: "question", title: "系统为什么失稳", attribution: "user_understanding" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$state", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$contract", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$state", to_id: "$contract", type: "explains", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$cyb", to_id: "$neg", type: "introduces", attribution: "ai_synthesis" } },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.created;
}

test("Chinese text is found without spaces: characters and character pairs", () => {
  assert.deepEqual(core.tokenize("自然状态"), ["自", "自然", "然", "然状", "状", "状态", "态"]);
  assert.deepEqual(core.tokenize("Natural Law 自然法"), ["natural", "law", "自", "自然", "然", "然法", "法"]);
});

test("exact titles and aliases rank first and say so", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const [hit] = core.search(store, "自然状态");
  assert.equal(hit.id, ids.$state);
  assert.ok(hit.reasons.includes("title"));
  const [alias] = core.search(store, "State of Nature");
  assert.equal(alias.id, ids.$state);
  assert.ok(alias.reasons.includes("alias: state of nature"));
  assert.equal(core.search(store, ids.$contract)[0].id, ids.$contract);
});

test("a tag query finds what is bound to it, core coverage above mentioned", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const books = core.search(store, "政治哲学", { kinds: ["book"] });
  assert.deepEqual(books.map((h) => h.id), [ids.$lev, ids.$cyb]);
  assert.ok(books[0].reasons.includes("tag: 政治哲学 (core)"));
  assert.ok(books[1].reasons.includes("tag: 政治哲学 (mentioned)"));
});

test("an everyday question reaches books through their entry questions", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const [hit] = core.search(store, "为什么要服从国家", { kinds: ["book"] });
  assert.equal(hit.id, ids.$lev);
  assert.ok(hit.reasons.some((r) => r.startsWith("question:")));
});

test("words in the text match when the title does not", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const hits = core.search(store, "使系统稳定", { kinds: ["node"] });
  assert.equal(hits[0]?.id, ids.$neg);
  assert.match(hits[0].reasons.join(), /text \d+%/);
  assert.equal(core.search(store, "量子力学").length, 0, "unrelated text finds nothing");
});

test("filters apply before ranking: tags, kinds, one book's knowledge", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  assert.deepEqual(core.search(store, "", { tag_ids: [ids.$fb] }).map((h) => h.id).sort(), [ids.$cyb, ids.$neg].sort());
  assert.deepEqual(core.search(store, "", { kinds: ["book"], tag_ids: [ids.$pol, ids.$ctl] }).map((h) => h.id), [ids.$cyb]);
  const inBook = core.search(store, "", { kinds: ["node"], book_id: ids.$lev }).map((h) => h.id).sort();
  assert.deepEqual(inBook, [ids.$state, ids.$contract].sort());
});

test("neighbours one relation away join below the hits, saying how they relate", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const hits = core.search(store, "自然状态", { expand_neighbors: true });
  const contract = hits.find((h) => h.id === ids.$contract);
  assert.ok(contract, JSON.stringify(hits));
  assert.ok(contract.score < hits[0].score);
  assert.ok(hits.some((h) => h.id === ids.$lev && h.reasons.some((r) => r.startsWith("expounds"))));
});

test("the index follows commits without a manual rebuild", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  assert.equal(core.search(store, "利维坦")[0].id, ids.$lev);
  store.applyPatch(patch([{ op: "update_book", id: ids.$lev, changes: { title: "利维坦：教会国家和市民国家的实质、形式和权力" } }]));
  assert.equal(core.search(store, "利维坦")[0].id, ids.$lev);
  assert.ok(core.search(store, "利维坦")[0].reasons.includes("title contains"));
});

test("a question asked as a sentence finds the titles and tags it mentions", (t) => {
  const { store } = scratchAtlas(t);
  const ids = library(store);
  const [node] = core.search(store, "自然状态到底是什么意思？", { kinds: ["node"] });
  assert.equal(node.id, ids.$state);
  assert.ok(node.reasons.includes("mentions: 自然状态"), JSON.stringify(node));
  const books = core.search(store, "控制理论里有哪些经典？", { kinds: ["book"] });
  assert.equal(books[0]?.id, ids.$cyb);
  assert.ok(books[0].reasons.includes("tag: 控制理论 (core)"));
});
