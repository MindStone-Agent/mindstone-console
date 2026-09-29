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
  { method: 'post', path: 'providers/enterprise/azure-openai', write: true },
  { method: 'post', path: 'providers/enterprise-azure/test', write: true },
  { method: 'post', path: 'providers/ollama-cloud/test', write: true },
  { method: 'delete', path: 'providers/enterprise-azure', write: true },
  { method: 'post', path: 'restart', write: true },
  { method: 'get', path: 'doctor', write: false },
  { method: 'get', path: 'logs', write: false },
  { method: 'get', path: 'approvals', write: false },
  { method: 'get', path: 'approvals/0b5e7c1a-1111-4222-8333-444455556666', write: false },
  { method: 'get', path: 'approvals/0b5e7c1a', write: false },
  { method: 'post', path: 'approvals/0b5e7c1a-1111-4222-8333-444455556666/approve', write: true },
  { method: 'post', path: 'approvals/0b5e7c1a/reject', write: true },
  { method: 'get', path: 'secrets', write: false },
  { method: 'delete', path: 'secrets/telegram-token', write: true },
  { method: 'get', path: 'skills', write: false },
  { method: 'get', path: 'skills/weekly-report', write: false },
  { method: 'get', path: 'skills/integration-builder', write: false },
  { method: 'post', path: 'skills/drafts', write: true },
  { method: 'delete', path: 'skills/drafts/weekly-report', write: true },
  { method: 'post', path: 'skills/weekly-report/install', write: true },
  { method: 'post', path: 'onboarding/complete', write: true },
  { method: 'post', path: 'memory/check', write: true },
  { method: 'post', path: 'memory/pull', write: true },
  { method: 'get', path: 'personas', write: false },
  // The persona builder (MindStone-Agent #125).
  { method: 'post', path: 'personas', write: true },
  { method: 'get', path: 'personas/analyst', write: false },
  { method: 'get', path: 'personas/Pack.Analyst_2', write: false },
  { method: 'patch', path: 'personas/analyst', write: true },
  { method: 'get', path: 'workflows', write: false },
  { method: 'post', path: 'workflows', write: true },
  { method: 'get', path: 'workflows/triage', write: false },
  { method: 'patch', path: 'workflows/triage', write: true },
  { method: 'get', path: 'knowledgebases', write: false },
  { method: 'get', path: 'personas/analyst/knowledgebases', write: false },
  { method: 'post', path: 'personas/analyst/knowledgebases', write: true },
  { method: 'get', path: 'personas/analyst/knowledgebases/notes/sources', write: false },
  { method: 'post', path: 'personas/analyst/knowledgebases/notes/sources', write: true },
  { method: 'post', path: 'personas/analyst/knowledgebases/notes/ingest', write: true },
  { method: 'post', path: 'knowledgebases/g1/reembed', write: true },
  { method: 'post', path: 'knowledgebases/HR_Hand.book/reembed', write: true },
  { method: 'post', path: 'personas/analyst/knowledgebases/notes/reembed', write: true },
  // USER.md from Settings (MindStone-Agent #140).
  { method: 'get', path: 'user', write: false },
  { method: 'patch', path: 'user', write: true },
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
      ['post', 'providers/'],
      ['post', 'providers/..'],
      ['post', 'providers/%2E%2E'],
      ['post', 'providers/.ollama'],
      ['post', 'providers/-'],
      ['post', 'providers/ollama%00'],
      ['post', 'providers/ollama%0A'],
      ['post', 'providers/ol.lama'],
      ['post', 'x/providers/ollama'],
      // Enterprise endpoints: register, test and remove, exactly.
      ['post', 'providers/enterprise/azure-openai/x'],
      ['post', 'providers/enterprise/..%2F..%2Fv1'],
      ['post', 'providers/enterprise/'],
      ['get', 'providers/enterprise/azure-openai'],
      ['post', 'providers/enterprise-azure/testx'],
      ['post', 'providers/enterprise-azure/test/x'],
      ['get', 'providers/enterprise-azure/test'],
      ['post', 'providers/-x/test'],
      ['post', 'providers/../test'],
      ['delete', 'providers/ollama'],
      ['delete', 'providers/enterprise-azure/x'],
      ['delete', 'providers/enterprise-'],
      ['delete', 'providers/enterprise-Azure'],
      ['delete', 'providers/enterprise'],
      ['get', 'x/models'],
      // Restart: POST only, exactly.
      ['get', 'restart'],
      ['post', 'restartx'],
      ['post', 'restart/now'],
      ['post', 'x/restart'],
      ['delete', 'restart'],
      // Diagnostics: GET doctor and logs only.
      ['get', 'doctorx'],
      ['get', 'doctor/x'],
      ['get', 'logs/'],
      ['get', 'logs/x'],
      ['get', 'x/logs'],
      ['get', 'x/doctor'],
      ['post', 'doctor'],
      ['post', 'logs'],
      ['patch', 'logs'],
      // Approvals: lowercase ids of 8 to 36 characters, approve or reject, nothing else.
      ['get', 'approvalsx'],
      ['get', 'approvals/'],
      ['get', 'approvals/0b5e7c1'],
      ['get', 'approvals/0B5E7C1A'],
      ['get', 'approvals/0b5e7c1a-1111-4222-8333-4444555566667'],
      ['get', 'approvals/0b5e7c1a/approve'],
      ['get', 'approvals/..%2Fconfig'],
      ['get', 'approvals/0b5e7c1a%2F..'],
      ['post', 'approvals'],
      ['post', 'approvals/0b5e7c1a'],
      ['post', 'approvals/0b5e7c1a/approvex'],
      ['post', 'approvals/0b5e7c1a/delete'],
      ['post', 'approvals/0b5e7c1a/approve/x'],
      ['post', 'approvals/0b5e7c1g/approve'],
      ['post', 'approvals/0B5E7C1A/approve'],
      ['post', 'approvals/0b5e.7c1a/approve'],
      ['post', 'x/approvals/0b5e7c1a/approve'],
      ['patch', 'approvals/0b5e7c1a/approve'],
      // Stored secrets: list, and delete one by a plain name.
      ['get', 'secretsx'],
      ['get', 'secrets/'],
      ['get', 'secrets/telegram-token'],
      ['get', 'x/secrets'],
      ['delete', 'secrets'],
      ['delete', 'secrets/'],
      ['delete', 'secrets/..'],
      ['delete', 'secrets/.env'],
      ['delete', 'secrets/..%2Fconfig.json'],
      ['delete', 'secrets/a%2F..%2F..%2Fconfig.json'],
      ['delete', 'secrets/a/b'],
      ['delete', 'x/secrets/a'],
      ['delete', `secrets/${'a'.repeat(65)}`],
      ['delete', 'config/memory'],
      ['delete', 'permissions/advanced'],
      ['patch', 'config/mem.ory'],
      // Skills: lowercase ids of up to 64 characters; list, show, draft, discard, install.
      ['get', 'skillsx'],
      ['get', 'skills/'],
      ['get', 'skills/Weekly-Report'],
      ['get', 'skills/-weekly'],
      ['get', 'skills/weekly_report'],
      ['get', 'skills/weekly.report'],
      ['get', `skills/${'a'.repeat(65)}`],
      ['get', 'skills/..%2Fconfig'],
      ['get', 'skills/a%2F..%2F..%2Fconfig'],
      ['get', 'skills/weekly-report/install'],
      ['get', 'skills/drafts/weekly-report'],
      ['get', 'x/skills'],
      ['post', 'skills'],
      ['post', 'skills/weekly-report'],
      ['post', 'skills/drafts/weekly-report'],
      ['post', 'skills/drafts/x/install'],
      ['post', 'skills/weekly-report/install/x'],
      ['post', 'skills/Weekly/install'],
      ['post', 'skills/..%2Fconfig/install'],
      ['post', 'skills/weekly-report/installx'],
      ['patch', 'skills/drafts'],
      ['patch', 'skills/weekly-report'],
      ['delete', 'skills'],
      ['delete', 'skills/weekly-report'],
      ['delete', 'skills/drafts'],
      ['delete', 'skills/drafts/'],
      ['delete', 'skills/drafts/..'],
      ['delete', 'skills/drafts/a%2F..%2F..%2Fconfig'],
      ['delete', 'skills/drafts/a/b'],
      ['delete', `skills/drafts/${'a'.repeat(65)}`],
      ['delete', 'skills/weekly-report/install'],
      // Anchored at the start too: a prefix never reaches a skill route.
      ['get', 'x/skills/a'],
      ['post', 'x/skills/drafts'],
      ['delete', 'x/skills/drafts/a'],
      ['post', 'x/skills/a/install'],
      ['get', '..%2Fv1%2Fskills/a'],
      ['post', '..%2Fv1%2Fskills/a/install'],
      ['delete', 'v1/skills/drafts/a'],
      // Guided setup (MindStone-Agent #102): POST onboarding/complete, memory/check and memory/pull only.
      ['get', 'onboarding/complete'],
      ['delete', 'onboarding/complete'],
      ['post', 'onboarding'],
      ['post', 'onboarding/completex'],
      ['post', 'onboarding/complete/x'],
      ['post', 'x/onboarding/complete'],
      ['get', 'memory/check'],
      ['patch', 'memory/check'],
      ['post', 'memory'],
      ['post', 'memory/checkx'],
      ['post', 'memory/check/x'],
      ['post', 'memory/check%2F..%2F..%2Fv1'],
      ['post', 'x/memory/check'],
      ['get', 'memory/pull'],
      ['delete', 'memory/pull'],
      ['post', 'memory/pullx'],
      ['post', 'memory/pull/x'],
      ['post', 'x/memory/pull'],
      ['post', 'memory/models/pull'],
      // Personas (#105, #125): no delete, no path tricks, no other methods.
      ['get', 'personas/'],
      ['get', 'personasx'],
      ['get', 'x/personas'],
      ['delete', 'personas'],
      ['patch', 'personas'],
      ['delete', 'personas/x'],
      ['post', 'personas/x'],
      ['get', 'personas/..'],
      ['get', 'personas/.hidden'],
      ['patch', 'personas/..'],
      ['get', 'personas%2F..%2Fconfig'],
      ['get', 'personas/a%2F..%2F..%2Fconfig'],
      ['get', `personas/${'a'.repeat(129)}`],
      ['delete', 'workflows/triage'],
      ['post', 'workflows/triage'],
      ['get', 'workflows/Triage'],
      ['get', 'workflows/..'],
      ['post', 'knowledgebases'],
      ['get', 'knowledgebases/g1'],
      ['get', 'knowledgebases/g1/reembed'],
      ['post', 'knowledgebases/.hidden/reembed'],
      ['post', 'knowledgebases/g1/reembed/x'],
      ['patch', 'personas/analyst/knowledgebases'],
      ['post', 'personas/analyst/knowledgebases/Notes/sources'],
      ['post', 'personas/analyst/knowledgebases/../sources'],
      ['post', 'personas/analyst/knowledgebases/notes/sources/x'],
      ['get', 'personas/analyst/knowledgebases/notes/ingest'],
      ['delete', 'personas/analyst/knowledgebases/notes'],
      ['post', 'personas/analyst/knowledgebases/notes/sources%2F..%2F..'],
      // USER.md (#140): read and replace only, at exactly that path.
      ['post', 'user'],
      ['delete', 'user'],
      ['get', 'user/x'],
      ['patch', 'users'],
      ['get', 'user%2F..%2Fconfig'],
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

  it('forwards only all=1, and only on the approvals list', async () => {
    const cases = [
      ['approvals?all=1', 'http://gateway.test:19790/admin/approvals?all=1'],
      ['approvals?all=1&x=2', 'http://gateway.test:19790/admin/approvals?all=1'],
      ['approvals?all=true', 'http://gateway.test:19790/admin/approvals'],
      ['approvals?x=1', 'http://gateway.test:19790/admin/approvals'],
      ['status?all=1', 'http://gateway.test:19790/admin/status'],
      ['approvals/0b5e7c1a?all=1', 'http://gateway.test:19790/admin/approvals/0b5e7c1a'],
    ];
    for (const [path, expected] of cases) {
      fetchMock.mockClear();
      await request(app).get(`/api/mindstone/admin/${path}`).set('x-test-caller', 'manage');
      expect([path, fetchMock.mock.calls[0]?.[0]]).toEqual([path, expected]);
    }
  });

  it('forwards only a known source, and only on reading one skill', async () => {
    const cases = [
      ['skills/weekly-report', 'http://gateway.test:19790/admin/skills/weekly-report'],
      [
        'skills/weekly-report?source=draft',
        'http://gateway.test:19790/admin/skills/weekly-report?source=draft',
      ],
      [
        'skills/weekly-report?source=installed&x=1',
        'http://gateway.test:19790/admin/skills/weekly-report?source=installed',
      ],
      [
        'skills/integration-builder?source=builtin',
        'http://gateway.test:19790/admin/skills/integration-builder?source=builtin',
      ],
      ['skills?source=draft', 'http://gateway.test:19790/admin/skills'],
      ['status?source=draft', 'http://gateway.test:19790/admin/status'],
      ['approvals?source=draft', 'http://gateway.test:19790/admin/approvals'],
    ];
    for (const [path, expected] of cases) {
      fetchMock.mockClear();
      await request(app).get(`/api/mindstone/admin/${path}`).set('x-test-caller', 'manage');
      expect([path, fetchMock.mock.calls[0]?.[0]]).toEqual([path, expected]);
    }
    // A write never carries it.
    for (const write of ['skills/drafts', 'skills/weekly-report/install']) {
      fetchMock.mockClear();
      await request(app)
        .post(`/api/mindstone/admin/${write}?source=draft`)
        .set('x-test-caller', 'manage')
        .send({});
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://gateway.test:19790/admin/${write}`);
    }
    for (const bad of ['Draft', 'drafts', '', 'x', '%2F..', 'draft&source=builtin']) {
      fetchMock.mockClear();
      const response = await request(app)
        .get(`/api/mindstone/admin/skills/weekly-report?source=${bad}`)
        .set('x-test-caller', 'manage');
      expect([bad, response.status]).toEqual([bad, 400]);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('forwards only a digits-only lines, and only on logs', async () => {
    const cases = [
      ['logs', 'http://gateway.test:19790/admin/logs'],
      ['logs?lines=80', 'http://gateway.test:19790/admin/logs?lines=80'],
      ['logs?lines=500&x=1', 'http://gateway.test:19790/admin/logs?lines=500'],
      ['logs?x=1', 'http://gateway.test:19790/admin/logs'],
      ['doctor?lines=5', 'http://gateway.test:19790/admin/doctor'],
      ['status?lines=5', 'http://gateway.test:19790/admin/status'],
      ['approvals?lines=5', 'http://gateway.test:19790/admin/approvals'],
      ['logs?all=1', 'http://gateway.test:19790/admin/logs'],
    ];
    for (const [path, expected] of cases) {
      fetchMock.mockClear();
      await request(app).get(`/api/mindstone/admin/${path}`).set('x-test-caller', 'manage');
      expect([path, fetchMock.mock.calls[0]?.[0]]).toEqual([path, expected]);
    }
    for (const bad of ['-1', '1.5', 'abc', '1000', '', '%2F..', '5&lines=6']) {
      fetchMock.mockClear();
      const response = await request(app)
        .get(`/api/mindstone/admin/logs?lines=${bad}`)
        .set('x-test-caller', 'manage');
      expect([bad, response.status]).toEqual([bad, 400]);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("waits past the gateway's own limits on the embed check and the model download, 15 s elsewhere", async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      for (const [method, path, expected] of [
        ['post', 'memory/pull', 16 * 60_000],
        ['post', 'memory/check', 55_000],
        ['post', 'onboarding/complete', 15_000],
        ['get', 'status', 15_000],
        // A private KB's ingest fetches its URL sources (#125).
        ['post', 'personas/analyst/knowledgebases/notes/ingest', 4 * 60_000],
        ['post', 'personas/analyst/knowledgebases/notes/sources', 15_000],
        // Approving a proposed private KB ingests it before answering.
        ['post', 'approvals/0b5e7c1a-1111-4222-8333-444455556666/approve', 4 * 60_000],
        ['post', 'approvals/0b5e7c1a-1111-4222-8333-444455556666/reject', 15_000],
      ]) {
        timeout.mockClear();
        await call('manage', { method, path });
        expect([path, timeout.mock.calls]).toEqual([path, [[expected]]]);
      }
    } finally {
      timeout.mockRestore();
    }
  });

  it('passes the setup body through as sent', async () => {
    await request(app)
      .post('/api/mindstone/admin/memory/check?embeddingProvider=x')
      .set('x-test-caller', 'manage')
      .send({ embeddingProvider: 'ollama:nomic-embed-text' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test:19790/admin/memory/check');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ embeddingProvider: 'ollama:nomic-embed-text' });
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

  it('a gateway that takes too long is a 504 gateway_timeout, not a 502', async () => {
    fetchMock.mockImplementation(async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const response = await call('manage', {
      method: 'post',
      path: 'personas/analyst/knowledgebases/notes/ingest',
    });
    expect(response.status).toBe(504);
    expect(response.body.code).toBe('gateway_timeout');
  });

  describe('a model download, which answers only when it ends (MindStone-Agent #145)', () => {
    const { LONG_WAIT } = require('../mindstone');
    const saved = LONG_WAIT.heartbeatMs;
    beforeEach(() => {
      LONG_WAIT.heartbeatMs = 20;
    });
    afterEach(() => {
      LONG_WAIT.heartbeatMs = saved;
    });
    const later = (settle, ms) =>
      new Promise((resolve, reject) => setTimeout(() => settle(resolve, reject), ms));
    const accepted = (text) => ({ status: 200, headers: { get: () => null }, text });
    const pull = () => call('manage', { method: 'post', path: 'memory/pull' });

    it('sends newlines while it runs, then the JSON', async () => {
      fetchMock.mockImplementation(async () =>
        accepted(() => later((resolve) => resolve('{"ok":true}'), 150)),
      );
      const response = await pull();
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text.startsWith('\n')).toBe(true);
      expect(JSON.parse(response.text)).toEqual({ ok: true });
    });

    it("passes the gateway's refusals through with their status, so the page can offer the permission", async () => {
      for (const status of [403, 409]) {
        fetchMock.mockImplementation(async () =>
          gatewayAnswer(status, '{"ok":false,"error":"refused"}'),
        );
        const response = await pull();
        expect(response.status).toBe(status);
        expect(response.body.error).toBe('refused');
      }
    });

    it("ends with an error of its own when the gateway's answer isn't JSON, never the answer", async () => {
      fetchMock.mockImplementation(async () =>
        accepted(() => later((resolve) => resolve('<html>ENOENT /home/synthetic</html>'), 60)),
      );
      const response = await pull();
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).ok).toBe(false);
      expect(response.text).not.toMatch(/ENOENT|synthetic/);
    });

    it('ends with gateway_timeout when the Console stops waiting', async () => {
      fetchMock.mockImplementation(async () =>
        accepted(() =>
          later((_resolve, reject) => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          }, 60),
        ),
      );
      const response = await pull();
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).code).toBe('gateway_timeout');
    });

    it('gets each newline past compression as it is written, not at the end', async () => {
      // The Console mounts compression(), which holds small writes until flushed.
      const http = require('node:http');
      const compressed = express();
      compressed.use(require('compression')());
      compressed.use(express.json());
      compressed.use((req, _res, next) => {
        req.user = CALLERS.manage;
        next();
      });
      compressed.use('/api/mindstone', require('../mindstone'));
      fetchMock.mockImplementation(async () =>
        accepted(() => later((resolve) => resolve('{"ok":true}'), 300)),
      );
      const server = compressed.listen(0);
      try {
        const started = Date.now();
        const firstByteAfter = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              port: server.address().port,
              method: 'POST',
              path: '/api/mindstone/admin/memory/pull',
              headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
            },
            (res) => {
              // Decoded: gzip sends its own header at the first write, before any newline.
              const decoded = res.pipe(require('node:zlib').createGunzip());
              decoded.once('data', () => resolve(Date.now() - started));
              decoded.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end('{}');
        });
        expect(firstByteAfter).toBeLessThan(200);
      } finally {
        server.closeAllConnections?.();
        server.close();
      }
    });

    it('a browser that leaves stops the download on the gateway', async () => {
      let signal;
      fetchMock.mockImplementation(async (_url, init) => {
        signal = init.signal;
        return accepted(
          () =>
            new Promise((_resolve, reject) =>
              init.signal.addEventListener('abort', () => reject(init.signal.reason)),
            ),
        );
      });
      await expect(pull().timeout(150)).rejects.toThrow();
      for (let i = 0; i < 50 && !signal?.aborted; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(signal?.aborted).toBe(true);
    });
  });
});
