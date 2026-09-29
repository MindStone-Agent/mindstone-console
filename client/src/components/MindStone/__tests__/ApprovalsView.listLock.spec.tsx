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

describe('MindStone approvals: the locked list, failed decisions and not-in-use results (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('while a decision is in flight "Show all" is locked with the list, and works again after it', async () => {
    const decidedC = {
      ...plainB,
      id: 'cccccccc-1111-4222-8333-444455556666',
      status: 'approved',
      summary: 'OLD APPROVED CARD',
    };
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: plainA });
      return Promise.resolve(url.includes('all=1') ? list([plainA, decidedC]) : list([plainA]));
    });
    const post = deferred();
    mockPost.mockReturnValue(post.promise);
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    approve(await screen.findByRole('region', { name: plainA.summary }));
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await act(async () => {
      post.resolve({
        ok: true,
        result: { outcome: 'approved', kind: 'skill_install', skillId: 'alpha' },
      });
    });
    const box = screen.getByRole('checkbox');
    expect(box).toBeEnabled();
    fireEvent.click(box);
    expect(await screen.findByText('OLD APPROVED CARD')).toBeInTheDocument();
  });

  it('an approve that fails with no code (a 5xx the proxy made generic) reads the card again', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        reads += 1;
        return Promise.resolve({ action: plainA });
      }
      return Promise.resolve(list([plainA]));
    });
    mockPost.mockRejectedValue({
      response: {
        status: 502,
        data: { ok: false, error: "the MindStone gateway couldn't handle the request" },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    approve(await screen.findByRole('region', { name: plainA.summary }));
    expect(
      await screen.findByText("the MindStone gateway couldn't handle the request"),
    ).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it('a reject that fails with no code (gateway down, 502) keeps the note the owner typed', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: plainA })
        : Promise.resolve(list([plainA])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    const section = await screen.findByRole('region', { name: plainA.summary });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    fireEvent.change(within(section).getByRole('textbox'), {
      target: { value: 'LONG CAREFUL NOTE' },
    });
    mockPost.mockRejectedValueOnce({
      response: { status: 502, data: { ok: false, error: "the MindStone gateway didn't answer" } },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    await screen.findByText("the MindStone gateway didn't answer");
    await act(async () => undefined);
    const now = screen.getByRole('region', { name: plainA.summary });
    expect(within(now).queryByRole('textbox')).not.toBeNull();
    expect((within(now).getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'LONG CAREFUL NOTE',
    );
  });

  it('a KB not in use is shown red (not green)', async () => {
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
        note: 'NOTE',
        ingested: { entryCount: 3 },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    const status = await screen.findByRole('status');
    expect(status).toHaveClass('text-red-600');
  });

  it('the deciding note is announced (a live region)', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: plainA })
        : Promise.resolve(list([plainA])),
    );
    mockPost.mockReturnValue(new Promise(() => undefined));
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    approve(await screen.findByRole('region', { name: plainA.summary }));
    const note = await screen.findByTestId('ms-appr-deciding');
    // The live region is always mounted; the note appears inside it.
    expect(note.closest('[aria-live]')).not.toBeNull();
  });
});
