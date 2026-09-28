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
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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

async function openDetail(detail: Record<string, unknown>) {
  serve(detail);
  render(
    <MemoryRouter>
      <ApprovalsView />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(detail.summary as string));
  return screen.findByRole('region', { name: detail.summary as string });
}

describe('MindStone approvals: a persona proposal (MindStone-Agent #105)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
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

  it('says approving makes it the active persona, then links to the Personas page', async () => {
    const section = await openDetail(personaAction());
    mockPost.mockResolvedValue({ ok: true });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(within(section).getByText('com_mindstone_appr_confirm_persona')).toBeInTheDocument();
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('com_mindstone_appr_persona_approved:Wren');
    expect(mockPost).toHaveBeenCalledWith(`/api/mindstone/admin/approvals/${ID}/approve`, {});
    expect(
      within(status).getByRole('link', { name: 'com_mindstone_appr_personas_link' }),
    ).toHaveAttribute('href', '/mindstone/personas');
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

  it('points at the Personas page when the persona was saved but not made active', async () => {
    const section = await openDetail(personaAction());
    mockPost.mockRejectedValue({
      response: {
        status: 409,
        data: { ok: false, error: 'saved, but not made active', code: 'not_activated' },
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('saved, but not made active');
    expect(
      within(status).getByRole('link', { name: 'com_mindstone_appr_personas_link' }),
    ).toHaveAttribute('href', '/mindstone/personas');
  });

  it('shows the persona that was active before an approved one', async () => {
    const section = await openDetail(
      personaAction({
        status: 'approved',
        decidedBy: 'console:u1',
        previousActivePersona: 'atlas',
      }),
    );
    expect(within(section).getByTestId('ms-appr-previous-persona')).toHaveTextContent(
      'com_mindstone_appr_persona_previous:atlas',
    );
    expect(within(section).queryByText('com_mindstone_appr_persona_effect')).toBeNull();
    expect(
      within(section).queryByRole('button', { name: 'com_mindstone_appr_approve' }),
    ).toBeNull();
    expect(
      within(section).getByRole('link', { name: 'com_mindstone_appr_personas_link' }),
    ).toHaveAttribute('href', '/mindstone/personas');
  });

  it('says none was active before when the approval recorded none', async () => {
    const section = await openDetail(
      personaAction({ status: 'approved', previousActivePersona: null }),
    );
    expect(within(section).getByTestId('ms-appr-previous-persona')).toHaveTextContent(
      'com_mindstone_appr_persona_previous_none',
    );
  });

  it('says nothing about a previous persona when none was recorded (a rejected proposal)', async () => {
    const section = await openDetail(personaAction({ status: 'rejected' }));
    expect(within(section).queryByTestId('ms-appr-previous-persona')).toBeNull();
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
