import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Where the library lives. The pi extension and the pi-web panel resolve it
// the same way, so both open the same folder (and, in one process, the same
// store).

export interface AtlasSettings {
  root?: string;
  autoEnable?: boolean;
}

/** PI_BOOK_ATLAS_DIR, else settings bookAtlas.root, else <agent dir>/atlas. */
export function resolveAtlasRoot(settings: AtlasSettings, env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = getAgentDir();
  const configured = env.PI_BOOK_ATLAS_DIR || settings.root;
  if (!configured) return join(agentDir, "atlas");
  if (configured === "~" || configured.startsWith("~/")) return join(process.env.HOME ?? "", configured.slice(1));
  return isAbsolute(configured) ? configured : resolve(agentDir, configured);
}
