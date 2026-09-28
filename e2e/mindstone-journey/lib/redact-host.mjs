// Removes host details from the evidence before it's posted: paths (home,
// scratch, the checkout) and the user and host names. Then checks that none
// is left in any text-like file.
//
//   node redact-host.mjs <evidence-dir> <pairs-file>
//
// The pairs file holds one "<value>\t<replacement>" per line; longer values
// are replaced first, so /Users/me/x/y becomes <scratch> before /Users/me
// becomes ~. Exit 0: nothing left; 1: something is left (the files and the
// replacement label are listed, never the value).
import fs from 'node:fs';
import path from 'node:path';

const [evidence, pairsFile] = process.argv.slice(2);
const pairs = fs
  .readFileSync(pairsFile, 'utf8')
  .split('\n')
  .map((line) => line.split('\t'))
  .filter(([value, label]) => value && label && value.length >= 3)
  .sort((a, b) => b[0].length - a[0].length);

// Names (user, host) are matched as words; paths anywhere.
const matcher = ([value]) =>
  value.includes('/') ? value : new RegExp(`(?<![A-Za-z0-9_.-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g');

const TEXT = /\.(log|txt|md|json|tsv|env|yml|yaml|html|sh|jsonl|out)$/i;
const files = [];
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (TEXT.test(entry.name) || !entry.name.includes('.')) files.push(full);
  }
};
walk(evidence);

let replaced = 0;
const left = [];
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  const before = text;
  for (const pair of pairs) {
    const m = matcher(pair);
    const parts = typeof m === 'string' ? text.split(m) : null;
    if (parts) {
      replaced += parts.length - 1;
      text = parts.join(pair[1]);
    } else {
      text = text.replace(m, () => {
        replaced += 1;
        return pair[1];
      });
    }
  }
  if (text !== before) fs.writeFileSync(file, text);
  for (const pair of pairs) {
    const m = matcher(pair);
    if (typeof m === 'string' ? text.includes(m) : m.test(text)) left.push(`${path.relative(evidence, file)}: ${pair[1]}`);
  }
}
if (left.length) {
  console.log(`redact-host: ${replaced} replaced, but host details are left:`);
  for (const l of left) console.log(`  ${l}`);
  process.exit(1);
}
console.log(`redact-host: ${replaced} host paths/names replaced in ${files.length} files; none left`);
