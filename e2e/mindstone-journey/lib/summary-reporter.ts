/**
 * Turns each journey test into one PASS / FAIL / PENDING / MOCK / SKIPPED
 * line with its evidence, for run-journey.sh's summary (journey-results.tsv)
 * and for people (journey-results.md). PENDING is a test.fixme(): a step
 * whose feature hasn't landed; its annotation says what "done" looks like.
 * MOCK is a step that passed against the gateway's mock route (no real model);
 * the gate counts it, like PENDING and SKIPPED, as not passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

type Row = { id: string; status: string; title: string; evidence: string; note: string };

function evidenceDir(): string {
  return process.env.UAT_EVIDENCE_DIR ?? path.resolve(__dirname, '..', 'evidence', 'manual');
}

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
    const note: string[] = [];
    if (status === 'PENDING' && fixme?.description) note.push(fixme.description);
    if (status === 'FAIL' && result.error?.message) note.push(`error: ${oneLine(result.error.message, 300)}`);
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
      note: oneLine(note.join(' | '), 900),
    });
  }

  onEnd(_result: FullResult) {
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
