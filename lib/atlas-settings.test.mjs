import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Settings › General › Book library writes pi's own settings.json: the switch
// is a packages entry, the folder and the learning default are bookAtlas.*.
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-atlas-settings-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const previousAtlasDir = process.env.PI_BOOK_ATLAS_DIR;
delete process.env.PI_BOOK_ATLAS_DIR;
test.after(async () => {
  if (previousAtlasDir !== undefined) process.env.PI_BOOK_ATLAS_DIR = previousAtlasDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const atlas = await jiti.import("./atlas-settings.ts");
const settingsPath = join(agentDir, "settings.json");
const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8"));

test("switching the library on and off edits only its own packages entry", async () => {
  await writeFile(settingsPath, JSON.stringify({ packages: ["npm:other-pkg", { source: "git:x/y", extensions: [] }], theme: "dark" }));
  let view = await atlas.readAtlasSettings();
  assert.equal(view.installed, false);
  assert.equal(view.packagePath, resolve(process.cwd(), "packages", "pi-book-atlas"));
  assert.equal(view.root, join(agentDir, "atlas"));
  assert.equal(view.rootSource, "default");

  assert.equal(view.folderSet, false);
  await assert.rejects(atlas.updateAtlasSettings({ installed: true }), /library folder first/, "no folder, no library");
  const folder = await mkdtemp(join(tmpdir(), "pi-web-atlas-folder-"));
  view = await atlas.updateAtlasSettings({ root: folder, installed: true });
  assert.equal(view.installed, true);
  await atlas.updateAtlasSettings({ installed: true });
  let saved = await readSettings();
  assert.deepEqual(saved.packages, ["npm:other-pkg", { source: "git:x/y", extensions: [] }, view.packagePath], "added once, others kept");
  assert.equal(saved.theme, "dark");

  view = await atlas.updateAtlasSettings({ root: null });
  assert.equal(view.installed, false, "clearing the folder turns the library off");
  saved = await readSettings();
  assert.deepEqual(saved.packages, ["npm:other-pkg", { source: "git:x/y", extensions: [] }]);
  await rm(folder, { recursive: true, force: true });
});

test("the folder must be absolute and its parent must exist; null goes back to the default", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-web-atlas-root-"));
  try {
    await assert.rejects(atlas.updateAtlasSettings({ root: "relative/atlas" }), /absolute/);
    await assert.rejects(atlas.updateAtlasSettings({ root: join(parent, "missing", "atlas") }), /does not exist/);
    let view = await atlas.updateAtlasSettings({ root: join(parent, "atlas"), autoEnable: true });
    assert.ok(existsSync(join(parent, "atlas")), "one new folder is made");
    assert.equal(view.root, join(parent, "atlas"));
    assert.equal(view.rootSource, "settings");
    assert.equal(view.autoEnable, true);
    assert.equal(view.exists, false);
    assert.deepEqual((await readSettings()).bookAtlas, { root: join(parent, "atlas"), autoEnable: true });

    process.env.PI_BOOK_ATLAS_DIR = parent;
    view = await atlas.readAtlasSettings();
    assert.equal(view.rootSource, "env");
    assert.equal(view.root, parent);
    delete process.env.PI_BOOK_ATLAS_DIR;

    view = await atlas.updateAtlasSettings({ root: null });
    assert.equal(view.rootSource, "default");
    assert.equal(view.folderSet, false);
    assert.deepEqual((await readSettings()).bookAtlas, { autoEnable: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a session learns after its last /atlas on, else by the default", async () => {
  const dir = join(agentDir, "sessions", "--atlas-test--");
  await mkdir(dir, { recursive: true });
  const id = "11111111-2222-4333-8444-555555555555";
  const file = join(dir, `2026-11-13T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-11-13T00:00:00.000Z", cwd: "/tmp" },
    { type: "custom", id: "a1", parentId: null, timestamp: "2026-11-13T00:00:01.000Z", customType: "pi-book-atlas/mode", data: { enabled: true } },
  ];
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const { cacheSessionPath } = await jiti.import("./session-reader.ts");
  cacheSessionPath(id, file);
  assert.equal(await atlas.sessionLearning(id, false), true);
  lines.push({ type: "custom", id: "a2", parentId: "a1", timestamp: "2026-11-13T00:00:02.000Z", customType: "pi-book-atlas/mode", data: { enabled: false } });
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const { invalidateSessionManagerCache } = await jiti.import("./session-reader.ts");
  invalidateSessionManagerCache(file);
  assert.equal(await atlas.sessionLearning(id, true), false);
});
