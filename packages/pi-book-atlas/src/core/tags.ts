import { COVERAGE, type Tag, type TagBinding } from "./schema";

// Tag rules (§7.2): ids are fixed and names may change; aliases hold only true
// synonyms; parents never form a cycle; a merge leaves the old id redirecting
// to the survivor and moves every binding over.

/** The form two labels are compared in: Unicode-normalized, trimmed, single-spaced, case-folded. */
export function normalizeLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Follows merge redirects to the tag that lives on; null for an unknown id or a redirect loop. */
export function resolveTag(tags: ReadonlyMap<string, Tag>, id: string): Tag | null {
  let current = tags.get(id);
  const seen = new Set<string>();
  while (current && current.status === "merged" && current.redirect_to) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = tags.get(current.redirect_to);
  }
  return current ?? null;
}

/** Live tags whose name or an alias reads as `label`. */
export function findTagsByLabel(tags: ReadonlyMap<string, Tag>, label: string): Tag[] {
  const wanted = normalizeLabel(label);
  return [...tags.values()].filter((tag) => tag.status === "active"
    && (normalizeLabel(tag.name) === wanted || tag.aliases.some((alias) => normalizeLabel(alias) === wanted)));
}

/** Whether giving `id` these parents would make a tag its own ancestor. */
export function wouldCycle(tags: ReadonlyMap<string, Tag>, id: string, parentIds: readonly string[]): boolean {
  const stack = [...parentIds];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === id) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const tag = tags.get(next);
    if (tag) stack.push(...tag.parent_ids);
  }
  return false;
}

const COVERAGE_RANK = new Map(COVERAGE.map((coverage, index) => [coverage, index]));

/**
 * Moves bindings of `fromIds` onto `intoId`. A target bound to both keeps one
 * binding: the stronger coverage, the union of sources. Returns null when
 * nothing changed.
 */
export function migrateBindings(bindings: readonly TagBinding[], fromIds: ReadonlySet<string>, intoId: string): TagBinding[] | null {
  if (!bindings.some((binding) => fromIds.has(binding.tag_id))) return null;
  const out: TagBinding[] = [];
  for (const binding of bindings) {
    const moved = fromIds.has(binding.tag_id) ? { ...binding, tag_id: intoId } : binding;
    const existing = out.find((b) => b.tag_id === moved.tag_id);
    if (!existing) {
      out.push({ ...moved, source_refs: [...moved.source_refs] });
      continue;
    }
    if (COVERAGE_RANK.get(moved.coverage)! < COVERAGE_RANK.get(existing.coverage)!) existing.coverage = moved.coverage;
    existing.source_refs = [...new Set([...existing.source_refs, ...moved.source_refs])];
    if (!existing.reason && moved.reason) existing.reason = moved.reason;
  }
  return out;
}

export function coverageRank(coverage: TagBinding["coverage"]): number {
  return COVERAGE_RANK.get(coverage) ?? COVERAGE.length;
}
