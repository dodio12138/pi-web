import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { SKIN_DEFAULT, SKIN_INIT_SCRIPT, SKIN_OPTIONS, applyDomSkin, isSkinPreference } from "./skin.ts";

test("first paint restores a saved skin and leaves the default, invalid or blocked storage unmarked", () => {
  for (const stored of [...SKIN_OPTIONS.map(({ id }) => id), null, "", "unknown", new Error("Blocked")]) {
    const root = { dataset: {} };
    runInNewContext(SKIN_INIT_SCRIPT, {
      localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
      document: { documentElement: root },
    });
    const expected = isSkinPreference(stored) && stored !== SKIN_DEFAULT ? stored : undefined;
    assert.equal(root.dataset.skin, expected);
  }
});

test("applying the default skin removes the attribute", () => {
  const root = { dataset: {} };
  applyDomSkin(root, "pixel");
  assert.equal(root.dataset.skin, "pixel");
  applyDomSkin(root, SKIN_DEFAULT);
  assert.equal("skin" in root.dataset, false);
});
