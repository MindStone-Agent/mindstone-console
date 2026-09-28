// Whether Playwright's non-zero exit is explained by steps a verdict doesn't
// count. The gate requires "Playwright exited 0", but a step outside a verdict
// (J11 when UAT_EXPECT_ENTERPRISE isn't set; J11 always, for the DEMO SUBSET)
// must not decide it through the exit code either. This reads Playwright's
// json report and answers: every failed test is one of <ids>, and there is no
// error outside a test (global setup, a hook, a worker crash).
//
//   node gate-rows.mjs <results.json> [id ...]
//
// Exit 0: explained (the failures are all in <ids>); 1: not explained (a
// failure elsewhere, a top-level error, no failures at all to explain it, or
// an unreadable report); the reason on stdout. With no ids, nothing is
// explained. Shared with lib/enterprise.selftest.mjs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every test in a Playwright json report: { id (J<n> from its title), title, ok }. */
export function reportTests(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const failed = (spec.tests ?? []).some((t) => (t.results ?? []).some((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted'));
      out.push({ id: spec.title.match(/^(J\d+)\b/)?.[1] ?? '?', title: spec.title, ok: spec.ok !== false && !failed });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

/** { explained, reason }: whether the report's failures all belong to `ids`. */
export function failuresOnlyIn(report, ids) {
  const allowed = new Set(ids);
  const errors = report.errors ?? [];
  if (errors.length) return { explained: false, reason: `${errors.length} error(s) outside any test` };
  const failed = reportTests(report).filter((t) => !t.ok);
  if (!failed.length) return { explained: false, reason: 'no failed test in the report' };
  const others = failed.filter((t) => !allowed.has(t.id));
  if (others.length) return { explained: false, reason: `failed: ${others.map((t) => t.id).join(', ')}` };
  return { explained: true, reason: `only ${failed.map((t) => t.id).join(', ')} failed` };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [file, ...ids] = process.argv.slice(2);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.log(`the Playwright report can't be read: ${error.message}`);
    process.exit(1);
  }
  const { explained, reason } = failuresOnlyIn(report, ids);
  console.log(reason);
  process.exit(explained ? 0 : 1);
}
