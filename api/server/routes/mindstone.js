/**
 * MindStone Console: server-side proxy to the MindStone-Agent gateway's admin
 * API (MindStone-Agent #38, P2). The browser calls /api/mindstone/admin/*; this
 * route checks the LibreChat session and the ACCESS_ADMIN capability, then
 * calls the gateway with the service token and the separate admin credential
 * (neither ever reaches the browser) and the signed-in user's id, with role
 * "admin". The browser passes an If-Match etag as ?ifMatch=, since the
 * Console's request helper can't set headers.
 */
const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

/** The gateway admin endpoints the Console may reach, and nothing else. */
const ALLOWED = [
  { method: 'GET', path: /^status$/ },
  { method: 'GET', path: /^config$/ },
  { method: 'PATCH', path: /^config\/[A-Za-z]+$/ },
  { method: 'POST', path: /^secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
  { method: 'GET', path: /^permissions$/ },
  { method: 'POST', path: /^permissions\/advanced$/ },
];

/** Gateway base URL: MINDSTONE_GATEWAY_URL is the OpenAI base (…/v1); the admin API sits at the root. */
function gatewayBase() {
  const url = process.env.MINDSTONE_GATEWAY_URL ?? '';
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Express 5 path syntax: a named wildcard, whose value is an array of segments.
router.all('/admin/*path', async (req, res) => {
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
      error: 'MINDSTONE_GATEWAY_URL, MINDSTONE_GATEWAY_TOKEN and MINDSTONE_ADMIN_TOKEN must be set on the Console server',
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
  const ifMatch = typeof req.query?.ifMatch === 'string' ? req.query.ifMatch : undefined;
  if (ifMatch && ifMatch.length <= 100 && /^"[0-9a-f]+"$/.test(ifMatch)) {
    headers['if-match'] = ifMatch;
  }
  try {
    const response = await fetch(`${base}/admin/${path}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const etag = response.headers.get('etag');
    if (etag) {
      res.set('ETag', etag);
    }
    res.status(response.status);
    res.type('application/json');
    return res.send(text);
  } catch (error) {
    return res.status(502).json({ ok: false, error: `the MindStone gateway didn't answer: ${error?.message ?? error}` });
  }
});

module.exports = router;
