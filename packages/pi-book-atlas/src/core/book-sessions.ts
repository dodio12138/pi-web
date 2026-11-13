import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./storage";
import { normalizeLabel } from "./tags";

// One book, one conversation: which pi session reads which book. Like the
// canvas layout, this is how the user works, not knowledge, so it lives in
// its own file beside the library and never enters patches or packs.

export const BOOK_SESSIONS_FILE = "book-sessions.json";

export interface BookSession {
  title: string;
  session_id: string;
  book_id?: string;
  linked_at: string;
}

type Map = Record<string, BookSession>;

function read(root: string): Map {
  const path = join(root, BOOK_SESSIONS_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { books?: Map };
    return raw.books && typeof raw.books === "object" ? raw.books : {};
  } catch {
    return {};
  }
}

/** The session for a book, by its id first, then by its title. */
export function findBookSession(root: string, book: { id?: string; title?: string }): BookSession | null {
  const books = Object.values(read(root));
  return (book.id ? books.find((b) => b.book_id === book.id) : undefined)
    ?? (book.title ? books.find((b) => normalizeLabel(b.title) === normalizeLabel(book.title!)) : undefined)
    ?? null;
}

/** Records (or moves) a book's session. A title already linked to another session keeps the newest. */
export function linkBookSession(root: string, link: { title: string; session_id: string; book_id?: string }, now = new Date().toISOString()): BookSession {
  const books = read(root);
  const key = normalizeLabel(link.title);
  const previous = books[key];
  const entry: BookSession = { title: link.title, session_id: link.session_id, ...(link.book_id ?? previous?.book_id ? { book_id: link.book_id ?? previous?.book_id } : {}), linked_at: now };
  books[key] = entry;
  writeFileAtomic(join(root, BOOK_SESSIONS_FILE), `${JSON.stringify({ books }, null, 2)}\n`);
  return entry;
}

/** The book a session reads, if any. */
export function bookOfSession(root: string, sessionId: string): BookSession | null {
  return Object.values(read(root)).find((b) => b.session_id === sessionId) ?? null;
}
