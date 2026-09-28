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

const mockGet = jest.fn();
const mockPatch = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const PERSONAS = [
  { id: 'atlas', name: 'Atlas', description: 'Steady and thorough.', version: '1' },
  { id: 'wren', name: 'Wren', description: 'A calm research partner.', version: '1' },
  { id: 'broken', name: 'broken', error: "this persona can't be loaded" },
];

function serve(active: string | null, personas = PERSONAS) {
  mockGet.mockImplementation((url: string) =>
    url.endsWith('/config')
      ? Promise.resolve({ config: {}, etag: '"e1"' })
      : Promise.resolve({ ok: true, active, personas }),
  );
}

async function renderPage(active: string | null, personas = PERSONAS) {
  serve(active, personas);
  render(
    <MemoryRouter>
      <PersonasView />
    </MemoryRouter>,
  );
  await screen.findByText(`com_mindstone_per_list:${personas.length}`);
}

const row = (id: string) => screen.getByTestId(`ms-persona-${id}`);

describe('MindStone personas page (MindStone-Agent #105)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPatch.mockReset();
  });

  it('lists each persona with its name, id and description, and says what personas are', async () => {
    await renderPage('atlas');
    expect(mockGet).toHaveBeenCalledWith('/api/mindstone/admin/personas');
    expect(screen.getByText('com_mindstone_per_intro')).toBeInTheDocument();
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

  it('Make active sends that persona id against the current config etag', async () => {
    await renderPage('atlas');
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

  it('says the config changed when the save is stale, and shows other refusals as sent', async () => {
    await renderPage('atlas');
    mockPatch.mockRejectedValueOnce({ response: { status: 412, data: { error: 'changed' } } });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('com_mindstone_stale_save');
    mockPatch.mockRejectedValueOnce({
      response: { status: 422, data: { error: "the change doesn't validate" } },
    });
    fireEvent.click(
      within(row('wren')).getByRole('button', { name: 'com_mindstone_per_make_active' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent("the change doesn't validate"),
    );
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
