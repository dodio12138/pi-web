import { NextResponse } from "next/server";
import { statSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { normalizeWorkspacePath, readWorkspaceDir, writeWorkspaceDir } from "@/lib/workspace-settings";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/workspace: { workspaceDir: string | null }
export async function GET() {
  const workspaceDir = readWorkspaceDir() ?? null;
  // The picker that opens there lists it through the file routes.
  if (workspaceDir) allowFileRoot(workspaceDir);
  return NextResponse.json({ workspaceDir }, { headers: NO_STORE });
}

// PUT /api/workspace  body: { workspaceDir: string | null }
// Sessions started afterwards are told about it; open ones keep what they had.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: NO_STORE });
  const body = await req.json().catch(() => null) as { workspaceDir?: unknown } | null;
  if (body?.workspaceDir === null) {
    writeWorkspaceDir(null);
    return NextResponse.json({ workspaceDir: null }, { headers: NO_STORE });
  }
  const dir = typeof body?.workspaceDir === "string" ? normalizeWorkspacePath(body.workspaceDir) : null;
  if (!dir) return NextResponse.json({ error: "An absolute path is required" }, { status: 400, headers: NO_STORE });
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    return NextResponse.json({ error: `Directory does not exist: ${dir}` }, { status: 400, headers: NO_STORE });
  }
  writeWorkspaceDir(dir);
  allowFileRoot(dir);
  return NextResponse.json({ workspaceDir: dir }, { headers: NO_STORE });
}
