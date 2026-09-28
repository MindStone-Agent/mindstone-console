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
 * - gotoOrStall: page.goto with Playwright's own timeout, its timeout labelled
 *   "STALL: navigation to <path> didn't load in Ns".
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

module.exports = {
  DEFAULT_API_TIMEOUT_MS,
  apiTimeoutMs,
  callTimeoutMs,
  StallError,
  isStall,
  apiStallMessage,
  navStallMessage,
  inPageFetch,
  fetchInPage,
  gotoOrStall,
};
