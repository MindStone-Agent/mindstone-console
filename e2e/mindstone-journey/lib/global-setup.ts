/**
 * Refuses to run into an evidence dir that already holds a journey's state or
 * results: a stale journey-state.json or journey-results.tsv could make a step
 * pass on an earlier run's data. run-journey.sh gives every run a fresh dir.
 */
import fs from 'node:fs';
import path from 'node:path';

export default function globalSetup() {
  const evidence = process.env.UAT_EVIDENCE_DIR;
  if (!evidence) throw new Error('UAT_EVIDENCE_DIR is not set: give each run its own, empty evidence dir');
  const stale = ['journey-state.json', 'journey-results.tsv', 'journey-results.md', 'stalls.tsv', 'screens']
    .map((name) => path.join(evidence, name))
    .filter((file) => fs.existsSync(file) && !(fs.statSync(file).isDirectory() && fs.readdirSync(file).length === 0));
  if (stale.length) {
    throw new Error(`the evidence dir already holds a journey run (${stale.join(', ')}): use a new UAT_EVIDENCE_DIR`);
  }
}
