// Provenance of the harness itself: a sha256 over its files, so a locally
// weakened spec or gate can't post a GATE: PASS under a clean commit.
//
//   node harness-hash.mjs <repo-root> <harness-dir-relative-to-root>
//
// Hashes every file git would track in the harness dir (tracked, plus
// untracked files that aren't ignored: evidence/ and .pw/ are ignored), as
// "<sha256 of file>  <path>" lines, sorted, then the sha256 of that listing.
// Outside a git checkout, every file under the dir except evidence/ and .pw/.
// Prints: "<sha256> <file count>".
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [root, dir] = process.argv.slice(2);
let files;
try {
  files = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '--', dir], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!['evidence', '.pw', 'node_modules'].includes(entry.name)) walk(rel);
      } else files.push(rel);
    }
  };
  walk(dir);
}
files.sort();
const listing = files
  .filter((f) => fs.existsSync(path.join(root, f)))
  .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')}  ${f}`)
  .join('\n');
console.log(`${crypto.createHash('sha256').update(listing).digest('hex')} ${files.length}`);
