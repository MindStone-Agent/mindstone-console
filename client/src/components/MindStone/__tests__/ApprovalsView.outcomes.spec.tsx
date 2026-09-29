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

const plainA = {
  ...skillCard,
  id: A,
  parentApprovalId: undefined,
  summary: 'install skill alpha: Alpha',
  skill: { id: 'alpha', label: 'Alpha', description: 'A skill.', instructions: '# Alpha' },
};
const plainB = {
  ...skillCard,
  id: B,
  parentApprovalId: undefined,
  summary: 'install skill bravo: Bravo',
  skill: { id: 'bravo', label: 'Bravo', description: 'B skill.', instructions: '# Bravo' },
};

const personaMissingText = 'NO-LONGER-EXISTS; reject this card';

describe('MindStone approvals: outcomes, hints and list reads (MindStone-Agent #125) — round 3 repros', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("a KB approved into a persona that doesn't load says it isn't in use, even when the ingest worked", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    mockPost.mockResolvedValue({
      ok: true,
      result: {
        outcome: 'approved',
        kind: 'persona_kb_create',
        personaId: 'wren',
        kbId: 'notes',
        listed: false,
        note: "the persona doesn't load, so this knowledge base isn't used until the persona is fixed",
        ingested: { entryCount: 3 },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent("the persona doesn't load");
  });

  it('while a decision is in flight the card list is locked and says why, so its answer lands on its own card', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: plainA });
      if (url.endsWith(`/approvals/${B}`)) return Promise.resolve({ action: plainB });
      return Promise.resolve(list([plainA, plainB]));
    });
    let finish: (value: unknown) => void = () => undefined;
    mockPost.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    approve(await screen.findByRole('region', { name: plainA.summary }));
    expect(await screen.findByTestId('ms-appr-deciding')).toBeInTheDocument();
    expect(screen.getByText(plainB.summary).closest('button')).toBeDisabled();
    expect(screen.getByText(plainA.summary, { selector: 'span' }).closest('button')).toBeDisabled();
    await act(async () => {
      finish({
        ok: true,
        result: { outcome: 'approved', kind: 'skill_install', skillId: 'alpha' },
      });
    });
    expect(screen.queryByTestId('ms-appr-deciding')).toBeNull();
    expect(screen.getByText(plainB.summary).closest('button')).toBeEnabled();
  });

  it('invalid_persona (persona folder gone) drops the "approve the persona first" hint', async () => {
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
            'persona wren is no longer in the personas folder; restore it, or reject this card',
          code: 'invalid_persona',
        },
      },
    });
    approve(section);
    await screen.findByText(/no longer in the personas folder/);
    expect(within(section).queryByTestId('ms-appr-part-of-persona')).toBeNull();
  });

  it('after persona_missing, a later refusal with no code never brings the "approve the persona first" hint back', async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes('/approvals/')
        ? Promise.resolve({ action: skillCard })
        : Promise.resolve(list([skillCard])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(skillCard.summary));
    const section = await screen.findByRole('region', { name: skillCard.summary });
    mockPost.mockRejectedValueOnce({
      response: { status: 409, data: { error: personaMissingText, code: 'persona_missing' } },
    });
    approve(section);
    await screen.findByText(personaMissingText);
    mockPost.mockRejectedValueOnce({
      response: { status: 502, data: { error: "the MindStone gateway didn't answer" } },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    );
    await screen.findByText("the MindStone gateway didn't answer");
    expect(within(section).queryByTestId('ms-appr-part-of-persona')).toBeNull();
  });

  it('a slow list read from before an approve, answering after it, never shows the approved card as pending', async () => {
    const kbA = { ...kbCard, id: A, summary: 'kb AAA' };
    const slow = deferred();
    let listReads = 0;
    let bApproved = false;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: kbA });
      if (url.endsWith(`/approvals/${B}`)) return Promise.resolve({ action: plainB });
      listReads += 1;
      const now = list([
        { ...kbA, status: 'rejected' },
        { ...plainB, status: bApproved ? 'approved' : 'pending' },
      ]);
      return listReads === 2
        ? slow.promise.then(() => list([{ ...kbA, status: 'rejected' }, plainB]))
        : Promise.resolve(now);
    });
    mockPost.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'PR', code: 'persona_rejected' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText('kb AAA'));
    approve(await screen.findByRole('region', { name: 'kb AAA' }));
    await screen.findByText('PR');
    fireEvent.click(screen.getByText(plainB.summary));
    const b = await screen.findByRole('region', { name: plainB.summary });
    mockPost.mockImplementationOnce(() => {
      bApproved = true;
      return Promise.resolve({
        ok: true,
        result: { outcome: 'approved', kind: 'skill_install', skillId: 'bravo' },
      });
    });
    approve(b);
    await screen.findByText('com_mindstone_appr_approved');
    await act(async () => {
      slow.resolve(undefined);
    });
    const listText = screen.getByRole('region', { name: /com_mindstone_appr_list/ }).textContent;
    expect(listText).toContain('[approved] skill_install');
  });
});
