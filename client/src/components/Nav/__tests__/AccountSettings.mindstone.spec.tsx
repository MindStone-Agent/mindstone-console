import { SystemRoles } from 'librechat-data-provider';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import AccountSettings from '../AccountSettings';

let mockRole: string | undefined;
let mockSmallScreen = false;
const mockSetSidebarOpen = jest.fn((_next: boolean, afterSlide?: () => void) => afterSlide?.());

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => jest.fn(),
}));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({
    user: { id: 'u1', name: 'Pat', email: 'pat@example.com', role: mockRole },
    isAuthenticated: true,
    logout: jest.fn(),
  }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
  useGetUserBalance: () => ({ data: undefined }),
}));
jest.mock('@librechat/client', () => ({
  GearIcon: () => null,
  DropdownMenuSeparator: () => <hr />,
  Avatar: () => null,
  useMediaQuery: () => mockSmallScreen,
}));
jest.mock('~/hooks/Nav/useSidebarToggle', () => () => ({ setSidebarOpen: mockSetSidebarOpen }));
jest.mock('../Settings', () => () => null);
jest.mock('~/components/Nav/SettingsTabs/General/ArchivedChatsModal', () => ({
  ArchivedChatsModal: () => null,
}));
jest.mock('~/store', () => ({ showShortcutsDialog: {} }));

function renderMenu() {
  render(
    <MemoryRouter initialEntries={['/c/new']}>
      <Routes>
        <Route path="/c/new" element={<AccountSettings />} />
        <Route path="/mindstone" element={<p data-testid="mindstone-page" />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTestId('nav-user'));
}

describe('AccountSettings MindStone link', () => {
  beforeEach(() => {
    mockSmallScreen = false;
    mockSetSidebarOpen.mockClear();
  });

  it('shows admins a MindStone item that opens /mindstone', async () => {
    mockRole = SystemRoles.ADMIN;
    renderMenu();
    fireEvent.click(await screen.findByTestId('nav-mindstone'));
    expect(await screen.findByTestId('mindstone-page')).toBeInTheDocument();
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
  });

  it('closes the drawer first on a phone, then opens /mindstone', async () => {
    mockRole = SystemRoles.ADMIN;
    mockSmallScreen = true;
    renderMenu();
    fireEvent.click(await screen.findByTestId('nav-mindstone'));
    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false, expect.any(Function));
    expect(await screen.findByTestId('mindstone-page')).toBeInTheDocument();
  });

  it('does not show the item to other users', async () => {
    mockRole = SystemRoles.USER;
    renderMenu();
    expect(await screen.findByTestId('nav-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-mindstone')).toBeNull();
  });
});
