/**
 * MindStone Console proxy (routes/mindstone.js): who may call which gateway
 * admin endpoint, and what the browser gets back. requireCapability is
 * replaced by a stand-in that checks the capability names the route asks for
 * (and platformOnly), so these tests pin the route's wiring; the real
 * capability check is LibreChat's own.
 *
 * The stand-in is stricter than production for tenant users: it refuses any
 * user with a tenantId when platformOnly is set, while the real check
 * (packages/api/src/middleware/capabilities.ts) looks for that user's own
 * grants at platform level. In the single-tenant compose nobody has a
 * tenantId, so it makes no difference there.
 */
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    READ_CONFIGS: 'read:configs',
    MANAGE_CONFIGS: 'manage:configs',
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) =>
    req.user ? next() : res.status(401).json({ message: 'Unauthorized' }),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability:
    (capability, options = {}) =>
    (req, res, next) => {
      const user = req.user;
      if (options.platformOnly && user.tenantId) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      return user.capabilities.includes(capability)
        ? next()
        : res.status(403).json({ message: 'Forbidden' });
    },
}));

const ADMIN = 'access:admin';
const READ = 'read:configs';
const MANAGE = 'manage:configs';

const CALLERS = {
  none: undefined,
  adminOnly: { id: 'u-admin-only', capabilities: [ADMIN] },
  readOnly: { id: 'u-read', capabilities: [ADMIN, READ] },
  manage: { id: 'u-manage', capabilities: [ADMIN, READ, MANAGE] },
  noAdminAccess: { id: 'u-no-admin', capabilities: [READ, MANAGE] },
  tenant: { id: 'u-tenant', tenantId: 't1', capabilities: [ADMIN, READ, MANAGE] },
};

const ENDPOINTS = [
  { method: 'get', path: 'status', write: false },
  { method: 'get', path: 'config', write: false },
  { method: 'get', path: 'permissions', write: false },
  { method: 'patch', path: 'config/memory', write: true },
  { method: 'post', path: 'secrets/telegram-token', write: true },
  { method: 'post', path: 'permissions/advanced', write: true },
  { method: 'get', path: 'models', write: false },
  { method: 'post', path: 'providers/ollama-cloud', write: true },
];

/** What each caller should get from an allowlisted endpoint. */
function expectedStatus(caller, endpoint) {
  if (caller === 'none') {
    return 401;
  }
  if (caller === 'adminOnly' || caller === 'noAdminAccess' || caller === 'tenant') {
    return 403;
  }
  if (caller === 'readOnly') {
    return endpoint.write ? 403 : 200;
  }
  return 200;
}

function gatewayAnswer(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe('MindStone admin proxy', () => {
  let app;
  let fetchMock;
  const savedEnv = {};
  const ENV = {
    MINDSTONE_GATEWAY_URL: 'http://gateway.test:19790/v1',
    MINDSTONE_GATEWAY_TOKEN: 'service-token-synthetic',
    MINDSTONE_ADMIN_TOKEN: 'admin-token-synthetic',
  };

  beforeAll(() => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const router = require('../mindstone');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const caller = req.get('x-test-caller');
      if (caller && CALLERS[caller]) {
        req.user = CALLERS[caller];
      }
      next();
    });
    app.use('/api/mindstone', router);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => gatewayAnswer(200, '{"ok":true}', { etag: '"abc123"' }));
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function call(caller, { method, path }) {
    const req = request(app)[method](`/api/mindstone/admin/${path}`);
    if (caller !== 'none') {
      req.set('x-test-caller', caller);
    }
    return method === 'get' ? req : req.send({ value: 1 });
  }

  describe('every allowlisted endpoint, for every caller', () => {
    const cases = [];
    for (const caller of Object.keys(CALLERS)) {
      for (const endpoint of ENDPOINTS) {
        cases.push([caller, endpoint.method.toUpperCase(), endpoint.path, endpoint]);
      }
    }
    it.each(cases)('%s: %s %s', async (caller, _method, _path, endpoint) => {
      const response = await call(caller, endpoint);
      const expected = expectedStatus(caller, endpoint);
      expect(response.status).toBe(expected);
      if (expected === 200) {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });
  });

  it('a read-only admin is refused any other method before the allowlist', async () => {
    for (const method of ['put', 'delete']) {
      const response = await call('readOnly', { method, path: 'config' });
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an endpoint outside the allowlist is 404 and never reaches the gateway', async () => {
    const outside = [
      ['post', 'v1/chat/completions'],
      ['post', 'config/..%2F..%2Fv1'],
      ['post', 'secrets/../config'],
      // A secret name that can hold a slash would reach any gateway path.
      ['post', 'secrets/a/..%2F..%2Fv1%2Fchat%2Fcompletions'],
      ['post', 'secrets/a%2F..%2F..%2Fv1%2Fchat%2Fcompletions'],
      ['post', 'secrets/..'],
      ['post', 'secrets/.env'],
      ['post', 'secrets/'],
      // Anchored at both ends.
      ['get', 'statusx'],
      ['get', 'xstatus'],
      ['get', 'config/memory'],
      ['get', 'permissionsx'],
      ['patch', 'config/memory/extra'],
      ['patch', 'config/memory%2F..%2F..%2Fv1'],
      ['post', 'permissions/advanced/x'],
      ['post', 'secrets/telegram-token/x'],
      ['get', 'modelsx'],
      ['post', 'providers/ollama/x'],
      ['post', 'providers/Ollama'],
      ['post', 'providers/..%2F..%2Fv1'],
      ['get', 'providers/ollama'],
    ];
    for (const [method, path] of outside) {
      const response = await call('manage', { method, path });
      expect([path, response.status]).toEqual([path, 404]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the gateway with its own credentials and the session user, not the browser headers', async () => {
    await request(app)
      .patch('/api/mindstone/admin/config/memory?ifMatch=%22abc123%22')
      .set('x-test-caller', 'manage')
      .set('x-mindstone-user-role', 'owner')
      .set('x-mindstone-user-id', 'someone-else')
      .set('x-mindstone-admin-token', 'forged')
      .set('if-match', '"forged"')
      .send({ value: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test:19790/admin/config/memory');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      authorization: 'Bearer service-token-synthetic',
      'content-type': 'application/json',
      'x-mindstone-admin-token': 'admin-token-synthetic',
      'x-mindstone-user-id': 'u-manage',
      'x-mindstone-user-role': 'admin',
      'if-match': '"abc123"',
    });
  });

  it("never forwards the browser's own If-Match header", async () => {
    await request(app)
      .patch('/api/mindstone/admin/config/memory')
      .set('x-test-caller', 'manage')
      .set('if-match', '"abc123"')
      .send({ value: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).has('if-match')).toBe(false);
  });

  it('refuses a malformed ifMatch instead of dropping it', async () => {
    const response = await request(app)
      .patch('/api/mindstone/admin/config/memory?ifMatch=abc')
      .set('x-test-caller', 'manage')
      .send({ value: 1 });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the gateway's JSON answer through with its etag, uncached", async () => {
    const response = await call('manage', { method: 'get', path: 'config' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers.etag).toBe('"abc123"');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it("passes the gateway's JSON refusals through, so the page can show them", async () => {
    fetchMock.mockImplementation(async () =>
      gatewayAnswer(412, '{"ok":false,"error":"the config changed"}'),
    );
    const response = await call('manage', { method: 'patch', path: 'config/memory' });
    expect(response.status).toBe(412);
    expect(response.body.error).toBe('the config changed');
  });

  it('never passes a gateway 5xx or a body that is not JSON to the browser', async () => {
    for (const [status, body] of [
      [500, '{"ok":false,"error":"ENOENT: /home/synthetic/.mindstone/config.json"}'],
      [200, '<html>ENOENT /home/synthetic/.mindstone/config.json</html>'],
      [404, '<html>proxy error at 10.0.0.9</html>'],
    ]) {
      fetchMock.mockImplementation(async () => gatewayAnswer(status, body));
      const response = await call('manage', { method: 'get', path: 'config' });
      expect(response.status).toBe(502);
      expect(response.text).not.toMatch(/ENOENT|synthetic|10\.0\.0\.9/);
    }
  });

  it("turns the gateway refusing the Console's credentials into a 502, not a logout", async () => {
    fetchMock.mockImplementation(async () => gatewayAnswer(401, '{"ok":false}'));
    const response = await call('manage', { method: 'get', path: 'config' });
    expect(response.status).toBe(502);
  });

  it('a failed gateway call never echoes the error', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED Bearer service-token-synthetic');
    });
    const response = await call('manage', { method: 'get', path: 'config' });
    expect(response.status).toBe(502);
    expect(response.text).not.toMatch(/token|ECONNREFUSED/);
  });
});
