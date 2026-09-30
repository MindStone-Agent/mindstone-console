/**
 * MindStone Console: display names for MindStone's models (#53). The gateway
 * lists each agent as the model mindstone/<agentId>; the model menu shows the
 * agent's name instead. Any signed-in user may read the names (everyone picks
 * a model), so this reads only the agents' ids and names from the gateway's
 * admin status, with the Console's own credentials, and returns nothing else.
 * Names are kept for a minute; a gateway that can't be read gives no names
 * (the menu then shows the ids), never an error.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const CACHE_MS = 60_000;
const NAME_MAX = 80;
let cached = { at: 0, names: null };

/** Gateway base URL: MINDSTONE_GATEWAY_URL is the OpenAI base (…/v1); the admin API sits at the root. */
function gatewayBase() {
  const url = process.env.MINDSTONE_GATEWAY_URL ?? '';
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** { "mindstone/<agentId>": name } from the status agents list; anything malformed is skipped. */
function namesFromStatus(body) {
  const agents = body?.system?.agents;
  const names = {};
  if (!Array.isArray(agents)) return names;
  for (const agent of agents) {
    const id = agent?.agentId;
    const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
    if (typeof id === 'string' && /^[A-Za-z0-9_.-]+$/.test(id) && name) {
      names[`mindstone/${id}`] = name.slice(0, NAME_MAX);
    }
  }
  return names;
}

async function readNames() {
  const base = gatewayBase();
  const token = process.env.MINDSTONE_GATEWAY_TOKEN;
  const adminToken = process.env.MINDSTONE_ADMIN_TOKEN;
  if (!base || !token || !adminToken) return {};
  const response = await fetch(`${base}/admin/status`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-mindstone-admin-token': adminToken,
      // The Console itself asks, not a user.
      'x-mindstone-user-id': 'mindstone-console',
      'x-mindstone-user-role': 'admin',
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`gateway status ${response.status}`);
  return namesFromStatus(await response.json());
}

router.get('/', requireJwtAuth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (cached.names && Date.now() - cached.at < CACHE_MS) {
    return res.json({ names: cached.names });
  }
  try {
    const names = await readNames();
    cached = { at: Date.now(), names };
    return res.json({ names });
  } catch (error) {
    logger.warn(
      '[mindstone] could not read agent names for the model menu:',
      error?.message ?? error,
    );
    return res.json({ names: {} });
  }
});

router.namesFromStatus = namesFromStatus;
router.resetCache = () => {
  cached = { at: 0, names: null };
};

module.exports = router;
