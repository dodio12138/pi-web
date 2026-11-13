import assert from "node:assert/strict";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

function library(store) {
  const b = (tag, coverage = "core") => ({ tag_id: tag, coverage, assigned_by: "human", source_refs: [] });
  const result = store.applyPatch(patch([
    { op: "create_tag", ref: "$pol", fields: { type: "domain", name: "政治哲学", aliases: ["political philosophy"] } },
    { op: "create_tag", ref: "$con", fields: { type: "topic", name: "社会契约论", parent_ids: ["$pol"] } },
    { op: "create_tag", ref: "$old", fields: { type: "topic", name: "契约论" } },
    { op: "create_tag", ref: "$fb", fields: { type: "topic", name: "反馈" } },
    { op: "create_source", ref: "$talk", fields: { kind: "conversation", title: "对话：自然状态", granularity: "message", locator: { session_id: "session-secret-123", message_id: "msg-secret-9" } } },
    { op: "create_source", ref: "$p13", fields: { kind: "book_text", title: "利维坦 第13章", granularity: "page", verification: "verified", locator: { chapter: "13", page: "94" } } },
    { op: "create_source", ref: "$local", fields: { kind: "user_note", title: "笔记", granularity: "none", url: "file:///Users/someone/notes.md" } },
    { op: "create_book", ref: "$lev", fields: { title: "利维坦", authors: ["霍布斯"], published_year: 1651, classification: { scheme_id: "clc", scheme_version: "5", codes: ["D0"] }, tag_bindings: [b("$con"), b("$old", "mentioned")] } },
    { op: "create_book", ref: "$loc", fields: { title: "政府论", authors: ["洛克"], published_year: 1689, tag_bindings: [b("$con", "discussed")] } },
    { op: "create_book", ref: "$ros", fields: { title: "社会契约论", authors: ["卢梭"], tag_bindings: [b("$con")] } },
    { op: "create_book", ref: "$cyb", fields: { title: "控制论", authors: ["维纳"], published_year: 1948, tag_bindings: [b("$fb")] } },
    { op: "create_node", ref: "$state", fields: { type: "concept", title: "自然状态", summary: "没有共同权力时的处境", attribution: "ai_synthesis", source_refs: ["$talk", "$local"], tag_bindings: [b("$con")] } },
    { op: "create_node", ref: "$quote", fields: { type: "claim", title: "人的生活孤独、贫困、卑污、残忍而短寿", attribution: "quoted", source_refs: ["$p13"] } },
    { op: "create_node", ref: "$unsure", fields: { type: "claim", title: "未核对的引文", attribution: "quoted" } },
    { op: "create_node", ref: "$mine", fields: { type: "question", title: "我觉得契约是虚构的", attribution: "user_understanding", tag_bindings: [b("$con")] } },
    { op: "create_node", ref: "$float", fields: { type: "concept", title: "无书可考的说法", attribution: "ai_synthesis", tag_bindings: [b("$con")] } },
    { op: "create_node", ref: "$neg", fields: { type: "concept", title: "负反馈", attribution: "ai_synthesis", tag_bindings: [b("$fb")] } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$state", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$loc", to_id: "$state", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$quote", type: "expounds", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$lev", to_id: "$unsure", type: "mentions", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$mine", to_id: "$state", type: "related_to", attribution: "user_understanding" } },
    { op: "create_relation", fields: { from_id: "$cyb", to_id: "$neg", type: "expounds", attribution: "ai_synthesis" } },
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  const merged = store.applyPatch(patch([{ op: "merge_tags", from_ids: [result.created.$old], into_id: result.created.$con }]));
  assert.equal(merged.ok, true, JSON.stringify(merged));
  return result.created;
}

const fixedNow = () => "2026-11-13T00:00:00.000Z";

test("a pack carries knowledge and where it comes from, never the person", (t) => {
  const { store, root } = scratchAtlas(t);
  const c = library(store);
  const pack = core.exportPack(store, {}, fixedNow);
  assert.equal(pack.format, "pi-book-atlas/pack");
  assert.equal(pack.schema_version, 1);
  assert.equal(pack.exported_at, "2026-11-13T00:00:00.000Z");

  const text = JSON.stringify(pack);
  for (const secret of ["session-secret-123", "msg-secret-9", "file:///", root, "对话：自然状态", "我觉得契约是虚构的"]) {
    assert.ok(!text.includes(secret), `the pack leaks ${secret}`);
  }
  assert.equal(pack.excluded.conversations, true);
  assert.equal(pack.excluded.user_notes, true);

  const state = pack.nodes.find((n) => n.id === c.$state);
  assert.deepEqual(state.sources.map((s) => [s.kind, s.title]), [["conversation", null], ["user_note", "笔记"]], "a conversation is named only as a kind");
  assert.deepEqual(state.books.map((b) => b.book_id).sort(), [c.$lev, c.$loc].sort(), "knowledge keeps its books");
  assert.equal(state.use, "paraphrase");
  assert.equal(pack.nodes.find((n) => n.id === c.$quote).use, "quotation", "checked page-level source: a quotation");
  assert.deepEqual(pack.nodes.find((n) => n.id === c.$quote).sources[0].locator, { chapter: "13", page: "94" });
  assert.equal(pack.nodes.find((n) => n.id === c.$unsure).use, "paraphrase", "quoted without a checked source stays a paraphrase");
  assert.deepEqual(pack.books.find((b) => b.id === c.$lev).classification.labels, ["D0 政治学、政治理论"]);
  assert.ok(!pack.relations.some((r) => r.from_id === c.$mine || r.to_id === c.$mine), "relations to left-out notes go too");

  const withNotes = core.exportPack(store, { include_user_notes: true }, fixedNow);
  assert.ok(withNotes.nodes.some((n) => n.id === c.$mine));
});

test("another system finds the same material by the same tag id, name, alias or old id", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  const pack = JSON.parse(JSON.stringify(core.exportPack(store, {}, fixedNow)));
  const byId = core.lookupPack(pack, c.$con);
  assert.deepEqual(byId.reading.map((b) => b.title), ["利维坦", "社会契约论", "政府论"], "core coverage before discussed");
  assert.ok(byId.paraphrases.some((n) => n.id === c.$state));
  assert.deepEqual(core.lookupPack(pack, "社会契约论").tag_id, c.$con);
  assert.deepEqual(core.lookupPack(pack, c.$old).tag_id, c.$con, "a merged tag id still resolves");
  assert.ok(pack.tags.some((tag) => tag.id === c.$pol), "parent tags travel with their children");
  assert.equal(core.lookupPack(pack, "political philosophy").tag_id, c.$pol);
  assert.deepEqual(core.lookupPack(pack, "量子力学").reading, []);
});

test("a tag filter takes the tag and the tags under it", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  const pack = core.exportPack(store, { tag_ids: [c.$pol] }, fixedNow);
  assert.ok(!pack.books.some((b) => b.id === c.$cyb));
  assert.ok(pack.books.some((b) => b.id === c.$lev), "社会契约论 is under 政治哲学");
  assert.ok(!pack.nodes.some((n) => n.id === c.$neg));
});

test("a game sees only books its world allows; unknown dates and bookless knowledge stay out", (t) => {
  const { store } = scratchAtlas(t);
  const c = library(store);
  const pack = core.exportPack(store, { game: { until_year: 1660 } }, fixedNow);
  assert.deepEqual(pack.books.map((b) => b.title), ["利维坦"], "政府论 is later, 社会契约论 has no year");
  assert.ok(pack.nodes.some((n) => n.id === c.$state), "reached through 利维坦");
  assert.deepEqual(pack.nodes.find((n) => n.id === c.$state).books.map((b) => b.book_id), [c.$lev]);
  assert.ok(!pack.nodes.some((n) => n.id === c.$float), "knowledge from no book is not allowed");
  assert.ok(!pack.nodes.some((n) => n.id === c.$neg));
  assert.ok(pack.excluded.outside_game > 0);

  const read = core.exportPack(store, { game: { book_ids: [c.$cyb] } }, fixedNow);
  assert.deepEqual(read.books.map((b) => b.title), ["控制论"]);
  assert.deepEqual(read.nodes.map((n) => n.title), ["负反馈"]);
});

test("a book's year is a whole number or unknown", (t) => {
  const { store } = scratchAtlas(t);
  const bad = store.applyPatch(patch([{ op: "create_book", fields: { title: "X", published_year: "1651年" } }]));
  assert.equal(bad.ok, false);
  const ok = store.applyPatch(patch([{ op: "create_book", ref: "$b", fields: { title: "论语", published_year: -479 } }]));
  assert.equal(ok.ok, true);
  assert.equal(store.books.get(ok.created.$b).published_year, -479);
});

test("the standalone example reads a pack written to disk", async (t) => {
  const { store, root } = scratchAtlas(t);
  const c = library(store);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const file = join(root, "pack.json");
  writeFileSync(file, JSON.stringify(core.exportPack(store, {}, fixedNow)));
  const { findByTag } = await import("../examples/pack-lookup.mjs");
  const found = findByTag(JSON.parse((await import("node:fs")).readFileSync(file, "utf8")), "社会契约论");
  assert.equal(found.tag.id, c.$con);
  const out = execFileSync(process.execPath, [new URL("../examples/pack-lookup.mjs", import.meta.url).pathname, file, "社会契约论"], { encoding: "utf8" });
  assert.match(out, /相关阅读：\n- 《利维坦》霍布斯，1651/);
  assert.match(out, /\[观点转述\] 自然状态：没有共同权力时的处境（出自《利维坦》《政府论》）/);
});
