/**
 * Changing one setup choice from Settings (MindStone-Agent #140): onboarding
 * ?change=<step> opens just that step with what is saved, sends the same
 * requests as guided setup, stays on the step after saving, and links back
 * to the page it came from (?from=, known pages only). Guided setup itself
 * is unchanged without ?change=.
 */
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MindStoneOnboardingView from '../OnboardingView';
import { CONFIRMATION } from '../confirmation';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();

jest.mock('librechat-data-provider', () => ({
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));
const mockLocalize = (key: string, values?: Record<string, string>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
}));

const BASE = '/api/mindstone/admin';
const DONE = { done: true, detail: 'done' };
const NOT_DONE = { done: false, detail: 'not done' };
const PROFILES = [
  { id: 'assistant', label: 'Assistant', description: 'General help' },
  { id: 'analyst', label: 'Analyst', description: 'Threat analysis' },
];

let steps: Record<string, { done: boolean; detail: string }>;
let advancedSettings: boolean;
let config: Record<string, unknown>;
let presets: Array<Record<string, unknown>>;

function renderAt(query: string) {
  render(
    <MemoryRouter initialEntries={[`/mindstone/onboarding?${query}`]}>
      <Routes>
        <Route path="/mindstone/onboarding" element={<MindStoneOnboardingView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const button = (name: string) => screen.getByRole('button', { name });
const patchesTo = (section: string) =>
  mockPatch.mock.calls.filter(([url]) => String(url).startsWith(`${BASE}/config/${section}`));

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  steps = { provider: DONE, persona: DONE, memory: DONE, connectors: NOT_DONE };
  advancedSettings = true;
  presets = [];
  config = {
    routing: { mode: 'pi-session', defaultAgentId: 'default', defaultModel: 'ollama/llama3' },
    onboarding: { profile: { id: 'assistant' } },
  };
  mockGet.mockImplementation(async (url: string) => {
    if (url === `${BASE}/status`) return { ok: true, onboarded: true, profiles: PROFILES, steps };
    if (url === `${BASE}/permissions`) return { permissions: { advancedSettings } };
    if (url === `${BASE}/models`) {
      return {
        presets,
        providers: [{ id: 'ollama', name: 'Ollama', configured: true, availableModelCount: 2 }],
        models: [
          { id: 'ollama/llama3', provider: 'ollama' },
          { id: 'ollama/qwen3', provider: 'ollama' },
        ],
      };
    }
    if (url === `${BASE}/config`) {
      return { config, etag: '"e1"' };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mockPatch.mockResolvedValue({ ok: true, changed: ['x'], restartRequired: false });
  mockPost.mockImplementation(async (url: string) => {
    if (url === `${BASE}/permissions/advanced`) {
      advancedSettings = true;
      return { ok: true };
    }
    throw new Error(`unexpected POST ${url}`);
  });
});

describe('changing one setup choice', () => {
  it('opens only the model step, filled in, and saves it in place', async () => {
    renderAt('change=model&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_change_title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'com_mindstone_onb_steps' })).toBeNull();
    expect(screen.getByTestId('ms-onb-change-back')).toHaveAttribute('href', '/mindstone');
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_back' })).toBeNull();
    const select = screen.getByRole('combobox', { name: 'com_mindstone_onb_model_title' });
    await waitFor(() => expect(select).toHaveValue('ollama/llama3'));

    fireEvent.change(select, { target: { value: 'ollama/qwen3' } });
    fireEvent.click(button('com_mindstone_onb_change_save'));
    await screen.findByText('com_mindstone_onb_change_saved');
    expect(patchesTo('routing')).toEqual([
      [
        `${BASE}/config/routing?ifMatch=%22e1%22`,
        { mode: 'pi-session', defaultAgentId: 'default', defaultModel: 'ollama/qwen3' },
      ],
    ]);
    // Still on the model step: a change never moves on to the next one.
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_model_title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_mindstone_onb_persona_title' })).toBeNull();
  });

  it('changes the base persona with the same two writes as setup, and stays', async () => {
    renderAt('change=persona&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_persona_title' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Assistant/ })).toBeChecked());
    fireEvent.click(screen.getByRole('radio', { name: /Analyst/ }));
    fireEvent.click(button('com_mindstone_onb_change_save'));
    await screen.findByText('com_mindstone_onb_change_saved');
    expect(patchesTo('onboarding')).toHaveLength(1);
    expect(patchesTo('onboarding')[0][1]).toMatchObject({
      profile: { id: 'analyst', label: 'Analyst' },
    });
    expect(patchesTo('agents')[0][1]).toEqual({ default: { id: 'default', profileId: 'analyst' } });
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_persona_title' }),
    ).toBeInTheDocument();
  });

  it('says how many memories another embedding model made, before the switch is saved', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/memory/check`) {
        return { ok: true, dimensions: 1024, index: { embedded: 7, otherModel: 5 } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderAt('change=memory&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByTestId('ms-onb-memory-reembed')).toHaveTextContent(
      'com_mindstone_onb_memory_reembed 5',
    );
  });

  it('says re-embedding needs a backfill when automatic recall is turned off', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/memory/check`) {
        return { ok: true, dimensions: 1024, index: { embedded: 7, otherModel: 5 } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderAt('change=memory&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByTestId('ms-onb-memory-reembed')).toHaveTextContent(
      'com_mindstone_onb_memory_reembed_off 5',
    );
  });

  it('a connector whose token is in the host environment keeps it when none is typed', async () => {
    steps = { ...steps, connectors: DONE };
    config = {
      ...config,
      channels: {
        telegram: {
          enabled: true,
          tokenEnv: 'TELEGRAM_BOT_TOKEN',
          ownerSenders: ['9'],
          allowedSenders: ['9'],
        },
      },
    };
    renderAt('change=connectors&from=settings');
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'com_mindstone_onb_connector_telegram' }),
      ).toBeChecked(),
    );
    expect(screen.getByTestId('ms-onb-token-kept')).toHaveTextContent(
      'com_mindstone_onb_token_env',
    );
    expect(button('com_mindstone_onb_change_save')).toBeEnabled();
    fireEvent.click(button('com_mindstone_onb_change_save'));
    await screen.findByText(/com_mindstone_onb_connector_saved/);
    const body = patchesTo('channels')[0][1] as { telegram: Record<string, unknown> };
    // Neither a token file nor a cleared env var: the host's token stays in use.
    expect(body.telegram).toEqual({ enabled: true, ownerSenders: ['9'], allowedSenders: ['9'] });
  });

  it("says nothing about re-embedding when no memory is another model's", async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/memory/check`) {
        return { ok: true, dimensions: 768, index: { embedded: 7, otherModel: 0 } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderAt('change=memory&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await screen.findByText('com_mindstone_onb_memory_ok 768');
    expect(screen.queryByTestId('ms-onb-memory-reembed')).toBeNull();
  });

  it('the provider change offers no way on to the model step', async () => {
    renderAt('change=provider&from=providers');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_provider_title' });
    // Models are usable already: guided setup would offer to go on with them.
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_use_existing' })).toBeNull();
  });

  it('connecting a local provider stays on the step, and so does a refusal', async () => {
    presets = [
      {
        presetId: 'lmstudio',
        providerId: 'lmstudio',
        name: 'LM Studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        needsKey: false,
      },
    ];
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/providers/lmstudio`) return { models: ['lmstudio/qwen'] };
      throw new Error(`unexpected POST ${url}`);
    });
    renderAt('change=provider&from=providers');
    fireEvent.click(await screen.findByRole('radio', { name: 'LM Studio' }));
    fireEvent.click(button('com_mindstone_onb_connect'));
    expect(await screen.findByText('com_mindstone_onb_connected 1')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_provider_title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_mindstone_onb_model_title' })).toBeNull();

    mockPost.mockRejectedValue({ response: { status: 422, data: { error: 'no models listed' } } });
    fireEvent.click(button('com_mindstone_onb_connect'));
    expect(await screen.findByText('no models listed')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_provider_title' }),
    ).toBeInTheDocument();
  });

  it('the persona and memory changes have no Back', async () => {
    renderAt('change=persona&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_persona_title' });
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_back' })).toBeNull();
  });

  it('the memory change has no Back', async () => {
    renderAt('change=memory&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_back' })).toBeNull();
  });

  it('when advanced settings run out mid-change, Access leads back to the same change', async () => {
    mockPatch.mockRejectedValueOnce({
      response: { status: 403, data: { error: 'advanced settings are off' } },
    });
    renderAt('change=model&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    fireEvent.change(screen.getByRole('combobox', { name: 'com_mindstone_onb_model_title' }), {
      target: { value: 'ollama/qwen3' },
    });
    fireEvent.click(button('com_mindstone_onb_change_save'));
    const regrant = await screen.findByRole('button', { name: 'com_mindstone_onb_regrant' });
    advancedSettings = false;
    fireEvent.click(regrant);
    fireEvent.change(await screen.findByRole('textbox', { name: 'com_mindstone_confirmation' }), {
      target: { value: CONFIRMATION },
    });
    fireEvent.click(button('com_mindstone_turn_on'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_change_title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'com_mindstone_onb_steps' })).toBeNull();
  });

  it('a saved connector opens filled in, keeps its token, lists and Discord servers', async () => {
    steps = { ...steps, connectors: DONE };
    config = {
      ...config,
      channels: {
        discord: {
          enabled: true,
          tokenFile: 'secrets/discord-bot.token',
          ownerSenders: ['111'],
          allowedSenders: ['111', '222'],
          allowedGuilds: ['g1'],
        },
      },
    };
    renderAt('change=connectors&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'com_mindstone_onb_connector_discord' }),
      ).toBeChecked(),
    );
    expect(screen.getByRole('textbox', { name: 'com_mindstone_onb_owner_ids' })).toHaveValue('111');
    expect(screen.getByRole('textbox', { name: 'com_mindstone_onb_allowed_ids' })).toHaveValue(
      '111, 222',
    );
    expect(screen.getByTestId('ms-onb-token-kept')).toBeInTheDocument();
    // No new token: the saved one is kept, and so are the servers.
    fireEvent.change(screen.getByRole('textbox', { name: 'com_mindstone_onb_owner_ids' }), {
      target: { value: '111, 333' },
    });
    fireEvent.click(button('com_mindstone_onb_change_save'));
    await screen.findByText(/com_mindstone_onb_connector_saved/);
    expect(mockPost.mock.calls.filter(([url]) => String(url).includes('/secrets/'))).toEqual([]);
    const body = patchesTo('channels')[0][1] as { discord: Record<string, unknown> };
    expect(body.discord).toEqual({
      enabled: true,
      ownerSenders: ['111', '333'],
      allowedSenders: ['111', '222', '333'],
    });
  });

  it('asks for advanced settings first, then opens the step being changed', async () => {
    advancedSettings = false;
    renderAt('change=model&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' });
    fireEvent.change(screen.getByRole('textbox', { name: 'com_mindstone_confirmation' }), {
      target: { value: CONFIRMATION },
    });
    fireEvent.click(button('com_mindstone_turn_on'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    expect(
      screen.getByRole('heading', { name: 'com_mindstone_onb_change_title' }),
    ).toBeInTheDocument();
  });

  it('the connectors change has no Skip and no Back', async () => {
    renderAt('change=connectors&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_skip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_back' })).toBeNull();
    expect(button('com_mindstone_onb_change_save')).toBeDisabled();
  });

  it('goes back only to a page it knows', async () => {
    renderAt('change=provider&from=providers');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_provider_title' });
    expect(screen.getByTestId('ms-onb-change-back')).toHaveAttribute(
      'href',
      '/mindstone/providers',
    );
  });

  it('an unknown ?from= goes back to Settings, never to the value given', async () => {
    renderAt(`change=model&from=${encodeURIComponent('https://example.com/x')}`);
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    expect(screen.getByTestId('ms-onb-change-back')).toHaveAttribute('href', '/mindstone');
  });

  it("is ordinary guided setup when the step can't be opened yet", async () => {
    steps = { provider: NOT_DONE, persona: NOT_DONE, memory: NOT_DONE, connectors: NOT_DONE };
    renderAt('change=model&from=settings');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_title' });
    expect(screen.getByRole('list', { name: 'com_mindstone_onb_steps' })).toBeInTheDocument();
    expect(screen.queryByTestId('ms-onb-change-back')).toBeNull();
  });

  it('is ordinary guided setup without ?change=, moving on after a save', async () => {
    renderAt('step=memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    expect(screen.getByRole('heading', { name: 'com_mindstone_onb_title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_mindstone_onb_back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_mindstone_onb_save_next' })).toBeInTheDocument();
  });
});
