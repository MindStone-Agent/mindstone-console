/**
 * MindStone Console: server-side proxy to the MindStone-Agent gateway's admin
 * API (MindStone-Agent #38, P2). The browser calls /api/mindstone/admin/*; this
 * route checks the LibreChat session and capabilities, then calls the gateway
 * with the service token and the separate admin credential (neither ever
 * reaches the browser) and the signed-in user's id, with role "admin". The
 * browser passes an If-Match etag as ?ifMatch=, since the Console's request
 * helper can't set headers.
 *
 * Capabilities: like LibreChat's other admin routers, access:admin alone isn't
 * enough. Reading the gateway config needs read:configs; changing it needs
 * manage:configs; both platform-level, since there is one gateway for every
 * tenant.
 */
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const requireRead = requireCapability(SystemCapabilities.READ_CONFIGS, { platformOnly: true });
const requireManage = requireCapability(SystemCapabilities.MANAGE_CONFIGS, { platformOnly: true });

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

/** The gateway admin endpoints the Console may reach, and nothing else. */
const ALLOWED = [
  { method: 'GET', path: /^status$/ },
  { method: 'GET', path: /^config$/ },
  { method: 'PATCH', path: /^config\/[A-Za-z]+$/ },
  { method: 'POST', path: /^secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
  { method: 'GET', path: /^permissions$/ },
  { method: 'GET', path: /^models$/ },
  { method: 'POST', path: /^providers\/[a-z][a-z-]{0,39}$/ },
  // Enterprise model endpoints (MindStone-Agent #126): register, test, remove.
  { method: 'POST', path: /^providers\/enterprise\/[a-z][a-z-]{0,39}$/ },
  { method: 'POST', path: /^providers\/[a-z0-9][a-z0-9-]{0,59}\/test$/ },
  { method: 'DELETE', path: /^providers\/enterprise-[a-z]{1,20}$/ },
  { method: 'POST', path: /^permissions\/advanced$/ },
  { method: 'POST', path: /^restart$/ },
  { method: 'GET', path: /^doctor$/ },
  { method: 'GET', path: /^logs$/ },
  { method: 'GET', path: /^approvals$/ },
  { method: 'GET', path: /^approvals\/[0-9a-f-]{8,36}$/ },
  { method: 'POST', path: /^approvals\/[0-9a-f-]{8,36}\/(approve|reject)$/ },
  { method: 'GET', path: /^secrets$/ },
  { method: 'DELETE', path: /^secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
  { method: 'GET', path: /^skills$/ },
  { method: 'GET', path: /^skills\/[a-z0-9][a-z0-9-]{0,63}$/ },
  { method: 'POST', path: /^skills\/drafts$/ },
  { method: 'DELETE', path: /^skills\/drafts\/[a-z0-9][a-z0-9-]{0,63}$/ },
  { method: 'POST', path: /^skills\/[a-z0-9][a-z0-9-]{0,63}\/install$/ },
  { method: 'POST', path: /^onboarding\/complete$/ },
  { method: 'POST', path: /^memory\/check$/ },
  { method: 'POST', path: /^memory\/pull$/ },
  { method: 'GET', path: /^personas$/ },
  // What the agent knows about the owner, its USER.md (MindStone-Agent #140).
  { method: 'GET', path: /^user$/ },
  { method: 'PATCH', path: /^user$/ },
  // The persona builder (MindStone-Agent #125): personas, workflows, the
  // global KB list, and a persona's private knowledge bases.
  { method: 'POST', path: /^personas$/ },
  { method: 'GET', path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/ },
  { method: 'PATCH', path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/ },
  { method: 'GET', path: /^workflows$/ },
  { method: 'POST', path: /^workflows$/ },
  { method: 'GET', path: /^workflows\/[a-z0-9][a-z0-9-]{0,39}$/ },
  { method: 'PATCH', path: /^workflows\/[a-z0-9][a-z0-9-]{0,39}$/ },
  { method: 'GET', path: /^knowledgebases$/ },
  { method: 'GET', path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases$/ },
  { method: 'POST', path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases$/ },
  {
    method: 'GET',
    path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases\/[a-z0-9][a-z0-9-]{0,39}\/sources$/,
  },
  {
    method: 'POST',
    path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases\/[a-z0-9][a-z0-9-]{0,39}\/sources$/,
  },
  {
    method: 'POST',
    path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases\/[a-z0-9][a-z0-9-]{0,39}\/ingest$/,
  },
  // Try again after a give-up (MindStone-Agent #158): clears a KB's re-embed state.
  // A shared KB's id is its folder's name, any name the list shows (MindStone-Agent #166):
  // one segment (checked decoded, so an encoded / is refused), never a dot folder.
  { method: 'POST', path: /^knowledgebases\/[^/.][^/]{0,1023}\/reembed$/ },
  {
    method: 'POST',
    path: /^personas\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/knowledgebases\/[a-z0-9][a-z0-9-]{0,39}\/reembed$/,
  },
];

/**
 * How long the gateway gets to answer. Each limit sits past the gateway's own
 * (embed check 20 s, model download 15 min), so its "took too long" answer
 * reaches the page instead of a generic 502.
 */
const TIMEOUT_MS = 15_000;
// The memory check may load its model first (MindStone-Agent #140: the gateway's check takes up to 50 s);
// 55 s stays under a front proxy's usual 60 s.
const ROUTE_TIMEOUT_MS = { 'memory/check': 55_000, 'memory/pull': 16 * 60_000 };
/**
 * A private KB's ingest fetches its URL sources one after another (at most
 * 10, 20 s each on the gateway), so it gets four minutes (#125).
 */
const INGEST_PATH = /^personas\/[A-Za-z0-9._-]+\/knowledgebases\/[a-z0-9-]+\/ingest$/;
const INGEST_TIMEOUT_MS = 4 * 60_000;
/** Approving a proposed private KB ingests it before answering (#125), so it gets an ingest's wait. */
const APPROVE_PATH = /^approvals\/[A-Za-z0-9-]+\/approve$/;
/**
 * A model download answers only when it ends, up to 15 minutes on the gateway
 * (MindStone-Agent #145). Once the gateway accepts it, the browser gets the
 * headers and a newline this often, so neither the browser (Firefox gives up
 * after 5 minutes with nothing) nor a proxy in between stops waiting.
 */
const LONG_WAIT = { paths: new Set(['memory/pull']), heartbeatMs: 10_000 };

/** Gateway base URL: MINDSTONE_GATEWAY_URL is the OpenAI base (…/v1); the admin API sits at the root. */
function gatewayBase() {
  const url = process.env.MINDSTONE_GATEWAY_URL ?? '';
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Reads need read:configs, writes need manage:configs. */
function requireForMethod(req, res, next) {
  return (req.method === 'GET' ? requireRead : requireManage)(req, res, next);
}

// Express 5 path syntax: a named wildcard, whose value is an array of segments.
router.all('/admin/*path', requireForMethod, async (req, res) => {
  // Nothing here may be cached: the config is masked, but it is still the config.
  res.set('Cache-Control', 'no-store');
  const segments = req.params.path;
  const path = Array.isArray(segments) ? segments.join('/') : (segments ?? '');
  const allowed = ALLOWED.some((rule) => rule.method === req.method && rule.path.test(path));
  if (!allowed) {
    return res.status(404).json({ ok: false, error: 'unknown MindStone admin endpoint' });
  }
  const base = gatewayBase();
  const token = process.env.MINDSTONE_GATEWAY_TOKEN;
  const adminToken = process.env.MINDSTONE_ADMIN_TOKEN;
  if (!base || !token || !adminToken) {
    return res.status(503).json({
      ok: false,
      error:
        'MINDSTONE_GATEWAY_URL, MINDSTONE_GATEWAY_TOKEN and MINDSTONE_ADMIN_TOKEN must be set on the Console server',
    });
  }
  const userId = req.user?.id ?? req.user?._id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'no signed-in user' });
  }
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-mindstone-admin-token': adminToken,
    'x-mindstone-user-id': String(userId),
    'x-mindstone-user-role': 'admin',
  };
  const ifMatch = req.query?.ifMatch;
  if (ifMatch !== undefined) {
    // A present but malformed etag is refused rather than dropped, so a save
    // never silently loses its stale-write guard.
    if (typeof ifMatch !== 'string' || ifMatch.length > 100 || !/^"[0-9a-f]+"$/.test(ifMatch)) {
      return res
        .status(400)
        .json({ ok: false, error: 'ifMatch must be the etag the settings page read' });
    }
    headers['if-match'] = ifMatch;
  }
  // Three queries reach the gateway, each on one path only: all=1 on the
  // approvals list (decided actions too), lines on the log tail and source on
  // one skill; nothing else from the browser's query string does.
  let query = path === 'approvals' && req.query?.all === '1' ? '?all=1' : '';
  if (
    req.method === 'GET' &&
    /^skills\/[a-z0-9-]+$/.test(path) &&
    req.query?.source !== undefined
  ) {
    const source = req.query.source;
    if (source !== 'installed' && source !== 'draft' && source !== 'builtin') {
      return res
        .status(400)
        .json({ ok: false, error: 'source must be installed, draft or builtin' });
    }
    query = `?source=${source}`;
  }
  // lines: digits only here; the gateway checks the 1 to 500 range.
  if (path === 'logs' && req.query?.lines !== undefined) {
    const lines = req.query.lines;
    if (typeof lines !== 'string' || !/^[0-9]{1,3}$/.test(lines)) {
      return res
        .status(400)
        .json({ ok: false, error: 'lines must be a whole number from 1 to 500' });
    }
    query = `?lines=${lines}`;
  }
  const longWait = LONG_WAIT.paths.has(path);
  // A browser that leaves a download stops it on the gateway, which frees its
  // one download slot at once (#145).
  const browserGone = new AbortController();
  if (longWait) {
    res.on('close', () => {
      if (!res.writableEnded) {
        browserGone.abort();
      }
    });
  }
  /** An error answer; once the headers have gone, its JSON ends the 200. */
  const fail = (status, body) =>
    res.headersSent ? res.end(JSON.stringify(body)) : res.status(status).json(body);
  let heartbeat;
  try {
    // Each segment encoded again, as it arrived decoded: a KB folder name may hold a space, # or ? (MindStone-Agent #166).
    const upstreamPath = Array.isArray(segments)
      ? segments.map((segment) => encodeURIComponent(segment)).join('/')
      : path;
    const response = await fetch(`${base}/admin/${upstreamPath}${query}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
      // Never follow a redirect: fetch would carry the admin credential (and
      // the body, which can hold a secret) to wherever it points.
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(
          ROUTE_TIMEOUT_MS[path] ??
            (INGEST_PATH.test(path) || APPROVE_PATH.test(path) ? INGEST_TIMEOUT_MS : TIMEOUT_MS),
        ),
        browserGone.signal,
      ]),
    });
    if (longWait && response.status === 200) {
      // Accepted: a refusal (403, 409) came as its own status, before this.
      res.status(200);
      res.type('application/json');
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write('\n');
        // Compression holds a small write back until it is flushed.
        res.flush?.();
      }, LONG_WAIT.heartbeatMs);
    }
    const text = await response.text();
    if (response.status === 401) {
      // The gateway refused the Console's own credentials. Passing 401 through
      // would read as an expired session in the browser and log the admin out.
      logger.error('[mindstone] the gateway refused the Console credentials (401)');
      return fail(502, {
        ok: false,
        error:
          "the MindStone gateway refused the Console's credentials; check MINDSTONE_GATEWAY_TOKEN and MINDSTONE_ADMIN_TOKEN",
      });
    }
    // Only the gateway's own JSON answers pass through. A 5xx, or a body that
    // isn't JSON (a proxy's HTML error page), can carry host paths or other
    // internals, so it is logged here and the browser gets a generic 502.
    let isJson = true;
    try {
      JSON.parse(text);
    } catch {
      isJson = false;
    }
    if (response.status >= 500 || !isJson) {
      logger.error(
        `[mindstone] the gateway answered ${response.status}${isJson ? '' : ' with a body that is not JSON'}`,
      );
      return fail(502, { ok: false, error: "the MindStone gateway couldn't handle the request" });
    }
    if (res.headersSent) {
      return res.end(text);
    }
    const etag = response.headers.get('etag');
    if (etag) {
      res.set('ETag', etag);
    }
    res.status(response.status);
    res.type('application/json');
    return res.send(text);
  } catch (error) {
    // Logged here, never sent: a fetch error can quote a header value (the
    // tokens) or a URL with credentials.
    logger.error('[mindstone] gateway request failed', error);
    if (browserGone.signal.aborted) {
      // Nobody is waiting for an answer.
      return;
    }
    // The Console stopped waiting: the gateway may still be working on it (a
    // long ingest), which isn't the same as a gateway that is down (#125).
    if (error?.name === 'TimeoutError') {
      return fail(504, {
        ok: false,
        error: "the MindStone gateway didn't answer in time; it may still finish",
        code: 'gateway_timeout',
      });
    }
    return fail(502, { ok: false, error: "the MindStone gateway didn't answer" });
  } finally {
    clearInterval(heartbeat);
  }
});

module.exports = router;
module.exports.LONG_WAIT = LONG_WAIT;
