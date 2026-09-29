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

describe("MindStone approvals: a persona's component cards (MindStone-Agent #125)", () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
  });

  it('shows the existing components a proposed persona lists', async () => {
    const section = await openDetail(
      personaAction({ components: { skills: ['alpha'], workflows: [], knowledgebases: ['g1'] } }),
    );
    const listed = within(section).getByTestId('ms-appr-persona-components');
    expect(listed).toHaveTextContent('com_mindstone_appr_persona_skills: alpha');
    expect(listed).toHaveTextContent('com_mindstone_appr_persona_kbs: g1');
    expect(listed).not.toHaveTextContent('com_mindstone_appr_persona_workflows');
  });

  it('shows a proposed workflow as text, says it is part of a persona, and what approving does', async () => {
    const section = await openDetail({
      id: ID,
      status: 'pending',
      kind: 'workflow_create',
      connectorId: 'console',
      summary: 'workflow triage for persona wren',
      parentApprovalId: 'parent-1',
      workflow: {
        id: 'triage',
        personaId: 'wren',
        definition: { steps: [{ id: 's', kind: 'route', note: SCRIPT }] },
      },
    });
    expect(within(section).getByTestId('ms-appr-part-of-persona')).toBeInTheDocument();
    const shown = within(section).getByTestId('ms-appr-workflow');
    expect(shown).toHaveTextContent('com_mindstone_appr_workflow_for:triage|wren');
    expect(shown).toHaveTextContent(SCRIPT);
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(within(section).getByText('com_mindstone_appr_confirm_workflow')).toBeInTheDocument();
  });

  it("shows a proposed KB's sources, and the gateway's refusal when its persona isn't approved yet", async () => {
    const section = await openDetail({
      id: ID,
      status: 'pending',
      kind: 'persona_kb_create',
      connectorId: 'console',
      summary: 'private knowledge base notes for persona wren',
      parentApprovalId: 'parent-1',
      knowledgebase: {
        personaId: 'wren',
        id: 'notes',
        sources: [{ name: 'source-1', text: 'Hidden\u200Bmark' }],
      },
    });
    const shown = within(section).getByTestId('ms-appr-kb');
    expect(shown).toHaveTextContent('com_mindstone_appr_kb_for:notes|wren');
    expect(shown).toHaveTextContent('Hidden\\u{200B}mark');
    mockPost.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'approve the persona first (approval parent-1)', code: 'persona_pending' },
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(within(section).getByText('com_mindstone_appr_confirm_kb')).toBeInTheDocument();
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    expect(
      await screen.findByText('approve the persona first (approval parent-1)'),
    ).toBeInTheDocument();
  });
});
