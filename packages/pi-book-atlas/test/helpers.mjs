import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
export const core = await jiti.import("../src/core/index.ts");

/** A fresh library folder, closed and removed after the test. */
export function scratchAtlas(t, { open = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-book-atlas-"));
  const opened = [];
  t.after(() => {
    for (const store of opened) {
      try { store.close(); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const openStore = (options = { create: true }) => {
    const { store, report } = core.openAtlas(root, options);
    if (!opened.includes(store)) opened.push(store);
    return { store, report };
  };
  return { root, openStore, ...(open ? openStore() : {}) };
}

/** Closes and reopens, as a restart would: nothing carried over in memory. */
export function restart(store, openStore) {
  store.close();
  return openStore({ create: false });
}

export const patch = (operations, extra = {}) => ({ schema_version: 1, operations, ...extra });
