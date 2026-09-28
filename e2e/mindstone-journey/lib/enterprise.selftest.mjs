// Offline self-test of J11's own pieces (enterprise endpoint, MindStone-Agent
// #126) and of the gate wiring that keeps J11 out of the verdicts that don't
// count it; no Console, no gateway. It requires that
// - the stub Azure endpoint (lib/azure-stub.mjs) answers only the run's key in
//   the api-key header: a missing key, a wrong key, and the right key in the
//   wrong header (Authorization: Bearer) all get 401 and no token;
// - with the key, POST …/responses?api-version=v1 streams the Responses API
//   (response.created … output_text deltas … response.completed) whose text
//   holds the run's token and the request's number, and echoes a
//   [nonce:<value>] marker's value (letters, digits, dashes only); stream:
//   false gets the JSON response; another path gets 404; health needs no key;
// - its request log records every request, with the key, the watched
//   credentials and the Authorization value in no form (plain, hex, base64),
//   and flags a watched credential or the key anywhere but the api-key header:
//   another header, the body, and the URL's query (percent-encoded too);
// - the stub refuses to start (exit 1, no value printed) when a watched
//   credential file can't be read, or a watched value is too short;
// - stubProof / stubLeaks (lib/enterprise-evidence.js) prove only an
//   authenticated, streamed request at the expected path and api-version after
//   the step's action (with the chat's nonce, and the request number the reply
//   shows, when given), and fail on a leak;
// - j11Decision is PENDING only when neither the Azure choice nor its form is
//   there, the gateway lists no azure-openai kind, and UAT_EXPECT_ENTERPRISE
//   isn't set; otherwise FAIL (or the real test, with the form);
// - J7's link rule (expectedStatusLinks) requires "Model providers" right
//   after Skills with the flag, accepts it there (only) without it, and keeps
//   every other link strict;
// - gate-rows (lib/gate-rows.mjs) excuses Playwright's exit only when every
//   failed test is an excused step failed on its own errors: not J1 timing out
//   too, not an error from a hook (afterAll / afterEach) charged to J11;
// - lib/gate.sh (what run-journey.sh sources): the required rows (J11 only
//   with the flag), the demo rows (never J11, J7 or J8), the uncounted steps,
//   pw_explained_by and the stall filter.
// The stub listens on 127.0.0.1, on the first free port in UAT_PORT_MIN to
// UAT_PORT_MAX (default 26900 to 26949). Run by run-journey.sh with X5.
//
//   node enterprise.selftest.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startAzureStub, replyText } from './azure-stub.mjs';
import { failuresOnlyIn } from './gate-rows.mjs';

const require = createRequire(import.meta.url);
const { j11Decision, readStubLog, stubProof, stubLeaks, expectedStatusLinks, RESPONSES_PATH, API_VERSION } = require('./enterprise-evidence.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

setTimeout(() => {
  console.log('enterprise self-test: hung (over 30 s)');
  process.exit(1);
}, 30_000).unref();

const PORT_MIN = Number(process.env.UAT_PORT_MIN ?? 26900);
const PORT_MAX = Math.min(Number(process.env.UAT_PORT_MAX ?? 26949), PORT_MIN + 49);
if (!(PORT_MIN > 0 && PORT_MAX >= PORT_MIN) || (PORT_MIN <= 18999 && PORT_MAX >= 18000)) {
  console.log(`enterprise self-test: bad port range ${PORT_MIN}-${PORT_MAX}`);
  process.exit(2);
}

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-enterprise-selftest-'));
const log = path.join(dir, 'requests.jsonl');
// Synthetic values only, generated here.
const rand = () => Math.random().toString(16).slice(2, 12).padEnd(10, '7');
const KEY = `uat-fake-azure-key-${rand()}${rand()}`;
const GATEWAY_TOKEN = `gwtoken${rand()}${rand()}`;
const TOKEN = `quartz-heron-${rand()}`;
const FORBIDDEN = [{ value: GATEWAY_TOKEN, label: '<forbidden credential 1>' }];

async function startOnFreePort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    try {
      return await startAzureStub({ port, key: KEY, token: TOKEN, log, forbidden: FORBIDDEN, deltaDelayMs: 1 });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`);
}

/** Parses an SSE body into its data objects. */
function sseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
}
const deltasOf = (text) => sseEvents(text).filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');

const stub = await startOnFreePort();
const base = `${stub.url}/openai/v1`;
const userInput = (text) => [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'input_text', text }] }];
const body = (extra = {}) => JSON.stringify({ model: 'uat-gpt-4o', stream: true, input: userInput('hello nonce-123'), ...extra });
const post = (url, headers, payload = body()) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
const responsesUrl = `${base}/responses?api-version=${API_VERSION}`;

try {
  const t0 = Date.now() - 1;

  // --- The stub: auth (requests #1-#3) ---
  for (const [what, headers] of [
    ['no key', {}],
    ['a wrong key', { 'api-key': `${KEY}x` }],
    ['the key as Authorization: Bearer (the wrong header)', { authorization: `Bearer ${KEY}` }],
  ]) {
    const response = await post(responsesUrl, headers);
    const text = await response.text();
    check(response.status === 401 && !text.includes(TOKEN), `${what}: 401, and no token in the answer`);
  }

  // --- #4: the right key; the Responses API stream, with the token and the request number ---
  const good = await post(responsesUrl, { 'api-key': KEY });
  const goodText = await good.text();
  const types = sseEvents(goodText).map((e) => e.type);
  check(good.status === 200 && (good.headers.get('content-type') ?? '').startsWith('text/event-stream'), 'the key in api-key: 200 text/event-stream');
  check(types[0] === 'response.created' && types[types.length - 1] === 'response.completed' && types.includes('response.output_item.done'), `the stream runs response.created … response.completed (${types.length} events)`);
  check(deltasOf(goodText) === replyText(TOKEN, 4) && deltasOf(goodText).includes(`${TOKEN} (request #4)`), `the text deltas spell "${replyText(TOKEN, 4)}" (the token and its request number)`);
  check(/^event: response\.created\ndata: /.test(goodText), 'each event has its event: line, like the real API');

  // --- #5: stream: false ---
  const json = await post(responsesUrl, { 'api-key': KEY }, body({ stream: false }));
  const parsed = await json.json();
  check(json.status === 200 && parsed.object === 'response' && JSON.stringify(parsed).includes(TOKEN), 'stream: false: the JSON response, with the token');

  // --- #6, #7: other paths, and health ---
  const other = await post(`${base}/chat/completions?api-version=${API_VERSION}`, { 'api-key': KEY });
  check(other.status === 404, 'another path with the key: 404');
  const health = await fetch(`${stub.url}/__stub/health`);
  check(health.status === 200, 'health answers without a key');

  // --- #8, #9: the nonce is echoed, and only a safe one ---
  const withNonce = await (await post(responsesUrl, { 'api-key': KEY }, body({ input: userInput('check [nonce:ent-abc123]: reply') }))).text();
  check(deltasOf(withNonce) === replyText(TOKEN, 8, 'ent-abc123') && deltasOf(withNonce).includes('(request #8, nonce ent-abc123)'), 'a [nonce:…] marker is echoed with the request number');
  const unsafe = await (await post(responsesUrl, { 'api-key': KEY }, body({ input: userInput('[nonce:<b>x</b>]') }))).text();
  check(deltasOf(unsafe) === replyText(TOKEN, 9) && !deltasOf(unsafe).includes('<b>'), 'a marker with other characters is not echoed');

  const cleanCount = 9;

  // --- #10-#13: leaks ---
  await post(responsesUrl, { 'api-key': KEY, 'x-extra': GATEWAY_TOKEN }); // #10 a watched credential in a header
  await post(responsesUrl, { 'api-key': KEY }, body({ input: `please use ${KEY}` })); // #11 the key in the body
  await post(`${responsesUrl}&api-key=${KEY}&t=${GATEWAY_TOKEN}`, { 'api-key': KEY }); // #12 both in the query
  const encoded = [...KEY].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  await post(`${responsesUrl}&k=${encoded}`, { 'api-key': KEY }); // #13 the key, percent-encoded, in the query

  // --- The log ---
  const raw = fs.readFileSync(log, 'utf8');
  const { entries } = readStubLog(log);
  const byN = (n) => entries.find((e) => e.n === n);
  check(entries.length === 13, `every request is logged (${entries.length} of 13)`);
  const forms = (v) => [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64').slice(0, 16), encoded];
  check(![KEY, GATEWAY_TOKEN].flatMap(forms).some((form) => raw.includes(form)), 'the log holds neither the key nor the watched credential, in any form');
  check(byN(3).headers.authorization === `<redacted, ${`Bearer ${KEY}`.length} chars>`, 'an Authorization header is logged as its length only');
  check([1, 2, 3].map((n) => byN(n).auth).join(',') === 'missing,wrong,missing', 'auth is recorded as missing / wrong / missing');
  check(byN(4).auth === 'ok' && byN(4).headers['api-key'] === '<ok>' && byN(4).body.lastUserText === 'hello nonce-123' && byN(4).body.stream === true, 'the good request: key ok, the last user text and stream recorded');
  check(byN(3).keyOutsideApiKeyHeader === true, 'the key in the Authorization header is flagged as outside api-key');
  check(byN(10).forbiddenCredentialSeen[0] === '<forbidden credential 1>' && !byN(10).keyOutsideApiKeyHeader, 'a watched credential in a header is flagged (as its label)');
  check(byN(11).keyOutsideApiKeyHeader === true && byN(11).body.lastUserText.includes('<the run key>'), 'the key in the body is flagged and replaced');
  check(byN(12).keyOutsideApiKeyHeader === true && byN(12).forbiddenCredentialSeen.length === 1 && byN(12).queryNames.includes('t'), 'the key and a watched credential in the URL query are both flagged');
  check(byN(13).keyOutsideApiKeyHeader === true, 'the key percent-encoded in the query is flagged');

  // --- stubProof / stubLeaks ---
  const clean = entries.filter((e) => e.n <= cleanCount && e.n !== 3); // no leak: without the Bearer request
  check(stubLeaks(clean).length === 0, 'stubLeaks: nothing in a clean log');
  check(stubProof(clean, { sinceMs: t0 }).reasons.length === 0, 'stubProof: the authenticated streamed request proves the call');
  check(stubProof(clean, { sinceMs: t0, nonce: 'nonce-123' }).reasons.length === 0, "stubProof: with the chat's nonce, too");
  check(stubProof(clean, { sinceMs: t0, nonce: 'ent-abc123', requestN: 8 }).reasons.length === 0, 'stubProof: with the request number the reply shows');
  check(stubProof(clean, { sinceMs: t0, nonce: 'ent-abc123', requestN: 4 }).reasons.length === 1, 'stubProof: a request number that is not the nonce request is not proof');
  check(stubProof(clean, { sinceMs: t0, nonce: 'nonce-999' }).reasons.length === 1, 'stubProof: another nonce is not proof');
  check(stubProof(clean, { sinceMs: Date.now() + 60_000 }).reasons.length === 1, 'stubProof: a request before the step began is not proof');
  check(stubProof(clean.filter((e) => e.n <= 2), { sinceMs: t0 }).reasons.length === 1, 'stubProof: only unauthenticated requests are not proof');
  check(stubProof(clean.filter((e) => e.body?.stream !== true || e.auth !== 'ok'), { sinceMs: t0 }).reasons.length === 1, 'stubProof: the JSON (not streamed) answer alone is not proof');
  check(stubProof(clean, { sinceMs: t0, path: `/openai/deployments/x${RESPONSES_PATH}` }).reasons.length === 1, 'stubProof: another path is not proof');
  check(stubProof(clean, { sinceMs: t0, apiVersion: '2025-04-01-preview' }).reasons.length === 1, 'stubProof: another api-version is not proof');
  const leaky = stubProof(entries, { sinceMs: t0 });
  check(leaky.reasons.length === 2 && /forbidden credential/.test(leaky.reasons[0]) && /outside the api-key header/.test(leaky.reasons[1]), 'stubProof: a leaked credential or key fails it, even with a good request');
  const urlOnly = [...clean, byN(12)];
  check(stubProof(urlOnly, { sinceMs: t0 }).reasons.length === 2 && stubLeaks(urlOnly).length === 2, 'stubProof / stubLeaks: a leak in the URL query alone fails them, with a good request there');
  check(stubLeaks([...clean, byN(13)]).length === 1, 'stubLeaks: the percent-encoded key in the query alone fails it');

  // --- The stub refuses what it can't watch ---
  await startAzureStub({ port: 0, key: KEY, token: TOKEN, log, forbidden: [{ value: 'short', label: 'x' }] }).then(
    (s) => {
      s.close();
      check(false, 'a watched value under 8 characters stops the stub');
    },
    () => check(true, 'a watched value under 8 characters stops the stub'),
  );
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const cli = spawnSync(process.execPath, [path.join(HERE, 'azure-stub.mjs')], {
    env: { PATH: process.env.PATH, UAT_ENT_STUB_PORT: String(PORT_MAX), UAT_ENT_KEY_FILE: keyFile, UAT_ENT_TOKEN: TOKEN, UAT_ENT_STUB_LOG: path.join(dir, 'cli.jsonl'), UAT_ENT_FORBIDDEN_FILES: `${keyFile}:${path.join(dir, 'missing')}` },
    encoding: 'utf8',
    timeout: 10_000,
  });
  check(cli.status === 1 && /entry 2: the file can't be read/.test(cli.stdout) && !cli.stdout.includes(KEY), `a watched file that can't be read stops the stub (exit ${cli.status}), and nothing is printed of the values`);

  // --- The PENDING logic ---
  const d = (kindOffered, formPresent, expectEnterprise, gatewayOffers = false) => j11Decision({ kindOffered, formPresent, expectEnterprise, gatewayOffers }).verdict;
  check(d(false, false, false) === 'pending', 'no Azure choice, no form, the gateway lists none, no UAT_EXPECT_ENTERPRISE: PENDING');
  check(d(false, false, true) === 'fail', 'no Azure choice, no form, UAT_EXPECT_ENTERPRISE=1: FAIL');
  check(d(true, false, false) === 'fail', 'the Azure choice without its form: FAIL (state changed), never PENDING');
  check(d(false, false, false, true) === 'fail', 'the gateway lists azure-openai but the Console does not offer it: FAIL (half landed), never PENDING');
  check(d(true, true, false) === 'run' && d(true, true, true) === 'run' && d(true, true, false, true) === 'run', 'the form is there: the real test, with or without the flag');

  // --- J7's /mindstone link rule ---
  const today = ['Run guided setup again', 'Diagnostics', 'Approvals', 'Skills'];
  const withP = [...today, 'Model providers'];
  const matches = (links, expectEnterprise) => JSON.stringify(links) === JSON.stringify(expectedStatusLinks({ links, today, expectEnterprise }).expected);
  check(matches(today, false) && matches(withP, false), 'J7 without the flag: today\'s links, with or without "Model providers" right after Skills');
  check(matches(withP, true) && !matches(today, true), 'J7 with UAT_EXPECT_ENTERPRISE=1: "Model providers" is required after Skills');
  check(!matches(['Run guided setup again', 'Diagnostics', 'Approvals', 'Model providers', 'Skills'], false) && !matches(['Run guided setup again', 'Diagnostics', 'Approvals', 'Model providers', 'Skills'], true), 'J7: "Model providers" before Skills fails, with or without the flag');
  check(!matches([...withP, 'Model providers'], false) && !matches([...withP, 'Model providers'], true), 'J7: "Model providers" twice fails');
  check(!matches(['Run guided setup again', 'Approvals', 'Skills', 'Model providers'], false) && !matches(['Run guided setup again', 'Approvals', 'Skills'], false), 'J7: another link missing fails, with or without "Model providers"');
  check(!matches([...withP, 'Extra'], false) && !matches([...today, 'Extra'], false), 'J7: any other extra link fails');

  // --- gate-rows: which failures the verdicts may excuse ---
  const SPEC = 'journey.spec.ts';
  const spec = (title, line, status, errors = []) => ({
    title,
    file: SPEC,
    line,
    ok: status === 'passed' || status === 'skipped',
    tests: [{ results: [{ status, errors }] }],
  });
  const at = (file, line, message = 'x') => ({ message, location: { file: `/abs/e2e/mindstone-journey/${file}`, line, column: 3 } });
  const report = (specs, errors = []) => ({ errors, suites: [{ specs: [], suites: [{ specs }] }] });
  const passing = [spec('J1 sign in', 200, 'passed'), spec('J9 recall', 990, 'skipped')];
  const j11 = (status, errors) => spec('J11 enterprise', 1200, status, errors);
  check(failuresOnlyIn(report([...passing, j11('failed', [at(SPEC, 1250)])]), ['J11']).explained, 'gate-rows: only J11 failed, on its own line: explained');
  check(failuresOnlyIn(report([...passing, j11('failed', [at('lib/journey.ts', 800)])]), ['J11']).explained, "gate-rows: J11's error in a helper file is its own: explained");
  check(failuresOnlyIn(report([...passing, j11('timedOut', [{ message: 'Test timeout' }])]), ['J11']).explained, 'gate-rows: J11 timing out (no location) is its own: explained');
  check(!failuresOnlyIn(report([...passing, j11('failed', [at(SPEC, 1250)])]), []).explained, 'gate-rows: with nothing excused, a J11 failure counts');
  check(!failuresOnlyIn(report([spec('J1 sign in', 200, 'failed', [at(SPEC, 210)]), j11('failed', [at(SPEC, 1250)])]), ['J11']).explained, 'gate-rows: J1 failing too is not explained');
  check(!failuresOnlyIn(report([spec('J1 sign in', 200, 'timedOut', [{ message: 'Test timeout' }]), spec('J9 recall', 990, 'skipped'), j11('failed', [at(SPEC, 1250)])]), ['J11']).explained, 'gate-rows: J1 timing out plus J11 failing is not explained');
  check(!failuresOnlyIn(report([...passing, j11('failed', [at(SPEC, 134, 'afterAll boom')])]), ['J11']).explained, "gate-rows: an afterAll error charged to J11 (at the hook's line) is not excused");
  check(!failuresOnlyIn(report([...passing, j11('failed', [at(SPEC, 1250), at(SPEC, 141, 'afterEach boom')])]), ['J11']).explained, "gate-rows: J11's own error plus an afterEach error is not excused");
  check(!failuresOnlyIn(report([...passing, j11('failed', [at(SPEC, 1250)])], [{ message: 'globalSetup' }]), ['J11']).explained, 'gate-rows: an error outside any test is not explained');
  check(!failuresOnlyIn(report(passing), ['J11']).explained, 'gate-rows: no failure at all does not explain a non-zero exit');

  // --- lib/gate.sh: the wiring run-journey.sh sources ---
  const results = path.join(dir, 'results.json');
  const stalls = path.join(dir, 'stalls.tsv');
  const sh = (script) => spawnSync('bash', ['-c', `set -Eeuo pipefail; source "${path.join(HERE, 'gate.sh')}"; ${script}`], { encoding: 'utf8' });
  const out = (script) => sh(script).stdout.trim();
  const rc = (script) => sh(script).status;
  check(!` ${out('gate_required_steps 0')} `.includes(' J11 ') && ` ${out('gate_required_steps 1')} `.endsWith(' J11 '), 'gate.sh: J11 is a required row only with the flag');
  check(out('gate_required_steps 1').replace(/ J11$/, '') === out('gate_required_steps 0') && out('gate_required_steps 0').split(' ').length === 24, 'gate.sh: the flag adds J11 and nothing else to the 24 rows');
  const demo = ` ${out('gate_demo_steps')} `;
  check(!demo.includes(' J11 ') && !demo.includes(' J7 ') && !demo.includes(' J8 ') && demo.includes(' J9 ') && demo.includes(' J6 ') && demo.includes(' X5 '), 'gate.sh: the demo subset is J1-J6, J9 and S/C/X, never J11');
  check(out('gate_uncounted 0') === 'J11' && out('gate_uncounted 1') === '' && out('echo "$GATE_DEMO_UNCOUNTED"') === 'J11', 'gate.sh: J11 is uncounted by the gate without the flag, counted with it, and always uncounted by the demo');
  fs.writeFileSync(results, JSON.stringify(report([...passing, j11('failed', [at(SPEC, 1250)])])));
  const glog = path.join(dir, 'gate-rows.log');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" J11`) === 0, 'gate.sh: pw_explained_by excuses exit 1 when only J11 failed and J11 is uncounted');
  check(rc(`pw_explained_by 1 "${results}" "${glog}" $(gate_uncounted 1)`) === 1, 'gate.sh: with the flag (nothing uncounted) the same exit is not excused');
  check(rc(`pw_explained_by 0 "${results}" "${glog}" J11`) === 1 && rc(`pw_explained_by 2 "${results}" "${glog}" J11`) === 1, 'gate.sh: pw_explained_by never excuses exit 0 (needs none) or another exit code');
  fs.writeFileSync(results, JSON.stringify(report([...passing, j11('failed', [at(SPEC, 134, 'afterAll boom')])])));
  check(rc(`pw_explained_by 1 "${results}" "${glog}" J11`) === 1, "gate.sh: pw_explained_by doesn't excuse an afterAll error charged to J11");
  fs.writeFileSync(stalls, 'J4\tSTALL: GET /api/messages\nJ11\tSTALL: navigation to /mindstone\nJ11\tSTALL: POST /api/x\n');
  check(out(`stalls_counted "${stalls}" J11`) === '1' && out(`stalls_counted "${stalls}"`) === '3' && out(`stalls_counted "${stalls}" $(gate_uncounted 1)`) === '3', 'gate.sh: J11 stalls are left out only where J11 is uncounted');
  check(out(`stalls_counted "${path.join(dir, 'none.tsv')}" J11`) === '0', 'gate.sh: no stalls file counts 0');
} finally {
  await stub.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`enterprise self-test: ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
