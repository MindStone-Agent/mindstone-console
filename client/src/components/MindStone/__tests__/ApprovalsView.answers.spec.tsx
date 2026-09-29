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

describe('MindStone approvals: what counts as an answer (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it('the bundled nginx 504 (HTML body) on a long KB approve is not "Not changed"', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: kbCard })
        : Promise.resolve(list([kbCard])),
    );
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 504',
      response: {
        status: 504,
        data: '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx/1.27.0</center></body></html>',
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(kbCard.summary));
    approve(await screen.findByRole('region', { name: kbCard.summary }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.getByRole('status')).not.toHaveTextContent('com_mindstone_not_changed');
  });

  it('no answer; owner reopens the card; the stale re-read answering late must not say the card cannot be read', async () => {
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
    const section = await screen.findByRole('region', { name: plainA.summary });
    fireEvent.click(within(section).getByRole('button', { name: 'com_mindstone_appr_reject' }));
    mockPost.mockRejectedValueOnce({ message: 'Network Error' });
    fireEvent.click(
      within(section).getByRole('button', { name: 'com_mindstone_appr_confirm_reject' }),
    );
    await screen.findByText('com_mindstone_appr_outcome_unknown');
    await act(async () => undefined);
    fireEvent.click(screen.getByText(plainA.summary, { selector: 'span' }));
    await act(async () => {
      reads[2].resolve({ action: plainA });
    });
    expect(screen.getByRole('region', { name: plainA.summary })).toBeInTheDocument();
    await act(async () => {
      reads[1].resolve({ action: plainA });
    });
    // The card is on screen, freshly read; the page now claims it can't read it.
    expect(screen.getByRole('region', { name: plainA.summary })).toBeInTheDocument();
    expect(screen.queryByText('com_mindstone_appr_no_answer_no_card')).toBeNull();
  });

  it('a refusal WITH an answer whose re-read fails: the owner still learns it was refused', async () => {
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
    mockPost.mockRejectedValue({ response: { status: 403, data: { message: 'Forbidden' } } });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.getByRole('status')).toHaveTextContent('Forbidden');
  });

  it('a 4xx with no JSON body is an answer: "not changed", not "outcome unknown"', async () => {
    mockGet.mockImplementation((url: string) =>
      url.endsWith(`/approvals/${A}`)
        ? Promise.resolve({ action: memCard })
        : Promise.resolve(list([memCard])),
    );
    mockPost.mockRejectedValue({ response: { status: 413, data: 'Payload Too Large' } });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    expect(await screen.findByText('com_mindstone_not_changed')).toBeInTheDocument();
  });

  it('the Console\'s own 504 JSON, then a failed re-read: the decision\'s text stays, not "no answer"', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith(`/approvals/${A}`)) {
        reads += 1;
        return reads === 1
          ? Promise.resolve({ action: memCard })
          : Promise.reject({ message: 'Network Error' });
      }
      return Promise.resolve(list([memCard]));
    });
    mockPost.mockRejectedValue({
      response: {
        status: 504,
        data: { ok: false, error: 'CONSOLE-TIMEOUT-TEXT', code: 'gateway_timeout' },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText(memCard.summary));
    approve(await screen.findByRole('region', { name: memCard.summary }));
    expect(await screen.findByText('CONSOLE-TIMEOUT-TEXT')).toBeInTheDocument();
    expect(screen.queryByText('com_mindstone_appr_no_answer_no_card')).toBeNull();
  });
});
