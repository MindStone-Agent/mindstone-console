import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import SettingsView from '../SettingsView';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'u1' } }),
}));

const mockGet = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: { get: (...args: unknown[]) => mockGet(...args), post: jest.fn(), patch: jest.fn() },
}));

function renderPage() {
  render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>,
  );
}

describe('MindStone settings page status', () => {
  afterEach(() => mockGet.mockReset());

  it('shows a loading line, then the system status the gateway returned', async () => {
    let resolveStatus: (value: unknown) => void = () => undefined;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return new Promise((resolve) => (resolveStatus = resolve));
      if (url.endsWith('/config')) return Promise.resolve({ config: {}, etag: 'e1' });
      return Promise.resolve({ permissions: { advancedSettings: false } });
    });
    renderPage();
    expect(screen.getByText('com_mindstone_loading')).toBeInTheDocument();
    resolveStatus({ onboarded: true, steps: {}, system: { ok: true, connectors: [] } });
    expect(await screen.findByTestId('ms-system')).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_sys_connectors_none')).toBeInTheDocument();
    expect(screen.queryByText('com_mindstone_loading')).toBeNull();
  });

  it('tells a non-admin the page is for admins instead of blaming the gateway', async () => {
    mockGet.mockRejectedValue({ response: { status: 403, data: { message: 'Forbidden' } } });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_mindstone_admin_only');
    expect(screen.queryByText('com_mindstone_loading')).toBeNull();
  });

  it('still says the gateway is unreachable for other failures', async () => {
    mockGet.mockRejectedValue({ response: { status: 502, data: {} } });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_mindstone_gateway_unreachable');
  });

  describe('the setup checklist (MindStone-Agent #102)', () => {
    async function renderSteps(steps: Record<string, { done: boolean; detail: string }>) {
      mockGet.mockImplementation((url: string) => {
        if (url.endsWith('/status')) return Promise.resolve({ onboarded: true, steps });
        if (url.endsWith('/config')) return Promise.resolve({ config: {}, etag: 'e1' });
        return Promise.resolve({ permissions: { advancedSettings: false } });
      });
      renderPage();
      await screen.findByTestId('ms-step-connectors');
    }

    it('calls a missing connector optional, not a gap', async () => {
      await renderSteps({ connectors: { done: false, detail: 'not configured' } });
      const row = screen.getByTestId('ms-step-connectors');
      expect(row).toHaveTextContent('com_mindstone_step_connectors: com_mindstone_step_optional');
      expect(row).not.toHaveTextContent('not configured');
    });

    it('shows a connector that is set up by what the gateway says', async () => {
      await renderSteps({ connectors: { done: true, detail: 'telegram' } });
      expect(screen.getByTestId('ms-step-connectors')).toHaveTextContent(
        'com_mindstone_step_connectors: telegram',
      );
    });

    it("says what memory is missing and links to setup's memory step", async () => {
      await renderSteps({
        connectors: { done: false, detail: 'none' },
        memory: { done: false, detail: 'no embedding provider set' },
      });
      const row = screen.getByTestId('ms-step-memory');
      expect(row).toHaveTextContent('com_mindstone_step_memory: no embedding provider set');
      expect(
        within(row).getByRole('link', { name: 'com_mindstone_step_set_up_memory' }),
      ).toHaveAttribute('href', '/mindstone/onboarding?step=memory');
    });

    it('shows the identity step and links a missing one to the about step', async () => {
      await renderSteps({
        connectors: { done: false, detail: 'none' },
        identity: { done: false, detail: 'no identity yet' },
      });
      const row = screen.getByTestId('ms-step-identity');
      expect(row).toHaveTextContent('com_mindstone_step_identity: no identity yet');
      expect(
        within(row).getByRole('link', { name: 'com_mindstone_step_set_up_identity' }),
      ).toHaveAttribute('href', '/mindstone/onboarding?step=about');
    });

    it('links nothing once a step is done, and names a step it does not know', async () => {
      await renderSteps({
        connectors: { done: true, detail: 'slack' },
        memory: { done: true, detail: 'vector store sqlite-vec, autoRecall on' },
        identity: { done: true, detail: 'identity written' },
        future: { done: false, detail: 'later' },
      });
      expect(within(screen.getByTestId('ms-step-memory')).queryByRole('link')).toBeNull();
      expect(within(screen.getByTestId('ms-step-identity')).queryByRole('link')).toBeNull();
      expect(screen.getByTestId('ms-step-future')).toHaveTextContent('future: later');
    });
  });
});
