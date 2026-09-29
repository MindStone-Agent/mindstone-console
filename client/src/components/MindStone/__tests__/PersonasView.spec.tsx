import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PersonasView from '../PersonasView';

/**
 * The key, then any values, so a test can see what was passed in. One stable
 * function, like the real hook's: a new one each render would re-run the
 * page's load effect on every render.
 */
const mockLocalize = (key: string, values?: Record<string, string>) =>
  values ? `${key}:${Object.values(values).join('|')}` : key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
}));

// The editor has its own spec: here only which persona it opens on matters.
jest.mock('../PersonaEditor', () => ({
  __esModule: true,
  default: ({ personaId, onClose }: { personaId?: string; onClose: () => void }) => (
    <div data-testid="ms-persona-editor-stub">
      {`editor:${personaId ?? 'new'}`}
      <button type="button" onClick={onClose}>
        {'close-editor'}
      </button>
    </div>
  ),
}));

const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

type SpecPersona = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  error?: string;
};

const PERSONAS: SpecPersona[] = [
  { id: 'atlas', name: 'Atlas', description: 'Steady and thorough.', version: '1' },
  { id: 'wren', name: 'Wren', description: 'A calm research partner.', version: '1' },
  { id: 'broken', name: 'broken', error: "this persona can't be loaded" },
];

/** The config's etag as the gateway would give it now. */
let mockEtag = '"e1"';

function serve(active: string | null, personas = PERSONAS) {
  mockGet.mockImplementation((url: string) =>
    url.endsWith('/config')
      ? Promise.resolve({ config: {}, etag: mockEtag })
      : Promise.resolve({ ok: true, active, personas }),
  );
}

const personasReads = () =>
  mockGet.mock.calls.filter(([url]) => url === '/api/mindstone/admin/personas').length;

async function renderPage(active: string | null, personas = PERSONAS) {
  serve(active, personas);
  render(
    <MemoryRouter>
      <PersonasView />
    </MemoryRouter>,
  );
  // The Use no persona button appears once the list has loaded.
  await screen.findByRole('button', { name: 'com_mindstone_per_use_none' });
  expect(screen.getByText(`com_mindstone_per_list:${personas.length}`)).toBeInTheDocument();
}

const row = (id: string) => screen.getByTestId(`ms-persona-${id}`);

describe('MindStone personas page (MindStone-Agent #105)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPatch.mockReset();
    mockEtag = '"e1"';
  });

  it('lists each persona with its name, id and description, and says what personas are', async () => {
    await renderPage('atlas');
    expect(mockGet).toHaveBeenCalledWith('/api/mindstone/admin/personas');
    expect(screen.getByText(/com_mindstone_per_intro/)).toHaveTextContent(
      'com_mindstone_per_intro com_mindstone_per_every_chat com_mindstone_persona_routes_note',
    );
    expect(row('atlas')).toHaveTextContent('Atlas');
    expect(row('atlas')).toHaveTextContent('Steady and thorough.');
    expect(row('wren')).toHaveTextContent('Wren');
    expect(row('wren')).toHaveTextContent('wren');
    expect(row('wren')).toHaveTextContent('A calm research partner.');
  });

  it('marks only the active persona, and offers Make active on the others', async () => {
    await renderPage('atlas');
    expect(within(row('atlas')).getByText('com_mindstone_per_active')).toBeInTheDocument();
    expect(within(row('wren')).queryByText('com_mindstone_per_active')).toBeNull();
    expect(
      within(row('atlas')).queryByRole('button', { name: 'com_mindstone_per_make_active' }),
    ).toBeNull();
    expect(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    ).toBeEnabled();
    expect(screen.queryByText('com_mindstone_per_active_none')).toBeNull();
  });

  it('Make active sends that persona id against the config etag read with the list', async () => {
    await renderPage('atlas');
    // Someone changes the config after the page loaded: the switch must not use the new etag.
    mockEtag = '"e2"';
    mockPatch.mockResolvedValue({ ok: true, changed: ['personas.active'], restartRequired: false });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith(
      `/api/mindstone/admin/config/personas?ifMatch=${encodeURIComponent('"e1"')}`,
      { active: 'wren' },
    );
    expect(await screen.findByRole('status')).toHaveTextContent('com_mindstone_per_activated:Wren');
  });

  it('Use no persona clears it with null', async () => {
    await renderPage('wren');
    mockPatch.mockResolvedValue({ ok: true, changed: ['personas.active'], restartRequired: false });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_per_use_none' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    const [url, body] = mockPatch.mock.calls[0];
    expect(url).toBe(`/api/mindstone/admin/config/personas?ifMatch=${encodeURIComponent('"e1"')}`);
    expect(body).toStrictEqual({ active: null });
    expect(await screen.findByRole('status')).toHaveTextContent('com_mindstone_per_cleared');
  });

  it('with no active persona, says so and has nothing to clear', async () => {
    await renderPage(null);
    expect(screen.getByText('com_mindstone_per_active_none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_mindstone_per_use_none' })).toBeDisabled();
    expect(screen.queryByText('com_mindstone_per_active')).toBeNull();
  });

  it("a persona that can't be loaded says so and can't be made active", async () => {
    await renderPage('atlas');
    expect(within(row('broken')).getByText('com_mindstone_per_broken')).toBeInTheDocument();
    expect(within(row('broken')).queryByRole('button')).toBeNull();
  });

  it('says when the active persona is not installed', async () => {
    await renderPage('gone');
    expect(screen.getByText('com_mindstone_per_active_missing:gone')).toBeInTheDocument();
  });

  it('shows an empty list with a hint to ask the agent', async () => {
    await renderPage(null, []);
    expect(screen.getByText('com_mindstone_per_none')).toBeInTheDocument();
  });

  it('on a stale switch, says the settings changed and reloads, then uses the new etag', async () => {
    await renderPage('atlas');
    expect(personasReads()).toBe(1);
    mockEtag = '"e2"';
    mockPatch.mockRejectedValueOnce({ response: { status: 412, data: { error: 'changed' } } });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('com_mindstone_per_stale');
    await waitFor(() => expect(personasReads()).toBe(2));
    mockPatch.mockResolvedValueOnce({ ok: true, changed: ['personas.active'] });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
    expect(mockPatch.mock.calls[0][0]).toBe(
      `/api/mindstone/admin/config/personas?ifMatch=${encodeURIComponent('"e1"')}`,
    );
    expect(mockPatch.mock.calls[1][0]).toBe(
      `/api/mindstone/admin/config/personas?ifMatch=${encodeURIComponent('"e2"')}`,
    );
  });

  it('shows other refusals as the gateway sent them', async () => {
    await renderPage('atlas');
    mockPatch.mockRejectedValueOnce({
      response: { status: 422, data: { error: "the change doesn't validate" } },
    });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent("the change doesn't validate");
  });

  it('shows non-printing characters in persona text as \\u{XXXX}', async () => {
    await renderPage('atlas', [
      { id: 'atlas', name: 'Atlas', version: '1' },
      { id: 'wren', name: 'Wr\u202Een', description: 'Calm\u200B and careful.', version: '1' },
    ]);
    expect(row('wren')).toHaveTextContent('Wr\\u{202E}en');
    expect(row('wren')).toHaveTextContent('Calm\\u{200B} and careful.');
    mockPatch.mockResolvedValue({ ok: true, changed: ['personas.active'] });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_per_activated:Wr\\u{202E}en',
    );
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B]/);
  });

  it('opens the editor to build a persona, or on the persona whose Edit is clicked (#125)', async () => {
    await renderPage('atlas');
    fireEvent.click(screen.getByTestId('ms-persona-create'));
    expect(screen.getByTestId('ms-persona-editor-stub')).toHaveTextContent('editor:new');
    // While the editor is open, there is no second Build button.
    expect(screen.queryByTestId('ms-persona-create')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close-editor' }));
    fireEvent.click(within(row('wren')).getByRole('button', { name: 'com_mindstone_pe_edit' }));
    expect(screen.getByTestId('ms-persona-editor-stub')).toHaveTextContent('editor:wren');
    // A persona that can't be loaded can't be edited here.
    expect(
      within(row('broken')).queryByRole('button', { name: 'com_mindstone_pe_edit' }),
    ).not.toBeInTheDocument();
    // Opening the editor changes nothing on the gateway.
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("says the gateway is unreachable when the list can't be read", async () => {
    mockGet.mockRejectedValue({ response: { status: 502, data: {} } });
    render(
      <MemoryRouter>
        <PersonasView />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_gateway_unreachable',
    );
  });
});
