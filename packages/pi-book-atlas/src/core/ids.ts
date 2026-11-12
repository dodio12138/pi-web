import { randomBytes } from "node:crypto";
import { ID_PREFIX, type ObjectKind } from "./schema";

// Ids are opaque: a kind prefix, a time part that sorts roughly by creation,
// and random characters. Nothing in them comes from a title, so renaming never
// changes an id (§6.1).

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newId(kind: ObjectKind, now = Date.now()): string {
  const time = now.toString(32).padStart(9, "0");
  return `${ID_PREFIX[kind]}-${time}${base32(randomBytes(5))}`;
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}
