// Fold ranges of a code fence, found from its indentation: a line whose next
// non-blank line is indented deeper opens a region that runs while the lines
// stay deeper. A closing line back at the opener's indent (`}`, `]`, `)`,
// `end`, `</tag>`, …) folds with it, so brace languages fold to `{ … }`.
// Indentation is what Python, YAML and Markdown nest by, and what every
// formatted brace language shows, so one rule covers the fences a reply holds
// without a parser per language.

/** Columns a tab advances to, as in most editors. */
const TAB_WIDTH = 4;

/** A line that only closes what an opener above it started. */
const CLOSER = /^(?:[}\])]|end\b|fi\b|done\b|esac\b|<\/|\*\/|"""|''')/;

/** Fences longer than this are not scanned (their highlight is deferred anyway). */
export const FOLD_MAX_LINES = 5000;

function indentOf(line: string): number | null {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += TAB_WIDTH - (width % TAB_WIDTH);
    else return width;
  }
  return null; // blank
}

/**
 * Maps each fold's first line to its last folded line (0-based, inclusive).
 * Folding line `start` hides `start + 1` through the returned end; regions
 * nest, and each hides at least one line.
 */
export function computeFoldRanges(code: string): Map<number, number> {
  const lines = code.replace(/\n$/, "").split("\n");
  const ranges = new Map<number, number>();
  if (lines.length < 3 || lines.length > FOLD_MAX_LINES) return ranges;
  const indents = lines.map(indentOf);

  for (let start = 0; start < lines.length; start += 1) {
    const base = indents[start];
    if (base === null) continue;
    let next = start + 1;
    while (next < lines.length && indents[next] === null) next += 1;
    if (next >= lines.length || (indents[next] as number) <= base) continue;

    // The body: every line deeper than the opener, blank lines included.
    let end = next;
    let probe = next + 1;
    while (probe < lines.length) {
      const indent = indents[probe];
      if (indent !== null && indent <= base) break;
      if (indent !== null) end = probe;
      probe += 1;
    }
    // A closer at the opener's own indent ends the fold with it.
    if (probe < lines.length && indents[probe] === base && CLOSER.test(lines[probe].trimStart())) end = probe;
    if (end > start) ranges.set(start, end);
  }
  return ranges;
}

/** Fences at least this long open with some of their blocks folded. */
export const AUTO_FOLD_MIN_LINES = 40;
/** A block shorter than this (lines hidden) is never folded for the reader. */
const AUTO_FOLD_MIN_BODY = 6;
/** A block hiding more than this share of the fence is opened up a level instead. */
const AUTO_FOLD_MAX_SHARE = 0.5;

/**
 * The folds a long fence opens with: the outermost blocks worth hiding, while
 * whatever frames most of the fence stays open. So a JSON document keeps its
 * top-level keys and a class keeps its method signatures, with their bodies
 * folded, and a short or flat fence starts fully open.
 */
export function autoFoldStarts(ranges: ReadonlyMap<number, number>, lineCount: number): Set<number> {
  const starts = new Set<number>();
  if (lineCount < AUTO_FOLD_MIN_LINES || ranges.size === 0) return starts;
  const ordered = [...ranges].sort((a, b) => a[0] - b[0]);

  // Ranges in line order nest like brackets: walk them with the end of the
  // block that was folded (nothing inside it is considered) or opened.
  let foldedUntil = -1;
  for (const [start, end] of ordered) {
    if (start <= foldedUntil) continue;
    const body = end - start;
    if (body < AUTO_FOLD_MIN_BODY) continue;
    const hasChildren = ordered.some(([inner, innerEnd]) => inner > start && innerEnd <= end && innerEnd - inner >= AUTO_FOLD_MIN_BODY);
    if (body > lineCount * AUTO_FOLD_MAX_SHARE && hasChildren) continue; // open it, look inside
    starts.add(start);
    foldedUntil = end;
  }
  return starts;
}

/** The lines hidden by the folded starts: true at each hidden index. */
export function hiddenLines(ranges: ReadonlyMap<number, number>, collapsed: ReadonlySet<number>, lineCount: number): boolean[] {
  const hidden = new Array<boolean>(lineCount).fill(false);
  for (const start of collapsed) {
    const end = ranges.get(start);
    if (end === undefined) continue;
    for (let line = start + 1; line <= end && line < lineCount; line += 1) hidden[line] = true;
  }
  return hidden;
}
