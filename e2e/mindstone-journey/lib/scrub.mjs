// Removes every secret the harness generated from the evidence dir.
//
//   node scrub.mjs <evidence-dir> <secret source>...
//
// A secret source is a file (its whole trimmed content is a secret; a .env
// file contributes each KEY=value whose key looks secret) or a directory (each
// file in it, as above). Text files under the evidence dir get every secret
// replaced with <redacted>. Values are never printed; only counts are.
import fs from 'node:fs';
import path from 'node:path';

const [evidence, ...sources] = process.argv.slice(2);
const SECRET_KEY = /(KEY|IV|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
const secrets = new Set();

function addFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (path.basename(file) === '.env' || file.endsWith('.env')) {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && SECRET_KEY.test(m[1]) && m[2].trim().length >= 8) secrets.add(m[2].trim());
    }
    return;
  }
  const value = text.trim();
  if (value.length >= 8 && !value.includes('\n')) secrets.add(value);
}

for (const source of sources) {
  try {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source)) addFile(path.join(source, name));
    } else addFile(source);
  } catch {
    // a source that doesn't exist (yet) has nothing to scrub
  }
}

const TEXT = /\.(log|txt|md|json|tsv|env|yml|yaml|html|sh|jsonl)$/i;
let files = 0;
let hits = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (TEXT.test(entry.name) || !entry.name.includes('.')) {
      let text = fs.readFileSync(full, 'utf8');
      let changed = false;
      for (const secret of secrets) {
        if (text.includes(secret)) {
          hits += text.split(secret).length - 1;
          text = text.split(secret).join('<redacted>');
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(full, text);
      files += 1;
    }
  }
}
if (evidence && fs.existsSync(evidence)) walk(evidence);
console.log(`scrub: ${secrets.size} secrets, ${files} files checked, ${hits} occurrences redacted`);
