"use client";

import { useCallback, useSyncExternalStore } from "react";
import { SKIN_DEFAULT, SKIN_STORAGE_KEY, applyDomSkin, isSkinPreference, type SkinPreference } from "@/lib/skin";

export type { SkinPreference } from "@/lib/skin";

const listeners = new Set<() => void>();
let skin: SkinPreference | null = null;

function readStoredSkin(): SkinPreference {
  try {
    const value = localStorage.getItem(SKIN_STORAGE_KEY);
    if (isSkinPreference(value)) return value;
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  return SKIN_DEFAULT;
}

function ensureSkin(): SkinPreference {
  if (typeof window === "undefined") return SKIN_DEFAULT;
  if (skin) return skin;
  skin = readStoredSkin();
  applyDomSkin(document.documentElement, skin);
  return skin;
}

// Another tab changed the skin: follow it.
function onStorage(event: StorageEvent): void {
  if (event.key !== SKIN_STORAGE_KEY) return;
  skin = isSkinPreference(event.newValue) ? event.newValue : SKIN_DEFAULT;
  applyDomSkin(document.documentElement, skin);
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(cb);
  ensureSkin();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useSkin() {
  const preference = useSyncExternalStore(subscribe, ensureSkin, () => SKIN_DEFAULT);

  const setSkinPreference = useCallback((next: SkinPreference) => {
    if (ensureSkin() === next) return;
    skin = next;
    applyDomSkin(document.documentElement, next);
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, next);
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
    listeners.forEach((cb) => cb());
  }, []);

  return { skin: preference, setSkinPreference };
}
