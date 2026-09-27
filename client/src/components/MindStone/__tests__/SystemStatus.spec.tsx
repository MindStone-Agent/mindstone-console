import { render, screen } from '@testing-library/react';
import SystemStatus, { type SystemStatusData } from '../SystemStatus';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}[${Object.values(values).join('|')}]` : key,
}));

/** Shaped like the gateway's MindStoneSystemStatus (mindstone-core status/status.ts). */
const healthy: SystemStatusData = {
  ok: true,
  config: { path: '/home/ms/.mindstone/mindstone.json', exists: true, agentCount: 1 },
  agents: [{ agentId: 'main', name: 'Mira', identityExists: true, userExists: true }],
  handoff: { exists: true, bytes: 4200, updatedAt: '2026-09-27T20:00:00Z', tokenEstimate: 1050 },
  gateway: {
    baseUrl: 'http://127.0.0.1:19789',
    auth: { mode: 'token', required: true },
    http: { modelsEnabled: true, chatCompletionsEnabled: true, responsesEnabled: false },
  },
  webchat: { enabled: true, url: 'http://127.0.0.1:19789/webchat', apiAuthApplies: true },
  memory: {
    sqlite: {
      present: true,
      sources: 12,
      chunks: 340,
      embeddedChunks: 338,
      duplicateTextChunks: 0,
      vectorBackend: 'sqlite-vec',
      sqliteVec: { available: true, version: 'v0.1.6' },
    },
  },
  routing: { mode: 'single', defaultAgentId: 'main', defaultModel: 'claude-sonnet-5' },
  piSessionSafety: {
    active: true,
    routingMode: 'single',
    usesGlobalPiAgentDir: false,
    resumeCap: { enabled: true, maxEntries: 800 },
  },
  personas: {
    count: 3,
    brokenCount: 0,
    resolvedForDefaultSession: { personaId: 'engineer', reason: 'default' },
  },
  skills: { builtinCount: 5, installedCount: 2, draftCount: 1, brokenCount: 0 },
  knowledgebases: { count: 1, indexedCount: 1, brokenCount: 0, entryCount: 40 },
  connectors: [
    {
      connectorId: 'telegram',
      enabled: true,
      credential: { configured: true, present: true, source: 'file' },
      sendPolicy: { effective: 'approval', overridden: false },
      runtime: { state: 'running' },
      queue: { pending: 4, delivered: 120, dead: 0 },
    },
  ],
};

const problems = (): SystemStatusData => ({
  ...healthy,
  ok: false,
  config: { path: '/x/mindstone.json', exists: false, agentCount: 0 },
  memory: {
    sqlite: {
      present: true,
      vectorBackend: 'js-cosine',
      sqliteVec: { available: false, error: 'extension not found' },
    },
  },
  piSessionSafety: { active: false, usesGlobalPiAgentDir: true },
  personas: { count: 2, brokenCount: 1 },
  connectors: [
    {
      connectorId: 'slack',
      enabled: true,
      credential: { configured: true, present: false, error: 'SLACK_BOT_TOKEN is not set' },
      sendPolicy: { effective: 'auto', overridden: true, warning: 'slack sends without approval' },
      runtime: { state: 'error', lastError: 'invalid_auth' },
      queue: { pending: 0, delivered: 3, dead: 2 },
    },
  ],
  agents: [{ agentId: 'ghost', identityExists: false, error: 'IDENTITY.md unreadable' }],
  handoff: { exists: false, bytes: 0 },
});

describe('MindStone SystemStatus', () => {
  it('says so when the gateway sends no system block', () => {
    render(<SystemStatus system={undefined} />);
    expect(screen.getByTestId('ms-system-empty')).toHaveTextContent('com_mindstone_sys_none');
  });

  it('renders every section of a healthy status, including connector queue depth', () => {
    render(<SystemStatus system={healthy} />);
    expect(screen.getByTestId('ms-system-overall')).toHaveTextContent('com_mindstone_sys_ok');
    for (const heading of [
      'com_mindstone_sys_gateway',
      'com_mindstone_sys_webchat',
      'com_mindstone_sys_memory',
      'com_mindstone_sys_pi',
      'com_mindstone_sys_content',
      'com_mindstone_sys_connectors',
      'com_mindstone_sys_agents',
      'com_mindstone_sys_handoff',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText('http://127.0.0.1:19789')).toBeInTheDocument();
    expect(screen.getByTestId('ms-sys-memory')).toHaveTextContent(
      'com_mindstone_sys_memory_counts[12|340|338]',
    );
    expect(screen.getByTestId('ms-sys-personas')).toHaveTextContent('[3|engineer]');
    const telegram = screen.getByTestId('ms-sys-connector-telegram');
    expect(telegram).toHaveTextContent('com_mindstone_sys_queue[4|120|0]');
    expect(telegram).toHaveTextContent('com_mindstone_sys_send_policy[approval]');
    expect(telegram).toHaveTextContent('running');
    expect(screen.getByTestId('ms-sys-agent-main')).toHaveTextContent('Mira');
    expect(
      screen.getByText('com_mindstone_sys_handoff_detail', { exact: false }),
    ).toHaveTextContent('[1,050|');
    // A healthy status shows no warnings or errors.
    expect(document.querySelector('.text-red-500, .text-orange-500')).toBeNull();
  });

  it('surfaces every problem the gateway reports', () => {
    render(<SystemStatus system={problems()} />);
    expect(screen.getByTestId('ms-system-overall')).toHaveTextContent('com_mindstone_sys_not_ok');
    expect(
      screen.getByText('com_mindstone_sys_config_missing[/x/mindstone.json]'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('com_mindstone_sys_sqlite_vec[extension not found]'),
    ).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_sys_pi_global')).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_sys_broken[1|0|0]')).toBeInTheDocument();
    const slack = screen.getByTestId('ms-sys-connector-slack');
    expect(slack).toHaveTextContent('SLACK_BOT_TOKEN is not set');
    expect(slack).toHaveTextContent('slack sends without approval');
    expect(slack).toHaveTextContent('invalid_auth');
    expect(slack).toHaveTextContent('com_mindstone_sys_dead[2]');
    expect(screen.getByTestId('ms-sys-agent-ghost')).toHaveTextContent(
      'com_mindstone_sys_no_identity',
    );
    expect(screen.getByTestId('ms-sys-agent-ghost')).toHaveTextContent('IDENTITY.md unreadable');
    expect(screen.getByText('com_mindstone_sys_handoff_none')).toBeInTheDocument();
  });

  it('does not crash on a partial or differently shaped status from another gateway version', () => {
    const odd = {
      ok: true,
      connectors: 'n/a',
      memory: {},
      agents: null,
    } as unknown as SystemStatusData;
    const { unmount } = render(<SystemStatus system={odd} />);
    expect(screen.getByTestId('ms-system-overall')).toHaveTextContent('com_mindstone_sys_ok');
    expect(screen.queryByRole('heading', { name: 'com_mindstone_sys_connectors' })).toBeNull();
    unmount();
    const holes = { ...healthy, connectors: [null, healthy.connectors![0]], agents: [null] };
    render(<SystemStatus system={holes as unknown as SystemStatusData} />);
    expect(screen.getByTestId('ms-sys-connector-telegram')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_mindstone_sys_agents' })).toBeNull();
  });

  it('says when no connectors are configured', () => {
    render(<SystemStatus system={{ ...healthy, connectors: [] }} />);
    expect(screen.getByText('com_mindstone_sys_connectors_none')).toBeInTheDocument();
  });
});

describe('MindStone SystemStatus against a real gateway payload', () => {
  /** Captured from a live gateway's GET /admin/status (paths rewritten): an enabled Telegram
   *  connector whose token file is missing, and a disabled Discord connector. */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('./gatewayStatus.fixture.json') as SystemStatusData;

  it('renders it, and shows the broken connector once even though the core checks pass', () => {
    render(<SystemStatus system={real} />);
    expect(screen.getByTestId('ms-system-overall')).toHaveTextContent('com_mindstone_sys_ok');
    const telegram = screen.getByTestId('ms-sys-connector-telegram');
    expect(telegram).toHaveTextContent('com_mindstone_sys_enabled_lc');
    expect(telegram).toHaveTextContent('error');
    expect(telegram.querySelectorAll('.text-red-500')).toHaveLength(1);
    expect(telegram).toHaveTextContent('credential unresolved: secret file not found');
    expect(screen.getByTestId('ms-sys-connector-discord')).toHaveTextContent('never started');
    expect(screen.getByTestId('ms-sys-agent-default')).toBeInTheDocument();
  });
});

describe('MindStone SystemStatus memory without a database', () => {
  it('says there is no database yet, without also warning about the vector extension', () => {
    const system = {
      ...healthy,
      memory: {
        sqlite: { present: false, sqliteVec: { available: false, error: 'database not present' } },
      },
    };
    render(<SystemStatus system={system} />);
    expect(screen.getByText('com_mindstone_sys_memory_none')).toBeInTheDocument();
    expect(screen.queryByText(/com_mindstone_sys_sqlite_vec/)).toBeNull();
  });
});

describe('MindStone SystemStatus persona line', () => {
  it('leaves out the default persona when none resolves', () => {
    render(<SystemStatus system={{ ...healthy, personas: { count: 0, brokenCount: 0 } }} />);
    expect(screen.getByTestId('ms-sys-personas')).toHaveTextContent(
      'com_mindstone_sys_personas_count[0]',
    );
  });
});
