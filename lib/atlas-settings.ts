import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveAtlasRoot, type AtlasSettings } from "@/packages/pi-book-atlas/src/root";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";
import { invalidateModelRuntimeWithExtensions } from "./model-runtime";
import { getSessionEntries, readSessionHeader, resolveSessionPath } from "./session-reader";

// Pi Book Atlas from Settings (fork only): turn the bundled extension on or
// off, choose the library folder and whether every session learns, without
// editing ~/.pi/agent/settings.json by hand. The extension is pi's own package
// entry, so the pi CLI on this machine sees the same switch.

/** The extension shipped in this repository. */
export function bundledAtlasPackage(): string {
  return resolve(process.cwd(), "packages", "pi-book-atlas");
}

const MODE_ENTRY = "pi-book-atlas/mode";

export interface AtlasSettingsView {
  /** The package is listed in pi's settings: new sessions load it. */
  installed: boolean;
  packagePath: string;
  /** The folder the library is in now, and what decides it. "default" counts as not chosen: the library cannot be turned on. */
  root: string;
  rootSource: "env" | "settings" | "default";
  /** A folder was chosen (or set by the environment). */
  folderSet: boolean;
  /** The folder as set in settings, if any. */
  rootSetting: string | null;
  autoEnable: boolean;
  /** A library already exists there. */
  exists: boolean;
}

const samePath = (a: string, b: string) => resolve(a) === resolve(b);

function packageEntries(settings: Record<string, unknown>): unknown[] {
  return Array.isArray(settings.packages) ? settings.packages : [];
}

function entrySource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") return (entry as { source: string }).source;
  return null;
}

function isAtlasEntry(entry: unknown, packagePath: string): boolean {
  const source = entrySource(entry);
  if (!source || !isAbsolute(source.replace(/^~(?=\/|$)/, homedir()))) return false;
  return samePath(source.replace(/^~(?=\/|$)/, homedir()), packagePath);
}

export async function readAtlasSettings(env: NodeJS.ProcessEnv = process.env): Promise<AtlasSettingsView> {
  const packagePath = bundledAtlasPackage();
  const raw = await readGlobalSettings(getGlobalSettingsPath(), (settings) => settings);
  const bookAtlas = (raw.bookAtlas && typeof raw.bookAtlas === "object" ? raw.bookAtlas : {}) as AtlasSettings;
  const root = resolveAtlasRoot(bookAtlas, env);
  return {
    installed: packageEntries(raw).some((entry) => isAtlasEntry(entry, packagePath)),
    packagePath,
    root,
    rootSource: env.PI_BOOK_ATLAS_DIR ? "env" : bookAtlas.root ? "settings" : "default",
    folderSet: Boolean(env.PI_BOOK_ATLAS_DIR || bookAtlas.root),
    rootSetting: typeof bookAtlas.root === "string" ? bookAtlas.root : null,
    autoEnable: bookAtlas.autoEnable === true,
    exists: existsSync(join(root, "atlas.json")),
  };
}

/** `~` expanded; a relative path is refused. */
export function normalizeAtlasRoot(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : null;
}

export interface AtlasSettingsChange {
  installed?: boolean;
  /** An absolute folder; null goes back to the default (<agent dir>/atlas). */
  root?: string | null;
  autoEnable?: boolean;
}

export async function updateAtlasSettings(input: AtlasSettingsChange): Promise<AtlasSettingsView> {
  let change = input;
  const packagePath = bundledAtlasPackage();
  if (change.installed && !existsSync(join(packagePath, "package.json"))) throw new Error(`The extension is not at ${packagePath}`);
  let root: string | null | undefined;
  if (change.root !== undefined) {
    root = change.root === null ? null : normalizeAtlasRoot(change.root);
    if (change.root !== null && !root) throw new Error("The library folder must be an absolute path");
    if (root) {
      // A new folder may be made inside an existing one, never a whole new tree.
      if (existsSync(root)) {
        if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
      } else if (existsSync(dirname(root)) && statSync(dirname(root)).isDirectory()) {
        mkdirSync(root);
      } else {
        throw new Error(`Folder does not exist: ${dirname(root)}`);
      }
    }
  }
  // The library has to be placed on purpose: no folder, no library.
  const current = await readAtlasSettings();
  const folderAfter = root !== undefined ? root : current.rootSource !== "default" ? current.root : null;
  if (change.installed && !folderAfter && current.rootSource !== "env") throw new Error("Choose the library folder first");
  // Clearing the folder turns the library off with it.
  if (root === null && current.rootSource !== "env") change = { ...change, installed: false };
  await updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
    if (change.installed !== undefined) {
      const rest = packageEntries(settings).filter((entry) => !isAtlasEntry(entry, packagePath));
      settings.packages = change.installed ? [...rest, packagePath] : rest;
      if ((settings.packages as unknown[]).length === 0) delete settings.packages;
    }
    if (root !== undefined || change.autoEnable !== undefined) {
      const bookAtlas = { ...(settings.bookAtlas && typeof settings.bookAtlas === "object" ? settings.bookAtlas as Record<string, unknown> : {}) };
      if (root !== undefined) {
        if (root === null) delete bookAtlas.root;
        else bookAtlas.root = root;
      }
      if (change.autoEnable !== undefined) bookAtlas.autoEnable = change.autoEnable;
      settings.bookAtlas = bookAtlas;
    }
  });
  // Provider lists share one extension-loaded runtime: rebuild it with the change.
  if (change.installed !== undefined) invalidateModelRuntimeWithExtensions();
  return readAtlasSettings();
}

/**
 * Whether a session is a learning session, the way the extension decides it:
 * the last /atlas on|off in the session, else the autoEnable setting.
 */
/** Whether a session reads, and why: a session in the library folder always does; otherwise its last /atlas on|off, else the default. */
export async function sessionLearningState(sessionId: string, autoEnable: boolean, root?: string): Promise<{ learning: boolean | null; fixed: boolean }> {
  const path = await resolveSessionPath(sessionId);
  if (!path) return { learning: null, fixed: false };
  const cwd = readSessionHeader(path)?.cwd;
  if (root && cwd && (resolve(cwd) === resolve(root) || resolve(cwd).startsWith(`${resolve(root)}/`))) return { learning: true, fixed: true };
  return { learning: await sessionLearning(sessionId, autoEnable), fixed: false };
}

export async function sessionLearning(sessionId: string, autoEnable: boolean, root?: string): Promise<boolean | null> {
  const path = await resolveSessionPath(sessionId);
  if (!path) return null;
  // A session started in the library folder always learns.
  const cwd = readSessionHeader(path)?.cwd;
  if (root && cwd && (resolve(cwd) === resolve(root) || resolve(cwd).startsWith(`${resolve(root)}/`))) return true;
  let state: boolean | null = null;
  for (const entry of getSessionEntries(path) as unknown as { type: string; customType?: string; data?: { enabled?: boolean } }[]) {
    if (entry.type === "custom" && entry.customType === MODE_ENTRY) state = Boolean(entry.data?.enabled);
  }
  return state ?? autoEnable;
}

