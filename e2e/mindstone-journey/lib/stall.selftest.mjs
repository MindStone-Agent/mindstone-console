// Offline self-test of the harness's stall detection (lib/stall.js, console
// #30), in a real Chromium page against a local HTTP server that never answers
// some routes; no Console. It requires that
// - a request that answers comes back as { status, text } (the positive control);
// - a request with no answer, or with headers but a body that never ends,
//   throws "STALL: GET <path> no response in Ns" within its timeout (not the
//   30 s default, not the step's budget);
// - a page whose evaluate never returns still stalls, on the node-side guard;
// - inside a polling loop, the call's timeout is cut to the loop's own
//   deadline, so the loop's limit fires even when every call stalls; a call
//   the deadline cut short ends the loop as its own limit (DeadlineError),
//   never as a stall, and one with its full timeout is still a stall;
// - a request from node (the gateway probes) stalls the same way;
// - a page load that never finishes is labelled "STALL: navigation to <path>";
// - a request the page sends itself on a UI action (J10's saves and ingest)
//   comes back as its status when answered, and stalls, named "(sent by the
//   page)", when it isn't, or when only another request was answered.
// The server listens on 127.0.0.1, on the first free port in UAT_PORT_MIN to
// UAT_PORT_MAX (default 26900 to 26949). Run by run-journey.sh with X5; needs
// @playwright/test (NODE_PATH). A watchdog ends it (exit 1) if it hangs itself.
//
//   node stall.selftest.mjs
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const { DEFAULT_API_TIMEOUT_MS, apiTimeoutMs, callTimeoutMs, isStall, DeadlineError, fetchInPage, fetchBefore, pollBefore, nodeFetch, gotoOrStall, responseOrStall } =
  require('./stall.js');

// The self-test must not hang the harness (X5) itself.
setTimeout(() => {
  console.log('stall self-test: hung (over 60 s)');
  process.exit(1);
}, 60_000).unref();

const PORT_MIN = Number(process.env.UAT_PORT_MIN ?? 26900);
const PORT_MAX = Math.min(Number(process.env.UAT_PORT_MAX ?? 26949), PORT_MIN + 49);
if (!(PORT_MIN > 0 && PORT_MAX >= PORT_MIN) || (PORT_MIN <= 18999 && PORT_MAX >= 18000)) {
  console.log(`stall self-test: bad port range ${PORT_MIN}-${PORT_MAX}`);
  process.exit(2);
}

// Requests left hanging, so the server can be closed at the end.
const held = new Set();
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>stall self-test</title><p>ok</p>');
  } else if (req.url === '/ok') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  } else if (req.url === '/slow-empty') {
    // A poll that answers, just slowly: an empty message list after 1.2 s.
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]'), 1_200);
  } else if (req.url === '/hang-body') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    held.add(res);
  } else {
    held.add(res); // /hang, /hang-page: never answer
  }
});
server.on('connection', (socket) => held.add(socket));

async function listen() {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`);
}

/** Runs fn; { error, ms }. */
async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { value, ms: Date.now() - t0 };
  } catch (error) {
    return { error, ms: Date.now() - t0 };
  }
}

let failures = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`);
}
/** A stall within [timeout, timeout + slack], with exactly `message`. */
function expectStall(name, r, message, timeoutMs, slackMs = 2_000) {
  const got = r.error ? `${r.error.name}: ${r.error.message}` : `no error, returned ${JSON.stringify(r.value)}`;
  check(
    `${name}: "${message}" after ${r.ms} ms`,
    !!r.error && isStall(r.error) && r.error.message.startsWith(message) && r.ms >= timeoutMs - 50 && r.ms <= timeoutMs + slackMs,
    got,
  );
}

// Pure checks: the timeout's source and a polling loop's cut.
check('default per-request timeout is 30 s', apiTimeoutMs({}) === DEFAULT_API_TIMEOUT_MS && DEFAULT_API_TIMEOUT_MS === 30_000);
check('UAT_API_TIMEOUT_MS overrides it', apiTimeoutMs({ UAT_API_TIMEOUT_MS: '5000' }) === 5_000);
check('a bad UAT_API_TIMEOUT_MS falls back to 30 s', apiTimeoutMs({ UAT_API_TIMEOUT_MS: 'soon' }) === 30_000 && apiTimeoutMs({ UAT_API_TIMEOUT_MS: '0' }) === 30_000);
check('a call far from its deadline gets the full timeout', callTimeoutMs(1_000_000, 0, 30_000) === 30_000);
check("a call near its loop's deadline is cut to what's left", callTimeoutMs(12_000, 0, 30_000) === 12_000);
check('a call past its deadline still gets 1 s, not none', callTimeoutMs(0, 5_000, 30_000) === 1_000);

const port = await listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`${base}/`);

  const ok = await timed(() => fetchInPage(page, { method: 'GET', url: '/ok', timeoutMs: 2_000 }));
  check(`an answered request returns its status and body (${ok.ms} ms)`, !ok.error && ok.value.status === 200 && ok.value.text === '{"ok":true}', ok.error?.message ?? JSON.stringify(ok.value));

  const hang = await timed(() => fetchInPage(page, { method: 'GET', url: '/hang', timeoutMs: 1_500 }));
  expectStall('no response at all', hang, 'STALL: GET /hang no response in 1.5s', 1_500);

  const body = await timed(() => fetchInPage(page, { method: 'POST', url: '/hang-body', body: '{}', timeoutMs: 1_500 }));
  expectStall('headers, then a body that never ends', body, 'STALL: POST /hang-body no response in 1.5s', 1_500);

  // A polling loop with 2 s left and the 30 s default cap: it ends at its deadline, not 30 s later,
  // and as the loop's own limit (DeadlineError), not a stall.
  const deadline = Date.now() + 2_000;
  const loop = await timed(() => fetchBefore(page, { method: 'GET', url: '/hang' }, deadline, 30_000));
  check(
    `inside a loop, a call its deadline cut short ends at the deadline as the loop's limit, not a stall (${loop.ms} ms)`,
    loop.error instanceof DeadlineError && !isStall(loop.error) && loop.ms >= 1_950 && loop.ms <= 4_000,
    loop.error ? `${loop.error.name}: ${loop.error.message}` : 'no error',
  );
  const full = await timed(() => fetchBefore(page, { method: 'GET', url: '/hang' }, Date.now() + 60_000, 1_500));
  expectStall('inside a loop, a call with its full timeout left is still a stall', full, 'STALL: GET /hang no response in 1.5s', 1_500);

  // QA repro: every poll answers [] after 1.2 s, with a 3.5 s limit. The last poll starts with less time left
  // than it takes; the loop must end timed out (the reply limit), not with a STALL.
  const polls = await timed(() =>
    pollBefore(3_500, (dl) => fetchBefore(page, { method: 'GET', url: '/slow-empty' }, dl, 30_000).then(() => undefined)),
  );
  check(
    `a reply that never finishes, polled slowly, times out as the reply limit, not a stall (${polls.ms} ms: ${polls.error ? polls.error.message : JSON.stringify(polls.value)})`,
    !polls.error && polls.value?.timedOut === true && /got no answer in the .* left before the limit/.test(polls.value.cut ?? '') && polls.ms <= 5_500,
  );
  const stalledPoll = await timed(() => pollBefore(60_000, (dl) => fetchBefore(page, { method: 'GET', url: '/hang' }, dl, 1_500)));
  expectStall('a polling loop whose call stalls with its full timeout ends on the stall', stalledPoll, 'STALL: GET /hang no response in 1.5s', 1_500);

  // From node (the gateway probes): same timeout and label, no host in it.
  const nodeOk = await timed(() => nodeFetch(`${base}/ok`, { timeoutMs: 2_000 }));
  check(`a node request that answers returns its status and body (${nodeOk.ms} ms)`, !nodeOk.error && nodeOk.value.status === 200 && nodeOk.value.text === '{"ok":true}', nodeOk.error?.message ?? '');
  const nodeHang = await timed(() => nodeFetch(`${base}/hang`, { timeoutMs: 1_500 }));
  expectStall('a node request with no response', nodeHang, 'STALL: GET /hang no response in 1.5s', 1_500);
  const nodeBody = await timed(() => nodeFetch(`${base}/hang-body`, { timeoutMs: 1_500 }));
  expectStall('a node request whose body never ends', nodeBody, 'STALL: GET /hang-body no response in 1.5s', 1_500);

  // A page that never returns from evaluate (its JS thread is busy): the node-side guard still fires.
  const stuck = await browser.newPage();
  await stuck.goto(`${base}/`);
  stuck.evaluate(() => {
    for (;;);
  }).catch(() => undefined);
  const guard = await timed(() => fetchInPage(stuck, { method: 'GET', url: '/ok', timeoutMs: 1_000, graceMs: 500 }));
  expectStall('a page stuck in evaluate (node-side guard)', guard, 'STALL: GET /ok no response in 1s', 1_500);

  // A request the page sends itself when the step clicks (J10's persona saves and ingest).
  const pageSends = (method, url) => () => page.evaluate(([m, u]) => void fetch(u, { method: m }).catch(() => undefined), [method, url]);
  const uiOk = await timed(() => responseOrStall(page, { method: 'POST', path: '/ok', timeoutMs: 2_000 }, pageSends('POST', '/ok')));
  check(`a request the page sends on a UI action returns its status (${uiOk.ms} ms)`, !uiOk.error && uiOk.value?.status === 200, uiOk.error?.message ?? JSON.stringify(uiOk.value));
  const uiHang = await timed(() => responseOrStall(page, { method: 'POST', path: '/hang', timeoutMs: 1_500 }, pageSends('POST', '/hang')));
  expectStall('a request the page sends on a UI action, with no response', uiHang, 'STALL: POST /hang no response in 1.5s (sent by the page)', 1_500);
  const uiOther = await timed(() => responseOrStall(page, { method: 'POST', path: '/ok', timeoutMs: 1_500 }, pageSends('GET', '/ok')));
  expectStall('only another request (GET, not POST) answered: still a stall', uiOther, 'STALL: POST /ok no response in 1.5s (sent by the page)', 1_500);

  const nav = await browser.newPage();
  const load = await timed(() => gotoOrStall(nav, `${base}/hang-page`, { timeout: 1_500 }));
  expectStall('a page load that never finishes', load, "STALL: navigation to /hang-page didn't load in 1.5s", 1_500);
  check('the navigation stall keeps Playwright\'s own error', /page\.goto: Timeout 1500ms exceeded/.test(load.error?.message ?? ''), load.error?.message ?? 'no error');
} finally {
  await browser.close().catch(() => undefined);
  for (const h of held) (h.destroy ?? h.end).call(h);
  server.close();
}
console.log(`stall self-test: ${total - failures} of ${total} controls behaved`);
process.exit(failures ? 1 : 0);
