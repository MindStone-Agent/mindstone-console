/**
 * Guided setup after the persona (MindStone-Agent #102): memory is required
 * and passes a live embed check first, a connector is optional, what the
 * agent should know is sent once, and "Start a chat" sends the first hello.
 * The settings page links straight to a step with ?step=.
 */
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MindStoneOnboardingView from '../OnboardingView';

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
const CHECK_OK = { ok: true, providerId: 'ollama', model: 'nomic-embed-text', dimensions: 768 };

let steps: Record<string, { done: boolean; detail: string }>;
let advancedSettings: boolean;
let onboarded: boolean;
let statusFails: boolean;

function ChatProbe() {
  const location = useLocation();
  return <p data-testid="chat-page">{location.search}</p>;
}

function renderAt(step?: string) {
  const entry = step ? `/mindstone/onboarding?step=${step}` : '/mindstone/onboarding';
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/mindstone/onboarding" element={<MindStoneOnboardingView />} />
        <Route path="/c/new" element={<ChatProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Calls to one endpoint, by path. */
function postsTo(path: string) {
  return mockPost.mock.calls.filter(([url]) => url === `${BASE}/${path}`);
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  steps = { provider: DONE, persona: DONE, memory: NOT_DONE, connectors: NOT_DONE };
  advancedSettings = true;
  onboarded = true;
  statusFails = false;
  mockGet.mockImplementation(async (url: string) => {
    if (url === `${BASE}/status` && statusFails) {
      throw { response: { status: 502, data: { ok: false, error: "the gateway didn't answer" } } };
    }
    if (url === `${BASE}/status`) return { ok: true, onboarded, profiles: [], steps };
    if (url === `${BASE}/permissions`) return { permissions: { advancedSettings } };
    if (url === `${BASE}/models`) return { presets: [], providers: [], models: [] };
    if (url === `${BASE}/config`) return { config: {}, etag: '"e1"' };
    throw new Error(`unexpected GET ${url}`);
  });
  mockPatch.mockResolvedValue({ ok: true, changed: ['x'], restartRequired: false });
});

describe('memory step', () => {
  it('keeps Save and continue off until a check of exactly this spec passes', async () => {
    mockPost.mockImplementation(async (url: string, body: { embeddingProvider: string }) =>
      body.embeddingProvider === 'ollama:mxbai-embed-large'
        ? { ok: false, error: 'the embedder answered 500' }
        : CHECK_OK,
    );
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    const next = button('com_mindstone_onb_save_next');
    expect(next).toBeDisabled();

    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByText('com_mindstone_onb_memory_ok 768')).toBeInTheDocument();
    expect(postsTo('memory/check')).toEqual([
      [`${BASE}/memory/check`, { embeddingProvider: 'ollama:nomic-embed-text' }],
    ]);
    expect(next).toBeEnabled();

    // Another model: the passed check no longer counts.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mxbai-embed-large' } });
    expect(next).toBeDisabled();
    expect(screen.queryByText('com_mindstone_onb_memory_ok 768')).toBeNull();
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByText('the embedder answered 500')).toBeInTheDocument();
    expect(next).toBeDisabled();

    // Back to the first model: the latest check was the failed one, so it still doesn't count.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nomic-embed-text' } });
    expect(next).toBeDisabled();
  });

  it('a new provider undoes the check, and a hosted one says where its key comes from', async () => {
    mockPost.mockResolvedValue(CHECK_OK);
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    expect(screen.queryByText('com_mindstone_onb_embed_host_note')).toBeNull();
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());

    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_embed_openai' }));
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    expect(screen.getByText('com_mindstone_onb_embed_host_note')).toBeInTheDocument();
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    expect(postsTo('memory/check').at(-1)).toEqual([
      `${BASE}/memory/check`,
      { embeddingProvider: 'openai:text-embedding-3-small' },
    ]);
  });

  it('an OpenAI-compatible endpoint takes a typed model, nomic-embed-text by default', async () => {
    mockPost.mockResolvedValue(CHECK_OK);
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_embed_compatible' }));
    const model = screen.getByLabelText('com_mindstone_onb_embed_custom_name');
    expect(model).toHaveValue('nomic-embed-text');
    fireEvent.change(model, { target: { value: 'bge-m3' } });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() =>
      expect(postsTo('memory/check').at(-1)?.[1]).toEqual({
        embeddingProvider: 'openai-compatible:bge-m3',
      }),
    );
  });

  it('saves the memory section with the checked spec, then moves on to connectors', async () => {
    mockPost.mockResolvedValue(CHECK_OK);
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'com_mindstone_onb_auto_recall' }));
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' }),
    ).toBeInTheDocument();
    expect(mockPatch).toHaveBeenCalledWith(`${BASE}/config/memory?ifMatch=%22e1%22`, {
      vectorStore: 'sqlite-vec',
      embeddingProvider: 'ollama:nomic-embed-text',
      autoRecall: true,
    });
  });

  it('leaves automatic recall off by default, as `mindstone onboard` does, and says whose chats it runs in', async () => {
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    const recall = screen.getByRole('checkbox', { name: 'com_mindstone_onb_auto_recall' });
    expect(recall).not.toBeChecked();
    expect(recall).toHaveAccessibleDescription('com_mindstone_onb_auto_recall_hint');
  });

  it('uses sqlite-vec, the store the gateway builds recall for, without offering another', async () => {
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    expect(screen.getByText('com_mindstone_onb_vector_store sqlite-vec')).toBeInTheDocument();
    expect(screen.queryByText(/lancedb/i)).toBeNull();
    const radios = screen.getAllByRole('radio').map((radio) => radio.getAttribute('name'));
    expect(new Set(radios)).toEqual(new Set(['ms-onb-embed-kind']));
  });

  it('offers to download a missing Ollama model, then checks again', async () => {
    let finishPull: (value: unknown) => void = () => undefined;
    let checks = 0;
    mockPost.mockImplementation((url: string) => {
      if (url === `${BASE}/memory/pull`) return new Promise((resolve) => (finishPull = resolve));
      checks += 1;
      return Promise.resolve(
        checks === 1
          ? { ok: false, error: 'model "nomic-embed-text" not found', missingModel: true }
          : CHECK_OK,
      );
    });
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByText('model "nomic-embed-text" not found')).toBeInTheDocument();

    fireEvent.click(button('com_mindstone_onb_memory_download'));
    expect(await screen.findByText('com_mindstone_onb_memory_downloading')).toBeInTheDocument();
    expect(postsTo('memory/pull')).toEqual([
      [`${BASE}/memory/pull`, { model: 'nomic-embed-text' }],
    ]);
    for (const name of [
      'com_mindstone_onb_memory_test',
      'com_mindstone_onb_memory_download',
      'com_mindstone_onb_save_next',
      'com_mindstone_onb_back',
    ]) {
      expect(button(name)).toBeDisabled();
    }
    expect(screen.getByRole('combobox')).toBeDisabled();

    await act(async () => finishPull({ ok: true }));
    expect(await screen.findByText('com_mindstone_onb_memory_ok 768')).toBeInTheDocument();
    expect(postsTo('memory/check')).toHaveLength(2);
    expect(button('com_mindstone_onb_save_next')).toBeEnabled();
  });

  it('shows a failed download, and the download stays on offer', async () => {
    mockPost.mockImplementation(async (url: string) =>
      url === `${BASE}/memory/pull`
        ? { ok: false, error: 'no space left on the gateway host' }
        : { ok: false, error: 'model not found', missingModel: true },
    );
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'com_mindstone_onb_memory_download' }),
    );
    expect(await screen.findByText('no space left on the gateway host')).toBeInTheDocument();
    expect(postsTo('memory/check')).toHaveLength(1);
    expect(button('com_mindstone_onb_memory_download')).toBeEnabled();
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
  });

  it('never offers a download for a hosted provider', async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'model not found', missingModel: true });
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_embed_openai' }));
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByText('model not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_memory_download' })).toBeNull();
  });

  it("shows the gateway's refusal of a check", async () => {
    mockPost.mockRejectedValue({
      response: { status: 400, data: { ok: false, error: 'embeddingProvider is not valid' } },
    });
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    expect(await screen.findByText('embeddingProvider is not valid')).toBeInTheDocument();
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
  });

  it('starts a rerun from the memory settings already saved', async () => {
    const base = mockGet.getMockImplementation();
    mockGet.mockImplementation(async (url: string) =>
      url === `${BASE}/config`
        ? {
            config: {
              memory: {
                vectorStore: 'lancedb',
                embeddingProvider: 'ollama:all-minilm',
                autoRecall: true,
              },
            },
            etag: '"e1"',
          }
        : base?.(url),
    );
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    expect(screen.getByRole('combobox')).toHaveValue('custom');
    expect(screen.getByLabelText('com_mindstone_onb_embed_custom_name')).toHaveValue('all-minilm');
    expect(screen.getByRole('checkbox', { name: 'com_mindstone_onb_auto_recall' })).toBeChecked();
    // A saved LanceDB store still becomes sqlite-vec: setup offers nothing else.
    mockPost.mockResolvedValue(CHECK_OK);
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(mockPatch.mock.calls[0][1]).toEqual({
      vectorStore: 'sqlite-vec',
      embeddingProvider: 'ollama:all-minilm',
      autoRecall: true,
    });
  });
});

describe('connectors step', () => {
  beforeEach(() => {
    steps.memory = DONE;
  });

  /** Open the step (unless already there), pick a connector, and fill its token and owner. */
  async function fillConnector(id: string, token: string, ownerIds: string, open = true) {
    if (open) renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    fireEvent.click(screen.getByRole('radio', { name: `com_mindstone_onb_connector_${id}` }));
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_bot_token'), {
      target: { value: token },
    });
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: ownerIds },
    });
  }

  async function openTelegram() {
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_connector_telegram' }));
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_bot_token'), {
      target: { value: '123456:FAKE-token' },
    });
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: '111, 222' },
    });
  }

  it('stores the token as a secret and points the connector at it', async () => {
    mockPost.mockResolvedValue({ ok: true, name: 'telegram-bot.token' });
    mockPatch.mockResolvedValue({
      ok: true,
      changed: ['channels.telegram'],
      restartRequired: true,
    });
    await openTelegram();
    const allowed = screen.getByLabelText('com_mindstone_onb_allowed_ids');
    expect(allowed).toHaveValue('111, 222');
    // The owners always get in, even when left out of the allowed list.
    fireEvent.change(allowed, { target: { value: '222, 333' } });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' }),
    ).toBeInTheDocument();
    expect(mockPost.mock.calls).toEqual([
      [`${BASE}/secrets/telegram-bot.token`, { value: '123456:FAKE-token' }],
    ]);
    expect(mockPatch).toHaveBeenCalledWith(`${BASE}/config/channels?ifMatch=%22e1%22`, {
      telegram: {
        enabled: true,
        tokenFile: 'secrets/telegram-bot.token',
        ownerSenders: ['111', '222'],
        allowedSenders: ['222', '333', '111'],
      },
    });
    expect(
      screen.getByText(
        'com_mindstone_onb_connector_saved_restart com_mindstone_onb_connector_telegram',
      ),
    ).toBeInTheDocument();

    // Back on the step, the token is gone from the page.
    fireEvent.click(button('com_mindstone_onb_back'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(screen.getByLabelText('com_mindstone_onb_bot_token')).toHaveValue('');
  });

  it('clears typed tokens whenever the step is left, not only on save', async () => {
    mockPost.mockResolvedValue(CHECK_OK);
    await openTelegram();
    fireEvent.click(button('com_mindstone_onb_skip'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_back'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(screen.getByLabelText('com_mindstone_onb_bot_token')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('com_mindstone_onb_bot_token'), {
      target: { value: '123456:FAKE-token' },
    });
    fireEvent.click(button('com_mindstone_onb_back'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(screen.getByLabelText('com_mindstone_onb_bot_token')).toHaveValue('');
    expect(postsTo('secrets/telegram-bot.token')).toEqual([]);
  });

  it('refuses a wildcard in either id field', async () => {
    await openTelegram();
    expect(button('com_mindstone_onb_save_next')).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_allowed_ids'), {
      target: { value: '111, *' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('com_mindstone_onb_no_wildcard');
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_allowed_ids'), {
      target: { value: '111' },
    });
    expect(button('com_mindstone_onb_save_next')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: '*' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('com_mindstone_onb_no_wildcard');
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
  });

  it('refuses any id with a wildcard in it, not only a bare *', async () => {
    await openTelegram();
    for (const value of ['111, **', '111, a*', ' * ']) {
      fireEvent.change(screen.getByLabelText('com_mindstone_onb_allowed_ids'), {
        target: { value },
      });
      expect([value, button('com_mindstone_onb_save_next')]).toEqual([
        value,
        expect.objectContaining({ disabled: true }),
      ]);
    }
  });

  it('Discord answers direct messages only: its allowed servers are sent empty', async () => {
    mockPost.mockResolvedValue({ ok: true });
    await fillConnector('discord', 'FAKE-discord-token', '234567890');
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    expect(mockPatch.mock.calls[0][1]).toEqual({
      discord: {
        enabled: true,
        tokenFile: 'secrets/discord-bot.token',
        ownerSenders: ['234567890'],
        allowedSenders: ['234567890'],
        allowedGuilds: [],
      },
    });
  });

  it('says Discord answers direct messages only, for Discord alone', async () => {
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_connector_telegram' }));
    expect(screen.queryByText('com_mindstone_onb_discord_dms')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_connector_discord' }));
    expect(screen.getByText('com_mindstone_onb_discord_dms')).toBeInTheDocument();
  });

  it('keeps a restart reminder naming every connector saved in this setup until Finish', async () => {
    mockPost.mockResolvedValue({ ok: true });
    mockPatch.mockResolvedValue({ ok: true, changed: ['channels'], restartRequired: true });
    await openTelegram();
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_back'));
    await fillConnector('discord', 'FAKE-discord-token', '234567890', false);
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    // Saving Telegram again doesn't list it twice.
    fireEvent.click(button('com_mindstone_onb_back'));
    await fillConnector('telegram', '123456:FAKE-token', '111', false);
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' });
    const reminder = screen.getByTestId('ms-onb-finish-restart');
    expect(reminder).toHaveTextContent(
      'com_mindstone_onb_finish_restart com_mindstone_onb_connector_telegram, com_mindstone_onb_connector_discord',
    );
    // Plain text: Start a chat stays the way on, so advanced settings go off first.
    expect(within(reminder).queryByRole('link')).toBeNull();
  });

  it('keeps the restart reminder for a single connector', async () => {
    mockPost.mockResolvedValue({ ok: true });
    mockPatch.mockResolvedValue({ ok: true, changed: ['channels'], restartRequired: true });
    await openTelegram();
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' });
    expect(screen.getByTestId('ms-onb-finish-restart')).toHaveTextContent(
      /^com_mindstone_onb_finish_restart com_mindstone_onb_connector_telegram$/,
    );
  });

  it('shows no restart reminder when the save needed none', async () => {
    mockPost.mockResolvedValue({ ok: true });
    await openTelegram();
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' });
    expect(screen.queryByTestId('ms-onb-finish-restart')).toBeNull();
  });

  it('clears the token from the page as it is sent, even when the save fails', async () => {
    let refuse: (reason: unknown) => void = () => undefined;
    mockPost.mockImplementation(() => new Promise((_resolve, reject) => (refuse = reject)));
    await openTelegram();
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await waitFor(() =>
      expect(screen.getByLabelText('com_mindstone_onb_bot_token')).toHaveValue(''),
    );
    await act(async () =>
      refuse({
        response: { status: 403, data: { error: 'needs the advanced-settings permission' } },
      }),
    );
    expect(await screen.findByText('needs the advanced-settings permission')).toBeInTheDocument();
    expect(mockPatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('com_mindstone_onb_bot_token')).toHaveValue('');
  });

  it('Slack stores the bot and app-level tokens and references both', async () => {
    mockPost.mockResolvedValue({ ok: true });
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_connector_slack' }));
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_bot_token'), {
      target: { value: 'xoxb-FAKE' },
    });
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: 'U012FAKE' },
    });
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_slack_app_token'), {
      target: { value: 'xapp-FAKE' },
    });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    expect(mockPost.mock.calls).toEqual([
      [`${BASE}/secrets/slack-bot.token`, { value: 'xoxb-FAKE' }],
      [`${BASE}/secrets/slack-app.token`, { value: 'xapp-FAKE' }],
    ]);
    expect(mockPatch.mock.calls[0][1]).toEqual({
      slack: {
        enabled: true,
        tokenFile: 'secrets/slack-bot.token',
        appTokenFile: 'secrets/slack-app.token',
        ownerSenders: ['U012FAKE'],
        allowedSenders: ['U012FAKE'],
      },
    });
  });

  it('needs a connector, its token and an owner id before saving', async () => {
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'com_mindstone_onb_connector_discord' }));
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_bot_token'), {
      target: { value: 'FAKE' },
    });
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: ' , ' },
    });
    expect(button('com_mindstone_onb_save_next')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_owner_ids'), {
      target: { value: '234567890' },
    });
    expect(button('com_mindstone_onb_save_next')).toBeEnabled();
  });

  it('can be skipped, and says where email and calendar are set up', async () => {
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    expect(screen.getByText('com_mindstone_onb_email_calendar')).toBeInTheDocument();
    fireEvent.click(button('com_mindstone_onb_skip'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' }),
    ).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('about step and finish', () => {
  beforeEach(() => {
    steps.memory = DONE;
  });

  it('sends only the answers given, then shows Finish', async () => {
    mockPost.mockResolvedValue({ ok: true });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_purpose'), {
      target: { value: '  Plan my week  ' },
    });
    fireEvent.change(screen.getByLabelText('com_mindstone_onb_user_context'), {
      target: { value: '   ' },
    });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' }),
    ).toBeInTheDocument();
    expect(postsTo('onboarding/complete')).toEqual([
      [`${BASE}/onboarding/complete`, { purpose: 'Plan my week' }],
    ]);
  });

  it('sends an empty body when nothing was written, and caps the answers', async () => {
    mockPost.mockResolvedValue({ ok: true });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    expect(screen.getByLabelText('com_mindstone_onb_purpose')).toHaveAttribute('maxlength', '2000');
    expect(screen.getByLabelText('com_mindstone_onb_user_context')).toHaveAttribute(
      'maxlength',
      '4000',
    );
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' });
    expect(postsTo('onboarding/complete')).toEqual([[`${BASE}/onboarding/complete`, {}]]);
  });

  it("stays on the step with the gateway's refusal", async () => {
    mockPost.mockRejectedValue({
      response: { status: 409, data: { ok: false, error: 'choose a persona first' } },
    });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(await screen.findByText('choose a persona first')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'com_mindstone_onb_done_title' })).toBeNull();
  });

  it('Start a chat opens a new chat that sends the first hello itself', async () => {
    mockPost.mockResolvedValue({ ok: true });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' });
    expect(screen.getByText('com_mindstone_onb_say_hello')).toBeInTheDocument();
    fireEvent.click(button('com_mindstone_onb_start_chat'));
    const chat = await screen.findByTestId('chat-page');
    const query = new URLSearchParams(chat.textContent ?? '');
    expect(query.get('prompt')).toBe('com_mindstone_onb_first_message');
    expect(query.get('submit')).toBe('true');
    expect(postsTo('permissions/advanced')).toEqual([
      [`${BASE}/permissions/advanced`, { enabled: false }],
    ]);
  });
});

describe('a failed status read after a save', () => {
  it('stays on Finish with the error and a Check again that reads the status again', async () => {
    steps.memory = DONE;
    onboarded = false;
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/onboarding/complete`) statusFails = true;
      return { ok: true };
    });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_not_done_title' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("the gateway didn't answer");
    expect(button('com_mindstone_onb_start_chat')).toBeDisabled();

    statusFails = false;
    onboarded = true;
    fireEvent.click(button('com_mindstone_onb_check_again'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_done_title' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('com_mindstone_onb_start_chat')).toBeEnabled();
  });
});

describe('advanced settings running out mid-setup', () => {
  const EXPIRED = {
    response: {
      status: 403,
      data: { ok: false, error: 'these settings need the advanced-settings permission' },
    },
  };

  it('offers them again from the refused step, then resumes it with its check kept', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/permissions/advanced`) {
        advancedSettings = true;
        return { ok: true };
      }
      return CHECK_OK;
    });
    mockPatch.mockImplementationOnce(async () => {
      advancedSettings = false;
      throw EXPIRED;
    });
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByText('these settings need the advanced-settings permission'),
    ).toBeInTheDocument();

    fireEvent.click(button('com_mindstone_onb_regrant'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' });
    fireEvent.change(await screen.findByLabelText('com_mindstone_confirmation'), {
      target: { value: 'enable advanced settings' },
    });
    fireEvent.click(button('com_mindstone_turn_on'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    // The passed check is still there: no need to run it again.
    expect(button('com_mindstone_onb_save_next')).toBeEnabled();
    expect(postsTo('memory/check')).toHaveLength(1);
    fireEvent.click(button('com_mindstone_onb_save_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' }),
    ).toBeInTheDocument();
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it('resumes the step that was refused, not the one setup was opened at', async () => {
    steps.memory = DONE;
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/permissions/advanced`) {
        advancedSettings = true;
        return { ok: true };
      }
      return CHECK_OK;
    });
    mockPatch.mockImplementationOnce(async () => {
      advancedSettings = false;
      throw EXPIRED;
    });
    renderAt('connectors');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' });
    fireEvent.click(button('com_mindstone_onb_back'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    await waitFor(() => expect(button('com_mindstone_onb_save_next')).toBeEnabled());
    fireEvent.click(button('com_mindstone_onb_save_next'));
    fireEvent.click(await screen.findByRole('button', { name: 'com_mindstone_onb_regrant' }));
    fireEvent.change(await screen.findByLabelText('com_mindstone_confirmation'), {
      target: { value: 'enable advanced settings' },
    });
    fireEvent.click(button('com_mindstone_turn_on'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' }),
    ).toBeInTheDocument();
  });

  it('offers them again when a model download is refused', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/memory/pull`) throw EXPIRED;
      return { ok: false, error: 'model not found', missingModel: true };
    });
    renderAt('memory');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' });
    fireEvent.click(button('com_mindstone_onb_memory_test'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'com_mindstone_onb_memory_download' }),
    );
    expect(
      await screen.findByRole('button', { name: 'com_mindstone_onb_regrant' }),
    ).toBeInTheDocument();
  });

  it('offers nothing for other refusals, or for a 403 the gateway did not explain', async () => {
    steps.memory = DONE;
    mockPost.mockRejectedValueOnce({
      response: { status: 409, data: { ok: false, error: 'choose a persona first' } },
    });
    renderAt('about');
    await screen.findByRole('heading', { name: 'com_mindstone_onb_about_title' });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByText('choose a persona first');
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_regrant' })).toBeNull();

    // The Console's own capability check answers 403 without a gateway reason.
    mockPost.mockRejectedValueOnce({ response: { status: 403, data: { message: 'Forbidden' } } });
    fireEvent.click(button('com_mindstone_onb_save_next'));
    await screen.findByText('com_mindstone_not_saved');
    expect(screen.queryByRole('button', { name: 'com_mindstone_onb_regrant' })).toBeNull();
  });
});

describe('provider step', () => {
  it('clears a typed API key once the step is left without connecting', async () => {
    const base = mockGet.getMockImplementation();
    mockGet.mockImplementation(async (url: string) =>
      url === `${BASE}/models`
        ? {
            presets: [
              {
                presetId: 'hosted',
                providerId: 'hosted',
                name: 'Hosted models',
                baseUrl: 'https://models.example.test/v1',
                needsKey: true,
              },
            ],
            providers: [{ id: 'hosted', name: 'Hosted', configured: true, availableModelCount: 1 }],
            models: [{ id: 'hosted/m1', provider: 'hosted' }],
          }
        : base?.(url),
    );
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'com_mindstone_onb_next' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Hosted models' }));
    const key = () => screen.getByLabelText('com_mindstone_onb_api_key');
    fireEvent.change(key(), { target: { value: 'sk-FAKE-key' } });
    fireEvent.click(button('com_mindstone_onb_use_existing'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_model_title' });
    fireEvent.click(button('com_mindstone_onb_back'));
    await screen.findByRole('heading', { name: 'com_mindstone_onb_provider_title' });
    expect(screen.getByRole('radio', { name: 'Hosted models' })).toBeChecked();
    expect(key()).toHaveValue('');
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('?step= from the settings page', () => {
  it('opens the memory step once the provider and persona are done', async () => {
    renderAt('memory');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' }),
    ).toBeInTheDocument();
  });

  it('starts at access when a step before it is not done', async () => {
    steps.persona = NOT_DONE;
    renderAt('memory');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' }),
    ).toBeInTheDocument();
    fireEvent.click(button('com_mindstone_onb_next'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_provider_title' }),
    ).toBeInTheDocument();
  });

  it('never skips memory to reach the connectors step', async () => {
    renderAt('connectors');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' }),
    ).toBeInTheDocument();
  });

  it('opens the connectors and about steps once memory is done', async () => {
    steps.memory = DONE;
    renderAt('connectors');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_connectors_title' }),
    ).toBeInTheDocument();
  });

  it('never skips memory to reach the about step', async () => {
    renderAt('about');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' }),
    ).toBeInTheDocument();
  });

  it('ignores a step it does not link to', async () => {
    renderAt('finish');
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_access_title' }),
    ).toBeInTheDocument();
  });

  it('without advanced settings, goes through access and then to the linked step', async () => {
    advancedSettings = false;
    mockPost.mockImplementation(async () => {
      advancedSettings = true;
      return { ok: true };
    });
    renderAt('memory');
    const confirm = await screen.findByLabelText('com_mindstone_confirmation');
    fireEvent.change(confirm, { target: { value: 'enable advanced settings' } });
    fireEvent.click(button('com_mindstone_turn_on'));
    expect(
      await screen.findByRole('heading', { name: 'com_mindstone_onb_memory_title' }),
    ).toBeInTheDocument();
  });
});
