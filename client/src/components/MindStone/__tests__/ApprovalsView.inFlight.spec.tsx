import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

const deferred = () => {
  let resolve: (v: unknown) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const approve = (section: HTMLElement) => {
  fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_approve' }));
  fireEvent.click(
    within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
  );
};

const plainB = {
  ...skillCard,
  id: B,
  parentApprovalId: undefined,
  summary: 'install skill bravo: Bravo',
  skill: { id: 'bravo', label: 'Bravo', description: 'B skill.', instructions: '# Bravo' },
};

describe('MindStone approvals: a decision in flight never touches another card (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("the re-read after persona_rejected, raced by a click on B, must not put A's refusal over B", async () => {
    const kbA = { ...kbCard, id: A, summary: 'kb AAA' };
    const cardB = { ...plainB };
    const reread = deferred();
    let aReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        aReads += 1;
        return aReads === 1 ? Promise.resolve({ action: kbA }) : reread.promise;
      }
      if (url.endsWith(`/approvals/${B}`)) return Promise.resolve({ action: cardB });
      return Promise.resolve(list([kbA, cardB]));
    });
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'PERSONA-OF-A-REJECTED', code: 'persona_rejected' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText('kb AAA'));
    approve(await screen.findByRole('region', { name: 'kb AAA' }));
    await screen.findByText('PERSONA-OF-A-REJECTED');
    // The re-read of A is slow; the owner clicks B meanwhile.
    fireEvent.click(screen.getByText(cardB.summary));
    await screen.findByRole('region', { name: cardB.summary });
    await act(async () => {
      reread.resolve({ action: { ...kbA, status: 'rejected' } });
    });
    expect(screen.getByRole('region', { name: cardB.summary })).toBeInTheDocument();
    expect(screen.queryByText('PERSONA-OF-A-REJECTED')).toBeNull();
  });

  it('an approved KB whose ingest failed is not shown in green', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    mockPost.mockResolvedValue({
      ok: true,
      result: { outcome: 'approved', kind: 'persona_kb_create', ingested: { error: 'boom' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    const status = await screen.findByRole('status');
    expect(status).toHaveClass('text-red-600');
  });

  it('gateway_timeout on approve re-reads the card and keeps the timeout text', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    const section = await screen.findByRole('region', { name: kbCard.summary });
    mockPost.mockRejectedValue({
      response: { status: 504, data: { error: 'MAY-STILL-FINISH', code: 'gateway_timeout' } },
    });
    const before = mockGet.mock.calls.filter(([u]) => String(u).endsWith(`/approvals/${A}`)).length;
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: { ...kbCard, status: 'approved' } })
        : Promise.resolve(list([{ ...kbCard, status: 'approved' }])),
    );
    approve(section);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(mockGet.mock.calls.filter(([u]) => String(u).endsWith(`/approvals/${A}`)).length).toBe(
      before + 1,
    );
    expect(await screen.findByText('MAY-STILL-FINISH')).toBeInTheDocument();
    const again = await screen.findByRole('region', { name: kbCard.summary });
    expect(within(again).queryByRole('button', { name: 'com_mindstone_appr_approve' })).toBeNull();
  });

  it('already_decided on reject re-reads the card', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    const section = await screen.findByRole('region', { name: kbCard.summary });
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'ALREADY-APPROVED', code: 'already_decided' } },
    });
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: { ...kbCard, status: 'approved' } })
        : Promise.resolve(list([{ ...kbCard, status: 'approved' }])),
    );
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    expect(await screen.findByText('ALREADY-APPROVED')).toBeInTheDocument();
    const again = await screen.findByRole('region', { name: kbCard.summary });
    expect(again).toHaveTextContent('approved');
    expect(within(again).queryByRole('button', { name: 'com_mindstone_appr_reject' })).toBeNull();
  });

  it('persona_missing shows the gateway text, offers no force, and leaves only a useful card', async () => {
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
        data: { error: 'NO-LONGER-EXISTS; reject this card', code: 'persona_missing' },
      },
    });
    approve(section);
    expect(await screen.findByText('NO-LONGER-EXISTS; reject this card')).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: 'com_mindstone_appr_skill_replace' }),
    ).toBeNull();
    // The card still tells the owner to approve the persona first, which the gateway just said is gone.
    expect(within(section).queryByTestId('ms-appr-part-of-persona')).toBeNull();
  });

  it("a workflow in a persona that doesn't load is shown as approved but not in use, with the gateway's note", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: wfCard })
        : Promise.resolve(list([wfCard])),
    );
    mockPost.mockResolvedValue({
      ok: true,
      result: {
        outcome: 'approved',
        kind: 'workflow_create',
        listed: false,
        note: "it was added to the persona's workflows, but the persona doesn't load, so it isn't used until the persona is fixed",
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(wfCard.summary));
    approve(await screen.findByRole('region', { name: wfCard.summary }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('com_mindstone_appr_component_not_joined');
    expect(status).toHaveTextContent("the persona doesn't load");
    expect(status).toHaveClass('text-red-600');
  });
});
