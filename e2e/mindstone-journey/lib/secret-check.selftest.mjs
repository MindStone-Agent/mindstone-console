// Positive and negative controls for secret-check.mjs, run as part of X1: a
// check that can't find a planted secret can't vouch for the evidence.
//
//   node secret-check.selftest.mjs
//
// Plants a synthetic secret (never a real one) in every form the checker
// claims to decode, each in its own temp dir, and requires a hit; a clean dir
// and a near-miss must stay clean. Also checks that secrets.mjs reads
// `export KEY=`, quoted values and subfolders. Exit 0 only if every control
// behaves; prints the control names, never the value.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { collectSecrets } from './secrets.mjs';
import { scan } from './secret-check.mjs';

const secret = `st${crypto.randomBytes(18).toString('hex')}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-secret-selftest-'));
let failures = 0;

/** A minimal stored (method 0) zip holding one file, optionally after a prefix. */
function zip(name, data, prefix = Buffer.alloc(0)) {
  const nameBuf = Buffer.from(name);
  const crc = zlib.crc32 ? zlib.crc32(data) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([prefix, local, nameBuf, data]);
}

/** A deflated zip entry with a data descriptor (sizes 0 in the local header), like streaming zippers write. */
function deflatedZipWithDescriptor(name, data) {
  const nameBuf = Buffer.from(name);
  const deflated = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([Buffer.from('JUNKPREFIX-not-a-zip-start'), local, nameBuf, deflated, Buffer.from('PK\x07\x08')]);
}

const json = (s) => JSON.stringify(s);
const uEscape = (s) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const half = Math.floor(secret.length / 2);
const gz = zlib.gzipSync(Buffer.from(`log line ${secret} end`));

const positives = {
  'plain text': `token=${secret}\n`,
  'base64 (offset 0)': Buffer.from(secret).toString('base64'),
  'base64 (offset 1)': Buffer.from(`x${secret}`).toString('base64'),
  'base64 (offset 2)': Buffer.from(`xy${secret}`).toString('base64'),
  'base64url': Buffer.from(`?${secret}`).toString('base64url'),
  'hex (lower)': Buffer.from(secret).toString('hex'),
  'hex (upper)': Buffer.from(secret).toString('hex').toUpperCase(),
  'UTF-16LE': Buffer.from(`pad ${secret} pad`, 'utf16le'),
  'UTF-16BE': Buffer.from(`pad ${secret} pad`, 'utf16le').swap16(),
  '\\u escapes (JSON)': `{"v":"${uEscape(secret)}"}`,
  'split by a newline': `${secret.slice(0, half)}\n${secret.slice(half)}`,
  'split by an escaped \\n in JSON': json(`${secret.slice(0, half)}\n${secret.slice(half)}`),
  'ANSI codes inside': `${secret.slice(0, half)}\u001b[31m\u001b[0m${secret.slice(half)}`,
  'ANSI as \\u001b in JSON': json(`${secret.slice(0, half)}\u001b[1m${secret.slice(half)}`),
  gzip: gz,
  'gzip after a prefix': Buffer.concat([Buffer.from('header bytes '), gz]),
  'base64 of gzip': gz.toString('base64'),
  'zip at byte 0': zip('a.txt', Buffer.from(secret)),
  'zip not at byte 0': zip('a.txt', Buffer.from(secret), Buffer.from('some leading bytes before the archive ')),
  'deflated zip with a data descriptor, not at byte 0': deflatedZipWithDescriptor('trace.json', Buffer.from(`{"x":"${secret}"}`)),
  'base64 of a zip in HTML': `<script>d="data:application/zip;base64,${zip('r.json', Buffer.from(secret)).toString('base64')}"</script>`,
  'zip inside gzip': zlib.gzipSync(zip('n.txt', Buffer.from(secret))),
  'zlib stream after a prefix': Buffer.concat([Buffer.from('binary header '), zlib.deflateSync(Buffer.from(`k=${secret}`))]),
  'base64 wrapped at 20 columns': (Buffer.from(`wrapped ${secret} wrapped`).toString('base64').match(/.{1,20}/g) ?? []).join('\n'),
};

for (const [name, content] of Object.entries(positives)) {
  const dir = fs.mkdtempSync(path.join(root, 'pos-'));
  fs.writeFileSync(path.join(dir, 'evidence.bin'), content);
  const { hits } = scan(dir, [secret]);
  const ok = hits.length > 0;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'MISS'} positive: ${name}`);
}

const negatives = {
  'clean dir': 'nothing to see here\n',
  'near miss (one character short)': secret.slice(0, -1),
};
for (const [name, content] of Object.entries(negatives)) {
  const dir = fs.mkdtempSync(path.join(root, 'neg-'));
  fs.writeFileSync(path.join(dir, 'evidence.txt'), content);
  const { hits } = scan(dir, [secret]);
  const ok = hits.length === 0;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FALSE'} negative: ${name}`);
}

// secrets.mjs: `export KEY=`, quoted values, subfolders, header files.
const src = fs.mkdtempSync(path.join(root, 'src-'));
fs.mkdirSync(path.join(src, 'nested', 'deeper'), { recursive: true });
const values = {
  exported: `ex${crypto.randomBytes(8).toString('hex')}`,
  quoted: `qu${crypto.randomBytes(8).toString('hex')}`,
  single: `sq${crypto.randomBytes(8).toString('hex')}`,
  nested: `ne${crypto.randomBytes(8).toString('hex')}`,
  header: `he${crypto.randomBytes(8).toString('hex')}`,
};
fs.writeFileSync(
  path.join(src, 'app.env'),
  `export API_TOKEN=${values.exported}\nDB_PASSWORD="${values.quoted}"\nJWT_SECRET='${values.single}'\nAPP_TITLE=not a secret\n`,
);
fs.writeFileSync(path.join(src, 'nested', 'deeper', 'token'), `${values.nested}\n`);
fs.writeFileSync(path.join(src, 'h-auth'), `Authorization: Bearer ${values.header}\n`);
const collected = new Set(collectSecrets([src]));
for (const [name, value] of Object.entries(values)) {
  const ok = collected.has(value);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'MISS'} secrets.mjs reads: ${name}`);
}
const quotesKept = [...collected].some((v) => v.startsWith('"') || v.startsWith("'"));
if (quotesKept) failures += 1;
console.log(`  ${quotesKept ? 'FAIL' : 'ok  '} secrets.mjs strips quotes`);
const nonSecret = collected.has('not a secret');
if (nonSecret) failures += 1;
console.log(`  ${nonSecret ? 'FAIL' : 'ok  '} secrets.mjs skips non-secret keys`);

fs.rmSync(root, { recursive: true, force: true });
const total = Object.keys(positives).length + Object.keys(negatives).length + Object.keys(values).length + 2;
console.log(`secret-check self-test: ${failures === 0 ? 'all' : total - failures} of ${total} controls behaved${failures ? ` (${failures} failed)` : ''}`);
process.exit(failures ? 1 : 0);
