/**
 * Stall detection for the harness's own requests and page loads (console #30),
 * shared with its offline self-test (lib/stall.selftest.mjs) so both run the
 * same code. A request that gets no answer, or a page that never loads, is an
 * environment STALL (colima's port forwarding has hung connections), not a
 * product answer: it must fail fast, and say so, instead of eating the step's
 * whole budget. A stall is still a FAIL.
 *
 * - inPageFetch runs inside the browser (page.evaluate), so it must stay
 *   self-contained: fetch with AbortSignal.timeout; { stalled: true } on the timeout.
 * - fetchInPage runs in node: page.evaluate(inPageFetch) raced against the same
 *   timeout plus a grace, so a page that never returns can't hang the step
 *   either. Throws a StallError "STALL: <method> <path> no response in Ns".
 * - fetchBefore / pollBefore: the same inside a polling loop with its own
 *   deadline. A request the deadline cut short (it never had its full
 *   timeout) is the loop's own limit running out, not a stall: a
 *   DeadlineError, and the loop ends as timed out.
 * - nodeFetch: a request from node (the gateway probes), same timeout and label.
 * - gotoOrStall: page.goto with Playwright's own timeout, its timeout labelled
 *   "STALL: navigation to <path> didn't load in Ns".
 * - responseOrStall: a UI action (a click) whose request the Console's own page
 *   sends, awaited up to a timeout: no response is a StallError "STALL: <method>
 *   <path> no response in Ns (sent by the page)". A response with an error
 *   status is an answer, not a stall; the step judges it.
 */
const DEFAULT_API_TIMEOUT_MS = 30_000;
const GRACE_MS = 5_000;
/** The shortest timeout a call gets, even with its loop's deadline (almost) reached. */
const MIN_CALL_MS = 1_000;

/** The per-request timeout: UAT_API_TIMEOUT_MS, or 30 s. */
function apiTimeoutMs(env = process.env) {
  const ms = Number(env.UAT_API_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_API_TIMEOUT_MS;
}

/** A call's timeout inside a polling loop: never past the loop's own deadline, never over the cap. */
function callTimeoutMs(deadline, now = Date.now(), cap = apiTimeoutMs()) {
  return Math.max(MIN_CALL_MS, Math.min(cap, deadline - now));
}

class StallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StallError';
  }
}

/** A request its polling loop's deadline cut short: the loop's limit ran out, not a stall. Never recorded as one. */
class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeadlineError';
  }
}

const isStall = (error) => error instanceof StallError || /^STALL: /.test(String(error && error.message));

/** "30" for whole seconds, "1.5" below ten. */
const seconds = (ms) => String(ms >= 10_000 || ms % 1_000 === 0 ? Math.round(ms / 1_000) : Math.round(ms / 100) / 10);

/** The path (and query) of a URL, so no host or port goes into a message. */
function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url);
  }
}

const apiStallMessage = (method, url, ms) => `STALL: ${method} ${pathOf(url)} no response in ${seconds(ms)}s`;
const navStallMessage = (url, ms) => `STALL: navigation to ${pathOf(url)} didn't load in ${seconds(ms)}s`;

/** In the browser: { status, text }, or { stalled: true } when the timeout aborted it (headers or body). */
async function inPageFetch({ method, url, headers, body, timeoutMs }) {
  try {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { stalled: true };
    throw error;
  }
}

/**
 * A request from inside the page: { status, text }, or a StallError when no
 * complete response came within timeoutMs. `body` is a string or undefined.
 */
async function fetchInPage(page, { method, url, headers = {}, body, timeoutMs = apiTimeoutMs(), graceMs = GRACE_MS }) {
  const message = apiStallMessage(method, url, timeoutMs);
  const evaluation = page.evaluate(inPageFetch, { method, url, headers, body, timeoutMs });
  evaluation.catch(() => undefined); // settles after the guard (or the page closes): nothing left to report
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ stalled: true }), timeoutMs + graceMs);
  });
  try {
    const result = await Promise.race([evaluation, guard]);
    if (result && result.stalled) throw new StallError(message);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchInPage inside a polling loop: the timeout is cut to the loop's
 * `deadline` (callTimeoutMs). Without a deadline, or with the full timeout
 * left, no answer is a StallError; when the deadline cut the timeout short,
 * a DeadlineError instead.
 */
async function fetchBefore(page, request, deadline, cap = apiTimeoutMs()) {
  const timeoutMs = deadline === undefined ? cap : callTimeoutMs(deadline, Date.now(), cap);
  try {
    return await fetchInPage(page, { ...request, timeoutMs });
  } catch (error) {
    if (error instanceof StallError && timeoutMs < cap) {
      throw new DeadlineError(`${request.method} ${pathOf(request.url)} got no answer in the ${seconds(timeoutMs)}s left before the limit`);
    }
    throw error;
  }
}

/**
 * A polling loop with its own limit: calls poll(deadline, started) until it
 * returns something other than undefined, pausing up to pauseMs between
 * calls, never past the deadline. Returns { value }, or { timedOut: true }
 * (with `cut`, what the final poll's DeadlineError said, when the limit ran
 * out during a request). Any other error (a StallError too) ends the loop.
 */
async function pollBefore(timeoutMs, poll, pauseMs = 1_500) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    let value;
    try {
      value = await poll(deadline, started);
    } catch (error) {
      if (error instanceof DeadlineError) return { timedOut: true, cut: error.message };
      throw error;
    }
    if (value !== undefined) return { value };
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(pauseMs, deadline - Date.now()))));
  }
  return { timedOut: true };
}

/** A request from node: { status, text }, or a StallError when no complete response came within timeoutMs. */
async function nodeFetch(url, { method = 'GET', headers = {}, timeoutMs = apiTimeoutMs() } = {}) {
  try {
    const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new StallError(apiStallMessage(method, url, timeoutMs));
    throw error;
  }
}

/**
 * page.goto, with Playwright's own timeout (options.timeout, else the
 * navigation timeout the caller passes for the label) named as a stall.
 */
async function gotoOrStall(page, url, options = {}, defaultTimeoutMs = 60_000) {
  try {
    return await page.goto(url, options);
  } catch (error) {
    if (error && error.name === 'TimeoutError') {
      const first = String(error.message).split('\n')[0].trim();
      throw new StallError(`${navStallMessage(url, options.timeout || defaultTimeoutMs)} (${first})`);
    }
    throw error;
  }
}

/**
 * Runs `action` (a click that makes the page send `method` `path`) and waits
 * for the page's response to it, up to `timeoutMs`. Listens before acting, so
 * a fast answer isn't missed. Returns { status }; no response in time is a
 * StallError. `path` is the request's exact path (no query).
 */
async function responseOrStall(page, { method, path, timeoutMs = apiTimeoutMs() }, action) {
  const waiting = page.waitForResponse(
    (response) => response.request().method() === method && new URL(response.url()).pathname === path,
    { timeout: timeoutMs },
  );
  waiting.catch(() => undefined); // settles after the action throws, too: nothing left to report
  await action();
  try {
    const response = await waiting;
    return { status: response.status() };
  } catch (error) {
    if (error && error.name === 'TimeoutError') throw new StallError(`${apiStallMessage(method, path, timeoutMs)} (sent by the page)`);
    throw error;
  }
}

module.exports = {
  DEFAULT_API_TIMEOUT_MS,
  apiTimeoutMs,
  callTimeoutMs,
  StallError,
  DeadlineError,
  isStall,
  apiStallMessage,
  navStallMessage,
  inPageFetch,
  fetchInPage,
  fetchBefore,
  pollBefore,
  nodeFetch,
  gotoOrStall,
  responseOrStall,
};
