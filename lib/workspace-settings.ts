import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// The workspace: the folder new projects go in when the user names no place
// (a clone, a project started from scratch). It is apart from the default
// session folder (~/pi-cwd/YYYYMMDD, lib/default-cwd.ts), which is a scratch
// cwd for chats. Pi-web keeps it in its own file beside pi's, read when a
// session starts (the agent is told about it, lib/rpc-manager.ts) and by the
// "Continue in another folder" picker, which opens there.

export function getWorkspaceSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-workspace.json");
}

/** `~` and `~/…` expanded; a relative path is refused. */
export function normalizeWorkspacePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : null;
}

/** The saved workspace, if it is still a directory; undefined otherwise. */
export function readWorkspaceDir(agentDir = getAgentDir()): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(getWorkspaceSettingsPath(agentDir), "utf8")) as { workspaceDir?: unknown };
    const dir = typeof parsed.workspaceDir === "string" ? normalizeWorkspacePath(parsed.workspaceDir) : null;
    return dir && statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the workspace (null clears it). Written to a temporary file and renamed, so a reader never sees half a file. */
export function writeWorkspaceDir(dir: string | null, agentDir = getAgentDir()): void {
  const path = getWorkspaceSettingsPath(agentDir);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(dir ? { workspaceDir: dir } : {}, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * What the agent is told about the workspace, appended to pi's system prompt
 * for a session that starts while one is set.
 */
export function workspacePromptNote(dir: string): string {
  return [
    "# Workspace",
    `The user's workspace for projects is ${dir}.`,
    "When the user asks to clone or download a repository, or to start a new project, and does not say where, create it in its own new folder inside this workspace, not in the current working directory.",
    "Say the full path you used. The user can then move this conversation into that folder with \"Continue in another folder\" in the session's menu in Pi Web.",
  ].join("\n");
}
