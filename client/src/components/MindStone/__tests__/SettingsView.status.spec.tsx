import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
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
});
