import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  buildGraph,
  describe,
  graphKey,
  listBooks,
  listTags,
  LockError,
  openAtlas,
  readLayout,
  updateLayout,
  type GraphRequest,
  type GraphViewKind,
  type LayoutChange,
  type PatchRequest,
} from "@/packages/pi-book-atlas/src/core/index";
import { resolveAtlasRoot, type AtlasSettings } from "@/packages/pi-book-atlas/src/root";
import { getGlobalSettingsPath } from "@/lib/global-settings-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

// The knowledge graph panel's backend (Pi Book Atlas, fork only). It goes
// through the same Knowledge Core as the pi extension: in this process both
// get the same store for the same folder, so the panel and the Agent share
// one writer, one set of checks and one revision counter. The folder comes
// from the server's own settings, never from the client.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const VIEWS: GraphViewKind[] = ["book", "session", "cross", "search"];

function settings(): AtlasSettings {
  try {
    const path = getGlobalSettingsPath();
    if (!existsSync(path)) return {};
    const value = (JSON.parse(readFileSync(path, "utf8")) as { bookAtlas?: AtlasSettings }).bookAtlas;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function library({ create = false } = {}) {
  const root = resolveAtlasRoot(settings());
  if (!create && !existsSync(join(root, "atlas.json"))) return { root, store: null };
  return { root, store: openAtlas(root, { create }).store };
}

function fail(error: unknown) {
  if (error instanceof LockError) return NextResponse.json({ error: error.message, locked: true }, { status: 423, headers: NO_STORE });
  return NextResponse.json({ error: (error as Error).message ?? String(error) }, { status: 500, headers: NO_STORE });
}

const list = (value: string | null) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

// GET /api/atlas?op=overview | revision | graph&view=…&book_id=…&session_id=…&q=…&tags=a,b&expand=a,b | read&id=…
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const op = params.get("op") ?? "overview";
  try {
    const { root, store } = library();
    if (!store) return NextResponse.json({ root, exists: false }, { headers: NO_STORE });
    switch (op) {
      case "revision":
        return NextResponse.json({ revision: store.meta.workspace_revision, version: store.version }, { headers: NO_STORE });
      case "overview":
        return NextResponse.json({
          root, exists: true,
          revision: store.meta.workspace_revision,
          counts: { books: store.books.size, nodes: store.nodes.size, tags: store.tags.size, relations: store.relations.size },
          books: listBooks(store),
          tags: listTags(store),
          problems: store.problems.map((p) => p.file),
        }, { headers: NO_STORE });
      case "graph": {
        const view = params.get("view") as GraphViewKind;
        if (!VIEWS.includes(view)) return NextResponse.json({ error: "Unknown view" }, { status: 400, headers: NO_STORE });
        const request: GraphRequest = {
          view,
          book_id: params.get("book_id") ?? undefined,
          session_id: params.get("session_id") ?? undefined,
          q: params.get("q") ?? undefined,
          tag_ids: list(params.get("tags")),
          expand: list(params.get("expand")),
        };
        const layout = readLayout(root);
        const key = graphKey(request);
        const graph = buildGraph(store, { ...request, hidden: layout.hidden[key] ?? [] });
        const saved = layout.positions[key] ?? {};
        const positions = Object.fromEntries(graph.cards.filter((c) => saved[c.id]).map((c) => [c.id, saved[c.id]]));
        return NextResponse.json({ ...graph, positions, hidden: layout.hidden[key] ?? [] }, { headers: NO_STORE });
      }
      case "read": {
        const id = params.get("id") ?? "";
        const view = describe(store, id);
        if (!view) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
        return NextResponse.json(view, { headers: NO_STORE });
      }
      default:
        return NextResponse.json({ error: "Unknown op" }, { status: 400, headers: NO_STORE });
    }
  } catch (error) {
    return fail(error);
  }
}

// POST /api/atlas  { op: "patch", patch } | { op: "layout", change } | { op: "reload" } | { op: "create" }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: NO_STORE });
  const body = await req.json().catch(() => null) as { op?: string; patch?: PatchRequest; change?: LayoutChange } | null;
  try {
    switch (body?.op) {
      case "create": {
        const { root, store } = library({ create: true });
        return NextResponse.json({ root, exists: true, revision: store!.meta.workspace_revision }, { headers: NO_STORE });
      }
      case "patch": {
        const { store } = library();
        if (!store) return NextResponse.json({ error: "No library yet" }, { status: 404, headers: NO_STORE });
        if (!body.patch || !Array.isArray(body.patch.operations)) return NextResponse.json({ error: "A patch needs operations" }, { status: 400, headers: NO_STORE });
        const result = store.applyPatch({ ...body.patch, schema_version: 1 });
        return NextResponse.json(result, { status: result.ok ? 200 : 409, headers: NO_STORE });
      }
      case "layout": {
        const { root, store } = library();
        if (!store) return NextResponse.json({ error: "No library yet" }, { status: 404, headers: NO_STORE });
        updateLayout(root, body.change ?? {});
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      }
      case "reload": {
        const { store } = library();
        if (!store) return NextResponse.json({ error: "No library yet" }, { status: 404, headers: NO_STORE });
        const report = store.reload();
        return NextResponse.json({ ok: true, report, revision: store.meta.workspace_revision }, { headers: NO_STORE });
      }
      default:
        return NextResponse.json({ error: "Unknown op" }, { status: 400, headers: NO_STORE });
    }
  } catch (error) {
    return fail(error);
  }
}
