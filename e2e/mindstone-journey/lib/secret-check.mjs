// Fails if any generated secret appears anywhere under the evidence dir.
//
//   node secret-check.mjs <evidence-dir> <secret source>...
//
// Each file is scanned as raw bytes and through every decoding the evidence
// could hide a secret behind:
// - encodings of the secret itself: UTF-8, UTF-16LE/BE, hex (either case),
//   base64 and base64url at any byte alignment;
// - a "flattened" text view with \uXXXX / \xNN escapes decoded, ANSI codes
//   removed and line breaks (real or escaped) removed, so a secret split
//   across lines or coloured by a terminal is still found;
// - containers: zips (anywhere in the file, not only at byte 0), gzip
//   streams (anywhere), and base64 runs, decoded and scanned recursively.
// - zlib streams (anywhere), and base64 wrapped across lines.
// Prints the files and the kind of match, never a value. Exit 0: clean;
// 1: a secret was found; 2: no secrets to look for (the check can't vouch).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { collectSecrets, needles } from './secrets.mjs';

const MAX_DEPTH = 5;
const LENIENT = { finishFlush: zlib.constants.Z_SYNC_FLUSH };

/** \uXXXX and \xNN escapes decoded, ANSI escape codes and line breaks (real or escaped) removed. */
export function flatten(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\\[rn]/g, '')
    .replace(/[\r\n]/g, '');
}

function* signatures(buffer, sig) {
  let i = buffer.indexOf(sig);
  while (i !== -1) {
    yield i;
    i = buffer.indexOf(sig, i + 1);
  }
}

/** Entries of every zip local header in the buffer, wherever it starts. */
function zipEntries(buffer) {
  const entries = [];
  for (const at of signatures(buffer, Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    if (at + 30 > buffer.length) continue;
    const flags = buffer.readUInt16LE(at + 6);
    const method = buffer.readUInt16LE(at + 8);
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    const start = at + 30 + nameLength + extraLength;
    if (start > buffer.length) continue;
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
    const sized = size > 0 && !(flags & 8);
    let raw = sized ? buffer.subarray(start, start + size) : buffer.subarray(start);
    try {
      if (method === 8) raw = zlib.inflateRawSync(raw, LENIENT);
      else if (!sized) {
        const next = buffer.indexOf(Buffer.from([0x50, 0x4b]), start);
        raw = buffer.subarray(start, next === -1 ? buffer.length : next);
      }
      entries.push({ name, data: raw });
    } catch {
      // not a readable entry
    }
  }
  return entries;
}

function gzipStreams(buffer) {
  const out = [];
  for (const at of signatures(buffer, Buffer.from([0x1f, 0x8b, 0x08]))) {
    try {
      out.push({ at, data: zlib.gunzipSync(buffer.subarray(at), LENIENT) });
    } catch {
      // not a gzip stream
    }
  }
  return out;
}

/** zlib streams (a 0x78 header with a valid check byte), anywhere in the buffer. */
function zlibStreams(buffer) {
  const out = [];
  for (let at = buffer.indexOf(0x78); at !== -1 && at < buffer.length - 2; at = buffer.indexOf(0x78, at + 1)) {
    if (((0x78 << 8) | buffer[at + 1]) % 31 !== 0) continue;
    try {
      const data = zlib.inflateSync(buffer.subarray(at), LENIENT);
      if (data.length) out.push({ at, data });
    } catch {
      // not a zlib stream
    }
  }
  return out;
}

function base64Runs(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const decoded = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length >= 12) out.push({ at: m.index, data: decoded });
  }
  return out;
}

/** Scans a directory for the given secrets; returns the hits (file and kind, never values). */
export function scan(dir, secrets) {
  const patterns = secrets.map((secret, i) => ({ i, secret, list: needles(secret) }));
  const hits = new Set();
  let scanned = 0;

  const scanBuffer = (buffer, where, depth) => {
    scanned += 1;
    for (const { i, secret, list } of patterns) {
      for (const { kind, bytes } of list) {
        if (buffer.includes(bytes)) hits.add(`${where}: secret #${i + 1} (${kind})`);
      }
      const flat = flatten(buffer.toString('latin1'));
      if (flat.includes(secret) || flat.includes(Buffer.from(secret, 'utf8').toString('latin1'))) {
        hits.add(`${where}: secret #${i + 1} (escaped/split)`);
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of zipEntries(buffer)) scanBuffer(entry.data, `${where}!${entry.name}`, depth + 1);
    for (const gz of gzipStreams(buffer)) scanBuffer(gz.data, `${where}#gzip@${gz.at}`, depth + 1);
    for (const z of zlibStreams(buffer)) scanBuffer(z.data, `${where}#zlib@${z.at}`, depth + 1);
    const text = buffer.toString('latin1');
    for (const b64 of base64Runs(text)) scanBuffer(b64.data, `${where}#base64@${b64.at}`, depth + 1);
    // base64 wrapped across lines (MIME/PEM style), read with the line breaks removed.
    const flat = flatten(text);
    if (flat !== text) for (const b64 of base64Runs(flat)) scanBuffer(b64.data, `${where}#wrapped-base64@${b64.at}`, depth + 1);
  };

  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) scanBuffer(fs.readFileSync(full), path.relative(dir, full), 0);
    }
  };
  walk(dir);
  return { hits: [...hits], scanned };
}

function main() {
  const [evidence, ...sources] = process.argv.slice(2);
  const secrets = collectSecrets(sources);
  if (!secrets.length) {
    console.log('secret-check: no secrets found in the sources, nothing to check against');
    process.exit(2);
  }
  if (!evidence || !fs.existsSync(evidence)) {
    console.log('secret-check: no evidence dir');
    process.exit(2);
  }
  const { hits, scanned } = scan(evidence, secrets);
  if (hits.length) {
    console.log(`secret-check: FOUND ${hits.length} occurrence(s) of ${secrets.length} secrets in ${scanned} files/entries:`);
    for (const hit of hits) console.log(`  ${hit}`);
    process.exit(1);
  }
  console.log(`secret-check: clean (${secrets.length} secrets, ${scanned} files/entries scanned, decoded: zip, gzip, zlib, base64 (also wrapped), hex, utf-16, escapes, split lines, ANSI)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
