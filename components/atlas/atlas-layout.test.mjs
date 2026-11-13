import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { placeCards, CARD_W, CARD_H } = await jiti.import("./atlas-layout.ts");

test("placed cards never move; only new ones get positions, deterministically", () => {
  const cards = [{ id: "book-a", kind: "book" }, { id: "node-1", kind: "node" }, { id: "node-2", kind: "node" }];
  const edges = [{ from: "book-a", to: "node-1" }, { from: "book-a", to: "node-2" }];
  const fixed = { "book-a": { x: 100, y: 50 } };
  const placed = placeCards(cards, edges, fixed);
  assert.deepEqual(Object.keys(placed).sort(), ["node-1", "node-2"]);
  assert.deepEqual(placeCards(cards, edges, fixed), placed, "same input, same layout");
  assert.deepEqual(placeCards(cards, edges, { ...fixed, ...placed }), {}, "nothing new, nothing placed");
});

test("new cards settle near what they relate to, without sitting on each other", () => {
  const cards = [{ id: "book-a", kind: "book" }, ...Array.from({ length: 12 }, (_, i) => ({ id: `node-${i}`, kind: "node" }))];
  const edges = cards.slice(1).map((c) => ({ from: "book-a", to: c.id }));
  const placed = placeCards(cards, edges, {});
  const all = Object.entries(placed);
  assert.equal(all.length, 13);
  for (const [a, pa] of all) {
    for (const [b, pb] of all) {
      if (a >= b) continue;
      const overlap = Math.abs(pa.x - pb.x) < CARD_W * 0.9 && Math.abs(pa.y - pb.y) < CARD_H * 0.9;
      assert.ok(!overlap, `${a} overlaps ${b}`);
    }
    if (a !== "book-a") assert.ok(Math.hypot(pa.x - placed["book-a"].x, pa.y - placed["book-a"].y) < 900, `${a} stays near its book`);
  }
});

test("asking about cards carries their ids and content into the chat", async () => {
  const { askText } = await jiti.import("./atlas-client.ts");
  const one = askText("质疑", [{ id: "node-abc", type: "concept", title: "自然状态", summary: "没有共同权力时的处境" }]);
  assert.match(one, /^\[知识图谱 · 质疑\]/);
  assert.match(one, /自然状态（概念，node-abc）：没有共同权力时的处境/);
  assert.match(one, /请对这个知识点提出最有力的质疑和反例。/);
  const two = askText("比较", [{ id: "node-a", type: "concept", title: "A", summary: "" }, { id: "node-b", type: "claim", title: "B", summary: "" }]);
  assert.match(two, /请比较这些知识点的异同。/);
  assert.match(two, /node-a[\s\S]*node-b/);
});

test("the tidy layout puts the book on top and its knowledge in rows below, without overlaps", async () => {
  const { layeredLayout } = await jiti.import("./atlas-layout.ts");
  const cards = [
    { id: "book-a", kind: "book", type: "book" },
    { id: "node-state", kind: "node", type: "concept" },
    { id: "node-social", kind: "node", type: "concept" },
    { id: "node-crisis", kind: "node", type: "question" },
    { id: "node-exec", kind: "node", type: "concept" },
    { id: "node-arist", kind: "node", type: "concept" },
    { id: "node-loose", kind: "node", type: "claim" },
  ];
  const edges = [
    { from: "book-a", to: "node-state" }, { from: "book-a", to: "node-social" }, { from: "book-a", to: "node-crisis" },
    { from: "node-state", to: "node-exec" }, { from: "node-social", to: "node-arist" },
  ];
  const p = layeredLayout(cards, edges);
  assert.equal(Object.keys(p).length, cards.length);
  assert.ok(p["book-a"].y < p["node-state"].y, "the book is above its knowledge");
  assert.equal(p["node-state"].y, p["node-crisis"].y, "direct knowledge shares a row");
  assert.ok(p["node-exec"].y > p["node-state"].y, "second step in the next row");
  assert.ok(p["node-loose"].y >= p["node-exec"].y, "unconnected cards go last");
  // Children sit under their parents: exec under state, arist under social.
  assert.equal(Math.sign(p["node-exec"].x - p["node-arist"].x), Math.sign(p["node-state"].x - p["node-social"].x));
  const all = Object.entries(p);
  for (const [a, pa] of all) for (const [b, pb] of all) {
    if (a < b) assert.ok(!(Math.abs(pa.x - pb.x) < CARD_W && Math.abs(pa.y - pb.y) < CARD_H), `${a} overlaps ${b}`);
  }
  assert.deepEqual(layeredLayout(cards, edges), p, "deterministic");
});

test("a long row wraps instead of running off the canvas", async () => {
  const { layeredLayout } = await jiti.import("./atlas-layout.ts");
  const cards = [{ id: "book-a", kind: "book" }, ...Array.from({ length: 14 }, (_, i) => ({ id: `node-${String(i).padStart(2, "0")}`, kind: "node", type: "concept" }))];
  const p = layeredLayout(cards, cards.slice(1).map((c) => ({ from: "book-a", to: c.id })));
  const xs = Object.values(p).map((q) => q.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 7 * (CARD_W + 56), "at most six across");
  assert.ok(new Set(cards.slice(1).map((c) => p[c.id].y)).size >= 3, "14 cards wrap into three rows");
});
