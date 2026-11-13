import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./storage";

// Where cards sit on the canvas, and which cards a view hides. This is how
// the library is shown, not knowledge: it lives in layout.json beside the
// library, outside patches and revisions, so moving a card never changes an
// object and editing an object never moves its card.

export const LAYOUT_FILE = "layout.json";

export interface Point { x: number; y: number }

export interface AtlasLayout {
  schema_version: 1;
  /** Per view key: where each card sits. Cards without one are arranged by the canvas. */
  positions: Record<string, Record<string, Point>>;
  /** Per view key ("book:<id>", "session:<id>", "cross", …): cards removed from that view only. */
  hidden: Record<string, string[]>;
}

export interface LayoutChange {
  /** The view the positions belong to. */
  view?: string;
  /** null removes the position, so the card is arranged again. */
  positions?: Record<string, Point | null>;
  hide?: { view: string; ids: string[] };
  show?: { view: string; ids: string[] };
}

const empty = (): AtlasLayout => ({ schema_version: 1, positions: {}, hidden: {} });

const finite = (p: unknown): p is Point => Boolean(p) && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y);

export function readLayout(root: string): AtlasLayout {
  const path = join(root, LAYOUT_FILE);
  if (!existsSync(path)) return empty();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AtlasLayout>;
    const layout = empty();
    for (const [view, points] of Object.entries(raw.positions ?? {})) {
      if (!points || typeof points !== "object") continue;
      const kept: Record<string, Point> = {};
      for (const [id, p] of Object.entries(points as Record<string, unknown>)) if (finite(p)) kept[id] = { x: p.x, y: p.y };
      if (Object.keys(kept).length) layout.positions[view] = kept;
    }
    for (const [view, ids] of Object.entries(raw.hidden ?? {})) if (Array.isArray(ids)) layout.hidden[view] = ids.filter((id) => typeof id === "string");
    return layout;
  } catch {
    // A file broken by hand is kept aside, not overwritten: the layout starts over.
    renameSync(path, `${path}.broken-${Date.now()}`);
    return empty();
  }
}

export function updateLayout(root: string, change: LayoutChange): AtlasLayout {
  const layout = readLayout(root);
  if (change.positions && change.view) {
    const points = layout.positions[change.view] ?? {};
    for (const [id, p] of Object.entries(change.positions)) {
      if (p === null) delete points[id];
      else if (finite(p)) points[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    if (Object.keys(points).length) layout.positions[change.view] = points;
    else delete layout.positions[change.view];
  }
  if (change.hide?.ids.length) {
    layout.hidden[change.hide.view] = [...new Set([...(layout.hidden[change.hide.view] ?? []), ...change.hide.ids])];
  }
  if (change.show?.ids.length) {
    const show = new Set(change.show.ids);
    const rest = (layout.hidden[change.show.view] ?? []).filter((id) => !show.has(id));
    if (rest.length) layout.hidden[change.show.view] = rest;
    else delete layout.hidden[change.show.view];
  }
  writeFileAtomic(join(root, LAYOUT_FILE), `${JSON.stringify(layout, null, 2)}\n`);
  return layout;
}
