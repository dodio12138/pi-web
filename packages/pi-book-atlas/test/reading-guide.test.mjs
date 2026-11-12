import assert from "node:assert/strict";
import test from "node:test";
import { core, patch, scratchAtlas } from "./helpers.mjs";

const now = "2026-11-12T00:00:00.000Z";
const book = { schema_version: 1, revision: 1, created_at: now, updated_at: now, source_refs: [], verification: "pending",
  id: "book-abc123def", title: "利维坦", authors: [], external_ids: {}, tag_bindings: [], entry_questions: [], body: "" };
const clc = (...codes) => ({ ...book, classification: { scheme_id: "clc", scheme_version: "5", codes } });
const problems = (value) => core.validateObject("book", value);

test("eight lenses, each a question with answers and what it decides when organizing", () => {
  assert.equal(core.READING_LENSES.length, 8);
  for (const lens of core.READING_LENSES) {
    assert.ok(lens.question.endsWith("？"), lens.key);
    assert.ok(lens.options.length >= 5, lens.key);
    assert.ok(lens.organizes.length > 0, lens.key);
  }
  const compact = core.readingLensPrompt();
  const full = core.readingLensPrompt({ options: true });
  assert.doesNotMatch(compact, /观察记录/, "the every-turn form leaves the answer lists out");
  assert.match(full, /观察记录/);
  assert.ok(compact.length < 900, `compact lens prompt is ${compact.length} chars`);
  const template = core.readingLensTemplate();
  assert.match(template, /^## 读书透镜/);
  for (const lens of core.READING_LENSES) assert.ok(template.includes(`### ${lens.label}`));
});

test("中图法: second-level classes and the finer codes under them; the label is the class's", () => {
  assert.equal(core.clcClassOf("D0"), "D0");
  assert.equal(core.clcClassOf("b502"), "B5");
  assert.equal(core.clcClassOf("TP311"), "TP");
  assert.equal(core.clcClassOf("D82"), "D8");
  assert.equal(core.clcClassOf("B82-0"), "B82");
  assert.equal(core.clcClassOf("W1"), null);
  assert.equal(core.clcClassOf("自然法"), null);
  assert.equal(core.clcLabel("D0"), "D0 政治学、政治理论");
  assert.equal(core.clcLabel("B502"), "B502 欧洲哲学");
  assert.match(core.clcPrompt(), /^A 马克思主义/);
});

test("a clc book has one main class and at most two others, each a real class", () => {
  assert.deepEqual(problems(clc("D0")), []);
  assert.deepEqual(problems(clc("D0", "B5", "C91")), []);
  assert.deepEqual(problems(clc("D0", "B5", "C91", "K5")).map((p) => p.path), ["classification.codes"]);
  const [unknown] = problems(clc("D3"));
  assert.equal(unknown.path, "classification.codes.0");
  assert.match(unknown.message, /D0 政治学、政治理论/, "suggests the classes under D");
});

test("a class finds its books by code or name, the main class above the others", (t) => {
  const { store } = scratchAtlas(t);
  const made = store.applyPatch(patch([
    { op: "create_book", ref: "$lev", fields: { title: "利维坦", authors: ["霍布斯"], classification: { scheme_id: "clc", scheme_version: "5", codes: ["D0", "B5"] } } },
    { op: "create_book", ref: "$eth", fields: { title: "尼各马可伦理学", authors: ["亚里士多德"], classification: { scheme_id: "clc", scheme_version: "5", codes: ["B82", "D0"] } } },
  ]));
  assert.equal(made.ok, true, JSON.stringify(made));
  const politics = core.search(store, "政治学", { kinds: ["book"] });
  assert.deepEqual(politics.map((h) => h.id), [made.created.$lev, made.created.$eth]);
  assert.ok(politics[0].reasons.includes("class: D0 政治学、政治理论"));
  assert.equal(core.search(store, "伦理学有哪些书", { kinds: ["book"] })[0].id, made.created.$eth);
  assert.equal(core.search(store, "B5", { kinds: ["book"] })[0].id, made.created.$lev);

  // The class can be revised; a wrong code is refused and nothing changes.
  const bad = store.applyPatch(patch([{ op: "update_book", id: made.created.$lev, changes: { classification: { scheme_id: "clc", scheme_version: "5", codes: ["Y9"] } } }]));
  assert.equal(bad.ok, false);
  const fixed = store.applyPatch(patch([{ op: "update_book", id: made.created.$lev, changes: { classification: { scheme_id: "clc", scheme_version: "5", codes: ["D09"] } } }]));
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.ok(core.search(store, "政治学", { kinds: ["book"] })[0].reasons.includes("class: D09 政治学、政治理论"));
});
