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
// - vectorOf is the one rule both memory checks use (#140's contract: a chunk
//   records its model; with no record, its size decides);
// - memoryChangeVerdict passes an embedding change only when the Console
//   warned before Save (whenever the old model had embedded memories) and the
//   chats after the change answered, the new fact was embedded by the new
//   model, and recall scored no other model's chunk; a failed or empty chat,
//   another model's chunk scored by its vector, or nothing recalled with the
//   fact captured FAIL; a chunk found by its words (recallMode "lexical",
//   #140's design until the backfill re-embeds it) is never judged; the
//   check's index.otherModel must count the old memories, and the warning
//   (ms-onb-memory-reembed) must show that count; with no chunk of another
//   model in the snapshot, the cross-model rule is reported not exercised,
//   never passed (R3); the cold-model Test is finding F-MSA-147 (R2);
//   what couldn't be exercised is PENDING, never a pass;
// - restoredIndexReasons: after the restore, every chunk is the restored
//   model's, or records another model that recall under it left out;
// - end to end, a correct product (re-embedding, or recording and leaving
//   out) passes both checks, and the product without the fix fails both;
// - restoreOutcome: a dirty or unchecked index is a restore failure; and
//   journey.spec.ts marks the check before the memory Save, runs it in the
//   finally after putBack, and records it with recordRestoreFailure;
// - restore_failures (lib/gate.sh) lists every setting a step left changed;
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
const {
  SETUP_STEPS,
  CHANGE_STEPS,
  changeHref,
  j12Decision,
  parityReasons,
  isCloudModel,
  pickAlternateModel,
  modelMatchReasons,
  memoryChangeVerdict,
  restoredIndexReasons,
  restoreOutcome,
  vectorOf,
  otherModelCount,
  byVector,
  hitsAsScored,
  COLD_MODEL_FINDING,
  EMBEDDING_WARNING,
} = require('./settings-parity-evidence.js');
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
check(pickAlternateModel(['ollama/gemma4:31b-cloud', 'other/gemma4:31b'], 'x', 'gemma4:31b') === undefined, 'model pick: the preferred name matches a whole model name, never a part of one');
check(pickAlternateModel(['acme/gemma4:31b-cloud', 'ollama/gemma4:31b-cloud'], 'x', 'gemma4:31b-cloud') === 'ollama/gemma4:31b-cloud', "model pick: the probed Ollama model through Ollama, not the same name through another provider");
check(!isCloudModel('ollama/foo:cloudy') && !isCloudModel('ollama/cloud-model') && isCloudModel('ollama/x:cloud'), 'model pick: only a ":cloud" or "-cloud" tag at the end is cloud');

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
check(modelMatchReasons({ chosen: '', saved: '', answered: answered() }).some((r) => /no model was chosen/.test(r)), 'model match: no chosen model: fails, saying so');

// --- The embedding change and the restore: one rule (vectorOf), MindStone-Agent #140's contract ---
const NOMIC = { spec: 'ollama:nomic-embed-text', dims: 768, chunks: 40 };
const MXBAI = { spec: 'ollama:mxbai-embed-large', dims: 1024 };
const WARNING = '40 memories were embedded by another model; they are re-embedded before recall uses them.';
const idx = (byDims, pending = 0, unreadable = 0) => ({ present: true, byDims, pending, unreadable });
const v = (chunkId, dims, model = null) => ({ chunkId, dims, model });
// Chunks as a product with the #140 fix records them (tagged), and as one without a record (untagged).
const oldTagged = v('transcript:j9#0', 768, 'ollama:nomic-embed-text');
const newTagged = v('transcript:cat#0', 1024, 'ollama:mxbai-embed-large:latest');
const lex = (chunk) => ({ ...chunk, recallMode: 'lexical' });
const vec = (chunk) => ({ ...chunk, recallMode: 'embedding' });
const probeOf = (hits, patch = {}) => ({ error: false, text: 'Your cat is quince-x.', fact: [newTagged], hits, ...patch });
const CLEAN = { otherLeft: 0, waitedMs: 6_000 };
const mv = (patch) => memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: WARNING, index: idx({ 768: 40, 1024: 1 }), probe: probeOf([vec(newTagged)]), reembedded: CLEAN, ...patch });

// vectorOf, the rule itself.
check(vectorOf(oldTagged, NOMIC) === 'same' && vectorOf(oldTagged, MXBAI) === 'other' && vectorOf(newTagged, MXBAI) === 'same', 'rule: a model record decides (with or without provider prefix and :latest)');
check(vectorOf(v('x', 1024, 'nomic-embed-text'), NOMIC) === 'same', 'rule: the record wins over the size (a record says which model; size alone can mislead)');
check(vectorOf(v('x', 768), NOMIC) === 'same' && vectorOf(v('x', 1024), NOMIC) === 'other' && vectorOf(v('x', 384), NOMIC) === 'other', 'rule: with no record, the size decides (smaller and larger both other)');
check(vectorOf(v('x', null), NOMIC) === 'unknown' && vectorOf(v('x', -1), NOMIC) === 'unknown' && vectorOf(v('x', 768), { spec: NOMIC.spec }) === 'unknown', "rule: no record and no size, or the model's size unknown: can't be told");
// #140 at 452aa06: in an index that records specs, an embedded chunk with a NULL embedding_spec is another model's,
// even at the same size; one with no vector is unknown (it is embedded later).
const recNull = (chunkId, dims) => ({ chunkId, dims, model: null, recorded: true });
check(vectorOf(recNull('x', 768), NOMIC) === 'other' && vectorOf(recNull('x', -1), NOMIC) === 'other' && vectorOf(recNull('x', null), NOMIC) === 'unknown', 'rule: a NULL embedding_spec on an embedded chunk is another model (the same size too); no vector is unknown');
check(vectorOf({ ...oldTagged, recorded: true }, NOMIC) === 'same' && vectorOf(v('x', 768), NOMIC) === 'same', 'rule: a recorded spec decides; an index from before #140 (no column) falls back to size');
// The index-clean count: embedded chunks that aren't the model's.
check(otherModelCount([newTagged, oldTagged, recNull('n', 768), recNull('p', null), v('u', 1024)], MXBAI) === 2 && otherModelCount([newTagged], MXBAI) === 0, 'index-clean count: another spec and a NULL spec count, a chunk with no vector does not');

// Recall after the change.
check(mv({}).verdict === 'pass' && /warned before Save/.test(mv({}).why), 'change: warned, the new fact embedded and recalled by the new model, nothing from the old: pass');
const silent = mv({ warned: undefined, index: idx({ 768: 40 }) });
check(silent.verdict === 'fail' && /^PRODUCT BUG: /.test(silent.why) && silent.stale === 40 && /no warning before Save, though 40 memories were embedded by ollama:nomic-embed-text/.test(silent.why), `change: 768-dim vectors left behind for a 1024-dim model, no warning: FAIL as a product bug ("${silent.why.slice(0, 80)}…")`);
check(mv({ warned: undefined }).verdict === 'fail' && mv({ warned: undefined, after: { spec: 'ollama:other-768', dims: 768 }, index: idx({ 768: 41 }), probe: probeOf([v('c', 768, 'other-768')], { fact: [v('c', 768, 'other-768')] }) }).verdict === 'fail', 'change: no warning before Save fails, the same vector size too');
const errored = mv({ probe: probeOf([], { error: true, errorText: 'routing_error: embedding size mismatch', text: '' }) });
check(errored.verdict === 'fail' && /did not answer \(the Console stored an error: routing_error/.test(errored.why), 'change: a chat after the change stored an error: FAIL, even with no hits');
check(mv({ probe: probeOf([], { text: '  ' }) }).verdict === 'fail' && /an empty reply/.test(mv({ probe: probeOf([], { text: '  ' }) }).why), 'change: a chat after the change came back empty: FAIL');
const scoredOld = mv({ probe: probeOf([vec(newTagged), oldTagged]) });
check(scoredOld.verdict === 'fail' && /scored 1 chunk\(s\) by the vector of another model than ollama:mxbai-embed-large: transcript:j9#0 \(768 dims, ollama:nomic-embed-text\)/.test(scoredOld.why), 'change: recall scored J9\'s old-model chunk against the new model: FAIL');
check(mv({ probe: probeOf([vec(newTagged), vec(v('old', 768))]) }).verdict === 'fail' && mv({ probe: probeOf([vec(newTagged), vec(v('big', 1536))]) }).verdict === 'fail', 'change: untagged, another size (smaller or larger), by vector: FAIL');
check(mv({ probe: probeOf([vec(newTagged)], { fact: [v('cat', 768, 'nomic-embed-text')] }) }).verdict === 'fail', 'change: the new fact embedded by the old model: FAIL');
check(mv({ probe: probeOf([]) }).verdict === 'fail' && /did not find the new fact by the new model's vector.*\(nothing at all\)/.test(mv({ probe: probeOf([]) }).why), 'change: the fact captured but recall supplied nothing: FAIL (there was something to recall)');
// N2: the positive proof is the new fact itself, recalled by the new model's vector; any other hit is not enough.
check(mv({ probe: probeOf([lex(newTagged)]) }).verdict === 'fail', 'N2: the new fact found only by its words: FAIL (recall by the new vector not shown)');
check(mv({ probe: probeOf([vec(v('transcript:other#0', 1024, 'mxbai-embed-large'))]) }).verdict === 'fail', 'N2: another new-model chunk recalled by vector, but not the fact: FAIL');
check(mv({ probe: probeOf([vec(v('transcript:cat#0', 768, 'nomic-embed-text'))], { fact: [v('transcript:cat#0', 768, 'nomic-embed-text')] }) }).verdict === 'fail', "N2: the fact scored by the old model's vector: FAIL");
check(mv({ probe: probeOf([newTagged]) }).verdict === 'fail', 'N2: the fact recalled with no recallMode recorded: not shown to be by vector, FAIL');
check(mv({ probe: probeOf([], { fact: [] }) }).verdict === 'pending' && /not captured in time/.test(mv({ probe: probeOf([], { fact: [] }) }).why), 'change: nothing captured and nothing recalled: PENDING (genuinely nothing to recall)');
check(mv({ probe: probeOf([vec(newTagged), vec(v('gone', null))]) }).verdict === 'pending' && mv({ probe: probeOf([vec(newTagged), vec(v('bad', -1))]) }).verdict === 'pending', "change: a vector hit that can't be told apart (no vector, unreadable, no record): PENDING, not clean");
check(mv({ probe: probeOf([vec(newTagged), vec(v('gone', null)), vec(oldTagged)]) }).verdict === 'fail', 'change: another model\'s chunk still fails next to an unknown one');
check(mv({ before: { ...NOMIC, chunks: 0 }, index: idx({ 1024: 1 }) }).verdict === 'pending' && mv({ probe: undefined }).verdict === 'pending', 'change: nothing to warn about, or no chat (recall off): PENDING, never a vacuous pass');
// R3: the cross-model rule is exercised only when the snapshot held another model's chunks; otherwise J12 says so.
{
  const none = mv({ probe: probeOf([vec(newTagged)], { snapshotOther: 0 }) });
  check(
    none.verdict === 'pass' && none.notExercised.length === 1 && /cross-model recall not exercised.*smoke-memory-model-switch\.sh/.test(none.why) && !/none by another model's vector/.test(none.why),
    'R3: no chunk of another model in the snapshot: the cross-model rule is reported NOT EXERCISED (MindStone-Agent\'s smoke covers it), never as passed',
  );
  const some = mv({ probe: probeOf([vec(newTagged), lex(oldTagged)], { snapshotOther: 26 }) });
  check(some.verdict === 'pass' && some.notExercised.length === 0 && /none by another model's vector \(26 of another model's in the index then\)/.test(some.why), 'R3: 26 chunks of another model in the snapshot, none scored by vector: exercised, and passed');
  check(mv({ probe: probeOf([vec(newTagged), vec(oldTagged)], { snapshotOther: 0 }) }).verdict === 'fail', 'R3: a vector hit from another model still FAILs, whatever the snapshot count');
  check(mv({ probe: probeOf([vec(newTagged)], { snapshotOther: 0 }), warned: undefined }).verdict === 'fail', 'R3: not exercised never excuses another failure');
}
// R2: the cold-model Test is a product finding (MindStone-Agent #147), with its issue.
{
  const text = COLD_MODEL_FINDING.text('ollama:mxbai-embed-large', 'This operation was aborted');
  check(
    COLD_MODEL_FINDING.id === 'F-MSA-147' && /MindStone-Agent\/issues\/147/.test(COLD_MODEL_FINDING.issue) && /^MindStone-Agent #147: .*ollama:mxbai-embed-large.*"This operation was aborted".*issues\/147$/.test(text),
    'R2: the cold-model finding names #147, the model and what the Test said, and links the issue',
  );
  const spec = fs.readFileSync(path.join(HERE, '..', 'journey.spec.ts'), 'utf8');
  check(/recordFinding\(COLD_MODEL_FINDING\.id, COLD_MODEL_FINDING\.text\(/.test(spec) && /FINDING \$\{COLD_MODEL_FINDING\.id\}/.test(spec), "R2: J12 records it in findings.md (the summary's findings, SUMMARY.md) and its row's note, not only a note");
}

// The re-embed after the change (#140: the backfill after each owner turn re-embeds another model's chunks).
check(mv({ reembedded: { otherLeft: 12, waitedMs: 120_000 } }).verdict === 'fail' && /12 embedded chunk\(s\) were still another model's 120 s after/.test(mv({ reembedded: { otherLeft: 12, waitedMs: 120_000 } }).why), "change: another model's chunks left after the wait: FAIL (the backfill didn't re-embed them)");
check(mv({ reembedded: undefined }).verdict === 'pending', 'change: the index-clean count not read: PENDING, not a pass');
check(mv({ after: NOMIC }).verdict === 'fail' && mv({ after: { spec: MXBAI.spec } }).verdict === 'fail' && mv({ before: { dims: 768 } }).verdict === 'fail', 'change: no change, no dimension count, or no model before: fails');
for (const text of [WARNING, 'Changing the model re-indexes 40 memories.', 'Memories made with the previous model are incompatible.', '12 memories were embedded by a different embedding model.']) {
  check(EMBEDDING_WARNING.test(text), `warning words: "${text}" is a warning`);
}
for (const text of ['43 memories indexed.', 'Embedding works: 1024 dimensions.', 'Memory lets the agent remember what matters across chats.']) {
  check(!EMBEDDING_WARNING.test(text), `warning words: "${text}" is not a warning`);
}

// Found by words, not by vector (#140: another model's chunks are found by their words until the backfill re-embeds
// them): the recall event's recallMode decides, and a word hit is never judged.
check(byVector(vec(oldTagged)) && byVector(oldTagged) && !byVector(lex(oldTagged)), 'by vector: recallMode "embedding", or none recorded (never excused unseen); not "lexical"');
const wordHit = mv({ probe: probeOf([vec(newTagged), lex(oldTagged), lex(v('old2', 768))]) });
check(wordHit.verdict === 'pass' && /2 found by words \(not judged/.test(wordHit.why), `change: J9's old-model chunk found by its words after the change: by design, PASS ("${wordHit.why.slice(0, 60)}…")`);
check(mv({ probe: probeOf([vec(newTagged), vec(oldTagged)]) }).verdict === 'fail', "change: the same old-model chunk scored by its vector: FAIL");
check(mv({ probe: probeOf([vec(newTagged), lex(v('gone', null))]) }).verdict === 'pass', "change: a word hit whose vector can't be read now is not judged (nor unproven)");
// N1: judged as the index was when recall scored the chunks (the snapshot before the chat), not as the chat's own
// turn left it.
{
  const snapshot = [newTagged, oldTagged];
  const now = [newTagged, v('transcript:j9#0', 1024, 'ollama:mxbai-embed-large')];
  const hits = hitsAsScored({ modes: [['transcript:cat#0', 'embedding'], ['transcript:j9#0', 'embedding']], snapshot, now });
  check(hits[1].dims === 768 && hits[1].model === 'ollama:nomic-embed-text' && hits[1].recallMode === 'embedding', "N1: a chunk the chat's own turn re-embedded afterwards is judged as it was scored (the old model's)");
  check(mv({ probe: probeOf(hits) }).verdict === 'fail', 'N1: so scoring the old vector still FAILs, though the index now shows it re-embedded');
  const late = hitsAsScored({ modes: [['transcript:new#0', undefined]], snapshot, now: [v('transcript:new#0', 1024, 'mxbai-embed-large')] });
  check(late[0].model === 'mxbai-embed-large' && !('recallMode' in late[0]), "N1: a chunk the snapshot doesn't have is read as it is now, with no mode invented");
  check(hitsAsScored({ modes: [['gone', 'lexical']], snapshot: [], now: [] })[0].dims === null, 'N1: a chunk in neither reading: no vector');
}
// The memory check's own count (index.otherModel) and the warning that shows it (ms-onb-memory-reembed).
const REEMBED = '40 memories were embedded by another model. Once you save, they are embedded again with this one after your next chat; until then, recall finds them by their words.';
check(EMBEDDING_WARNING.test(REEMBED), "warning words: #140's own ms-onb-memory-reembed text is a warning");
check(mv({ warned: REEMBED, reported: 40 }).verdict === 'pass', 'change: the check reported 40 memories from another model and the warning shows 40: pass');
check(mv({ warned: REEMBED, reported: 0 }).verdict === 'fail' && /reported 0 memories embedded by another model/.test(mv({ warned: REEMBED, reported: 0 }).why), 'change: memories before the change but the check reports 0 from another model: FAIL');
check(mv({ warned: REEMBED, reported: 38 }).verdict === 'fail' && /the warning says 40, but the memory check reported 38/.test(mv({ warned: REEMBED, reported: 38 }).why), 'change: the warning shows another number than the check reported: FAIL');
check(mv({ warned: undefined, reported: 40 }).verdict === 'fail', 'change: the check reported them but the step showed no warning: FAIL');

// The index after the restore, by the same rule.
const R = { spec: NOMIC.spec, dims: 768, present: true };
const rr = (chunks, recalled) => restoredIndexReasons({ ...R, chunks, recalled });
check(rr([oldTagged, v('a', 768), v('p', null)], [oldTagged]).length === 0, 'restore: every chunk the restored model\'s (pending ones allowed), recall under it clean: usable');
check(rr([oldTagged, newTagged], [oldTagged]).length === 0, "restore: the new model's chunk left in the index but recorded as its own and left out by recall: usable (the leave-out product)");
check(rr([oldTagged, newTagged], undefined).some((r) => /no chat ran/.test(r)), "restore: another model's recorded chunk, but no chat under the restored model to show it's left out: not proven");
check(rr([oldTagged, newTagged], [oldTagged, newTagged]).some((r) => /scored 1 chunk\(s\) by the vector of another model/.test(r)), "restore: recall under the restored model scored the new model's chunk by its vector: a reason");
check(rr([oldTagged, newTagged], [vec(oldTagged), lex(newTagged)]).length === 0, "restore: the new model's chunk found by its words under the restored model: by design, usable");
check(rr([oldTagged, v('cat', 1024)], [oldTagged]).some((r) => /1 chunk\(s\) of another size with no model record/.test(r)), 'restore: an untagged chunk of another size (neither re-embedded nor recorded): a reason');
check(rr([v('a', 768), v('small', 384)], []).length === 1, 'restore: an untagged chunk smaller than the restored size is a reason too');
check(rr([v('a', 768), v('bad', -1)], []).some((r) => /unreadable/.test(r)), 'restore: an unreadable vector: a reason');
check(restoredIndexReasons({ spec: NOMIC.spec, dims: undefined, present: true, chunks: [], recalled: [] }).length === 1 && restoredIndexReasons({ ...R, present: false, chunks: [] }).length === 0, "restore: the restored size unknown is a reason; no index, nothing to check");

// End to end, the correct product (#140's contract): the change, the probe chats, the restore, then PASS both ways.
{
  const reembed = {
    change: memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: WARNING, index: idx({ 1024: 42 }), probe: probeOf([vec(v('transcript:cat#0', 1024)), vec(v('transcript:j9#0', 1024))], { fact: [v('transcript:cat#0', 1024)] }), reembedded: CLEAN }),
    restore: rr([v('transcript:cat#0', 768), v('transcript:j9#0', 768), v('transcript:new#0', 768)], [v('transcript:cat#0', 768)]),
  };
  check(reembed.change.verdict === 'pass' && reembed.restore.length === 0, 'end to end: a product that re-embeds (no model record): the change passes, the restored index is usable');
  const leaveOut = {
    change: memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: WARNING, index: idx({ 768: 40, 1024: 1 }), probe: probeOf([vec(newTagged)]), reembedded: CLEAN }),
    restore: rr([oldTagged, v('transcript:j9#1', 768, 'nomic-embed-text'), newTagged, v('transcript:asked#0', 1024, 'mxbai-embed-large')], [oldTagged]),
  };
  check(leaveOut.change.verdict === 'pass' && leaveOut.restore.length === 0, 'end to end: a product that records each chunk\'s model, leaves other models out and re-embeds them: the change passes, the restored index is usable');
  const leaveOutOnly = memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: WARNING, index: idx({ 768: 40, 1024: 1 }), probe: probeOf([vec(newTagged)]), reembedded: { otherLeft: 40, waitedMs: 120_000 } });
  check(leaveOutOnly.verdict === 'fail', "end to end: one that never re-embeds fails the change (#140's contract re-embeds after the next turn)");
  const broken = {
    change: memoryChangeVerdict({ before: NOMIC, after: MXBAI, warned: undefined, index: idx({ 768: 40, 1024: 1 }), probe: probeOf([v('transcript:cat#0', 1024), v('transcript:j9#0', 768)], { fact: [v('transcript:cat#0', 1024)] }) }),
    restore: rr([v('transcript:j9#0', 768), v('transcript:cat#0', 1024)], [v('transcript:cat#0', 1024)]),
  };
  check(broken.change.verdict === 'fail' && broken.restore.length > 0, 'end to end: the product without the fix fails both (silent change, old chunk scored; a mixed index after the restore)');
  // #140 as built (452aa06): embedding_spec on each chunk; after the change, old chunks are found by words and the next
  // turn's backfill re-embeds them; after the restore, the same the other way.
  const spec = (m) => `ollama:${m}`;
  const built = {
    change: memoryChangeVerdict({
      before: NOMIC,
      after: MXBAI,
      warned: REEMBED,
      reported: 40,
      index: idx({ 1024: 41 }),
      probe: probeOf([vec(v('transcript:cat#0', 1024, spec('mxbai-embed-large'))), lex(v('transcript:j9#0', 768, spec('nomic-embed-text')))], { fact: [v('transcript:cat#0', 1024, spec('mxbai-embed-large'))] }),
      reembedded: { otherLeft: 0, waitedMs: 9_000 },
    }),
    restore: rr(
      [v('transcript:j9#0', 768, spec('nomic-embed-text')), v('transcript:cat#0', 768, spec('nomic-embed-text')), v('transcript:asked#0', 1024, spec('mxbai-embed-large')), recNull('transcript:old#0', 768)],
      [lex(v('transcript:cat#0', 1024, spec('mxbai-embed-large'))), vec(v('transcript:j9#0', 768, spec('nomic-embed-text')))],
    ),
  };
  check(built.change.verdict === 'pass' && built.restore.length === 0, `end to end: #140 as built (a model record, old chunks found by words, the backfill re-embeds): the change passes, the restored index is usable${built.change.verdict === 'pass' ? '' : ` (${built.change.why})`}${built.restore.length ? ` (${built.restore.join('; ')})` : ''}`);
}

// restoreOutcome (A2): the index check is a restore failure, never a deferred J12 check.
const settingsOk = { ok: true, lines: ['routing.defaultModel put back'] };
check(restoreOutcome({ settings: settingsOk, index: { required: false, ran: false } }).ok, 'restore outcome: settings back, no embedding change: ok');
check(restoreOutcome({ settings: settingsOk, index: { required: true, ran: true, reasons: [] } }).ok, 'restore outcome: settings back, the index usable: ok');
const dirty = restoreOutcome({ settings: settingsOk, index: { required: true, ran: true, reasons: ['still holds 3 chunk(s) of another size'] } });
check(!dirty.ok && dirty.failures.join() === 'still holds 3 chunk(s) of another size', 'restore outcome: settings back but a dirty index: a restore FAILURE (recorded for the gate)');
const skipped = restoreOutcome({ settings: settingsOk, index: { required: true, ran: false, why: 'page closed' } });
check(!skipped.ok && /not checked after the restore \(page closed\)/.test(skipped.failures[0]), 'restore outcome: the index check required but it could not run: a restore failure, never skipped');
check(!restoreOutcome({ settings: { ok: false, lines: ['USER.md NOT as before'] }, index: { required: false, ran: false } }).ok, 'restore outcome: a setting not put back: a failure');

// A2 in journey.spec.ts itself: the check's marker is set before the memory Save, the check runs in the finally
// after putBack, and its reasons go to recordRestoreFailure, never to J12's deferred checks.
{
  const spec = fs.readFileSync(path.join(HERE, '..', 'journey.spec.ts'), 'utf8');
  const j12 = spec.slice(spec.indexOf("test('J12 "), spec.indexOf("test('J10 "));
  const marker = j12.indexOf('restoredModel = { spec: beforeSpec');
  const save = j12.indexOf("path: '/api/mindstone/admin/config/memory' }, () =>");
  const fin = j12.lastIndexOf('} finally {');
  const putBackAt = j12.indexOf("putBack(['model', 'memory', 'user'])", fin);
  const checkAt = j12.indexOf('checkRestoredIndex(model)', fin);
  const recordAt = j12.indexOf("recordRestoreFailure('J12'", fin);
  check(marker > 0 && save > 0 && marker < save, 'A2: the restore check is marked needed BEFORE the memory Save (no throw after the Save can skip it)');
  check(fin > 0 && putBackAt > fin && checkAt > putBackAt && recordAt > checkAt, 'A2: the index check runs in the finally, after putBack, and feeds recordRestoreFailure');
  check(!/deferred\.push\([^)]*restoredIndex|deferred\.push\(\.\.\.reasons\)/.test(j12), "A2: the index check's reasons never go to J12's deferred checks");
}

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
    check(queryRecallIndex(file, 'vectors', []).length === 5 && queryRecallIndex(file, 'vectors', []).every((r) => r.model === null), 'recall-index vectors: every chunk, and no model record when the index keeps none');
    const tagged = path.join(tmp, 'tagged.sqlite');
    const t = new DatabaseSync(tagged);
    // MindStone-Agent #140 (452aa06): memory_chunks.embedding_spec, "<provider id>:<model>".
    t.exec('CREATE TABLE memory_chunks (chunk_id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json TEXT, embedding_spec TEXT, metadata_json TEXT, updated_at TEXT NOT NULL)');
    t.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?, ?, ?, ?)').run('a', 'x', vec(768), 'ollama:nomic-embed-text', null, 't');
    t.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?, ?, ?, ?)').run('b', 'x', vec(1024), 'ollama:mxbai-embed-large', null, 't');
    t.prepare('INSERT INTO memory_chunks VALUES (?, ?, ?, ?, ?, ?)').run('c', 'x', vec(768), null, null, 't');
    t.close();
    const models = (file) => Object.fromEntries(queryRecallIndex(file, 'chunkdims', ['a', 'b', 'c']).map((r) => [r.chunk_id, [r.model, r.recorded]]));
    check(models(tagged).a[0] === 'ollama:nomic-embed-text' && models(tagged).b[0] === 'ollama:mxbai-embed-large' && models(tagged).a[1] === 1, "recall-index: #140's embedding_spec column is read as each chunk's model record");
    check(JSON.stringify(models(tagged).c) === '[null,1]' && JSON.stringify(models(file).a) === '[null,0]', 'recall-index: a NULL embedding_spec reads as recorded with no model; an index without the column records nothing');
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
const BASE = 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 J9 J13 X1 X2 X3 X4 X5';
check(out('gate_required_steps 0') === BASE && out('gate_required_steps 0 0 0') === BASE && out('gate_required_steps 1 1') === `${BASE} J10 J11`, 'gate.sh: without the J12 flag the required rows are unchanged (the 25, plus J10/J11 with their flags)');
check(out('gate_required_steps 0 0 1') === `${BASE} J12` && out('gate_required_steps 1 1 1') === `${BASE} J10 J11 J12`, 'gate.sh: UAT_EXPECT_SETTINGS_PARITY=1 adds J12, and nothing else');
check(!has(out('gate_required_steps 1 1 0'), 'J12'), "gate.sh: J10's and J11's flags don't bring J12 in");
check(out('gate_demo_steps') === 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J9 J13 X1 X2 X3 X4 X5', 'gate.sh: the DEMO SUBSET is unchanged (J1-J6, J9, J13 and S/C/X), never J12');
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
  // Two errors: J12's own through the helper (result.error, with the stack), then a hook's (no stack of its own).
  const twoErrors = report([
    ...passing,
    { ...j12('failed', []), tests: [{ results: [{ status: 'failed', errors: [at(SPEC, 225), at(SPEC, 141, 'afterEach boom')], error: { ...at(SPEC, 225), stack: `Error: x\n    at helper (/abs/e2e/mindstone-journey/${SPEC}:225:7)\n    at /abs/e2e/mindstone-journey/${SPEC}:1250:7` } }] }] },
    j10('passed'),
    j11('passed'),
  ]);
  check(!failuresOnlyIn(twoErrors, ['J12']).explained, "gate-rows: the first error's stack never excuses a second error at a hook's line");
  check(!failuresOnlyIn(all('failed', [at(SPEC, 1500)]), ['J12']).explained, "gate-rows: an error at the next test's own first line is not J12's");

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
  // A step that could not put back what it changed: listed for both verdicts, whatever its own row.
  const restores = path.join(dir, 'restore-failures.tsv');
  fs.writeFileSync(restores, 'J12\tUSER.md (none before J12) removed from the data dir: nothing removed\nJ10\tactive persona j10-b-x put back to none: NOT restored\n');
  check(
    out(`restore_failures "${restores}"`) === 'J12: USER.md (none before J12) removed from the data dir: nothing removed\nJ10: active persona j10-b-x put back to none: NOT restored' &&
      out(`restore_failures "${path.join(dir, 'none.tsv')}"`) === '' &&
      rc(`restore_failures "${path.join(dir, 'none.tsv')}"`) === 0,
    'gate.sh: restore_failures lists each step that left a setting changed, and nothing (exit 0) without the file',
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`settings parity self-test: ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
