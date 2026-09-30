// Offline self-test of J10's own pieces (the persona builder in the Console,
// MindStone-Agent #125) and of the gate wiring for its flag; no Console, no
// gateway. It requires that
// - j10Decision is PENDING only when the Personas page has no "Build a
//   persona" and UAT_EXPECT_PERSONA_BUILDER isn't set; FAIL with the flag; the
//   real test whenever the entry point is there;
// - on synthetic gateway transcript lines shaped like MindStone-Agent's
//   (parsed by the same sessionLines J9 uses), builtPersonaReasons proves the
//   built persona's reply only with: that persona in metadata.personaContext,
//   a memory_recall_injected event in the reply's own run with a hit from
//   `pkb:<persona>:<kb>:`, no other persona's private KB, and the token in no
//   other entry. A global `kb:` hit, another KB or persona's `pkb:`, an event in
//   another run or after the reply, a missing run id, and the wrong persona must
//   each fail with a reason;
// - isolationReasons (the negative control) fails when the built persona's
//   private KB is recalled under the control persona (in any of the chat's
//   recall events), when the built persona answered, or, before any chat held
//   the token, when the token is anywhere in the control chat; after one did,
//   the token alone is not a failure (shared transcripts), the private KB is;
// - skillsVerdict proves the restriction only with another skill installed,
//   the built persona listing and prompting exactly the picked skill, and the
//   control persona's prompt holding the others;
// - lib/gate.sh: J10 is a required row only with its flag, J11's flag doesn't
//   bring it in, the DEMO SUBSET is exactly what it was (never J10),
//   J10 is uncounted without its flag, and pw_explained_by and the stall filter
//   leave out J10 only where it is uncounted; gate-rows excuses J10's own
//   failure, not a hook's error charged to it.
// (J10's restore of the active persona, run in a finally, is decided by
// personaRestore, checked here too.)
// Run by run-journey.sh with X5.
//
//   node persona-builder.selftest.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { failuresOnlyIn } from './gate-rows.mjs';

const require = createRequire(import.meta.url);
const { j10Decision, personaTurnEvidence, builtPersonaReasons, isolationReasons, skillsVerdict, personaRestore, RECALL_EVENT } = require('./persona-builder-evidence.js');
const { sessionLines } = require('./recall-evidence.js');
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
const d = (createOffered, expectPersonaBuilder, listShown = true, gatewayRoutes = false) =>
  j10Decision({ createOffered, expectPersonaBuilder, listShown, gatewayRoutes }).verdict;
check(d(false, false) === 'pending', 'no "Build a persona", no UAT_EXPECT_PERSONA_BUILDER: PENDING');
check(d(false, false, false) === 'pending' && d(false, false, true, true) === 'pending', 'no "Build a persona" (the page unrendered, or the gateway already has the routes), no flag: PENDING');
check(d(false, true) === 'fail' && d(false, true, true, true) === 'fail', 'no "Build a persona" with UAT_EXPECT_PERSONA_BUILDER=1: FAIL');
check(d(true, false) === 'run' && d(true, true) === 'run' && d(true, false, false) === 'run', 'the entry point is there: the real test, with or without the flag (a broken flow is then a FAIL)');
check(/gateway already has/.test(j10Decision({ createOffered: false, expectPersonaBuilder: false, listShown: true, gatewayRoutes: true }).why), "PENDING's reason says when the gateway already has the routes (#142)");

// --- Synthetic transcripts ---
const A = 'j10-a-mabc';
const B = 'j10-b-mabc';
const KB = 'j10-facts-mabc';
const TOKEN = 'lumen-mabc123';
const CHAT = 'c10c10c1-0000-4000-8000-000000000010';
const OTHER = 'c10c10c1-0000-4000-8000-000000000099';
const key = (id) => `agent:default:console:${id}`;
const line = (o) => JSON.stringify(o);
const ask = 'What is the harbour lighthouse call sign? Answer with just the call sign.';
const user = (runId, text = ask, id = CHAT) => line({ sessionKey: key(id), role: 'user', text, runId });
const components = (personaId, patch = {}) => ({
  personaId,
  skills: ['journey-console-1'],
  skillsInPrompt: ['journey-console-1'],
  globalKnowledgebases: 'all',
  privateKnowledgebases: 'own',
  ...patch,
});
const reply = (runId, text, personaId, comps, id = CHAT) =>
  line({
    sessionKey: key(id),
    role: 'assistant',
    text,
    runId,
    metadata: {
      event: 'assistant_response',
      provider: 'pi-session',
      ...(personaId ? { personaContext: { injected: true, personaId, reason: 'config:personas.active', tokenEstimate: 40 } } : {}),
      ...(comps ? { personaComponents: comps } : {}),
    },
  });
const pkbHit = (persona = A, kb = KB) => ({ id: `pkb:${persona}:${kb}:harbour.md`, chunkId: `pkb:${persona}:${kb}:harbour.md#0`, title: `[Persona KB ${kb}] harbour`, score: 0.7, source: 'kb' });
const kbHit = { id: `kb:${KB}:harbour.md`, chunkId: `kb:${KB}:harbour.md#0`, title: 'global', score: 0.6, source: 'kb' };
const transcriptHit = { id: 'transcript:x', chunkId: 'chunk-x', title: 'chat', score: 0.4, source: key(OTHER) };
const recall = (runId, hits, id = CHAT) =>
  line({ sessionKey: key(id), role: 'event', runId, text: `Injected ${hits.length} recalled memory chunk(s) into prompt context.`, metadata: { event: RECALL_EVENT, query: ask, hitCount: hits.length, hits } });
const evidence = (lines) => personaTurnEvidence(sessionLines(lines.join('\n'), CHAT), TOKEN);

const builtCases = [
  { name: "proven: persona A answered, its pkb hit in the reply's run, the token only in the reply", lines: [user('r1'), recall('r1', [pkbHit()]), reply('r1', TOKEN, A, components(A))], ok: true },
  {
    name: 'proven among another chat, junk lines and a transcript hit',
    lines: ['not json', user('r0', `the call sign is ${TOKEN}`, OTHER), user('r1'), recall('r1', [transcriptHit, pkbHit()]), reply('r1', `It is ${TOKEN}.`, A, components(A))],
    ok: true,
  },
  { name: 'no recall event at all', lines: [user('r1'), reply('r1', TOKEN, A, components(A))], ok: false, reason: /no memory_recall_injected event/ },
  { name: 'only a global kb: hit (same KB id), no pkb:', lines: [user('r1'), recall('r1', [kbHit]), reply('r1', TOKEN, A, components(A))], ok: false, reason: /no hit from the private KB/ },
  { name: "a pkb: hit from another of A's KBs", lines: [user('r1'), recall('r1', [pkbHit(A, 'other-kb')]), reply('r1', TOKEN, A, components(A))], ok: false, reason: /no hit from the private KB/ },
  { name: "persona B's private KB recalled under A (with A's own hit too)", lines: [user('r1'), recall('r1', [pkbHit(), pkbHit(B)]), reply('r1', TOKEN, A, components(A))], ok: false, reason: /another persona's private KB/ },
  { name: 'the recall event is in an earlier run', lines: [user('r0'), recall('r0', [pkbHit()]), reply('r0', 'x', A), user('r1'), reply('r1', TOKEN, A, components(A))], ok: false, reason: /not in the reply's own turn/ },
  { name: 'the recall event comes after the reply', lines: [user('r1'), reply('r1', TOKEN, A, components(A)), recall('r1', [pkbHit()])], ok: false, reason: /not in the reply's own turn/ },
  { name: 'the reply has no run id', lines: [user('r1'), recall('r1', [pkbHit()]), reply(undefined, TOKEN, A, components(A))], ok: false, reason: /no run id/ },
  { name: 'persona B answered', lines: [user('r1'), recall('r1', [pkbHit()]), reply('r1', TOKEN, B, components(B))], ok: false, reason: /answered by persona j10-b-mabc, not j10-a-mabc/ },
  { name: 'no persona injected', lines: [user('r1'), recall('r1', [pkbHit()]), reply('r1', TOKEN, undefined, undefined)], ok: false, reason: /\(none injected\)/ },
  { name: 'the token is in the user message too', lines: [user('r1', `${ask} (hint: ${TOKEN})`), recall('r1', [pkbHit()]), reply('r1', TOKEN, A, components(A))], ok: false, reason: /entries other than the reply/ },
  { name: 'an empty conversation', lines: [], ok: false, reason: /no entries/ },
  { name: 'no assistant entry', lines: [user('r1'), recall('r1', [pkbHit()])], ok: false, reason: /no assistant entry/ },
];
for (const c of builtCases) {
  const reasons = builtPersonaReasons(evidence(c.lines), { personaId: A, kbId: KB });
  check(c.ok ? reasons.length === 0 : reasons.some((r) => c.reason.test(r)), `built persona: ${c.name}${c.ok ? '' : ` -> "${reasons.join('; ') || 'NO REASON'}"`}`);
}

// --- The isolation check (negative control) ---
const controlCases = [
  { name: 'holds: persona B answered, no recall hits, no token', lines: [user('r2'), reply('r2', "I don't know.", B, components(B, { skills: 'all', privateKnowledgebases: 'none' }))], ok: true },
  { name: 'holds: B recalled only a transcript chunk', lines: [user('r2'), recall('r2', [transcriptHit]), reply('r2', "I don't know.", B)], ok: true },
  { name: "BROKEN: A's private KB recalled under B", lines: [user('r2'), recall('r2', [pkbHit()]), reply('r2', "I don't know.", B)], ok: false, reason: /j10-a-mabc's private KB was recalled under j10-b-mabc/ },
  { name: "BROKEN: A's private KB recalled in an earlier turn of the control chat", lines: [user('r1', 'hi'), recall('r1', [pkbHit()]), reply('r1', 'hello', B), user('r2'), reply('r2', 'no idea', B)], ok: false, reason: /private KB was recalled/ },
  { name: 'BROKEN: the control was answered by A', lines: [user('r2'), reply('r2', "I don't know.", A, components(A))], ok: false, reason: /not the control persona/ },
  { name: 'BROKEN: the token in the control reply, before any chat held it', lines: [user('r2'), reply('r2', `It is ${TOKEN}.`, B)], ok: false, reason: /token is in the control conversation/ },
  { name: 'no reply in the control chat', lines: [user('r2')], ok: false, reason: /no reply/ },
];
for (const c of controlCases) {
  const reasons = isolationReasons(evidence(c.lines), { builtPersonaId: A, controlPersonaId: B });
  check(c.ok ? reasons.length === 0 : reasons.some((r) => c.reason.test(r)), `isolation: ${c.name}${c.ok ? '' : ` -> "${reasons.join('; ') || 'NO REASON'}"`}`);
}
const afterA = evidence([user('r3'), recall('r3', [transcriptHit]), reply('r3', `It is ${TOKEN}.`, B)]);
check(isolationReasons(afterA, { builtPersonaId: A, controlPersonaId: B, tokenMayLeak: true }).length === 0, 'isolation after a chat under A: the token through a transcript hit alone is not a failure');
const afterALeak = evidence([user('r3'), recall('r3', [transcriptHit, pkbHit()]), reply('r3', `It is ${TOKEN}.`, B)]);
check(isolationReasons(afterALeak, { builtPersonaId: A, controlPersonaId: B, tokenMayLeak: true }).some((r) => /private KB was recalled/.test(r)), "isolation after a chat under A: A's private KB under B still fails");

// --- Skills ---
const P = 'journey-console-1';
const Q = 'journey-chat-1';
const built = components(A);
const control = components(B, { skills: 'all', skillsInPrompt: [P, Q] });
const sv = (patch) => skillsVerdict({ picked: P, installed: [P, Q], built, control, ...patch });
check(sv({}).provable && sv({}).reasons.length === 0, 'skills: A lists and prompts only the picked skill, B (none listed) prompts both: proven');
check(sv({ built: components(A, { skills: 'all', skillsInPrompt: [P, Q] }) }).reasons.length === 2, 'skills: A listing none ("all") and prompting both fails, twice');
check(sv({ built: components(A, { skillsInPrompt: [P, Q] }) }).reasons.some((r) => /prompt held skills/.test(r)), "skills: the other skill in A's prompt fails");
check(sv({ built: components(A, { skillsInPrompt: undefined }) }).reasons.some((r) => /no skillsInPrompt/.test(r)), 'skills: no skillsInPrompt on the record fails');
check(sv({ built: undefined }).reasons.some((r) => /no metadata.personaComponents/.test(r)), 'skills: no personaComponents on A fails');
check(sv({ control: components(B, { skills: 'all', skillsInPrompt: [P] }) }).reasons.some((r) => /positive control/.test(r)), "skills: B's prompt missing the other skill fails the positive control");
check(sv({ control: components(B, { skills: [P] }) }).reasons.some((r) => /should list none/.test(r)), 'skills: a control persona that lists skills fails');
const one = skillsVerdict({ picked: P, installed: [P], built, control: undefined });
check(!one.provable && one.reasons.length === 0 && /only one skill is installed/.test(one.why), 'skills: with one installed skill the restriction is not provable (PENDING), not a pass');

// --- personaRestore: J10's finally puts the active persona back ---
const pr = (before, now, known = [A, B, 'journey-x']) => personaRestore({ before, now, known });
check(pr(null, null).action === 'none' && pr('journey-x', 'journey-x').action === 'none', 'restore: nothing to do when the active persona is what it was');
check(pr('journey-x', B).action === 'activate' && pr('journey-x', B).active === 'journey-x', 'restore: B left active mid-step, journey-x before: make journey-x active again');
check(pr(null, B).action === 'clear' && pr(null, B).active === null && pr(null, A).active === null, 'restore: A or B left active, none before: use no persona (active null)');
check(pr('journey-x', A, [A, B]).action === 'clear' && pr('journey-x', A, [A, B]).active === null, 'restore: the persona active before is no longer listed: use no persona, never a missing id');
check(pr('journey-x', null).action === 'activate', 'restore: no persona active now, journey-x before: make it active again');
check(pr(undefined, undefined).action === 'none', 'restore: an unknown "before" and "now" (none on both) needs nothing');

// --- lib/gate.sh: J10's flag ---
const sh = (script) => spawnSync('bash', ['-c', `set -Eeuo pipefail; source "${path.join(HERE, 'gate.sh')}"; ${script}`], { encoding: 'utf8' });
const out = (script) => sh(script).stdout.trim();
const rc = (script) => sh(script).status;
const has = (list, id) => ` ${list} `.includes(` ${id} `);
const BASE = 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 J9 J13 X1 X2 X3 X4 X5';
check(out('gate_required_steps 0') === BASE && out('gate_required_steps 0 0') === BASE && out('gate_required_steps 1') === `${BASE} J11`, 'gate.sh: without the J10 flag the required rows are the 25 (plus J11 with its own flag)');
check(out('gate_required_steps 0 1') === `${BASE} J10` && out('gate_required_steps 1 1') === `${BASE} J10 J11`, 'gate.sh: UAT_EXPECT_PERSONA_BUILDER=1 adds J10, and nothing else');
check(!has(out('gate_required_steps 1 0'), 'J10'), "gate.sh: J11's flag doesn't bring J10 in");
check(out('gate_demo_steps') === 'S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J9 J13 X1 X2 X3 X4 X5', 'gate.sh: the DEMO SUBSET is unchanged (J1-J6, J9, J13 and S/C/X), never J10');
check(has(out('echo "$GATE_DEMO_UNCOUNTED"'), 'J10') && has(out('echo "$GATE_OPTIONAL_STEPS"'), 'J10'), 'gate.sh: J10 is always a known row, and always uncounted by the demo');
// (J12's own flag is set here, so only J10's and J11's are judged; lib/settings-parity.selftest.mjs covers J12.)
check(out('gate_uncounted 0 0 1') === 'J10 J11' && out('gate_uncounted 1 0 1') === 'J10' && out('gate_uncounted 0 1 1') === 'J11' && out('gate_uncounted 1 1 1') === '', 'gate.sh: J10 is uncounted by the gate exactly when its flag is off');
check(out('gate_uncounted 0') === 'J10 J11 J12', 'gate.sh: the persona-builder flag (and every other) defaults to off');

// --- gate-rows and pw_explained_by with J10 ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-persona-builder-selftest-'));
try {
  const SPEC = 'journey.spec.ts';
  const spec = (title, line, status, errors = []) => ({ title, file: SPEC, line, ok: status === 'passed' || status === 'skipped', tests: [{ results: [{ status, errors }] }] });
  const at = (file, line, message = 'x') => ({ message, location: { file: `/abs/e2e/mindstone-journey/${file}`, line, column: 3 } });
  const report = (specs, errors = []) => ({ errors, suites: [{ specs: [], suites: [{ specs }] }] });
  const passing = [spec('J1 sign in', 200, 'passed'), spec('J9 recall', 990, 'passed')];
  const j10 = (status, errors) => spec('J10 persona builder', 1180, status, errors);
  const j11 = (status, errors) => spec('J11 enterprise', 1500, status, errors);
  check(failuresOnlyIn(report([...passing, j10('failed', [at(SPEC, 1300)]), j11('passed')]), ['J10', 'J11']).explained, "gate-rows: only J10 failed, on its own line, both uncounted: explained");
  check(failuresOnlyIn(report([...passing, j10('timedOut', [{ message: 'Test timeout' }]), j11('failed', [at(SPEC, 1600)])]), ['J10', 'J11']).explained, 'gate-rows: J10 timing out and J11 failing, both uncounted: explained');
  check(!failuresOnlyIn(report([...passing, j10('failed', [at(SPEC, 1300)]), j11('passed')]), ['J11']).explained, 'gate-rows: J10 failing with only J11 uncounted (the J10 flag on) is not explained');
  check(!failuresOnlyIn(report([...passing, j10('failed', [at(SPEC, 141, 'afterEach boom')]), j11('passed')]), ['J10', 'J11']).explained, "gate-rows: an afterEach error charged to J10 (at the hook's line) is not excused");
  check(!failuresOnlyIn(report([spec('J1 sign in', 200, 'failed', [at(SPEC, 210)]), j10('failed', [at(SPEC, 1300)])]), ['J10', 'J11']).explained, 'gate-rows: J1 failing as well as J10 is not explained');

  const results = path.join(dir, 'results.json');
  const glog = path.join(dir, 'gate-rows.log');
  fs.writeFileSync(results, JSON.stringify(report([...passing, j10('failed', [at(SPEC, 1300)]), j11('passed')])));
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $(gate_uncounted 0 0)`) === 0, 'gate.sh: without the J10 flag, exit 1 from J10 alone is excused');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $(gate_uncounted 0 1)`) === 1, 'gate.sh: with UAT_EXPECT_PERSONA_BUILDER=1, the same exit is not excused');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $GATE_DEMO_UNCOUNTED`) === 0, 'gate.sh: the DEMO SUBSET always excuses J10 alone');
  const stalls = path.join(dir, 'stalls.tsv');
  fs.writeFileSync(stalls, 'J4\tSTALL: GET /api/messages\nJ10\tSTALL: POST /api/mindstone/admin/personas no response in 30s (sent by the page)\n');
  check(out(`stalls_counted "${stalls}" $(gate_uncounted 1 0)`) === '1' && out(`stalls_counted "${stalls}" $(gate_uncounted 1 1)`) === '2' && out(`stalls_counted "${stalls}" $GATE_DEMO_UNCOUNTED`) === '1', 'gate.sh: a J10 stall counts against the gate only with its flag, never against the demo');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`persona builder self-test: ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
