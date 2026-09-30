/**
 * The MindStone section is in the sidebar for admins only (#53), through the
 * real hook.
 */
import { renderHook } from '@testing-library/react';
import { SystemRoles } from 'librechat-data-provider';

let mockRole: string | undefined = SystemRoles.ADMIN;
jest.mock('~/hooks', () => ({ useAuthContext: () => ({ user: { id: 'u1', role: mockRole } }) }));
jest.mock('~/hooks/Nav/useSideNavLinks', () => () => []);
jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => () => null);
jest.mock('~/components/MindStone/MindStoneSection', () => () => null);
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
  useGetEndpointsQuery: () => ({ data: {} }),
  useInsightsAccessQuery: () => ({ data: undefined, isLoading: false }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: () => ({ data: { expiresAt: undefined } }),
}));
jest.mock('recoil', () => ({ ...jest.requireActual('recoil'), useRecoilValue: () => undefined }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/c/new' }),
}));
jest.mock('~/store', () => ({ conversationEndpointByIndex: () => ({}) }));

import useUnifiedSidebarLinks from '../useUnifiedSidebarLinks';

describe('useUnifiedSidebarLinks and the MindStone section (#53)', () => {
  it('includes it right after the chats for an admin', () => {
    mockRole = SystemRoles.ADMIN;
    const { result } = renderHook(() => useUnifiedSidebarLinks());
    expect(result.current.map((l) => l.id).slice(0, 2)).toEqual(['conversations', 'mindstone']);
  });

  it('leaves it out for a user who is not an admin', () => {
    mockRole = SystemRoles.USER;
    const { result } = renderHook(() => useUnifiedSidebarLinks());
    expect(result.current.map((l) => l.id)).not.toContain('mindstone');
  });
});
