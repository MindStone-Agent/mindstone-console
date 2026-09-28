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
];

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
  try {
    const response = await fetch(`${base}/admin/${path}${query}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
      // Never follow a redirect: fetch would carry the admin credential (and
      // the body, which can hold a secret) to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status === 401) {
      // The gateway refused the Console's own credentials. Passing 401 through
      // would read as an expired session in the browser and log the admin out.
      logger.error('[mindstone] the gateway refused the Console credentials (401)');
      return res.status(502).json({
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
      return res
        .status(502)
        .json({ ok: false, error: "the MindStone gateway couldn't handle the request" });
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
    return res.status(502).json({ ok: false, error: "the MindStone gateway didn't answer" });
  }
});

module.exports = router;
