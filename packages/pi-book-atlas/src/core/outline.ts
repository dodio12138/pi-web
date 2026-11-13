// A book's table of contents as the spine of its graph: columns (one per
// part; chapters outside any part, such as an introduction or a conclusion,
// form columns of their own), chapters in reading order, sections inside.

import type { BookOutline, OutlineItem } from "./schema";

export interface OutlineChapter {
  id: string;
  title: string;
  sections: { id: string; title: string }[];
}

export interface OutlineColumn {
  /** The part's id, or null for chapters outside any part. */
  id: string | null;
  title: string | null;
  chapters: OutlineChapter[];
}

/** The columns of the spine, in reading order. A part without chapters is a column with one chapter: itself. */
export function outlineColumns(outline: BookOutline | null | undefined): OutlineColumn[] {
  if (!outline?.items.length) return [];
  const items = outline.items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const columns: OutlineColumn[] = [];
  const chapters = new Map<string, OutlineChapter>();
  let loose: OutlineColumn | null = null;
  const partColumn = new Map<string, OutlineColumn>();

  for (const item of items) {
    if (item.level === "part") {
      const column: OutlineColumn = { id: item.id, title: item.title, chapters: [] };
      partColumn.set(item.id, column);
      columns.push(column);
      loose = null;
    } else if (item.level === "chapter") {
      const chapter: OutlineChapter = { id: item.id, title: item.title, sections: [] };
      chapters.set(item.id, chapter);
      const column = item.parent ? partColumn.get(item.parent) : undefined;
      if (column) {
        column.chapters.push(chapter);
        loose = null;
      } else {
        if (!loose) { loose = { id: null, title: null, chapters: [] }; columns.push(loose); }
        loose.chapters.push(chapter);
      }
    } else {
      const parent = item.parent ? byId.get(item.parent) : undefined;
      if (parent?.level === "chapter") chapters.get(parent.id)?.sections.push({ id: item.id, title: item.title });
      else if (parent?.level === "part") {
        // A section straight under a part: show it as a chapter of that part.
        const column = partColumn.get(parent.id);
        const chapter: OutlineChapter = { id: item.id, title: item.title, sections: [] };
        chapters.set(item.id, chapter);
        column?.chapters.push(chapter);
      } else {
        if (!loose) { loose = { id: null, title: null, chapters: [] }; columns.push(loose); }
        const chapter: OutlineChapter = { id: item.id, title: item.title, sections: [] };
        chapters.set(item.id, chapter);
        loose.chapters.push(chapter);
      }
    }
  }
  for (const column of columns) {
    if (column.id && column.chapters.length === 0) column.chapters.push({ id: column.id, title: column.title ?? "", sections: [] });
  }
  return columns;
}

/** The chapter an outline entry belongs to: a section's chapter, a chapter itself, a part's own column head. */
export function chapterOf(outline: BookOutline | null | undefined, id: string | null | undefined): string | null {
  if (!outline || !id) return null;
  const item = outline.items.find((entry) => entry.id === id);
  if (!item) return null;
  if (item.level === "section" && item.parent) {
    const parent = outline.items.find((entry) => entry.id === item.parent);
    return parent?.level === "chapter" ? parent.id : item.id;
  }
  return item.id;
}

export function outlineItem(outline: BookOutline | null | undefined, id: string | null | undefined): OutlineItem | null {
  return (outline && id && outline.items.find((entry) => entry.id === id)) || null;
}

/** The outline as the Agent needs it: one line per entry, ids first, indented by level. */
export function outlinePrompt(outline: BookOutline): string {
  const indent = { part: "", chapter: "  ", section: "    " } as const;
  const source = { user: "from the user", web: "from the web", model: "recalled by a model, unchecked" }[outline.source];
  return [`Table of contents (${source}${outline.note ? `: ${outline.note}` : ""}):`, ...outline.items.map((item) => `${indent[item.level]}${item.id} ${item.title}`)].join("\n");
}
