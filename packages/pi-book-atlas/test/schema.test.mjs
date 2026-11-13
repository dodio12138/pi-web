import assert from "node:assert/strict";
import test from "node:test";
import { core } from "./helpers.mjs";

const now = "2026-11-12T00:00:00.000Z";
const base = { schema_version: 1, revision: 1, created_at: now, updated_at: now, source_refs: [], verification: "pending" };

const paths = (kind, value) => core.validateObject(kind, value).map((p) => p.path);

test("a well-formed node passes; each wrong field is named", () => {
  const node = { ...base, id: "node-abc123def", type: "concept", title: "自然状态", summary: "", aliases: [], tag_bindings: [], attribution: "ai_synthesis", body: "" };
  assert.deepEqual(core.validateObject("node", node), []);
  assert.deepEqual(paths("node", { ...node, type: "theory", attribution: "fact", id: "book-abc123def" }), ["id", "type", "attribution"]);
  assert.deepEqual(paths("node", { ...node, tag_bindings: [{ tag_id: "tag-x1y2z3", coverage: "most", assigned_by: "human", source_refs: [] }] }), ["tag_bindings[0].coverage"]);
});

test("a classification code needs its scheme: codes are never copied across systems unnamed", () => {
  const book = { ...base, id: "book-abc123def", title: "利维坦", authors: [], external_ids: {}, tag_bindings: [], entry_questions: [], body: "",
    classification: { scheme_id: null, scheme_version: null, codes: ["D0"] } };
  assert.deepEqual(paths("book", book), ["classification.codes"]);
  assert.deepEqual(paths("book", { ...book, classification: { scheme_id: "clc", scheme_version: "5", codes: ["D0"] } }), []);
});

test("sources that claim chapter, page or message precision must say where", () => {
  const source = { schema_version: 1, revision: 1, created_at: now, updated_at: now, id: "src-abc123def", kind: "book_text", title: "利维坦 第13章", verification: "pending" };
  assert.deepEqual(paths("source", { ...source, granularity: "page" }), ["locator"]);
  assert.deepEqual(paths("source", { ...source, granularity: "page", locator: { chapter: "13", page: "88" } }), []);
  assert.deepEqual(paths("source", { ...source, kind: "conversation", granularity: "message", locator: { session_id: "s" } }), ["locator.message_id"]);
});

test("tags: only a merged tag redirects, and a merged one must", () => {
  const tag = { schema_version: 1, revision: 1, created_at: now, updated_at: now, id: "tag-abc123def", type: "topic", name: "反馈", definition: "", aliases: [], parent_ids: [], status: "active", redirect_to: null };
  assert.deepEqual(core.validateObject("tag", tag), []);
  assert.deepEqual(paths("tag", { ...tag, status: "merged" }), ["redirect_to"]);
  assert.deepEqual(paths("tag", { ...tag, redirect_to: "tag-zzz999" }), ["redirect_to"]);
});

test("front matter round-trips and keeps strings as strings", () => {
  const text = core.serializeFrontMatter({ id: "node-x", date: "2026-11-12", answer: "no", list: ["a"] }, "# 正文\n\n内容");
  const { data, body } = core.parseFrontMatter(text);
  assert.deepEqual(data, { id: "node-x", date: "2026-11-12", answer: "no", list: ["a"] });
  assert.equal(body, "# 正文\n\n内容");
  assert.throws(() => core.parseFrontMatter("no front matter"), /must start with ---/);
  assert.throws(() => core.parseFrontMatter("---\nid: x\n"), /not closed/);
});

test("ids carry their kind and nothing else", () => {
  const a = core.newId("node");
  const b = core.newId("node");
  assert.match(a, /^node-[0-9a-z]{17}$/);
  assert.notEqual(a, b);
  assert.equal(core.kindOfId(a), "node");
  assert.equal(core.kindOfId(core.newId("relation")), "relation");
});

test("the trimmed relation set: old types stay readable, new ones are refused with what to use", async () => {
  const { scratchAtlas, patch } = await import("./helpers.mjs");
  const t = { after: (fn) => test.after(fn) };
  const { store } = scratchAtlas(t);
  const made = store.applyPatch(patch([
    { op: "create_node", ref: "$a", fields: { type: "claim", title: "A", attribution: "ai_synthesis" } },
    { op: "create_node", ref: "$q", fields: { type: "question", title: "Q", attribution: "ai_synthesis" } },
    { op: "create_relation", fields: { from_id: "$a", to_id: "$q", type: "answers", attribution: "ai_synthesis" } },
  ]));
  assert.equal(made.ok, true, JSON.stringify(made));
  const old = store.applyPatch(patch([{ op: "create_relation", fields: { from_id: made.created.$a, to_id: made.created.$q, type: "qualifies", attribution: "ai_synthesis" } }]));
  assert.equal(old.ok, false);
  assert.match(old.errors[0].message, /"qualifies" is no longer used: use "refutes" with a note "限定：…"/);
  // A relation already in a file with an old type is still valid and shows as its new type.
  const legacy = { schema_version: 1, revision: 1, created_at: now, updated_at: now, source_refs: [], verification: "pending",
    id: "rel-abc123def", from_id: "node-abc123def", to_id: "node-def456ghi", type: "exemplifies", attribution: "ai_synthesis" };
  assert.deepEqual(core.validateObject("relation", legacy), []);
  assert.equal(core.canonicalRelation("exemplifies"), "explains");
  assert.equal(core.canonicalRelation("introduces"), "expounds");
  assert.equal(core.canonicalRelation("answers"), "answers");
});
