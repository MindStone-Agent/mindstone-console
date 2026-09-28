// Offline self-test of J11's own pieces (enterprise endpoint, MindStone-Agent
// #126); no Console, no gateway. It requires that
// - the stub Azure endpoint (lib/azure-stub.mjs) answers only the run's key in
//   the api-key header: a missing key, a wrong key, and the right key in the
//   wrong header (Authorization: Bearer) all get 401 and no token;
// - with the key, POST …/responses?api-version=v1 streams the Responses API
//   (response.created … output_text deltas … response.completed) whose text
//   holds the run's token, and stream: false gets the JSON response;
// - another path gets 404, and health answers without a key;
// - its request log records every request, with the key, the forbidden
//   credentials and the Authorization value in no form (plain, hex, base64),
//   and flags a forbidden credential or the key outside api-key;
// - stubProof (lib/enterprise-evidence.js) proves only an authenticated,
//   streamed request at the expected path and api-version after the step's
//   action (with the chat's nonce, when given), and fails on a leak;
// - j11Decision is PENDING only when neither the Azure choice nor its form
//   is there and UAT_EXPECT_ENTERPRISE isn't set; FAIL with it set, or when
//   the choice is there without its form;
// - gate-rows (lib/gate-rows.mjs) excuses Playwright's exit only when every
//   failed test is one of the given steps and nothing failed outside a test.
// The stub listens on 127.0.0.1, on the first free port in UAT_PORT_MIN to
// UAT_PORT_MAX (default 26900 to 26949). Run by run-journey.sh with X5.
//
//   node enterprise.selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startAzureStub, replyText } from './azure-stub.mjs';
import { failuresOnlyIn } from './gate-rows.mjs';

const require = createRequire(import.meta.url);
const { j11Decision, readStubLog, stubProof, RESPONSES_PATH, API_VERSION } = require('./enterprise-evidence.js');

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

async function startOnFreePort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    try {
      return await startAzureStub({ port, key: KEY, token: TOKEN, log, forbidden: [{ value: GATEWAY_TOKEN, label: '<forbidden credential 1>' }], deltaDelayMs: 1 });
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

const stub = await startOnFreePort();
const base = `${stub.url}/openai/v1`;
const body = (extra = {}) =>
  JSON.stringify({ model: 'uat-gpt-4o', stream: true, input: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'input_text', text: 'hello nonce-123' }] }], ...extra });
const post = (url, headers, payload = body()) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
const responsesUrl = `${base}/responses?api-version=${API_VERSION}`;

try {
  const t0 = Date.now() - 1;

  // Auth: only the key in api-key.
  for (const [what, headers] of [
    ['no key', {}],
    ['a wrong key', { 'api-key': `${KEY}x` }],
    ['the key as Authorization: Bearer (the wrong header)', { authorization: `Bearer ${KEY}` }],
  ]) {
    const response = await post(responsesUrl, headers);
    const text = await response.text();
    check(response.status === 401 && !text.includes(TOKEN), `${what}: 401, and no token in the answer`);
  }

  // The right key: the Responses API stream, with the token.
  const good = await post(responsesUrl, { 'api-key': KEY });
  const goodText = await good.text();
  const events = sseEvents(goodText);
  const types = events.map((e) => e.type);
  const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  check(good.status === 200 && (good.headers.get('content-type') ?? '').startsWith('text/event-stream'), 'the key in api-key: 200 text/event-stream');
  check(types[0] === 'response.created' && types[types.length - 1] === 'response.completed' && types.includes('response.output_item.done'), `the stream runs response.created … response.completed (${types.length} events)`);
  check(deltas === replyText(TOKEN) && deltas.includes(TOKEN), `the text deltas spell "${replyText(TOKEN)}"`);
  check(/^event: response\.created\ndata: /.test(goodText), 'each event has its event: line, like the real API');

  // stream: false gets the JSON response.
  const json = await post(responsesUrl, { 'api-key': KEY }, body({ stream: false }));
  const parsed = await json.json();
  check(json.status === 200 && parsed.object === 'response' && JSON.stringify(parsed).includes(TOKEN), 'stream: false: the JSON response, with the token');

  // Other paths, and health.
  const other = await post(`${base}/chat/completions?api-version=${API_VERSION}`, { 'api-key': KEY });
  check(other.status === 404, 'another path with the key: 404');
  const health = await fetch(`${stub.url}/__stub/health`);
  check(health.status === 200, 'health answers without a key');

  // Leaks: the gateway token in a header, and the key in the body.
  await post(responsesUrl, { 'api-key': KEY, 'x-extra': GATEWAY_TOKEN });
  await post(responsesUrl, { 'api-key': KEY }, body({ input: `please use ${KEY}` }));

  // The log.
  const raw = fs.readFileSync(log, 'utf8');
  const { entries } = readStubLog(log);
  check(entries.length === 9, `every request is logged (${entries.length} of 9)`);
  const forms = (v) => [v, Buffer.from(v).toString('hex'), Buffer.from(v).toString('base64').slice(0, 16)];
  check(![KEY, GATEWAY_TOKEN].flatMap(forms).some((form) => raw.includes(form)), 'the log holds neither the key nor the forbidden credential, in any form');
  check(!raw.includes(`Bearer ${KEY.slice(0, 12)}`) && entries[2].headers.authorization === `<redacted, ${`Bearer ${KEY}`.length} chars>`, 'an Authorization header is logged as its length only');
  check(entries.slice(0, 3).map((e) => e.auth).join(',') === 'missing,wrong,missing', 'auth is recorded as missing / wrong / missing');
  check(entries[3].auth === 'ok' && entries[3].headers['api-key'] === '<ok>' && entries[3].body.lastUserText === 'hello nonce-123' && entries[3].body.stream === true, 'the good request: key ok, the last user text and stream recorded');
  const leak = entries.find((e) => (e.forbiddenCredentialSeen ?? []).length);
  check(Boolean(leak) && leak.forbiddenCredentialSeen[0] === '<forbidden credential 1>', 'a forbidden credential in a header is flagged (as its label)');
  const inBody = entries[entries.length - 1];
  check(inBody.keyOutsideApiKeyHeader === true && inBody.body.lastUserText.includes('<the run key>'), 'the key in the body is flagged and replaced');

  check(entries[2].keyOutsideApiKeyHeader === true, 'the key in the Authorization header is flagged as outside api-key');

  // stubProof on the good part of the log only (no leak: without the Bearer request), then on the whole of it.
  const clean = entries.slice(0, 7).filter((_, i) => i !== 2);
  check(stubProof(clean, { sinceMs: t0 }).reasons.length === 0, 'stubProof: the authenticated streamed request proves the call');
  check(stubProof(clean, { sinceMs: t0, nonce: 'nonce-123' }).reasons.length === 0, "stubProof: with the chat's nonce, too");
  check(stubProof(clean, { sinceMs: t0, nonce: 'nonce-999' }).reasons.length === 1, 'stubProof: another nonce is not proof');
  check(stubProof(clean, { sinceMs: Date.now() + 60_000 }).reasons.length === 1, 'stubProof: a request before the step began is not proof');
  check(stubProof(clean.slice(0, 2), { sinceMs: t0 }).reasons.length === 1, 'stubProof: only unauthenticated requests are not proof');
  check(stubProof(clean.filter((e) => e.body?.stream !== true || e.auth !== 'ok'), { sinceMs: t0 }).reasons.length === 1, 'stubProof: the JSON (not streamed) answer alone is not proof');
  check(stubProof(clean, { sinceMs: t0, path: `/openai/deployments/x${RESPONSES_PATH}` }).reasons.length === 1, 'stubProof: another path is not proof');
  check(stubProof(clean, { sinceMs: t0, apiVersion: '2025-04-01-preview' }).reasons.length === 1, 'stubProof: another api-version is not proof');
  const leaky = stubProof(entries, { sinceMs: t0 });
  check(leaky.reasons.length === 2 && /forbidden credential/.test(leaky.reasons[0]) && /outside the api-key header/.test(leaky.reasons[1]), 'stubProof: a leaked credential or key fails it, even with a good request');

  // The PENDING logic.
  const d = (kindOffered, formPresent, expectEnterprise) => j11Decision({ kindOffered, formPresent, expectEnterprise }).verdict;
  check(d(false, false, false) === 'pending', 'no Azure choice, no form, no UAT_EXPECT_ENTERPRISE: PENDING');
  check(d(false, false, true) === 'fail', 'no Azure choice, no form, UAT_EXPECT_ENTERPRISE=1: FAIL');
  check(d(true, false, false) === 'fail', 'the Azure choice without its form: FAIL (state changed), never PENDING');
  check(d(true, true, false) === 'run' && d(true, true, true) === 'run', 'the form is there: the real test, with or without the flag');

  // The gate's Playwright exit.
  const spec = (title, status) => ({ title, ok: status === 'passed' || status === 'skipped', tests: [{ results: [{ status }] }] });
  const report = (specs, errors = []) => ({ errors, suites: [{ specs: [], suites: [{ specs }] }] });
  const passing = [spec('J1 sign in', 'passed'), spec('J9 recall', 'skipped')];
  check(failuresOnlyIn(report([...passing, spec('J11 enterprise', 'failed')]), ['J11']).explained, 'gate-rows: only J11 failed, J11 excused: explained');
  check(!failuresOnlyIn(report([...passing, spec('J11 enterprise', 'failed')]), []).explained, 'gate-rows: with nothing excused, a J11 failure counts');
  check(!failuresOnlyIn(report([spec('J1 sign in', 'failed'), spec('J11 enterprise', 'failed')]), ['J11']).explained, 'gate-rows: J1 failing too is not explained');
  check(!failuresOnlyIn(report([...passing, spec('J11 enterprise', 'timedOut')], [{ message: 'afterAll' }]), ['J11']).explained, 'gate-rows: an error outside a test is not explained');
  check(!failuresOnlyIn(report(passing), ['J11']).explained, 'gate-rows: no failure at all does not explain a non-zero exit');
} finally {
  await stub.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`enterprise self-test: ${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
