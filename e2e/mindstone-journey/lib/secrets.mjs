// The secrets a run generated, read from their files. Shared by scrub.mjs and
// secret-check.mjs. Values never leave this process's memory.
//
// A source is a file or a directory (read recursively). In a file:
// - a .env-style file (any line KEY=value, optionally `export KEY=value`,
//   optionally quoted) contributes each value whose key looks secret;
// - a one-line "Header-Name: value" file (the harness's curl header files)
//   contributes the value (after "Bearer ", if present);
// - any other one-line file is one secret.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /(KEY|IV|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
const MIN_LENGTH = 8;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(value) {
  const m = value.match(/^(['"])(.*)\1$/);
  return m ? m[2] : value;
}

function fromFile(file, secrets) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const looksEnv = /\.env($|\.)/.test(path.basename(file)) || (lines.length > 0 && lines.every((l) => ENV_LINE.test(l)) && lines.length > 1);
  if (looksEnv) {
    for (const line of lines) {
      const m = line.match(ENV_LINE);
      if (!m || !SECRET_KEY.test(m[1])) continue;
      const value = unquote(m[2]);
      if (value.length >= MIN_LENGTH) secrets.add(value);
    }
    return;
  }
  const value = text.trim();
  if (!value || value.includes('\n')) return;
  const header = value.match(/^[A-Za-z][A-Za-z-]*:\s*(?:Bearer\s+)?(.+)$/);
  if (header) {
    if (header[1].trim().length >= MIN_LENGTH) secrets.add(header[1].trim());
    return;
  }
  const single = value.match(ENV_LINE);
  if (single && SECRET_KEY.test(single[1])) {
    const v = unquote(single[2]);
    if (v.length >= MIN_LENGTH) secrets.add(v);
    return;
  }
  if (value.length >= MIN_LENGTH) secrets.add(unquote(value));
}

function fromPath(source, secrets, depth = 0) {
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    return; // a source that doesn't exist has nothing in it
  }
  if (stat.isDirectory()) {
    if (depth > 6) return;
    for (const name of fs.readdirSync(source)) fromPath(path.join(source, name), secrets, depth + 1);
  } else if (stat.isFile() && stat.size < 1024 * 1024) {
    fromFile(source, secrets);
  }
}

export function collectSecrets(sources) {
  const secrets = new Set();
  for (const source of sources) if (source) fromPath(source, secrets);
  return [...secrets];
}

/** The base64 run that encodes only `bytes`, at each of the three byte alignments. */
export function base64Cores(bytes) {
  const out = [];
  for (let k = 0; k < 3; k += 1) {
    const encoded = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    const core = encoded.slice(start, end);
    if (core.length >= 12) {
      out.push(core);
      out.push(core.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return out;
}

/**
 * Every byte string the secret could appear as inside a larger buffer:
 * itself (UTF-8, UTF-16LE, UTF-16BE), lower- and upper-case hex, and the
 * base64 / base64url runs that encode it. Each entry: { kind, bytes }.
 */
export function needles(secret) {
  const utf8 = Buffer.from(secret, 'utf8');
  const hex = utf8.toString('hex');
  const le = Buffer.from(secret, 'utf16le');
  const be = Buffer.from(le).swap16();
  const out = [
    { kind: 'plain', bytes: utf8 },
    { kind: 'hex', bytes: Buffer.from(hex) },
    { kind: 'HEX', bytes: Buffer.from(hex.toUpperCase()) },
    { kind: 'utf16le', bytes: le },
    { kind: 'utf16be', bytes: be },
  ];
  for (const core of base64Cores(utf8)) out.push({ kind: 'base64', bytes: Buffer.from(core) });
  return out;
}
