// Whether Playwright's non-zero exit is explained by steps a verdict doesn't
// count. The gate requires "Playwright exited 0", but a step outside a verdict
// (J11 when UAT_EXPECT_ENTERPRISE isn't set; J11 always, for the DEMO SUBSET)
// must not decide it through the exit code either. This reads Playwright's
// json report and answers: every failed test is one of <ids>, each failed only
// on its own errors, and there is no error outside a test (global setup, a
// worker crash).
//
// "Its own errors": Playwright charges an error in a hook to a test (an
// afterAll error goes to the worker's LAST test, which is J11; an afterEach
// error to each test). Such an error is located in the spec file, outside the
// test's own lines. So a failed test is excused only when none of its errors
// is located in its spec file outside [its line, the next test's line). An
// error in a helper file, or with no location (a timeout), is its own.
//
//   node gate-rows.mjs <results.json> [id ...]
//
// Exit 0: explained (the failures are all in <ids>); 1: not explained (a
// failure elsewhere, a top-level error, no failures at all to explain it, or
// an unreadable report); the reason on stdout. With no ids, nothing is
// explained. Shared with lib/enterprise.selftest.mjs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every test in a Playwright json report: { id (J<n> from its title), title, file, line, ok, errors: [{ file, line }] }. */
export function reportTests(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
      const failed = results.some((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted');
      const errors = results.flatMap((r) => r.errors ?? []).map((e) => ({ file: e.location?.file, line: e.location?.line }));
      out.push({ id: spec.title.match(/^(J\d+)\b/)?.[1] ?? '?', title: spec.title, file: spec.file, line: spec.line, ok: spec.ok !== false && !failed, errors });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

const sameFile = (located, specFile) => Boolean(located && specFile) && (located === specFile || located.endsWith(`/${specFile}`));

/** The errors of `test` located in its spec file outside its own lines (a hook's, or another test's). */
export function foreignErrors(test, all) {
  const next = all
    .filter((t) => t.file === test.file && t.line > test.line)
    .reduce((min, t) => Math.min(min, t.line), Infinity);
  return test.errors.filter((e) => sameFile(e.file, test.file) && typeof e.line === 'number' && (e.line < test.line || e.line >= next));
}

/** { explained, reason }: whether the report's failures all belong to `ids`. */
export function failuresOnlyIn(report, ids) {
  const allowed = new Set(ids);
  const errors = report.errors ?? [];
  if (errors.length) return { explained: false, reason: `${errors.length} error(s) outside any test` };
  const all = reportTests(report);
  const failed = all.filter((t) => !t.ok);
  if (!failed.length) return { explained: false, reason: 'no failed test in the report' };
  const others = failed.filter((t) => !allowed.has(t.id));
  if (others.length) return { explained: false, reason: `failed: ${others.map((t) => t.id).join(', ')}` };
  const hooked = failed.filter((t) => foreignErrors(t, all).length);
  if (hooked.length) {
    return {
      explained: false,
      reason: `${hooked.map((t) => `${t.id} has an error from outside its own lines (${foreignErrors(t, all).map((e) => `line ${e.line}`).join(', ')}: a hook's)`).join('; ')}`,
    };
  }
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
