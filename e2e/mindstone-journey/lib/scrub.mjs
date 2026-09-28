// Defence in depth after secret-check.mjs: replaces every generated secret in
// the evidence dir's text files with <redacted>. It can't see into binaries,
// zips or base64, which is why secret-check.mjs is the gate, not this.
//
//   node scrub.mjs <evidence-dir> <secret source>...
//
// Values are never printed; only counts are.
import fs from 'node:fs';
import path from 'node:path';
import { collectSecrets } from './secrets.mjs';

const [evidence, ...sources] = process.argv.slice(2);
const secrets = collectSecrets(sources);
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
console.log(`scrub: ${secrets.length} secrets, ${files} files checked, ${hits} occurrences redacted`);
