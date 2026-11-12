import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

// Durable writes for the Atlas folder (§11).
//
// One file: written to a temporary file beside it, flushed, then renamed over
// it, so a reader sees the old file or the new one, never half of either.
//
// Several files: a transaction. Every new file is first written in full to a
// temporary file. Then a journal record listing them is written: that record
// is the commit point. Then each temporary file is renamed into place, and the
// record is removed. On open, recover() finishes any committed transaction
// (every file it needs already exists) and deletes temporary files that never
// got a record. So after a crash the library holds the whole new version or the
// whole old one, never a mix.

const TMP_MARK = ".atlas-tmp-";

function fsyncDir(dir: string) {
  // Make the rename itself durable. Not supported everywhere (Windows): best effort.
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // ignore
  }
}

function writeFully(path: string, content: string) {
  const fd = openSync(path, "w");
  try {
    const buffer = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tempPathFor(path: string, tag: string): string {
  return join(dirname(path), `${basename(path)}${TMP_MARK}${tag}`);
}

/** Replaces one file atomically. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path, randomBytes(4).toString("hex"));
  writeFully(tmp, content);
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

export interface FileWrite {
  /** Path relative to the Atlas root, with "/" separators. */
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
}

interface JournalRecord {
  txid: string;
  created_at: string;
  writes: { path: string; tmp: string | null }[];
}

export class AtlasStorage {
  constructor(readonly root: string) {}

  abs(relPath: string): string {
    return join(this.root, ...relPath.split("/"));
  }

  rel(absPath: string): string {
    return relative(this.root, absPath).split(sep).join("/");
  }

  read(relPath: string): string | null {
    try {
      return readFileSync(this.abs(relPath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  list(relDir: string, extension: string): string[] {
    const dir = this.abs(relDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(extension) && !name.includes(TMP_MARK))
      .sort()
      .map((name) => `${relDir}/${name}`);
  }

  private journalDir() {
    return this.abs("journal");
  }

  /**
   * Writes every file of one change, or none of them. `beforeCommit` runs after
   * the temporary files exist and before the commit record: a test uses it to
   * simulate a crash at that point.
   */
  commit(writes: FileWrite[], hooks: { beforeCommit?: () => void; afterCommitRecord?: (renamed: number) => void } = {}): string {
    const txid = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const record: JournalRecord = { txid, created_at: new Date().toISOString(), writes: [] };
    for (const write of writes) {
      const target = this.abs(write.path);
      mkdirSync(dirname(target), { recursive: true });
      if (write.content === null) {
        record.writes.push({ path: write.path, tmp: null });
        continue;
      }
      const tmp = tempPathFor(target, txid);
      writeFully(tmp, write.content);
      record.writes.push({ path: write.path, tmp: this.rel(tmp) });
    }
    hooks.beforeCommit?.();
    mkdirSync(this.journalDir(), { recursive: true });
    const recordPath = join(this.journalDir(), `tx-${txid}.json`);
    writeFileAtomic(recordPath, JSON.stringify(record, null, 2));
    // Committed: from here on, recovery finishes the transaction.
    this.apply(record, hooks.afterCommitRecord);
    unlinkSync(recordPath);
    fsyncDir(this.journalDir());
    return txid;
  }

  private apply(record: JournalRecord, onStep?: (renamed: number) => void) {
    let renamed = 0;
    for (const write of record.writes) {
      const target = this.abs(write.path);
      if (write.tmp === null) {
        rmSync(target, { force: true });
      } else {
        const tmp = this.abs(write.tmp);
        // Already renamed by an interrupted run: the target holds the new content.
        if (existsSync(tmp)) renameSync(tmp, target);
      }
      renamed += 1;
      onStep?.(renamed);
      fsyncDir(dirname(target));
    }
  }

  /**
   * Finishes committed transactions and removes temporary files of
   * uncommitted ones. Returns what it did, for the open report.
   */
  recover(): { completed: string[]; discardedTemp: string[] } {
    const completed: string[] = [];
    const dir = this.journalDir();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).sort()) {
        if (!name.startsWith("tx-") || !name.endsWith(".json")) continue;
        const recordPath = join(dir, name);
        let record: JournalRecord;
        try {
          record = JSON.parse(readFileSync(recordPath, "utf8")) as JournalRecord;
        } catch {
          // A record that never finished writing was never the commit point:
          // writeFileAtomic renames it into place only once complete.
          rmSync(recordPath, { force: true });
          continue;
        }
        this.apply(record);
        unlinkSync(recordPath);
        completed.push(record.txid);
      }
    }
    const discardedTemp: string[] = [];
    const walk = (absDir: string) => {
      if (!existsSync(absDir)) return;
      for (const name of readdirSync(absDir)) {
        const full = join(absDir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && !name.startsWith(".git")) walk(full);
        } else if (name.includes(TMP_MARK)) {
          rmSync(full, { force: true });
          discardedTemp.push(this.rel(full));
        }
      }
    };
    walk(this.root);
    return { completed, discardedTemp };
  }
}

// ---------------------------------------------------------------------------
// Library lock: one process writes a library at a time (§11). Within a process,
// openAtlas() hands out one shared store per folder, so sessions share it.

export interface LockInfo {
  pid: number;
  host: string;
  started_at: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockError extends Error {
  constructor(readonly holder: LockInfo) {
    super(`The Atlas library is in use by process ${holder.pid} on ${holder.host} (since ${holder.started_at}).`);
    this.name = "LockError";
  }
}

export function acquireLock(root: string): () => void {
  const lockPath = join(root, ".atlas.lock");
  const mine: LockInfo = { pid: process.pid, host: hostname(), started_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      try { writeSync(fd, JSON.stringify(mine)); } finally { closeSync(fd); }
      return () => {
        try {
          const held = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
          if (held.pid === mine.pid && held.host === mine.host) unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: LockInfo | null = null;
      try { holder = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo; } catch { holder = null; }
      // A lock left by a process that is gone (same machine) is stale. Another
      // machine's lock is never broken here: shared network folders are out of scope.
      const stale = !holder || (holder.host === mine.host && !processAlive(holder.pid));
      if (!stale && holder) throw new LockError(holder);
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Could not take the Atlas library lock");
}
