import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_FOLD_MIN_LINES, FOLD_MAX_LINES, autoFoldStarts, computeFoldRanges, hiddenLines } from "./code-folding.ts";

const ranges = (code) => Object.fromEntries(computeFoldRanges(code));

test("python blocks fold by indentation, nested", () => {
  const code = [
    "def a():",          // 0
    "    if x:",         // 1
    "        y()",       // 2
    "",                  // 3
    "        z()",       // 4
    "    return 1",      // 5
    "",                  // 6
    "print(a())",        // 7
  ].join("\n");
  assert.deepEqual(ranges(code), { 0: 5, 1: 4 });
});

test("a brace block folds its closing line with it", () => {
  const code = ["function f() {", "  if (x) {", "    y();", "  }", "  return 1;", "}", "f();"].join("\n");
  assert.deepEqual(ranges(code), { 0: 5, 1: 3 });
});

test("JSON arrays and objects fold to their closers", () => {
  const code = JSON.stringify({ a: [1, 2], b: { c: true } }, null, 2);
  // {, "a": [, 1, 2, ], "b": {, "c": true, }, }
  assert.deepEqual(ranges(code), { 0: 8, 1: 4, 5: 7 });
});

test("tabs count to the next tab stop; a trailing newline adds no line", () => {
  assert.deepEqual(ranges("a:\n\tb:\n\t\tc\n"), { 0: 2, 1: 2 });
});

test("flat code, short fences and huge fences have no folds", () => {
  assert.deepEqual(ranges("a\nb\nc"), {});
  assert.deepEqual(ranges("a:\n  b"), {});
  assert.deepEqual(ranges(Array.from({ length: FOLD_MAX_LINES + 1 }, (_, i) => (i % 2 ? "  x" : "y")).join("\n")), {});
});

test("hidden lines follow the collapsed starts, nested ones included", () => {
  const folds = new Map([[0, 5], [1, 3]]);
  assert.deepEqual(hiddenLines(folds, new Set([1]), 7), [false, false, true, true, false, false, false]);
  assert.deepEqual(hiddenLines(folds, new Set([0, 1]), 7), [false, true, true, true, true, true, false]);
  assert.deepEqual(hiddenLines(folds, new Set([4]), 7), new Array(7).fill(false));
});

const autoFolds = (code) => {
  const lines = code.split("\n");
  return [...autoFoldStarts(computeFoldRanges(code), lines.length)].sort((a, b) => a - b).map((line) => lines[line].trim());
};
const body = (indent, count) => Array.from({ length: count }, (_, i) => `${" ".repeat(indent)}step${i}()`);

test("a long file folds each function body and keeps the signatures", () => {
  const code = ["import x", "", "def a():", ...body(4, 12), "", "def b():", ...body(4, 12), "", "def tiny():", "    return 1", "", ...body(0, 10)].join("\n");
  assert.ok(code.split("\n").length >= AUTO_FOLD_MIN_LINES);
  assert.deepEqual(autoFolds(code), ["def a():", "def b():"]);
});

test("a class that frames most of the fence opens to fold its methods", () => {
  const code = ["class Ship:", "    def a(self):", ...body(8, 15), "", "    def b(self):", ...body(8, 15), "", "    def c(self):", ...body(8, 8)].join("\n");
  assert.deepEqual(autoFolds(code), ["def a(self):", "def b(self):", "def c(self):"]);
});

test("long JSON keeps its top-level keys and folds their large values", () => {
  const value = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
  const code = JSON.stringify({ name: "x", orbit: value, stages: Array.from({ length: 8 }, (_, i) => i), small: { a: 1 }, deep: { inner: value } }, null, 2);
  assert.ok(code.split("\n").length >= AUTO_FOLD_MIN_LINES);
  const folded = autoFolds(code);
  assert.deepEqual(folded, ['"orbit": {', '"stages": [', '"deep": {']);
  assert.ok(!folded.includes("{"), "the root object stays open");
});

test("short fences start fully open", () => {
  const code = ["def a():", ...body(4, 12)].join("\n");
  assert.deepEqual(autoFolds(code), []);
});

test("fold analysis of the largest scanned fence stays fast", () => {
  const lines = [];
  // Deeply nested blocks: every line opens or closes one, the worst case for the scan.
  const depth = 12;
  const opener = (d) => `${" ".repeat(d * 2)}if (x${d}) {`;
  const closer = (d) => `${" ".repeat(d * 2)}}`;
  while (lines.length < FOLD_MAX_LINES - 2 * depth - 2) {
    for (let d = 0; d < depth; d += 1) lines.push(opener(d));
    lines.push(`${" ".repeat(depth * 2)}work();`);
    for (let d = depth - 1; d >= 0; d -= 1) lines.push(closer(d));
  }
  const code = lines.join("\n");
  const started = performance.now();
  const ranges = computeFoldRanges(code);
  autoFoldStarts(ranges, lines.length);
  const elapsed = performance.now() - started;
  assert.ok(ranges.size > 1000);
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)}ms`);
});
