#!/usr/bin/env node
// How another application reads a Pi Book Atlas pack: no dependency on this
// package, only the JSON. Give it a pack and a tag (id, name or alias):
//
//   node pack-lookup.mjs atlas-pack.json 社会契约论
//
// It prints related reading first, then knowledge, each marked as a
// paraphrase, a quotation or a game setting, so an answer can say which.

import { readFileSync } from "node:fs";

export function findByTag(pack, tag) {
  if (pack.format !== "pi-book-atlas/pack") throw new Error("Not a Pi Book Atlas pack");
  if (pack.schema_version > 1) throw new Error(`Pack schema ${pack.schema_version} is newer than this reader`);
  const norm = (s) => String(s).trim().toLowerCase();
  const id = pack.tag_redirects[tag]
    ?? pack.tags.find((t) => t.id === tag || norm(t.name) === norm(tag) || t.aliases.some((a) => norm(a) === norm(tag)))?.id;
  const entry = id && pack.tag_index[id];
  if (!entry) return null;
  const books = new Map(pack.books.map((b) => [b.id, b]));
  const nodes = new Map(pack.nodes.map((n) => [n.id, n]));
  return {
    tag: pack.tags.find((t) => t.id === id),
    reading: entry.books.map((b) => books.get(b)),
    knowledge: entry.nodes.map((n) => nodes.get(n)),
  };
}

const LABEL = { paraphrase: "观点转述", quotation: "直接引文", setting: "游戏设定" };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, tag] = process.argv.slice(2);
  if (!file || !tag) {
    console.error("Usage: node pack-lookup.mjs <pack.json> <tag>");
    process.exit(2);
  }
  const found = findByTag(JSON.parse(readFileSync(file, "utf8")), tag);
  if (!found) {
    console.log(`No material for "${tag}".`);
    process.exit(0);
  }
  console.log(`# ${found.tag.name} (${found.tag.id})`);
  console.log("\n相关阅读：");
  for (const b of found.reading) console.log(`- 《${b.title}》${b.authors.join("、")}${b.published_year != null ? `，${b.published_year}` : ""}`);
  console.log("\n相关知识：");
  for (const n of found.knowledge) {
    const books = n.books.map((l) => found.reading.find((b) => b.id === l.book_id)?.title ?? l.book_id);
    console.log(`- [${LABEL[n.use]}] ${n.title}${n.summary ? `：${n.summary}` : ""}${books.length ? `（出自《${books.join("》《")}》）` : ""}`);
  }
}
