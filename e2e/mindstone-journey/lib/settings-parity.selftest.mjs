// Offline self-test of J12's own pieces (settings parity, MindStone-Agent
// #140) and of the gate wiring for its flag; no Console, no gateway. It
// requires that
// - j12Decision is PENDING only when Settings renders without "Your setup"
//   and UAT_EXPECT_SETTINGS_PARITY isn't set; FAIL with the flag, and FAIL
//   (never PENDING) when Settings itself didn't render; the real test whenever
//   the section is there;
// - parityReasons passes only a table with every setup step exactly once:
//   Provider, Model, Persona, Memory and Connectors each a Change link whose
//   href is exactly `/mindstone/onboarding?change=<step>&from=settings` (and,
//   once followed, that opened the step); Access and About you each their
//   control on Settings. A missing step, a wrong target, a link that opened
//   something else, a duplicate or an unknown row must each fail with a reason;
// - pickAlternateModel picks the cloud model the harness found answering
//   (UAT_ALT_MODEL) or, without one, another cloud model; never a local one,
//   never the current one, and nothing with UAT_ALT_MODEL=none;
// - modelMatchReasons (the model-match check) proves the chat used the model
//   chosen in Settings only when the saved route, the Settings row and the
//   Pi session's provider and model all agree, with no fallback;
// - memoryChangeVerdict passes an embedding change only when the Console
//   warned before Save (whenever the old model had embedded memories; the
//   same vector size is no excuse) and recall after the change scored no
//   chunk of another size; old vectors left behind with no warning FAIL as a
//   product bug; no change, or no dimension count, FAIL too;
// - the recall-index reader's `dims` mode (lib/recall-index.js, the child
//   process J12 reads the index with) counts chunks by vector size, pending
//   and unreadable ones apart, and `chunkdims` gives given chunks' sizes;
// - lib/gate.sh: J12 is a required row only with its flag (J10's and J11's
//   don't bring it in), the DEMO SUBSET is exactly what it was (never J12),
//   J12 is uncounted without its flag, and pw_explained_by and the stall
//   filter leave out J12 only where it is uncounted; gate-rows excuses J12's
//   own failure (a spec-file helper's error too, when its stack passes
//   through J12's lines), not a hook's error charged to it.
// Run by run-journey.sh with X5.
//
//   node settings-parity.selftest.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { failuresOnlyIn, stackLines } from './gate-rows.mjs';

const require = createRequire(import.meta.url);
const { SETUP_STEPS, CHANGE_STEPS, changeHref, j12Decision, parityReasons, pickAlternateModel, modelMatchReasons, memoryChangeVerdict } = require('./settings-parity-evidence.js');
const { queryRecallIndex } = require('./recall-index.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
function check(ok, what) {
  checks += 1;
  if (ok) console.log(`ok   ${what}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}`);
  }
}

// --- The PENDING logic ---
const d = (sectionPresent, expectParity, settingsShown = true, gatewayRoute = false) => j12Decision({ settingsShown, sectionPresent, expectParity, gatewayRoute }).verdict;
check(d(false, false) === 'pending' && d(false, false, true, true) === 'pending', 'no "Your setup", no UAT_EXPECT_SETTINGS_PARITY: PENDING (the gateway route or not)');
check(d(false, true) === 'fail' && d(false, true, true, true) === 'fail', 'no "Your setup" with UAT_EXPECT_SETTINGS_PARITY=1: FAIL');
check(d(false, false, false) === 'fail' && d(true, false, false) === 'fail', 'Settings did not render: FAIL, never PENDING (nothing could be looked for)');
check(d(true, false) === 'run' && d(true, true) === 'run', 'the section is there: the real test, with or without the flag (a broken section is then a FAIL)');
check(/already has GET \/admin\/user/.test(j12Decision({ settingsShown: true, sectionPresent: false, expectParity: false, gatewayRoute: true }).why), "PENDING's reason says when the gateway already has GET /admin/user");

// --- The parity table ---
const goodRows = () => [
  { step: 'Access', kind: 'in-place', control: true, shows: 'On.' },
  ...Object.entries(CHANGE_STEPS).map(([step, change]) => ({ step, kind: 'change', href: changeHref(change), opened: true })),
  { step: 'About you', kind: 'in-place', control: true },
];
const without = (step) => goodRows().filter((row) => row.step !== step);
const patched = (step, patch) => goodRows().map((row) => (row.step === step ? { ...row, ...patch } : row));
check(SETUP_STEPS.join(',') === 'Access,Provider,Model,Persona,Memory,Connectors,About you', 'the setup steps are the #102 flow less Finish');
check(parityReasons(goodRows()).length === 0, 'parity: every step has its equivalent (five Change links, Access and About you in place): no reason');
const tableCases = [
  { name: 'Access missing', rows: without('Access'), reason: /^Access: no Settings equivalent/ },
  { name: 'About you missing', rows: without('About you'), reason: /^About you: no Settings equivalent/ },
  { name: 'Connectors missing', rows: without('Connectors'), reason: /^Connectors: no Settings equivalent/ },
  { name: "the Model link goes to the persona step", rows: patched('Model', { href: changeHref('persona') }), reason: /^Model: the Change link goes to/ },
  { name: 'the Memory link comes back to another page (from=providers)', rows: patched('Memory', { href: '/mindstone/onboarding?change=memory&from=providers' }), reason: /^Memory: the Change link goes to/ },
  { name: 'the Persona link is the full setup (no change=)', rows: patched('Persona', { href: '/mindstone/onboarding' }), reason: /^Persona: the Change link goes to/ },
  { name: 'the Provider row has no link', rows: patched('Provider', { kind: 'none', href: undefined }), reason: /^Provider: expected a Change link/ },
  { name: 'the Model link opened something else', rows: patched('Model', { opened: false, openedWhy: 'the full setup' }), reason: /^Model: the Change link did not open just the model step \(the full setup\)/ },
  { name: 'Access without its control', rows: patched('Access', { control: false }), reason: /^Access: no control on Settings/ },
  { name: 'About you as a link, not the editor', rows: patched('About you', { kind: 'change', href: '/x' }), reason: /^About you: no control on Settings/ },
  { name: 'Model twice', rows: [...goodRows(), { step: 'Model', kind: 'change', href: changeHref('model') }], reason: /^Model: 2 rows/ },
  { name: 'a row for a step setup does not have', rows: [...goodRows(), { step: 'Finish', kind: 'in-place', control: true }], reason: /steps setup doesn't have: Finish/ },
  { name: 'no rows at all', rows: [], reason: /^Access: no Settings equivalent/ },
];
for (const c of tableCases) {
  const reasons = parityReasons(c.rows);
  check(reasons.some((r) => c.reason.test(r)), `parity: ${c.name} -> "${reasons.join('; ') || 'NO REASON'}"`);
}
check(parityReasons(without('Access')).length === 1, 'parity: one missing step is one reason, the rest still judged');

// --- The model pick ---
const offered = ['ollama/deepseek-v4.1-flash:cloud', 'ollama/gemma4:26b', 'ollama/deepseek-v4-pro:cloud', 'ollama/nomic-embed-text:latest', 'ollama/gemma4:31b-cloud', 'ollama/deepseek-v4-flash:cloud'];
check(pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud') === 'ollama/deepseek-v4-flash:cloud', 'model pick: another cloud model, the first by id');
check(pickAlternateModel(['ollama/a:cloud', 'ollama/gemma4:26b', 'ollama/b:latest'], 'ollama/a:cloud') === undefined, 'model pick: never a local model (it would load into a shared Ollama): none');
check(pickAlternateModel(['ollama/a:cloud', 'ollama/a:cloud'], 'ollama/a:cloud') === undefined && pickAlternateModel([], 'x') === undefined, 'model pick: only the current model (or nothing) offered: none');
check(pickAlternateModel(['ollama/gemma4:31b-cloud', 'ollama/a:cloud'], 'ollama/a:cloud') === 'ollama/gemma4:31b-cloud', 'model pick: a "-cloud" tag counts as cloud');
check(pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud', 'gemma4:31b-cloud') === 'ollama/gemma4:31b-cloud', 'model pick: the model the harness found answering (UAT_ALT_MODEL) wins over the first by id');
check(pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud', 'none') === undefined, 'model pick: UAT_ALT_MODEL=none (no other cloud model answered): none, never an unprobed one');
check(pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud', 'missing:cloud') === undefined && pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud', 'deepseek-v4.1-flash:cloud') === undefined, 'model pick: a preferred model the step does not offer, or the current one: none');
check(pickAlternateModel(offered, 'ollama/deepseek-v4.1-flash:cloud', 'gemma4:26b') === undefined, 'model pick: a preferred local model is still refused');

// --- The model-match check ---
const CHOSEN = 'ollama/deepseek-v4-flash:cloud';
const answered = (patch = {}) => ({ provider: 'ollama', model: 'deepseek-v4-flash:cloud', gatewayProvider: 'pi-session', gatewayModel: 'mindstone/default', ...patch });
const mm = (patch = {}) => modelMatchReasons({ chosen: CHOSEN, saved: CHOSEN, shown: `Default model ${CHOSEN} Change`, answered: answered(), ...patch });
check(mm().length === 0, 'model match: the saved route, the Settings row and the Pi session all name the chosen model: proven');
check(mm({ shown: undefined }).length === 0, 'model match: without a Settings reading, the route and the Pi session decide');
check(mm({ saved: 'ollama/deepseek-v4.1-flash:cloud' }).some((r) => /config.routing.defaultModel is "ollama\/deepseek-v4.1-flash:cloud", not the chosen/.test(r)), 'model match: the saved route is still the old model: fails');
check(mm({ shown: 'Default model ollama/deepseek-v4.1-flash:cloud' }).some((r) => /Default model row shows/.test(r)), 'model match: Settings still shows the old model: fails');
check(mm({ answered: answered({ model: 'deepseek-v4.1-flash:cloud' }) }).some((r) => /the Pi session called ollama\/deepseek-v4.1-flash:cloud, not/.test(r)), 'model match: the chat ran on the old model: fails');
check(mm({ answered: answered({ provider: 'ollama-cloud' }) }).some((r) => /the Pi session called ollama-cloud\//.test(r)), 'model match: the same model name through another provider: fails');
check(mm({ answered: answered({ modelFallbackMessage: 'fell back to x' }) }).some((r) => /fell back/.test(r)), 'model match: a model fallback in the Pi session: fails');
check(mm({ answered: undefined }).some((r) => /no assistant entry/.test(r)), 'model match: no transcript entry for the reply: fails');
check(modelMatchReasons({ chosen: 'openrouter/meta/llama-3:free', saved: 'openrouter/meta/llama-3:free', answered: { provider: 'openrouter', model: 'meta/llama-3:free' } }).length === 0, 'model match: a model id with a slash in it splits at the first slash only');
check(modelMatchReasons({ chosen: '', saved: '', answered: answered() }).length === 1, 'model match: no chosen model: fails');

// --- The embedding change ---
const NOMIC = { spec: 'ollama:nomic-embed-text', dims: 768, chunks: 40 };
const MXBAI = { spec: 'ollama:mxbai-embed-large', dims: 1024 };
const WARNING = '40 memories were embedded by another model; they are re-embedded before recall uses them.';
const idx = (byDims, pending = 0) => ({ present: true, byDims, pending, unreadable: 0 });
const mv = (patch) => memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: undefined, index: idx({ 768: 40 }), recallHits: undefined, ...patch });
const silent = mv({});
check(silent.verdict === 'fail' && /^PRODUCT BUG: /.test(silent.why) && silent.stale === 40 && /no warning before Save, though 40 memories were embedded by ollama:nomic-embed-text/.test(silent.why), `embedding change: 768-dim vectors left behind for a 1024-dim model, no warning: FAIL as a product bug ("${silent.why.slice(0, 90)}…")`);
check(mv({ index: idx({ 768: 40, 1024: 3 }, 2) }).verdict === 'fail' && mv({ index: idx({ 768: 40, 1024: 3 }, 2) }).stale === 40, 'embedding change: a mixed index (new vectors next to old ones), no warning: still the bug');
check(mv({ index: idx({ 1024: 43 }) }).verdict === 'fail' && !/PRODUCT BUG/.test(mv({ index: idx({ 1024: 43 }) }).why), 'embedding change: re-indexed but no warning before Save: fails (the Console must say so), not as stale vectors');
check(mv({ after: { spec: 'ollama:other-768', dims: 768 } }).verdict === 'fail', 'embedding change: the same vector size, memories from the old model, no warning: fails (size is no excuse)');
check(mv({ warned: WARNING }).verdict === 'pass' && /warned before Save/.test(mv({ warned: WARNING }).why), 'embedding change: the Console warned before Save, no recall after: pass');
check(mv({ warned: WARNING, recallHits: [{ chunkId: 'c1', dims: 1024 }, { chunkId: 'c2', dims: null }] }).verdict === 'pass', 'embedding change: warned, and recall after the change scored only new-size chunks (or ones since removed): pass');
const scoredOld = mv({ warned: WARNING, recallHits: [{ chunkId: 'transcript:j9#0', dims: 768 }, { chunkId: 'c1', dims: 1024 }] });
check(scoredOld.verdict === 'fail' && /recall after the change scored 1 chunk\(s\) embedded at another size.*transcript:j9#0 at 768/.test(scoredOld.why), 'embedding change: warned, but recall scored an old 768-dim chunk (the J9 fact) against the new model: fails');
check(mv({ before: { ...NOMIC, chunks: 0 }, index: idx({}) }).verdict === 'pass', 'embedding change: no memories embedded before the change: nothing to warn about, pass');
check(mv({ after: NOMIC }).verdict === 'fail' && /did not change/.test(mv({ after: NOMIC }).why), 'embedding change: the model did not change: fails');
check(mv({ after: { spec: MXBAI.spec } }).verdict === 'fail' && /no dimension count/.test(mv({ after: { spec: MXBAI.spec } }).why), "embedding change: the new model's Test gave no dimension count: fails");
check(mv({ before: { dims: 768 } }).verdict === 'fail', 'embedding change: an unknown model before the change: fails');

// --- The recall-index reader's dims mode (a child process, like J12's) ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-settings-parity-selftest-'));
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(tmp, 'memory.sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE memory_chunks (chunk_id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json TEXT, updated_at TEXT NOT NULL)');
    const insert = writer.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?, ?)');
    const vec = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => i / n));
    insert.run('a', 'x', vec(768), 't');
    insert.run('b', 'x', vec(768), 't');
    insert.run('c', 'x', vec(1024), 't');
    insert.run('d', 'x', null, 't');
    insert.run('e', 'x', 'not json', 't');
    const rows = queryRecallIndex(file, 'dims', []);
    const got = Object.fromEntries(rows.map((r) => [String(r.dims), r.n]));
    check(got['768'] === 2 && got['1024'] === 1 && got.null === 1 && got['-1'] === 1 && rows.length === 4, `recall-index dims (child process, WAL writer open): 2 at 768, 1 at 1024, 1 pending, 1 unreadable (${JSON.stringify(got)})`);
    const per = Object.fromEntries(queryRecallIndex(file, 'chunkdims', ['a', 'c', 'd', 'gone']).map((r) => [r.chunk_id, r.dims]));
    check(per.a === 768 && per.c === 1024 && per.d === null && !('gone' in per), `recall-index chunkdims: each given chunk's size, null when not embedded, nothing for a missing one (${JSON.stringify(per)})`);
  } finally {
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- lib/gate.sh: J12's flag ---
const sh = (script) => spawnSync('bash', ['-c', `set -Eeuo pipefail; source "${path.join(HERE, 'gate.sh')}"; ${script}`], { encoding: 'utf8' });
const out = (script) => sh(script).stdout.trim();
const rc = (script) => sh(script).status;
const has = (list, id) => ` ${list} `.includes(` ${id} `);
const BASE = 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 J9 X1 X2 X3 X4 X5';
check(out('gate_required_steps 0') === BASE && out('gate_required_steps 0 0 0') === BASE && out('gate_required_steps 1 1') === `${BASE} J10 J11`, 'gate.sh: without the J12 flag the required rows are unchanged (the 24, plus J10/J11 with their flags)');
check(out('gate_required_steps 0 0 1') === `${BASE} J12` && out('gate_required_steps 1 1 1') === `${BASE} J10 J11 J12`, 'gate.sh: UAT_EXPECT_SETTINGS_PARITY=1 adds J12, and nothing else');
check(!has(out('gate_required_steps 1 1 0'), 'J12'), "gate.sh: J10's and J11's flags don't bring J12 in");
check(out('gate_demo_steps') === 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J9 X1 X2 X3 X4 X5', 'gate.sh: the DEMO SUBSET is unchanged (J1-J6, J9 and S/C/X), never J12');
check(has(out('echo "$GATE_DEMO_UNCOUNTED"'), 'J12') && has(out('echo "$GATE_OPTIONAL_STEPS"'), 'J12'), 'gate.sh: J12 is always a known row, and always uncounted by the demo');
check(out('gate_uncounted 1 1 0') === 'J12' && out('gate_uncounted 1 1 1') === '' && out('gate_uncounted 0 0 1') === 'J10 J11' && out('gate_uncounted 1 1') === 'J12', 'gate.sh: J12 is uncounted by the gate exactly when its flag is off (the default)');

// --- gate-rows and pw_explained_by with J12 ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-settings-parity-gate-'));
try {
  const SPEC = 'journey.spec.ts';
  const spec = (title, line, status, errors = []) => ({ title, file: SPEC, line, ok: status === 'passed' || status === 'skipped', tests: [{ results: [{ status, errors }] }] });
  const at = (file, line, message = 'x') => ({ message, location: { file: `/abs/e2e/mindstone-journey/${file}`, line, column: 3 } });
  const report = (specs, errors = []) => ({ errors, suites: [{ specs: [], suites: [{ specs }] }] });
  const passing = [spec('J1 sign in', 200, 'passed'), spec('J9 recall', 1000, 'passed')];
  const j12 = (status, errors) => spec('J12 settings parity', 1200, status, errors);
  const j10 = (status, errors) => spec('J10 persona builder', 1500, status, errors);
  const j11 = (status, errors) => spec('J11 enterprise', 1800, status, errors);
  const all = (j12s, j12e, rest = [j10('passed'), j11('passed')]) => report([...passing, j12(j12s, j12e), ...rest]);
  check(failuresOnlyIn(all('failed', [at(SPEC, 1300)]), ['J10', 'J11', 'J12']).explained, 'gate-rows: only J12 failed, on its own lines, uncounted: explained');
  check(failuresOnlyIn(all('failed', [at('lib/journey.ts', 900)]), ['J12']).explained, "gate-rows: J12's error in a helper file is its own: explained");
  check(!failuresOnlyIn(all('failed', [at(SPEC, 1300)]), ['J10', 'J11']).explained, 'gate-rows: J12 failing with only J10 and J11 uncounted (the J12 flag on) is not explained');
  check(!failuresOnlyIn(all('failed', [at(SPEC, 141, 'afterEach boom')]), ['J12']).explained, "gate-rows: an afterEach error charged to J12 (at the hook's line) is not excused");
  check(!failuresOnlyIn(all('failed', [at(SPEC, 1600)]), ['J12']).explained, "gate-rows: an error located in J10's lines, charged to J12, is not excused");
  check(!failuresOnlyIn(report([spec('J1 sign in', 200, 'failed', [at(SPEC, 210)]), j12('failed', [at(SPEC, 1300)])]), ['J12']).explained, 'gate-rows: J1 failing as well as J12 is not explained');
  // A spec-file helper (expectAnswer, above the tests) is located at the helper; its stack (result.error) says who called it.
  const withStack = (status, location, frames) => ({
    ...j12(status, [at(SPEC, location)]),
    tests: [{ results: [{ status, errors: [at(SPEC, location)], error: { ...at(SPEC, location), stack: `Error: x\n${frames.map((f) => `    at ${f} (/abs/e2e/mindstone-journey/${SPEC}:${f === 'helper' ? location : f}:7)`).join('\n')}` } }] }],
  });
  const stacked = (status, location, frames) => report([...passing, withStack(status, location, frames), j10('passed'), j11('passed')]);
  check(stackLines('Error: x\n    at expectAnswer (/a/b/journey.spec.ts:225:60)\n    at /a/b/journey.spec.ts:1686:7\n    at /a/b/lib/journey.ts:305:21', SPEC).join(',') === '225,1686', 'gate-rows: stackLines reads the spec-file frames only');
  check(failuresOnlyIn(stacked('failed', 225, ['helper', 1250]), ['J12']).explained, "gate-rows: a spec-file helper's error (expectAnswer at line 225) called from J12's own lines is J12's own: explained");
  check(!failuresOnlyIn(stacked('failed', 141, ['helper', 142]), ['J12']).explained, "gate-rows: an afterEach error whose stack stays in the hook's lines is still not excused");
  check(!failuresOnlyIn(stacked('failed', 225, ['helper', 1600]), ['J12']).explained, "gate-rows: a helper's error called from J10's lines, charged to J12, is not excused");

  const results = path.join(dir, 'results.json');
  const glog = path.join(dir, 'gate-rows.log');
  fs.writeFileSync(results, JSON.stringify(all('failed', [at(SPEC, 1300)])));
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $(gate_uncounted 1 1 0)`) === 0, 'gate.sh: without the J12 flag, exit 1 from J12 alone is excused');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $(gate_uncounted 1 1 1)`) === 1, 'gate.sh: with UAT_EXPECT_SETTINGS_PARITY=1, the same exit is not excused');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $GATE_DEMO_UNCOUNTED`) === 0, 'gate.sh: the DEMO SUBSET always excuses J12 alone');
  const stalls = path.join(dir, 'stalls.tsv');
  fs.writeFileSync(stalls, 'J4\tSTALL: GET /api/messages\nJ12\tSTALL: PATCH /api/mindstone/admin/config/routing no response in 30s (sent by the page)\n');
  check(
    out(`stalls_counted "${stalls}" $(gate_uncounted 1 1 0)`) === '1' && out(`stalls_counted "${stalls}" $(gate_uncounted 1 1 1)`) === '2' && out(`stalls_counted "${stalls}" $GATE_DEMO_UNCOUNTED`) === '1',
    'gate.sh: a J12 stall counts against the gate only with its flag, never against the demo',
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`settings parity self-test: ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
