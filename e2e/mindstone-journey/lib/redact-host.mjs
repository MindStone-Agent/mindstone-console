// Removes host details from the evidence before it's posted: paths (home,
// scratch, the checkout) and the user and host names. Then checks that none
// is left in any text-like file.
//
//   node redact-host.mjs [--check] <evidence-dir> <pairs-file>
//
// The pairs file holds one "<value>\t<replacement>" per line (values of 3+
// characters). Every value is replaced as a plain substring, longest first,
// so /Users/me/x/y becomes <scratch> before /Users/me becomes ~, and a name
// inside a mangled path (like "-Users-me-") is caught too. The re-check is a
// plain substring scan of every value. With --check, nothing is changed: it
// only reports what's there. Exit 0: nothing left; 1: something is left (the
// files and the replacement label are listed, never the value).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const [evidence, pairsFile] = checkOnly ? args.slice(1) : args;
const pairs = fs
  .readFileSync(pairsFile, 'utf8')
  .split('\n')
  .map((line) => line.split('\t'))
  .filter(([value, label]) => value && label && value.length >= 3)
  .sort((a, b) => b[0].length - a[0].length);

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
  if (!checkOnly) {
    const before = text;
    for (const [value, label] of pairs) {
      const parts = text.split(value);
      replaced += parts.length - 1;
      text = parts.join(label);
    }
    if (text !== before) fs.writeFileSync(file, text);
  }
  for (const [value, label] of pairs) {
    if (text.includes(value)) left.push(`${path.relative(evidence, file)}: ${label}`);
  }
}
if (left.length) {
  console.log(`redact-host${checkOnly ? ' --check' : ''}: ${replaced} replaced, but host details are left in ${left.length} place(s):`);
  for (const l of left) console.log(`  ${l}`);
  process.exit(1);
}
console.log(`redact-host${checkOnly ? ' --check' : ''}: ${replaced} host paths/names replaced in ${files.length} files; none left`);
