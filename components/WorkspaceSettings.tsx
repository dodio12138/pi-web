"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { DirectoryPicker } from "./DirectoryPicker";
import { ConfigButton } from "./SettingsUi";

/** GET /api/workspace: the folder new projects go in (lib/workspace-settings.ts), or null. */
export async function fetchWorkspaceDir(): Promise<string | null> {
  try {
    const res = await fetch("/api/workspace", { cache: "no-store" });
    const data = await res.json() as { workspaceDir?: string | null };
    return res.ok ? data.workspaceDir ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Settings › General › Workspace: the folder new projects go in when the user
 * names no place, apart from the default session folder (~/pi-cwd/YYYYMMDD).
 * Sessions started afterwards are told about it, and "Continue in another
 * folder" opens there.
 */
export function WorkspaceSettings() {
  const { t } = useI18n();
  const [dir, setDir] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchWorkspaceDir().then((value) => {
      if (!alive) return;
      setDir(value);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  // The picker sits above Settings: one Escape closes only the picker.
  useEffect(() => (picking ? listenForStackedDialogEscape(document, () => setPicking(false)) : undefined), [picking]);

  const save = useCallback(async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceDir: next }),
      });
      const data = await res.json().catch(() => ({})) as { workspaceDir?: string | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDir(data.workspaceDir ?? null);
      setPicking(false);
    } catch (cause) {
      setError(t("settings.workspaceSaveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setSaving(false);
    }
  }, [t]);

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.workspace")}</h3>
      <p id="settings-workspace-description" className="settings-general-description">{t("settings.workspaceDescription")}</p>
      <div className="settings-workspace-row">
        <code className="settings-workspace-path" title={dir ?? undefined} data-empty={!dir || undefined}>
          {loaded ? dir ?? t("settings.workspaceNone") : "…"}
        </code>
        <ConfigButton size="small" disabled={!loaded || saving} aria-describedby="settings-workspace-description" onClick={() => setPicking(true)}>
          {t("settings.workspaceChoose")}
        </ConfigButton>
        {dir && (
          <ConfigButton size="small" variant="ghost" disabled={saving} onClick={() => void save(null)}>
            {t("settings.workspaceClear")}
          </ConfigButton>
        )}
      </div>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {picking && (
        <DirectoryPicker
          stacked
          initialPath={dir ?? undefined}
          busy={saving}
          error={error}
          onCancel={() => setPicking(false)}
          onSelect={(path) => void save(path)}
        />
      )}
    </section>
  );
}
