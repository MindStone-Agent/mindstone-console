// The secrets a run generated, read from their files. Shared by scrub.mjs and
// secret-check.mjs. Values never leave this process's memory.
//
// A source is a file (its whole trimmed content is one secret; a .env file
// contributes each KEY=value whose key looks secret) or a directory (each
// file in it, as above).
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /(KEY|IV|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
const MIN_LENGTH = 8;

function fromFile(file, secrets) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (path.basename(file) === '.env' || file.endsWith('.env')) {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && SECRET_KEY.test(m[1]) && m[2].trim().length >= MIN_LENGTH) secrets.add(m[2].trim());
    }
    return;
  }
  // Header files the harness writes for curl ("Name: value") hold a secret after the colon.
  const header = text.trim().match(/^[A-Za-z-]+:\s*(?:Bearer\s+)?(.+)$/);
  if (header && !text.trim().includes('\n')) {
    if (header[1].length >= MIN_LENGTH) secrets.add(header[1].trim());
    return;
  }
  const value = text.trim();
  if (value.length >= MIN_LENGTH && !value.includes('\n')) secrets.add(value);
}

export function collectSecrets(sources) {
  const secrets = new Set();
  for (const source of sources) {
    if (!source) continue;
    try {
      const stat = fs.statSync(source);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(source)) {
          const full = path.join(source, name);
          if (fs.statSync(full).isFile()) fromFile(full, secrets);
        }
      } else fromFile(source, secrets);
    } catch {
      // a source that doesn't exist has nothing in it
    }
  }
  return [...secrets];
}

/**
 * Every string the secret could appear as inside a larger file: itself, and
 * its base64 / base64url encodings at each of the three byte alignments (the
 * run of characters that encodes only the secret's own bytes).
 */
export function needles(secret) {
  const bytes = Buffer.from(secret, 'utf8');
  const out = new Set([secret]);
  for (let k = 0; k < 3; k += 1) {
    const encoded = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    const core = encoded.slice(start, end);
    if (core.length >= 12) {
      out.add(core);
      out.add(core.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return [...out];
}
