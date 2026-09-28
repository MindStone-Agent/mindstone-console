// Sets KEY=<value> in a .env file, with the value read from a file, so a
// secret never appears on a command line (the README's `sed "s|…$(cat …)|"`
// puts it in sed's argv, visible to `ps`).
//
//   node env-set.mjs <env-file> <KEY> <value-file>
//
// Replaces the first `KEY=` line (appends one if there's none) and keeps the
// file's mode. Prints only the key.
import fs from 'node:fs';

const [envFile, key, valueFile] = process.argv.slice(2);
if (!envFile || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key ?? '') || !valueFile) {
  console.error('usage: env-set.mjs <env-file> <KEY> <value-file>');
  process.exit(2);
}
const value = fs.readFileSync(valueFile, 'utf8').trim();
if (!value || /[\r\n]/.test(value)) {
  console.error(`env-set: the value for ${key} is empty or spans lines`);
  process.exit(1);
}
const mode = fs.statSync(envFile).mode & 0o777;
const lines = fs.readFileSync(envFile, 'utf8').split('\n');
const at = lines.findIndex((line) => line.startsWith(`${key}=`));
if (at === -1) lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
else lines[at] = `${key}=${value}`;
fs.writeFileSync(envFile, lines.join('\n'), { mode });
fs.chmodSync(envFile, mode);
console.log(`env-set: ${key} set`);
