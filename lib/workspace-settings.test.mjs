import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getWorkspaceSettingsPath, normalizeWorkspacePath, readWorkspaceDir, workspacePromptNote, writeWorkspaceDir } = await jiti.import("./workspace-settings.ts");

async function agentDir(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("paths: ~ expands, relative paths are refused", () => {
  assert.equal(normalizeWorkspacePath("~"), homedir());
  assert.equal(normalizeWorkspacePath("~/code"), join(homedir(), "code"));
  assert.equal(normalizeWorkspacePath("/tmp/x/../y"), "/tmp/y");
  assert.equal(normalizeWorkspacePath("code"), null);
  assert.equal(normalizeWorkspacePath("   "), null);
});

test("the workspace round-trips through its own file, and clears", async (t) => {
  const dir = await agentDir(t);
  const workspace = join(dir, "projects");
  mkdirSync(workspace);
  assert.equal(readWorkspaceDir(dir), undefined);
  writeWorkspaceDir(workspace, dir);
  assert.deepEqual(JSON.parse(readFileSync(getWorkspaceSettingsPath(dir), "utf8")), { workspaceDir: workspace });
  assert.equal(readWorkspaceDir(dir), workspace);
  writeWorkspaceDir(null, dir);
  assert.equal(readWorkspaceDir(dir), undefined);
});

test("a workspace that no longer exists reads as unset", async (t) => {
  const dir = await agentDir(t);
  writeWorkspaceDir(join(dir, "gone"), dir);
  assert.equal(readWorkspaceDir(dir), undefined);
});

test("the agent is told where new projects go", () => {
  const note = workspacePromptNote("/Users/me/GitHub");
  assert.match(note, /\/Users\/me\/GitHub/);
  assert.match(note, /clone/);
  assert.match(note, /Continue in another folder/);
});
