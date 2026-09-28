import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ApprovalsView from '../ApprovalsView';

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
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const ID = '0b5e7c1a-1111-4222-8333-444455556666';
const SCRIPT = '<script>window.pwned = true</script>';

function personaAction(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: 'pending',
    kind: 'persona_create',
    connectorId: 'console',
    summary: 'Persona: Wren',
    persona: {
      id: 'wren',
      name: 'Wren',
      description: 'A calm, careful research partner.',
      voice: `Plain and warm. **Never shouts.**\n# Not a heading`,
      workingStyle: `Asks before acting. ${SCRIPT}`,
      boundaries: ['No legal advice.', '[a link](https://example.test)'],
    },
    ...overrides,
  };
}

function serve(detail: Record<string, unknown>) {
  mockGet.mockImplementation((url: string) =>
    url.includes('/approvals/')
      ? Promise.resolve({ action: detail })
      : Promise.resolve({
          actions: [
            {
              id: ID,
              status: detail.status,
              kind: detail.kind,
              connectorId: 'console',
              summary: detail.summary,
            },
          ],
          status: { pending: 1, approved: 0, rejected: 0 },
        }),
  );
}

/** `shown` is the summary as the page shows it, when that differs from what the gateway sent. */
async function openDetail(detail: Record<string, unknown>, shown = detail.summary as string) {
  serve(detail);
  render(
    <MemoryRouter>
      <ApprovalsView />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(shown));
  return screen.findByRole('region', { name: shown });
}

describe('MindStone approvals: a persona proposal (MindStone-Agent #105)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
  });

  it('shows every field of the proposal as plain text', async () => {
    const section = await openDetail(personaAction());
    const fields = within(section).getByTestId('ms-appr-persona');
    for (const label of [
      'com_mindstone_appr_persona_name',
      'com_mindstone_appr_persona_id',
      'com_mindstone_appr_persona_description',
      'com_mindstone_appr_persona_voice',
      'com_mindstone_appr_persona_working_style',
      'com_mindstone_appr_persona_boundaries',
    ]) {
      expect(within(fields).getByText(label)).toBeInTheDocument();
    }
    expect(within(fields).getByText('Wren')).toBeInTheDocument();
    expect(within(fields).getByText('wren')).toBeInTheDocument();
    expect(within(fields).getByText('A calm, careful research partner.')).toBeInTheDocument();
    const boundaries = within(fields)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(boundaries).toEqual(['No legal advice.', '[a link](https://example.test)']);
    expect(within(section).getByText('com_mindstone_appr_persona_effect')).toBeInTheDocument();
  });

  it('renders markup and markdown in the proposal literally, never as HTML', async () => {
    const section = await openDetail(personaAction());
    const fields = within(section).getByTestId('ms-appr-persona');
    expect(fields.textContent).toContain(SCRIPT);
    expect(fields.textContent).toContain('**Never shouts.**');
    expect(fields.textContent).toContain('# Not a heading');
    expect(fields.textContent).toContain('[a link](https://example.test)');
    expect(fields.querySelector('script, strong, h1, a')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it('says approving only saves it, then points at the Personas page to make it active', async () => {
    const section = await openDetail(personaAction());
    mockPost.mockResolvedValue({
      ok: true,
      result: { outcome: 'approved', kind: 'persona_create', personaId: 'wren' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    // The confirmation carries the effect line, shown once.
    expect(within(section).getAllByText('com_mindstone_appr_persona_effect')).toHaveLength(1);
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('com_mindstone_appr_persona_saved:Wren');
    expect(status.textContent).not.toMatch(/activ/);
    expect(mockPost).toHaveBeenCalledWith(`/api/mindstone/admin/approvals/${ID}/approve`, {});
    expect(
      within(status).getByRole('link', { name: 'com_mindstone_appr_personas_link' }),
    ).toHaveAttribute('href', '/mindstone/personas');
    // Approving never switches the active persona: only the Personas page does.
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockGet.mock.calls.map(([url]) => url)).not.toContain('/api/mindstone/admin/config');
  });

  it("shows the gateway's text when the persona id is taken, and offers no overwrite", async () => {
    const section = await openDetail(personaAction());
    const text =
      'a persona named wren already exists; ask the agent for a new name, or reject this proposal';
    mockPost.mockRejectedValue({
      response: { status: 409, data: { ok: false, error: text, code: 'persona_exists' } },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('link', { name: 'com_mindstone_appr_personas_link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_mindstone_appr_overwrite' })).toBeNull();
    // Still pending: the admin can reject it from here.
    expect(within(section).getByTestId('ms-appr-persona')).toBeInTheDocument();
  });

  it('says on the pending card that a persona route rule still wins for its chats', async () => {
    const section = await openDetail(personaAction());
    expect(within(section).getByText('com_mindstone_persona_routes_note')).toBeInTheDocument();
  });

  it('a decided persona approval claims nothing about activation', async () => {
    const section = await openDetail(
      personaAction({ status: 'approved', decidedBy: 'console:u1' }),
    );
    expect(within(section).getByTestId('ms-appr-persona')).toBeInTheDocument();
    expect(within(section).queryByText('com_mindstone_appr_persona_effect')).toBeNull();
    expect(within(section).queryByText('com_mindstone_persona_routes_note')).toBeNull();
    expect(
      within(section).queryByRole('button', { name: 'com_mindstone_appr_approve' }),
    ).toBeNull();
    expect(section.textContent).not.toMatch(/activ|previous/);
  });

  it('shows non-printing characters in the proposal as \\u{XXXX}', async () => {
    const name = 'Wr\u202Een';
    const section = await openDetail(
      personaAction({
        summary: `persona proposal from console: ${name} (wren)`,
        persona: {
          id: 'wren',
          name,
          voice: 'Line one\n\tindented',
          boundaries: ['No\u200Bthing hidden.'],
        },
      }),
      'persona proposal from console: Wr\\u{202E}en (wren)',
    );
    const fields = within(section).getByTestId('ms-appr-persona');
    expect(fields.textContent).toContain('Wr\\u{202E}en');
    expect(fields.textContent).toContain('No\\u{200B}thing hidden.');
    // Newlines and tabs are text, not hidden characters.
    expect(fields.textContent).toContain('Line one\n\tindented');
    expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(
      'persona proposal from console: Wr\\u{202E}en (wren)',
    );
    mockPost.mockResolvedValue({ ok: true, result: { kind: 'persona_create', personaId: 'wren' } });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_appr_persona_saved:Wr\\u{202E}en',
    );
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B]/);
  });

  it('still shows a memory write as its text, with the memory confirmation', async () => {
    const section = await openDetail({
      id: ID,
      status: 'pending',
      kind: 'memory_write',
      connectorId: 'telegram',
      summary: 'Memory: notes.md',
      memory: { path: 'notes.md', content: 'Remember the synthetic fact.' },
    });
    expect(within(section).queryByTestId('ms-appr-persona')).toBeNull();
    expect(within(section).getByText('Remember the synthetic fact.')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(within(section).getByText('com_mindstone_appr_confirm_memory')).toBeInTheDocument();
  });
});
