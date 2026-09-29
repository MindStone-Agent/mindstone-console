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

describe('MindStone approvals: focus, late re-reads and honest outcomes (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('a stale re-read answering after the owner reopened the card does not steal focus from the note being typed', async () => {
    const reads: Array<ReturnType<typeof deferred>> = [];
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        if (reads.length === 0) {
          reads.push(deferred());
          return Promise.resolve({ action: plainA });
        }
        const d = deferred();
        reads.push(d);
        return d.promise;
      }
      return Promise.resolve(list([plainA]));
    });
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    let section = await screen.findByRole('region', { name: plainA.summary });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    mockPost.mockRejectedValueOnce({
      response: { status: 502, data: { ok: false, error: 'GW-DOWN' } },
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    await screen.findByText('GW-DOWN');
    await act(async () => undefined);
    // re-read reads[1] is still out; the owner clicks the card again (list unlocked)
    fireEvent.click(screen.getByText(plainA.summary, { selector: 'span' }));
    await act(async () => {
      reads[2].resolve({ action: plainA });
    });
    section = screen.getByRole('region', { name: plainA.summary });
    // fresh open: no message
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    const box = within(section).getByRole('textbox') as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'half a sen' } });
    expect(document.activeElement).toBe(box);
    // the older re-read answers now
    await act(async () => {
      reads[1].resolve({ action: plainA });
    });
    expect(document.activeElement).toBe(box);
    expect(screen.queryByText('GW-DOWN')).toBeNull();
  });

  it('no answer to the decision AND the re-read fails: the page must not point at a card that is not there', async () => {
    let n = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        n += 1;
        return n === 1
          ? Promise.resolve({ action: memCard })
          : Promise.reject({ message: 'Network Error' });
      }
      return Promise.resolve(list([memCard]));
    });
    mockPost.mockRejectedValue({ message: 'Network Error' });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await act(async () => undefined);
    await act(async () => undefined);
    const status = screen.getByRole('status');
    const cardShown = screen.queryByRole('region', { name: memCard.summary }) !== null;
    // "The card below shows what it is now" is only true if a card is below.
    expect(cardShown || !status.textContent?.includes('com_mindstone_appr_outcome_unknown')).toBe(
      true,
    );
  });

  it('a 403 Forbidden (read-only admin) is a definite refusal, not "didn\'t hear back"', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({ response: { status: 403, data: { message: 'Forbidden' } } });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.getByRole('status')).not.toHaveTextContent('com_mindstone_appr_outcome_unknown');
  });

  // Gap specs: pass on HEAD, meant to kill surviving mutants.
  it('not_found closes the card', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({
      response: { status: 404, data: { error: 'NF', code: 'not_found' } },
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await screen.findByText('NF');
    expect(screen.queryByRole('region', { name: memCard.summary })).toBeNull();
  });

  it('a reject with no answer that did go through: no Confirm reject on the decided card', async () => {
    let rejected = false;
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: { ...plainA, status: rejected ? 'rejected' : 'pending' } })
        : Promise.resolve(list([plainA])),
    );
    renderPage();
    fireEvent.click(await screen.findByText(plainA.summary));
    const section = await screen.findByRole('region', { name: plainA.summary });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    mockPost.mockImplementationOnce(() => {
      rejected = true;
      return Promise.reject({ message: 'Network Error' });
    });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    await act(async () => undefined);
    await act(async () => undefined);
    const now = screen.getByRole('region', { name: plainA.summary });
    expect(
      within(now).queryByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    ).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('com_mindstone_appr_outcome_unknown');
  });

  it('an approve with no answer that is still pending does not leave Confirm approve armed', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({ message: 'Network Error' });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await act(async () => undefined);
    await act(async () => undefined);
    const now = screen.getByRole('region', { name: memCard.summary });
    expect(
      within(now).queryByRole('button', { name: 'com_mindstone_appr_confirm_approve' }),
    ).toBeNull();
  });

  it('a coded refusal with no text says Not changed', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({ response: { status: 409, data: { code: 'memory_exists' } } });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    expect(await screen.findByRole('status')).toHaveTextContent('com_mindstone_not_changed');
  });

  it('the deciding live region exists before the decision starts', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    renderPage();
    await screen.findByText(memCard.summary);
    const region = document.querySelector(
      'section[aria-labelledby="ms-appr-list"] [aria-live="polite"]',
    );
    expect(region).not.toBeNull();
  });
  it('a long approve finishing does not pull focus out of a field the owner moved to elsewhere in the app', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    const post = deferred();
    mockPost.mockReturnValue(post.promise);
    render(
      <MemoryRouter>
        <input aria-label="app search" />
        <ApprovalsView />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    const search = screen.getByLabelText('app search');
    search.focus();
    await act(async () => {
      post.resolve({
        ok: true,
        result: { outcome: 'approved', kind: 'persona_kb_create', ingested: { entryCount: 1 } },
      });
    });
    expect(document.activeElement).toBe(search);
  });
});
