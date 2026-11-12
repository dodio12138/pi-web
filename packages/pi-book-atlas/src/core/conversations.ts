import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// The raw-discussion layer (§5, §9): the visible messages of learning
// sessions, one JSON line each in conversations/<session-id>.jsonl. Append-only.
// A message is identified by the host's entry id and a hash of its text, so a
// reconnect, a retry or a resumed session never stores it twice (§9.1,
// acceptance 4). Branch identity is kept through each entry's parent id.
// "organized" lines record which messages have been turned into knowledge.

export interface CapturedMessage {
  type: "message";
  session_id: string;
  entry_id: string;
  parent_id: string | null;
  role: "user" | "assistant";
  text: string;
  hash: string;
  /** When the host recorded the message, as it says. */
  timestamp: string | null;
  captured_at: string;
  machine: string;
  workspace: string;
}

export interface OrganizedMark {
  type: "organized";
  session_id: string;
  entry_ids: string[];
  task_id: string;
  at: string;
}

type Line = CapturedMessage | OrganizedMark;

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const SAFE_ID = /^[\w.-]{1,120}$/;

export class ConversationLog {
  private cache = new Map<string, { size: number; lines: Line[] }>();

  constructor(private readonly root: string) {}

  private path(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new Error(`Unsafe session id: ${sessionId}`);
    return join(this.root, "conversations", `${sessionId}.jsonl`);
  }

  /** Every complete line of a session's log; a torn last line (a crash mid-append) is skipped. */
  read(sessionId: string): Line[] {
    const path = this.path(sessionId);
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    const cached = this.cache.get(sessionId);
    if (cached && cached.size === size) return cached.lines;
    const lines: Line[] = [];
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as Line);
      } catch {
        // A partial line: never a record.
      }
    }
    this.cache.set(sessionId, { size, lines });
    return lines;
  }

  messages(sessionId: string): CapturedMessage[] {
    return this.read(sessionId).filter((line): line is CapturedMessage => line.type === "message");
  }

  organizedIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    for (const line of this.read(sessionId)) if (line.type === "organized") for (const id of line.entry_ids) ids.add(id);
    return ids;
  }

  /** Messages captured but not yet organized into knowledge, oldest first. */
  pending(sessionId: string): CapturedMessage[] {
    const done = this.organizedIds(sessionId);
    return this.messages(sessionId).filter((m) => !done.has(m.entry_id));
  }

  private append(sessionId: string, lines: Line[]) {
    if (lines.length === 0) return;
    const path = this.path(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    // A torn last line from an earlier crash: start on a fresh line.
    let prefix = "";
    if (existsSync(path) && statSync(path).size > 0) {
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) prefix = "\n";
    }
    const fd = openSync(path, "a");
    try {
      const buffer = Buffer.from(prefix + lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.cache.delete(sessionId);
  }

  /**
   * Stores the messages not seen before (by entry id, and by text for the same
   * entry). Returns those it stored.
   */
  capture(sessionId: string, messages: Omit<CapturedMessage, "type" | "hash" | "captured_at" | "session_id">[]): CapturedMessage[] {
    const known = new Map(this.messages(sessionId).map((m) => [m.entry_id, m.hash]));
    const now = new Date().toISOString();
    const fresh: CapturedMessage[] = [];
    for (const message of messages) {
      const hash = textHash(message.text);
      if (known.get(message.entry_id) === hash) continue;
      // Same entry with other text: the host rewrote it. Both lines stay; readers take the newer.
      known.set(message.entry_id, hash);
      fresh.push({ type: "message", session_id: sessionId, hash, captured_at: now, ...message });
    }
    this.append(sessionId, fresh);
    return fresh;
  }

  markOrganized(sessionId: string, entryIds: string[], taskId: string): void {
    const done = this.organizedIds(sessionId);
    const ids = entryIds.filter((id) => !done.has(id));
    if (ids.length === 0) return;
    this.append(sessionId, [{ type: "organized", session_id: sessionId, entry_ids: ids, task_id: taskId, at: new Date().toISOString() }]);
  }
}
