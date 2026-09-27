/**
 * MindStone Console: server-side proxy to the MindStone-Agent gateway's admin
 * API (MindStone-Agent #38, P2). The browser calls /api/mindstone/admin/*; this
 * route checks the LibreChat session and the ACCESS_ADMIN capability, then
 * calls the gateway with the service token (which never reaches the browser)
 * and the signed-in user's id, with role "admin".
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

router.all('/admin/*', async (req, res) => {
  const path = req.params[0] ?? '';
  const allowed = ALLOWED.some((rule) => rule.method === req.method && rule.path.test(path));
  if (!allowed) {
    return res.status(404).json({ ok: false, error: 'unknown MindStone admin endpoint' });
  }
  const base = gatewayBase();
  const token = process.env.MINDSTONE_GATEWAY_TOKEN;
  if (!base || !token) {
    return res.status(503).json({ ok: false, error: 'MINDSTONE_GATEWAY_URL and MINDSTONE_GATEWAY_TOKEN must be set on the Console server' });
  }
  try {
    const response = await fetch(`${base}/admin/${path}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-mindstone-user-id': String(req.user?.id ?? req.user?._id ?? 'unknown'),
        'x-mindstone-user-role': 'admin',
      },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    res.status(response.status);
    res.type('application/json');
    return res.send(text);
  } catch (error) {
    return res.status(502).json({ ok: false, error: `the MindStone gateway didn't answer: ${error?.message ?? error}` });
  }
});

module.exports = router;
