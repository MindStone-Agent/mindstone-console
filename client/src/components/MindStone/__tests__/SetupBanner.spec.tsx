import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MindStoneSetupBanner, { SETUP_BANNER_DISMISSED_KEY } from '../SetupBanner';

let mockRole: string | undefined;
const mockGet = jest.fn();

jest.mock('librechat-data-provider', () => ({
  request: { get: (...args: unknown[]) => mockGet(...args) },
  SystemRoles: { ADMIN: 'ADMIN', USER: 'USER' },
}));
const mockLocalize = (key: string) => key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useAuthContext: () => ({ user: mockRole ? { id: 'u1', role: mockRole } : undefined }),
}));

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={['/c/new']}>
      <Routes>
        <Route path="/c/new" element={<MindStoneSetupBanner />} />
        <Route path="/mindstone/onboarding" element={<p data-testid="onboarding-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MindStoneSetupBanner (mindstone-console #18)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockGet.mockReset();
    mockRole = 'ADMIN';
  });

  it('shows an admin the banner when setup is incomplete, and opens onboarding', async () => {
    mockGet.mockResolvedValue({ ok: true, onboarded: false, steps: {} });
    renderBanner();
    expect(await screen.findByTestId('mindstone-setup-banner')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/mindstone/admin/status');
    expect(screen.getByText('com_mindstone_setup_banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_setup_banner_action' }));
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
  });

  it('stays hidden once setup is done', async () => {
    mockGet.mockResolvedValue({ ok: true, onboarded: true, steps: {} });
    renderBanner();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
  });

  it('stays hidden when the status has no onboarded flag', async () => {
    mockGet.mockResolvedValue({ ok: true });
    renderBanner();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
  });

  it('stays hidden, without an error, when the status call fails', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('503'), { response: { status: 503 } }));
    renderBanner();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is never shown to, or fetched for, a non-admin', async () => {
    mockRole = 'USER';
    mockGet.mockResolvedValue({ ok: true, onboarded: false });
    renderBanner();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
  });

  it('remembers a dismissal for the browser session', async () => {
    mockGet.mockResolvedValue({ ok: true, onboarded: false });
    const { unmount } = renderBanner();
    fireEvent.click(
      await screen.findByRole('button', { name: 'com_mindstone_setup_banner_dismiss' }),
    );
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
    expect(sessionStorage.getItem(SETUP_BANNER_DISMISSED_KEY)).toBe('1');
    unmount();

    mockGet.mockClear();
    renderBanner();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mindstone-setup-banner')).toBeNull();
  });
});
