/**
 * Display names for MindStone's models (routes/mindstoneModelNames.js, #53):
 * any signed-in user gets { "mindstone/<agentId>": name } and nothing else
 * from the gateway status; without a session, 401; a gateway failure gives
 * no names, not an error.
 */
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) =>
    req.user ? next() : res.status(401).json({ message: 'Unauthorized' }),
}));

const router = require('../mindstoneModelNames');

function app(user) {
  const a = express();
  a.use((req, res, next) => {
    req.user = user;
    next();
  });
  a.use('/api/mindstone-model-names', router);
  return a;
}

const STATUS = {
  onboarded: true,
  steps: {},
  config: { path: '/secret/path/mindstone.json' },
  system: {
    agents: [
      { agentId: 'default', name: 'Cairn', identityExists: true, error: 'x' },
      { agentId: 'analyst', name: '  Threat Analyst  ' },
      { agentId: 'noname' },
      { agentId: '../evil', name: 'Evil' },
      { agentId: 'long', name: 'x'.repeat(200) },
    ],
  },
};

describe('MindStone model names (#53)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    router.resetCache();
    process.env.MINDSTONE_GATEWAY_URL = 'http://gateway:18789/v1';
    process.env.MINDSTONE_GATEWAY_TOKEN = 'service-token';
    process.env.MINDSTONE_ADMIN_TOKEN = 'admin-token';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => STATUS }));
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('gives a signed-in user (not only admins) the agent names, and nothing else', async () => {
    const res = await request(app({ id: 'u1', role: 'USER' })).get('/api/mindstone-model-names');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      names: {
        'mindstone/default': 'Cairn',
        'mindstone/analyst': 'Threat Analyst',
        'mindstone/noname': 'MindStone (noname)',
        'mindstone/long': 'x'.repeat(80),
      },
    });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('http://gateway:18789/admin/status');
    expect(init.headers['x-mindstone-admin-token']).toBe('admin-token');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('refuses a request without a session', async () => {
    const res = await request(app(undefined)).get('/api/mindstone-model-names');
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('gives no names, not an error, when the gateway fails or is not configured', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    let res = await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: {} });

    router.resetCache();
    delete process.env.MINDSTONE_ADMIN_TOKEN;
    res = await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    expect(res.body).toEqual({ names: {} });
  });

  it('asks the gateway once for requests that arrive together, and remembers a failure', async () => {
    let finish;
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, json: async () => STATUS });
        }),
    );
    const both = Promise.all([
      request(app({ id: 'u1' })).get('/api/mindstone-model-names'),
      request(app({ id: 'u2' })).get('/api/mindstone-model-names'),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    finish();
    const [a, b] = await both;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(a.body).toEqual(b.body);

    router.resetCache();
    global.fetch = jest.fn(async () => {
      throw new Error('connection refused');
    });
    await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("shows MindStone, not setup's placeholder title, for an agent without a name of its own", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        system: {
          agents: [
            { agentId: 'default', name: 'MindStone Agent Identity Pending' },
            { agentId: 'helper', name: 'mindstone agent identity pending' },
          ],
        },
      }),
    }));
    const res = await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    expect(res.body).toEqual({
      names: { 'mindstone/default': 'MindStone', 'mindstone/helper': 'MindStone (helper)' },
    });
  });

  it('strips hidden characters from names', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        system: { agents: [{ agentId: 'default', name: 'Ca\u202Eirn\u200B' }] },
      }),
    }));
    const res = await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    expect(res.body).toEqual({ names: { 'mindstone/default': 'Cairn' } });
  });

  it('asks the gateway at most once a minute', async () => {
    await request(app({ id: 'u1' })).get('/api/mindstone-model-names');
    await request(app({ id: 'u2' })).get('/api/mindstone-model-names');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
