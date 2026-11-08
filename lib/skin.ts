// A skin is a visual style layered over whichever palette (lib/theme.ts) is active:
// fonts, shapes and control styling, not colors. It is applied as html[data-skin].
export const SKIN_OPTIONS = [
  { id: "default", label: "settings.skinDefault" },
  { id: "pixel", label: "settings.skinPixel" },
] as const;

export type SkinPreference = (typeof SKIN_OPTIONS)[number]["id"];

export const SKIN_STORAGE_KEY = "pi-skin";
export const SKIN_DEFAULT: SkinPreference = "default";

export function isSkinPreference(value: unknown): value is SkinPreference {
  return SKIN_OPTIONS.some((option) => option.id === value);
}

/** Sets data-skin on <html>; the default skin is the absence of the attribute. */
export function applyDomSkin(root: { dataset: Record<string, string | undefined> }, skin: SkinPreference): void {
  if (skin === SKIN_DEFAULT) delete root.dataset.skin;
  else root.dataset.skin = skin;
}

// Apply the saved skin before first paint, including when storage is blocked.
export const SKIN_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(SKIN_STORAGE_KEY)});if(${JSON.stringify(SKIN_OPTIONS.map((option) => option.id).filter((id) => id !== SKIN_DEFAULT))}.includes(s))document.documentElement.dataset.skin=s}catch(e){}})();`;
