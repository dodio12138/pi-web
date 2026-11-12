import { dump, JSON_SCHEMA, load } from "js-yaml";

// Books and nodes are Markdown files a person can read and edit: YAML front
// matter for the fields, Markdown for the body (§11). The JSON schema keeps
// YAML from turning "2026-11-12" into a Date or "no" into false.

export interface FrontMatterFile {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = "---";

export function parseFrontMatter(text: string): FrontMatterFile {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) throw new Error("missing front matter: the file must start with ---");
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) throw new Error("front matter is not closed with ---");
  const after = normalized.slice(end + FENCE.length + 1);
  if (after !== "" && !after.startsWith("\n")) throw new Error("front matter must end with a line of just ---");
  const data = load(normalized.slice(FENCE.length + 1, end), { schema: JSON_SCHEMA });
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("front matter must be a mapping");
  // One blank line separates the fence from the body, and the file ends with one
  // line break (serializeFrontMatter writes both); the body is what lies between.
  return { data: data as Record<string, unknown>, body: after.replace(/^\n\n?/, "").replace(/\n$/, "") };
}

export function serializeFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = dump(data, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
  const text = body.replace(/\s+$/, "");
  return `${FENCE}\n${yaml}${FENCE}\n${text ? `\n${text}\n` : ""}`;
}
