import { MessagesSquare } from 'lucide-react';
import type { NavLink } from '~/common';

jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => () => null);
jest.mock('~/components/MindStone/MindStoneSection', () => () => null);
jest.mock('~/hooks/Nav/useSideNavLinks', () => () => []);
jest.mock('~/data-provider', () => ({}));
jest.mock('~/hooks', () => ({}));
jest.mock('~/store', () => ({}));

import { leadingLinks, mindStoneLink } from '../useUnifiedSidebarLinks';

const chats: NavLink = {
  title: 'com_ui_chat_history',
  label: '',
  icon: MessagesSquare,
  id: 'conversations',
};

describe('the MindStone section in the sidebar (#53)', () => {
  it('comes right after the chats for an admin', () => {
    expect(leadingLinks(chats, true).map((link) => link.id)).toEqual([
      'conversations',
      'mindstone',
    ]);
    expect(mindStoneLink.title).toBe('com_mindstone_nav');
    expect(mindStoneLink.Component).toBeDefined();
  });

  it("isn't there for anyone else", () => {
    expect(leadingLinks(chats, false).map((link) => link.id)).toEqual(['conversations']);
  });
});
