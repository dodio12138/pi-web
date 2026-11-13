"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { DirectoryPicker } from "../DirectoryPicker";
import { ConfigButton, ConfigSwitch } from "../SettingsUi";

// Settings › General › Book library (Pi Book Atlas, fork only): the
// extension's switch, the library folder and the learning default, written to
// pi's settings.json by /api/atlas so nobody edits it by hand.

export interface AtlasSettingsState {
  installed: boolean;
  packagePath: string;
  root: string;
  rootSource: "env" | "settings" | "default";
  folderSet: boolean;
  rootSetting: string | null;
  autoEnable: boolean;
  exists: boolean;
  learning?: boolean | null;
}

export async function fetchAtlasSettings(sessionId?: string | null): Promise<AtlasSettingsState | null> {
  try {
    const res = await fetch(`/api/atlas?op=settings${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store" });
    return res.ok ? await res.json() as AtlasSettingsState : null;
  } catch {
    return null;
  }
}

export async function saveAtlasSettings(settings: { installed?: boolean; root?: string | null; autoEnable?: boolean }): Promise<AtlasSettingsState> {
  const res = await fetch("/api/atlas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "settings", settings }),
  });
  const data = await res.json().catch(() => ({})) as AtlasSettingsState & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function AtlasSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<AtlasSettingsState | null>(null);
  const [saving, setSaving] = useState<"installed" | "root" | "autoEnable" | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchAtlasSettings().then((value) => { if (alive) setState(value); });
    return () => { alive = false; };
  }, []);

  useEffect(() => (picking ? listenForStackedDialogEscape(document, () => setPicking(false)) : undefined), [picking]);

  const save = useCallback(async (key: "installed" | "root" | "autoEnable", settings: Parameters<typeof saveAtlasSettings>[0]) => {
    setSaving(key);
    setError(null);
    try {
      setState(await saveAtlasSettings(settings));
      setPicking(false);
    } catch (cause) {
      setError(t("settings.atlasSaveFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setSaving(null);
    }
  }, [t]);

  const loaded = state !== null;
  const envRoot = state?.rootSource === "env";

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.atlas")}</h3>
      <p className="settings-general-description">{t("settings.atlasDescription")}</p>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{t("settings.atlasEnable")}</span>
          <ConfigSwitch
            checked={state?.installed === true}
            disabled={loaded && !state.folderSet}
            loading={!loaded || saving === "installed"}
            label={t("settings.atlasEnable")}
            describedBy="settings-atlas-enable-note"
            onChange={(installed) => void save("installed", { installed })}
          />
        </div>
      </div>
      <p id="settings-atlas-enable-note" className="settings-general-description">
        {loaded && !state.folderSet ? t("settings.atlasEnableNeedsFolder") : t("settings.atlasEnableNote")}
      </p>

      <h4 className="settings-general-heading" style={{ fontSize: "0.95em", marginTop: 12 }}>{t("settings.atlasFolder")}</h4>
      <div className="settings-workspace-row">
        <code className="settings-workspace-path" title={state?.folderSet ? state.root : undefined} data-empty={(loaded && !state.folderSet) || undefined}>
          {loaded ? (state.folderSet ? state.root : t("settings.workspaceNone")) : "…"}
        </code>
        <ConfigButton size="small" disabled={!loaded || saving !== null || envRoot} onClick={() => setPicking(true)}>
          {t("settings.workspaceChoose")}
        </ConfigButton>
        {state?.rootSetting && !envRoot && (
          <ConfigButton size="small" variant="ghost" disabled={saving !== null} onClick={() => void save("root", { root: null })}>
            {t("settings.workspaceClear")}
          </ConfigButton>
        )}
      </div>
      <p className="settings-general-description">
        {envRoot ? t("settings.atlasFolderEnv") : t("settings.atlasFolderSet")}
        {loaded && state.folderSet && !state.exists && ` ${t("settings.atlasFolderNew")}`}
      </p>

      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{t("settings.atlasAutoEnable")}</span>
          <ConfigSwitch
            checked={state?.autoEnable === true}
            loading={!loaded || saving === "autoEnable"}
            label={t("settings.atlasAutoEnable")}
            describedBy="settings-atlas-auto-note"
            onChange={(autoEnable) => void save("autoEnable", { autoEnable })}
          />
        </div>
      </div>
      <p id="settings-atlas-auto-note" className="settings-general-description">{t("settings.atlasAutoEnableNote")}</p>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {picking && state && (
        <DirectoryPicker
          stacked
          initialPath={state.folderSet && state.exists ? state.root : undefined}
          busy={saving !== null}
          error={error}
          onCancel={() => setPicking(false)}
          onSelect={(path) => void save("root", { root: path })}
        />
      )}
    </section>
  );
}
