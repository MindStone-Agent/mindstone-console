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
/** A failed read is remembered too, so a down gateway isn't asked on every request. */
const FAILURE_CACHE_MS = 30_000;
const NAME_MAX = 80;
let cached = { at: 0, names: null, ttl: CACHE_MS };
/** One gateway read at a time, shared by the requests that arrive while it runs. */
let pending = null;

/** Control, bidi and zero-width characters out: a name can't disguise itself in the menu. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Gateway base URL: MINDSTONE_GATEWAY_URL is the OpenAI base (…/v1); the admin API sits at the root. */
function gatewayBase() {
  const url = process.env.MINDSTONE_GATEWAY_URL ?? '';
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The title setup gives an agent before its identity has a name of its own. */
const PLACEHOLDER_TITLE = /^mindstone agent identity pending$/i;

/** An agent without a name of its own reads as MindStone, not as its id or setup's placeholder. */
function fallbackName(id) {
  return id === 'default' ? 'MindStone' : `MindStone (${id})`;
}

/** { "mindstone/<agentId>": name } from the status agents list; anything malformed is skipped. */
function namesFromStatus(body) {
  const agents = body?.system?.agents;
  const names = {};
  if (!Array.isArray(agents)) return names;
  for (const agent of agents) {
    const id = agent?.agentId;
    const title = typeof agent?.name === 'string' ? agent.name.replace(HIDDEN, '').trim() : '';
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(id)) continue;
    const name = title && !PLACEHOLDER_TITLE.test(title) ? title : fallbackName(id);
    names[`mindstone/${id}`] = name.slice(0, NAME_MAX);
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

/** The names, from the cache or one shared gateway read; never throws. */
function currentNames() {
  if (cached.names && Date.now() - cached.at < cached.ttl) return Promise.resolve(cached.names);
  if (!pending) {
    pending = readNames()
      .then((names) => {
        cached = { at: Date.now(), names, ttl: CACHE_MS };
        return names;
      })
      .catch((error) => {
        logger.warn(
          '[mindstone] could not read agent names for the model menu:',
          error?.message ?? error,
        );
        cached = { at: Date.now(), names: {}, ttl: FAILURE_CACHE_MS };
        return {};
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

router.get('/', requireJwtAuth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  return res.json({ names: await currentNames() });
});

router.namesFromStatus = namesFromStatus;
router.resetCache = () => {
  cached = { at: 0, names: null, ttl: CACHE_MS };
  pending = null;
};

module.exports = router;
