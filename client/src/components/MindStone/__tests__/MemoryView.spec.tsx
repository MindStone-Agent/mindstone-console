import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import MemoryView from '../MemoryView';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key} ${JSON.stringify(args)}` : key,
}));

const mockGet = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: { get: (...args: unknown[]) => mockGet(...args) },
}));

const done = { done: true, detail: '' };
function respond(status: unknown, config: unknown = {}) {
  mockGet.mockImplementation((url: string) =>
    url.endsWith('/status') ? Promise.resolve(status) : Promise.resolve({ config }),
  );
}

function renderPage() {
  render(
    <MemoryRouter>
      <MemoryView />
    </MemoryRouter>,
  );
}

describe('MindStone Memory page (#53)', () => {
  afterEach(() => mockGet.mockReset());

  it('shows the embedding model, recall, and the memory store status', async () => {
    respond(
      {
        onboarded: true,
        steps: { access: done, provider: done, model: done, persona: done, memory: done },
        system: {
          memory: {
            sqlite: {
              present: true,
              vectorBackend: 'sqlite-vec',
              sources: 3,
              chunks: 40,
              embeddedChunks: 38,
            },
          },
        },
      },
      { memory: { embeddingProvider: 'ollama:nomic-embed-text', autoRecall: true } },
    );
    renderPage();
    expect(await screen.findByTestId('ms-mem-embedding')).toHaveTextContent(
      'ollama:nomic-embed-text; com_mindstone_ys_recall com_mindstone_ys_on',
    );
    expect(screen.getByTestId('ms-sys-memory')).toHaveTextContent('sqlite-vec');
    expect(screen.getByTestId('ms-sys-memory')).toHaveTextContent(
      'com_mindstone_sys_memory_counts',
    );
    expect(screen.getByTestId('ms-mem-settings')).toHaveAttribute('href', '/mindstone');
  });

  it("says so when memory isn't set up, and when the store reports a problem", async () => {
    respond({
      onboarded: false,
      steps: {},
      system: { memory: { sqlite: { present: true, error: 'database is locked' } } },
    });
    renderPage();
    expect(await screen.findByTestId('ms-mem-not-set')).toBeInTheDocument();
    expect(screen.getByTestId('ms-sys-memory')).toHaveTextContent('database is locked');
  });

  it('links a change back to this page when the memory step can be changed', async () => {
    respond(
      {
        onboarded: true,
        steps: { access: done, provider: done, model: done, persona: done, memory: done },
        system: {},
      },
      { memory: { embeddingProvider: 'ollama:nomic-embed-text' } },
    );
    renderPage();
    const change = await screen.findByTestId('ms-mem-change');
    expect(change.getAttribute('href')).toMatch(
      /^\/mindstone\/onboarding\?change=memory&from=memory$/,
    );
  });

  it('tells a non-admin the page is for admins', async () => {
    mockGet.mockRejectedValue({ response: { status: 403, data: {} } });
    renderPage();
    expect(await screen.findByTestId('ms-mem-error')).toHaveTextContent('com_mindstone_admin_only');
  });
});
