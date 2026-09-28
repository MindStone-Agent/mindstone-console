// Fails if any generated secret appears anywhere under the evidence dir:
// in plain text, base64-encoded, inside a .zip (Playwright traces and
// reports), or inside a base64 zip embedded in a text file.
//
//   node secret-check.mjs <evidence-dir> <secret source>...
//
// Prints the files and the kind of match, never a value. Exit 0: clean;
// 1: a secret was found; 2: no secrets to look for (the check can't vouch).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { collectSecrets, needles } from './secrets.mjs';

const [evidence, ...sources] = process.argv.slice(2);
const secrets = collectSecrets(sources);
if (!secrets.length) {
  console.log('secret-check: no secrets found in the sources, nothing to check against');
  process.exit(2);
}
const patterns = secrets.map((secret, i) => ({ i, needles: needles(secret) }));
const hits = [];
let scanned = 0;

function scanBuffer(buffer, where, depth = 0) {
  scanned += 1;
  const text = buffer.toString('latin1');
  for (const { i, needles: list } of patterns) {
    list.forEach((needle, n) => {
      if (text.includes(needle)) hits.push(`${where}: secret #${i + 1} (${n === 0 ? 'plain' : 'base64'})`);
    });
  }
  if (depth > 4) return;
  // A zip (a trace, a report archive) or a zip nested in one.
  if (buffer.length > 22 && buffer.readUInt32LE(0) === 0x04034b50) {
    for (const entry of unzip(buffer)) scanBuffer(entry.data, `${where}!${entry.name}`, depth + 1);
  }
  // A zip embedded as base64 in a text file (Playwright's html report does this).
  for (const m of text.matchAll(/UEsDB[A-Za-z0-9+/=]{40,}/g)) {
    try {
      const inner = Buffer.from(m[0], 'base64');
      scanBuffer(inner, `${where}#base64zip@${m.index}`, depth + 1);
    } catch {
      // not decodable
    }
  }
}

/** Entries of a zip, from its central directory (handles data descriptors). */
function unzip(buffer) {
  const entries = [];
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buffer.length; n += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    try {
      entries.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    } catch {
      entries.push({ name, data: raw });
    }
  }
  return entries;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) scanBuffer(fs.readFileSync(full), path.relative(evidence, full));
  }
}

if (!evidence || !fs.existsSync(evidence)) {
  console.log(`secret-check: no evidence dir ${evidence}`);
  process.exit(2);
}
walk(evidence);
if (hits.length) {
  console.log(`secret-check: FOUND ${hits.length} occurrence(s) of ${secrets.length} secrets in ${scanned} files/entries:`);
  for (const hit of [...new Set(hits)]) console.log(`  ${hit}`);
  process.exit(1);
}
console.log(`secret-check: clean (${secrets.length} secrets, ${scanned} files/entries scanned, zips and base64 decoded)`);
