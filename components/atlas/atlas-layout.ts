// Places the cards that have no position yet; cards already placed (by hand
// or in an earlier arrangement) never move. New cards start near the cards
// they relate to and settle with a short force pass in which only they move,
// so an Agent adding knowledge never rearranges what the user laid out.

export interface Point { x: number; y: number }
export interface LayoutCard { id: string; kind: "book" | "node" }
export interface LayoutEdge { from: string; to: string }

export const CARD_W = 176;
export const CARD_H = 72;

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function placeCards(cards: LayoutCard[], edges: LayoutEdge[], fixed: Record<string, Point>): Record<string, Point> {
  const pos = new Map<string, Point>();
  for (const card of cards) if (fixed[card.id]) pos.set(card.id, { ...fixed[card.id] });
  const fresh = cards.filter((card) => !pos.has(card.id));
  if (fresh.length === 0) return {};

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  // Start positions: around placed neighbours, else on a ring around the placed cards (or the origin).
  const placed = [...pos.values()];
  const centre = placed.length
    ? { x: placed.reduce((s, p) => s + p.x, 0) / placed.length, y: placed.reduce((s, p) => s + p.y, 0) / placed.length }
    : { x: 0, y: 0 };
  const ringStart = placed.length ? Math.max(...placed.map((p) => Math.hypot(p.x - centre.x, p.y - centre.y))) + 260 : 0;
  // Books first so knowledge can start beside its book.
  const order = [...fresh].sort((a, b) => Number(b.kind === "book") - Number(a.kind === "book"));
  order.forEach((card, i) => {
    const near = (neighbours.get(card.id) ?? []).map((id) => pos.get(id)).filter((p): p is Point => Boolean(p));
    const angle = hash(card.id) * Math.PI * 2;
    if (near.length) {
      const base = { x: near.reduce((s, p) => s + p.x, 0) / near.length, y: near.reduce((s, p) => s + p.y, 0) / near.length };
      pos.set(card.id, { x: base.x + Math.cos(angle) * 240, y: base.y + Math.sin(angle) * 160 });
    } else if (!placed.length && i === 0) {
      pos.set(card.id, { x: 0, y: 0 });
    } else {
      const r = ringStart + 120 * Math.floor(i / 12);
      pos.set(card.id, { x: centre.x + Math.cos(angle) * Math.max(r, 280), y: centre.y + Math.sin(angle) * Math.max(r, 200) });
    }
  });

  // Settle: springs along edges, repulsion between all cards; only fresh cards move.
  const moving = new Set(fresh.map((c) => c.id));
  const ids = cards.map((c) => c.id);
  const ideal = 260;
  for (let step = 0; step < 220; step += 1) {
    const cool = 1 - step / 220;
    const force = new Map<string, Point>([...moving].map((id) => [id, { x: 0, y: 0 }]));
    for (const a of moving) {
      const pa = pos.get(a)!;
      const f = force.get(a)!;
      for (const b of ids) {
        if (a === b) continue;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = (pa.y - pb.y) * 1.6; // cards are wider than tall
        let d = Math.hypot(dx, dy);
        if (d < 1) { dx = hash(a + b) - 0.5; dy = hash(b + a) - 0.5; d = 1; }
        const push = (ideal * ideal) / d / d;
        f.x += (dx / d) * push * 40;
        f.y += (dy / d) * push * 40;
      }
      for (const b of neighbours.get(a) ?? []) {
        const pb = pos.get(b);
        if (!pb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const pull = (d - ideal) * 0.08;
        f.x += (dx / d) * pull;
        f.y += (dy / d) * pull;
      }
    }
    for (const id of moving) {
      const p = pos.get(id)!;
      const f = force.get(id)!;
      const len = Math.hypot(f.x, f.y);
      const max = 30 * cool + 1;
      const k = len > max ? max / len : 1;
      p.x += f.x * k;
      p.y += f.y * k;
    }
  }
  return Object.fromEntries(fresh.map((c) => {
    const p = pos.get(c.id)!;
    return [c.id, { x: Math.round(p.x), y: Math.round(p.y) }];
  }));
}
