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

const memCard = {
  id: A,
  status: 'pending',
  kind: 'memory_write',
  connectorId: 'console',
  summary: 'write memory notes.md',
  memory: { path: 'notes.md', content: 'hello' },
};
const sendCard = {
  id: A,
  status: 'pending',
  kind: 'connector_send',
  connectorId: 'telegram',
  summary: 'reply to chat 1',
  send: { text: 'hi', chatId: '1' },
};

describe('MindStone approvals: recovering from a decision that failed or answered late (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('an approve that lost its connection (no response) but went through is not reported "Not changed."', async () => {
    let approved = false;
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: { ...memCard, status: approved ? 'approved' : 'pending' } })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockImplementation(() => {
      approved = true;
      return Promise.reject({ message: 'Network Error' });
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    const region = await screen.findByRole('region', { name: memCard.summary });
    await act(async () => undefined);
    expect(within(region).getByText(/approved/)).toBeInTheDocument();
    // The card now says approved; the page must not say nothing changed.
    expect(screen.getByRole('status')).not.toHaveTextContent('com_mindstone_not_changed');
  });

  it('queue_busy on approve reads the card again', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        reads += 1;
        return Promise.resolve({ action: sendCard });
      }
      return Promise.resolve(list([sendCard]));
    });
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'QB', code: 'queue_busy' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(sendCard.summary));
    approve(await screen.findByRole('region', { name: sendCard.summary }));
    await screen.findByText('QB');
    await act(async () => undefined);
    expect(reads).toBe(2);
  });

  it('changed on approve reads the card again', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        reads += 1;
        return Promise.resolve({ action: sendCard });
      }
      return Promise.resolve(list([sendCard]));
    });
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'CH', code: 'changed' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(sendCard.summary));
    approve(await screen.findByRole('region', { name: sendCard.summary }));
    await screen.findByText('CH');
    await act(async () => undefined);
    expect(reads).toBe(2);
  });

  it('a KB not in use says so, with a fallback reason when the note is blank', async () => {
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
        listed: false,
        note: '  ',
        ingested: { entryCount: 3 },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(
      'com_mindstone_appr_kb_not_in_use:com_mindstone_appr_persona_not_loading',
    );
  });

  it('a reject that timed out (504) but did not go through keeps the typed note', async () => {
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
      response: { status: 504, data: { error: 'T', code: 'gateway_timeout' } },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    await screen.findByText('T');
    await act(async () => undefined);
    const now = screen.getByRole('region', { name: plainA.summary });
    expect(within(now).queryByRole('textbox')).not.toBeNull();
  });

  it('not_found on approve (card deleted) leaves the dead card with a live confirm button and the list unrefreshed', async () => {
    let gets = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) return Promise.resolve({ action: memCard });
      gets += 1;
      return Promise.resolve(list([memCard]));
    });
    mockPost.mockRejectedValue({
      response: { status: 404, data: { error: 'NF', code: 'not_found' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    const region = await screen.findByRole('region', { name: memCard.summary });
    approve(region);
    await screen.findByText('NF');
    await act(async () => undefined);
    expect(gets).toBeGreaterThan(1);
  });

  it('after memory_exists, Cancel then Approve offers Overwrite before the gateway is asked again', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'EXISTS', code: 'memory_exists' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    const region = await screen.findByRole('region', { name: memCard.summary });
    approve(region);
    await screen.findByText('EXISTS');
    fireEvent.click(within(region).getByRole('button', { name: 'com_mindstone_appr_cancel' }));
    fireEvent.click(within(region).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(
      within(region).queryByRole('button', { name: 'com_mindstone_appr_overwrite' }),
    ).toBeNull();
  });
});

describe('MindStone approvals: stale reads, focus and the force offer (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('two reads of the same card answering out of order: the older (pending) read must not replace the newer (approved) one', async () => {
    const reads: Array<ReturnType<typeof deferred>> = [];
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        if (reads.length === 0) {
          reads.push(deferred());
          return Promise.resolve({ action: memCard });
        }
        const d = deferred();
        reads.push(d);
        return d.promise;
      }
      return Promise.resolve(list([memCard]));
    });
    mockPost.mockRejectedValue({
      response: { status: 504, data: { error: 'MAY-STILL-FINISH', code: 'gateway_timeout' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await screen.findByText('MAY-STILL-FINISH');
    await act(async () => undefined);
    // The re-read (reads[1]) is still out; the list is unlocked, so the owner clicks the card again.
    fireEvent.click(screen.getByText(memCard.summary, { selector: 'span' }));
    // The newer read answers first: the approve went on and finished.
    await act(async () => {
      reads[2].resolve({ action: { ...memCard, status: 'approved', decidedBy: 'console:u' } });
    });
    // Then the older read answers, from before it finished.
    await act(async () => {
      reads[1].resolve({ action: memCard });
    });
    const region = screen.getByRole('region', { name: memCard.summary });
    expect(within(region).queryByRole('button', { name: 'com_mindstone_appr_approve' })).toBeNull();
  });

  it('after a decision, keyboard focus is left somewhere useful (not dropped to <body>)', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockResolvedValue({ ok: true, result: { outcome: 'approved', kind: 'memory_write' } });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    const region = await screen.findByRole('region', { name: memCard.summary });
    fireEvent.click(within(region).getByRole('button', { name: 'com_mindstone_appr_approve' }));
    const confirm = within(region).getByRole('button', {
      name: 'com_mindstone_appr_confirm_approve',
    });
    confirm.focus();
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    await screen.findByText('com_mindstone_appr_approved');
    expect(document.activeElement).not.toBe(document.body);
  });
});
