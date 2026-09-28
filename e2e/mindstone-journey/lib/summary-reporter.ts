/**
 * Turns each journey test into one PASS / FAIL / PENDING / MOCK / SKIPPED
 * line with its evidence, for run-journey.sh's summary (journey-results.tsv)
 * and for people (journey-results.md). PENDING is a test.fixme(): a step
 * whose feature hasn't landed; its annotation says what "done" looks like.
 * MOCK is a step that passed against the gateway's mock route (no real model);
 * the gate counts it, like PENDING and SKIPPED, as not passed.
 * A step with a `stall` annotation (lib/journey.ts recordStall: a request or
 * page load that never answered) is FAIL whatever else happened, with the
 * stall in its note: an environment stall is never a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

type Row = { id: string; status: string; title: string; evidence: string; note: string };

function evidenceDir(): string {
  return process.env.UAT_EVIDENCE_DIR ?? path.resolve(__dirname, '..', 'evidence', 'manual');
}

/** One line (tabs and newlines would break the TSV), never truncated: a cut error hides what failed. */
function oneLine(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
}

export default class SummaryReporter implements Reporter {
  private rows: Row[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    const match = test.title.match(/^(J\d+)\s+(.*)$/);
    const id = match?.[1] ?? 'J?';
    const title = match?.[2] ?? test.title;
    const notes = test.annotations.filter((a) => a.type === 'note').map((a) => a.description ?? '');
    const label = test.annotations.find((a) => a.type === 'label')?.description;
    const fixme = test.annotations.find((a) => a.type === 'fixme');
    const mock = test.annotations.some((a) => a.type === 'mock');
    let status: string;
    if (result.status === 'passed') status = mock ? 'MOCK' : 'PASS';
    else if (result.status === 'skipped' && fixme) status = 'PENDING';
    else if (result.status === 'skipped') status = 'SKIPPED';
    else status = 'FAIL';
    const stalls = [...new Set(test.annotations.filter((a) => a.type === 'stall').map((a) => oneLine(a.description ?? '')))];
    const error = result.error?.message ? oneLine(result.error.message) : '';
    const note: string[] = [];
    if (stalls.length && status !== 'FAIL') note.push(`FAIL on a stall (the step was ${status})`);
    if (stalls.length) status = 'FAIL';
    if (status === 'PENDING' && fixme?.description) note.push(fixme.description);
    if (status === 'FAIL' && error) note.push(`error: ${error}`);
    // Every stall, unless the error already says it.
    note.push(...stalls.filter((s) => !error.includes(s)));
    note.push(...notes);
    // The copies in evidence/screens and evidence/logs (Playwright's own copies have hashed names).
    const files = [
      ...new Set(test.annotations.filter((a) => a.type === 'evidence').map((a) => a.description ?? '')),
    ].filter(Boolean);
    this.rows.push({
      id,
      status,
      title: label ? `${title} [${label}]` : title,
      evidence: files.join(', '),
      note: oneLine(note.join(' | ')),
    });
  }

  onEnd(_result: FullResult) {
    // No test ran (for example, global setup refused a stale evidence dir):
    // write nothing, so an earlier run's results are never replaced by an empty file.
    if (this.rows.length === 0) return;
    const dir = evidenceDir();
    fs.mkdirSync(dir, { recursive: true });
    const clean = (s: string) => s.replace(/[\t\n]/g, ' ');
    fs.writeFileSync(
      path.join(dir, 'journey-results.tsv'),
      this.rows
        .map((r) => [r.id, r.status, r.title, r.evidence, r.note].map(clean).join('\t'))
        .join('\n') + (this.rows.length ? '\n' : ''),
    );
    const md = [
      '| Status | ID | Step | Evidence | Note |',
      '|---|---|---|---|---|',
      ...this.rows.map(
        (r) => `| ${r.status} | ${r.id} | ${r.title} | ${r.evidence} | ${r.note.replace(/\|/g, '\\|')} |`,
      ),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'journey-results.md'), `${md}\n`);
  }

  printsToStdio() {
    return false;
  }
}
