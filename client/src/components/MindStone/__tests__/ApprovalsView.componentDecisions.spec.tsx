import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ApprovalsView from '../ApprovalsView';

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
    patch: jest.fn(),
  },
}));

const A = 'aaaaaaaa-1111-4222-8333-444455556666';
const B = 'bbbbbbbb-1111-4222-8333-444455556666';

function list(details: Record<string, unknown>[]) {
  return {
    actions: details.map((d) => ({
      id: d.id,
      status: d.status,
      kind: d.kind,
      connectorId: 'console',
      summary: d.summary,
    })),
    status: { pending: details.length, approved: 0, rejected: 0 },
  };
}

const skillCard = {
  id: A,
  status: 'pending',
  kind: 'skill_install',
  connectorId: 'console',
  summary: 'install skill beta for persona wren: Beta',
  parentApprovalId: 'parent-1',
  skill: { id: 'beta', label: 'Beta', description: 'A skill.', instructions: '# Beta' },
};
const kbCard = {
  id: A,
  status: 'pending',
  kind: 'persona_kb_create',
  connectorId: 'console',
  summary: 'private knowledge base notes for persona wren (1 source(s))',
  parentApprovalId: 'parent-1',
  knowledgebase: {
    personaId: 'wren',
    id: 'notes',
    name: 'Payroll export (trusted)',
    sources: [{ name: 'source-1', text: 'Hello' }],
  },
};
const wfCard = {
  id: A,
  status: 'pending',
  kind: 'workflow_create',
  connectorId: 'console',
  summary: 'workflow triage for persona wren (1 step(s))',
  parentApprovalId: 'parent-1',
  workflow: {
    id: 'triage',
    personaId: 'wren',
    definition: { steps: [{ id: 's', kind: 'route' }] },
  },
};

function renderPage() {
  render(
    <MemoryRouter>
      <ApprovalsView />
    </MemoryRouter>,
  );
}

/**
 * Deciding a persona's component cards (MindStone-Agent #125, console review):
 * no force on a persona's skill, the approve's own outcome shown, and a card
 * that changed while another was open never approved by mistake.
 */
describe("MindStone approvals: deciding a persona's component cards (MindStone-Agent #125)", () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('a persona component skill never offers force after skill_exists', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: skillCard })
        : Promise.resolve(list([skillCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(skillCard.summary));
    const section = await screen.findByRole('region', { name: skillCard.summary });
    mockPost.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error:
            'skill "beta" already exists, and a persona\'s new skill can\'t replace one; reject this card',
          code: 'skill_exists',
        },
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    await screen.findByText(/can't replace one/);
    expect(
      within(section).queryByRole('button', { name: 'com_mindstone_appr_skill_replace' }),
    ).toBeNull();
  });

  it("an approved KB whose ingest failed says so (the gateway's `ingested.error`)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    const section = await screen.findByRole('region', { name: kbCard.summary });
    mockPost.mockResolvedValue({
      ok: true,
      result: {
        outcome: 'approved',
        kind: 'persona_kb_create',
        personaId: 'wren',
        kbId: 'notes',
        ingested: { error: 'embedding provider unreachable' },
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent('embedding provider unreachable');
    // Written but not indexed isn't a success: it reads as a problem.
    expect(screen.getByRole('status')).toHaveClass('text-red-600');
  });

  it('an approved workflow that could not join its persona says so (listed: false)', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: wfCard })
        : Promise.resolve(list([wfCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(wfCard.summary));
    const section = await screen.findByRole('region', { name: wfCard.summary });
    mockPost.mockResolvedValue({
      ok: true,
      result: {
        outcome: 'approved',
        kind: 'workflow_create',
        workflowId: 'triage',
        personaId: 'wren',
        listed: false,
        note: "it couldn't be added to the persona's workflows.json (x); attach it in the persona editor",
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent('attach it in the persona editor');
  });

  it("the KB card shows the KB's name (agent-written, it is written to disk)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    const section = await screen.findByRole('region', { name: kbCard.summary });
    expect(section).toHaveTextContent('Payroll export (trusted)');
  });

  it('an Approve clicked on card A while card B loads must not become an approve of B', async () => {
    const cardA = { ...wfCard, id: A, summary: 'workflow AAA' };
    const cardB = { ...kbCard, id: B, summary: 'kb BBB' };
    let releaseB: (v: unknown) => void = () => undefined;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: cardA });
      if (url.endsWith(`/approvals/${B}`)) return new Promise((r) => (releaseB = r));
      return Promise.resolve(list([cardA, cardB]));
    });
    mockPost.mockResolvedValue({ ok: true, result: {} });
    renderPage();
    fireEvent.click(await screen.findByText('workflow AAA'));
    await screen.findByRole('region', { name: 'workflow AAA' });
    // Owner clicks card B in the list: A goes at once, so none of its buttons can act while B loads.
    fireEvent.click(screen.getByText('kb BBB'));
    expect(screen.queryByRole('region', { name: 'workflow AAA' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'com_mindstone_appr_approve' })).toBeNull();
    // B's detail arrives.
    await act(async () => {
      releaseB({ action: cardB });
    });
    const b = await screen.findByRole('region', { name: 'kb BBB' });
    // The confirm step the owner opened for A is now sitting on B.
    expect(
      within(b).queryByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    ).toBeNull();
  });

  it('a late detail answer for an earlier click does not replace the card clicked last', async () => {
    const cardA = { ...wfCard, id: A, summary: 'workflow AAA' };
    const cardB = { ...kbCard, id: B, summary: 'kb BBB' };
    let releaseA: (v: unknown) => void = () => undefined;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return new Promise((r) => (releaseA = r));
      if (url.endsWith(`/approvals/${B}`)) return Promise.resolve({ action: cardB });
      return Promise.resolve(list([cardA, cardB]));
    });
    renderPage();
    fireEvent.click(await screen.findByText('workflow AAA'));
    fireEvent.click(screen.getByText('kb BBB'));
    await screen.findByRole('region', { name: 'kb BBB' });
    await act(async () => {
      releaseA({ action: cardA });
    });
    expect(screen.queryByRole('region', { name: 'workflow AAA' })).toBeNull();
  });

  const open = async (detail: Record<string, unknown>) => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: detail })
        : Promise.resolve(list([detail])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(detail.summary as string));
    return screen.findByRole('region', { name: detail.summary as string });
  };
  const approve = (section: HTMLElement) => {
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
  };

  it('an approved KB that was ingested says how many entries', async () => {
    const section = await open(kbCard);
    mockPost.mockResolvedValue({
      ok: true,
      result: { outcome: 'approved', kind: 'persona_kb_create', ingested: { entryCount: 7 } },
    });
    approve(section);
    expect(await screen.findByText('com_mindstone_appr_kb_ingested:7')).toBeInTheDocument();
  });

  it("an approved skill that couldn't join its persona says so", async () => {
    const section = await open(skillCard);
    mockPost.mockResolvedValue({
      ok: true,
      result: {
        outcome: 'approved',
        kind: 'skill_install',
        skillId: 'beta',
        persona: { id: 'wren', listed: false, note: 'attach it in the persona editor' },
      },
    });
    approve(section);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_appr_component_not_joined:attach it in the persona editor',
    );
  });

  it('a plain skill (not part of a persona) still offers force on skill_exists', async () => {
    const plain = {
      ...skillCard,
      parentApprovalId: undefined,
      summary: 'install skill beta: Beta',
    };
    const section = await open(plain);
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'already installed', code: 'skill_exists' } },
    });
    approve(section);
    expect(
      await within(section).findByRole('button', { name: 'com_mindstone_appr_skill_replace' }),
    ).toBeInTheDocument();
  });

  it('a card whose persona was rejected is read again after the refusal', async () => {
    const section = await open(kbCard);
    mockPost.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'its persona was rejected', code: 'persona_rejected' },
      },
    });
    const reads = mockGet.mock.calls.length;
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: { ...kbCard, status: 'rejected' } })
        : Promise.resolve(list([{ ...kbCard, status: 'rejected' }])),
    );
    approve(section);
    expect(await screen.findByText('its persona was rejected')).toBeInTheDocument();
    expect(mockGet.mock.calls.length).toBeGreaterThan(reads + 1);
    const again = await screen.findByRole('region', { name: kbCard.summary });
    expect(within(again).queryByRole('button', { name: 'com_mindstone_appr_approve' })).toBeNull();
  });

  it('only a pending component card says to approve its persona first; only a component skill says it installs for everyone', async () => {
    const decided = await open({ ...wfCard, status: 'approved' });
    expect(within(decided).queryByTestId('ms-appr-part-of-persona')).toBeNull();
    cleanup();
    mockGet.mockReset();
    const plain = await open({
      ...skillCard,
      parentApprovalId: undefined,
      summary: 'install skill beta: Beta',
    });
    expect(within(plain).queryByTestId('ms-appr-skill-everyone')).toBeNull();
  });

  it("shows every KB source in full, and the workflow's definition with invisible characters marked", async () => {
    const long = 'x'.repeat(5000) + 'END-OF-SOURCE';
    const section = await open({
      ...kbCard,
      knowledgebase: {
        ...kbCard.knowledgebase,
        sources: [
          { name: 'source-1', text: 'first' },
          { name: 'source-2', text: long },
        ],
      },
    });
    expect(section).toHaveTextContent('first');
    expect(section).toHaveTextContent('END-OF-SOURCE');
    cleanup();
    mockGet.mockReset();
    const wf = await open({
      ...wfCard,
      workflow: {
        ...wfCard.workflow,
        definition: {
          steps: [
            { id: 'a', kind: 'route' },
            { id: 'b\u200B', kind: 'route' },
          ],
        },
      },
    });
    expect(within(wf).getByTestId('ms-appr-workflow')).toHaveTextContent('b\\u{200B}');
  });

  it('a decided persona card never says approving is refused for a missing workflow', async () => {
    const persona = {
      id: A,
      status: 'approved',
      kind: 'persona_create',
      connectorId: 'console',
      summary: 'Persona: Wren',
      persona: { id: 'wren', name: 'Wren', voice: 'Plain.' },
      components: { skills: [], workflows: ['gone'], knowledgebases: [] },
      listedWorkflows: [{ id: 'gone', steps: null }],
    };
    const section = await open(persona);
    expect(section).toHaveTextContent('com_mindstone_appr_persona_workflow_unreadable:gone');
    expect(section).not.toHaveTextContent('com_mindstone_appr_persona_workflow_missing');
  });

  it("a decided component skill doesn't say approving installs it for everyone", async () => {
    const section = await open({ ...skillCard, status: 'approved' });
    expect(within(section).queryByTestId('ms-appr-skill-everyone')).toBeNull();
  });

  it('after persona_missing on one card, the next card opened still shows its own "approve the persona first" hint', async () => {
    const other = { ...kbCard, id: B, summary: 'kb BBB' };
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: wfCard });
      if (url.endsWith(`/approvals/${B}`)) return Promise.resolve({ action: other });
      return Promise.resolve(list([wfCard, other]));
    });
    renderPage();
    fireEvent.click(await screen.findByText(wfCard.summary));
    const a = await screen.findByRole('region', { name: wfCard.summary });
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'gone; reject this card', code: 'persona_missing' } },
    });
    approve(a);
    await screen.findByText('gone; reject this card');
    expect(within(a).queryByTestId('ms-appr-part-of-persona')).toBeNull();
    fireEvent.click(screen.getByText('kb BBB'));
    const b = await screen.findByRole('region', { name: 'kb BBB' });
    expect(within(b).getByTestId('ms-appr-part-of-persona')).toBeInTheDocument();
  });
});
