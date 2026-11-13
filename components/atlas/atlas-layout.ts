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

export interface LayeredCard extends LayoutCard { type?: string }

const TYPE_ORDER: Record<string, number> = { book: 0, concept: 1, claim: 2, method: 3, skill: 4, example: 5, question: 6 };
export const LAYER_GAP = 200;
export const COLUMN_GAP = CARD_W + 56;
const MAX_PER_ROW = 6;

/**
 * A tidy arrangement for reading: books on top, the knowledge they relate to
 * in the row below, what that knowledge relates to below that. Within a row,
 * cards sit under the cards they connect to (barycentre sweeps, fewer
 * crossings) and cards of one type stay together. Cards no book reaches form
 * the last rows. A row longer than six wraps.
 */
export function layeredLayout(cards: LayeredCard[], edges: LayoutEdge[]): Record<string, Point> {
  if (cards.length === 0) return {};
  const ids = new Set(cards.map((c) => c.id));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const neighbours = new Map<string, string[]>(cards.map((c) => [c.id, []]));
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }
  const typeOf = (id: string) => byId.get(id)?.type ?? (byId.get(id)?.kind === "book" ? "book" : "concept");

  // Layers by distance from the books (or, without books, from the best-connected card).
  const layer = new Map<string, number>();
  const books = cards.filter((c) => c.kind === "book").map((c) => c.id);
  const seeds = books.length ? books : [[...cards].sort((a, b) => neighbours.get(b.id)!.length - neighbours.get(a.id)!.length || a.id.localeCompare(b.id))[0].id];
  let frontier = seeds;
  for (const id of seeds) layer.set(id, 0);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id)!) {
        if (layer.has(other)) continue;
        layer.set(other, layer.get(id)! + 1);
        next.push(other);
      }
    }
    frontier = next;
  }
  // Cards not reached: their own rows below, still grouped by what they connect to.
  let deepest = Math.max(...layer.values());
  const rest = cards.filter((c) => !layer.has(c.id));
  if (rest.length) {
    deepest += 1;
    for (const c of rest) layer.set(c.id, deepest);
  }

  const rows: string[][] = [];
  for (const c of cards) (rows[layer.get(c.id)!] ??= []).push(c.id);
  for (const row of rows) row?.sort((a, b) => (TYPE_ORDER[typeOf(a)] ?? 9) - (TYPE_ORDER[typeOf(b)] ?? 9) || a.localeCompare(b));

  // Barycentre sweeps: order each row by the mean position of its neighbours in the row above (then below).
  const index = new Map<string, number>();
  const reindex = () => rows.forEach((row) => row?.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (row: string[], other: number) => {
    const score = (id: string) => {
      const near = neighbours.get(id)!.filter((n) => layer.get(n) === other);
      if (!near.length) return index.get(id)!;
      return near.reduce((s, n) => s + index.get(n)!, 0) / near.length;
    };
    const scores = new Map(row.map((id) => [id, score(id)]));
    row.sort((a, b) => scores.get(a)! - scores.get(b)! || (TYPE_ORDER[typeOf(a)] ?? 9) - (TYPE_ORDER[typeOf(b)] ?? 9) || a.localeCompare(b));
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let r = 1; r < rows.length; r += 1) if (rows[r]) { sweep(rows[r], r - 1); reindex(); }
    for (let r = rows.length - 2; r >= 0; r -= 1) if (rows[r]) { sweep(rows[r], r + 1); reindex(); }
  }

  // Place: rows centred on x = 0; long rows wrap into sub-rows, offset by half a column.
  const out: Record<string, Point> = {};
  let y = 0;
  for (const row of rows) {
    if (!row?.length) continue;
    for (let start = 0, sub = 0; start < row.length; start += MAX_PER_ROW, sub += 1) {
      const chunk = row.slice(start, start + MAX_PER_ROW);
      const offset = sub % 2 ? COLUMN_GAP / 2 : 0;
      chunk.forEach((id, i) => { out[id] = { x: Math.round((i - (chunk.length - 1) / 2) * COLUMN_GAP + offset), y }; });
      y += sub < Math.ceil(row.length / MAX_PER_ROW) - 1 ? CARD_H + 64 : 0;
    }
    y += LAYER_GAP;
  }
  return out;
}

// ---- Structure layout: the book's table of contents as the spine ----------

export interface SpineColumn {
  id: string | null;
  title: string | null;
  chapters: { id: string; title: string; sections: { id: string; title: string }[] }[];
}

export interface StructureCard extends LayeredCard { chapter?: string | null }

export interface StructureFrames {
  parts: { id: string; title: string; x: number; y: number; w: number; h: number }[];
  chapters: { id: string; title: string; sections: { id: string; title: string }[]; x: number; y: number; w: number; h: number }[];
  /** Reading-order arrows: book to each column, chapter to chapter down a column's left edge. */
  arrows: { x1: number; y1: number; x2: number; y2: number }[];
  /** The band around the spine where supplements sit. */
  outer: { x: number; y: number; w: number; h: number } | null;
}

const INDENT = 26;
const CARD_GAP = 16;
export const SPINE_COLUMN_W = INDENT + 2 * CARD_W + CARD_GAP;
const SPINE_COLUMN_GAP = 72;
const ROW_STEP = CARD_H + 32;
const SECTION_LINE = 17;
const SECTIONS_SHOWN = 3;

/**
 * Book on top; one column per part (chapters outside parts get their own),
 * chapter boxes down each column in reading order with the knowledge from that
 * chapter under its box, two across; knowledge from no chapter (background,
 * comparisons, the Agent's supplements) in a band below the spine.
 */
export function structureLayout(columns: SpineColumn[], cards: StructureCard[], bookId: string): { positions: Record<string, Point>; frames: StructureFrames } {
  const positions: Record<string, Point> = {};
  const frames: StructureFrames = { parts: [], chapters: [], arrows: [], outer: null };
  const chapterIds = new Set(columns.flatMap((c) => c.chapters.map((ch) => ch.id)));
  const byChapter = new Map<string, StructureCard[]>();
  const outer: StructureCard[] = [];
  for (const card of cards) {
    if (card.id === bookId) continue;
    if (card.kind === "node" && card.chapter && chapterIds.has(card.chapter)) (byChapter.get(card.chapter) ?? byChapter.set(card.chapter, []).get(card.chapter)!).push(card);
    else outer.push(card);
  }
  const typeRank = (c: StructureCard) => TYPE_ORDER[c.type ?? "concept"] ?? 9;
  for (const list of byChapter.values()) list.sort((a, b) => typeRank(a) - typeRank(b) || a.id.localeCompare(b.id));

  const bookY = 0;
  positions[bookId] = { x: 0, y: bookY };
  const top = bookY + CARD_H / 2 + 70;
  const n = columns.length;
  let bottom = top;
  columns.forEach((column, i) => {
    const cx = (i - (n - 1) / 2) * (SPINE_COLUMN_W + SPINE_COLUMN_GAP);
    const left = cx - SPINE_COLUMN_W / 2;
    let y = top;
    if (column.id) {
      frames.parts.push({ id: column.id, title: column.title ?? "", x: left, y, w: SPINE_COLUMN_W, h: 40 });
      frames.arrows.push({ x1: 0, y1: bookY + CARD_H / 2 + 6, x2: cx, y2: y - 4 });
      y += 40 + 22;
    } else {
      frames.arrows.push({ x1: 0, y1: bookY + CARD_H / 2 + 6, x2: cx, y2: y - 4 });
    }
    column.chapters.forEach((chapter, k) => {
      const shown = Math.min(chapter.sections.length, SECTIONS_SHOWN);
      const more = chapter.sections.length > SECTIONS_SHOWN ? 1 : 0;
      const h = 38 + (shown + more) * SECTION_LINE + (shown + more ? 6 : 0);
      if (k > 0 || column.id) {
        // From the previous box (or the part) down the column's left edge.
        const prevBottom = k > 0 ? frames.chapters[frames.chapters.length - 1] : frames.parts[frames.parts.length - 1];
        frames.arrows.push({ x1: left + INDENT / 2, y1: prevBottom.y + prevBottom.h, x2: left + INDENT / 2, y2: y - 2 });
      }
      frames.chapters.push({ id: chapter.id, title: chapter.title, sections: chapter.sections, x: left, y, w: SPINE_COLUMN_W, h });
      y += h + 22;
      const list = byChapter.get(chapter.id) ?? [];
      list.forEach((card, j) => {
        const row = Math.floor(j / 2);
        const alone = j === list.length - 1 && list.length % 2 === 1;
        const x = alone ? left + INDENT + (2 * CARD_W + CARD_GAP) / 2 : left + INDENT + CARD_W / 2 + (j % 2) * (CARD_W + CARD_GAP);
        positions[card.id] = { x: Math.round(x), y: Math.round(y + CARD_H / 2 + row * ROW_STEP) };
      });
      if (list.length) y += Math.ceil(list.length / 2) * ROW_STEP;
      y += 26;
    });
    bottom = Math.max(bottom, y);
  });

  if (outer.length) {
    const width = Math.max(n * SPINE_COLUMN_W + (n - 1) * SPINE_COLUMN_GAP, 3 * (CARD_W + CARD_GAP));
    const perRow = Math.max(1, Math.floor((width - 2 * 24 + CARD_GAP) / (CARD_W + CARD_GAP)));
    const y0 = bottom + 70;
    const rows = Math.ceil(outer.length / perRow);
    outer.sort((a, b) => typeRank(a) - typeRank(b) || a.id.localeCompare(b.id));
    outer.forEach((card, j) => {
      const row = Math.floor(j / perRow);
      const inRow = Math.min(perRow, outer.length - row * perRow);
      const k = j - row * perRow;
      positions[card.id] = { x: Math.round((k - (inRow - 1) / 2) * (CARD_W + CARD_GAP)), y: Math.round(y0 + 40 + CARD_H / 2 + row * ROW_STEP) };
    });
    frames.outer = { x: -width / 2, y: y0, w: width, h: 40 + rows * ROW_STEP + 8 };
  }
  return { positions, frames };
}
