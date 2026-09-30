/**
 * The MindStone section of the left sidebar (#53), for admins: one link to
 * each MindStone page, so they're found from the chat page without the name
 * menu or a typed address. The pages check admin access on the server too.
 */
import { memo } from 'react';
import { useMediaQuery } from '@librechat/client';
import { useLocation, useNavigate } from 'react-router-dom';
import { Brain, CheckSquare, Drama, Server, Settings, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export const MINDSTONE_PAGES: { to: string; label: TranslationKeys; icon: LucideIcon }[] = [
  { to: '/mindstone/personas', label: 'com_mindstone_per_title', icon: Drama },
  { to: '/mindstone/skills', label: 'com_mindstone_skill_title', icon: Wrench },
  { to: '/mindstone/memory', label: 'com_mindstone_mem_title', icon: Brain },
  { to: '/mindstone/approvals', label: 'com_mindstone_appr_title', icon: CheckSquare },
  { to: '/mindstone/providers', label: 'com_mindstone_prov_title', icon: Server },
  { to: '/mindstone', label: 'com_mindstone_settings_title', icon: Settings },
];

const MindStoneSection = memo(function MindStoneSection() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { setSidebarOpen } = useSidebarToggle();

  return (
    <nav
      aria-label={localize('com_mindstone_nav')}
      className="flex flex-col gap-1 px-2 py-2"
      data-testid="mindstone-section"
    >
      <h2 className="px-2 pb-1 text-sm font-medium text-text-secondary">
        {localize('com_mindstone_nav')}
      </h2>
      {MINDSTONE_PAGES.map(({ to, label, icon: Icon }) => {
        const current = location.pathname === to;
        return (
          <a
            key={to}
            href={to}
            aria-current={current ? 'page' : undefined}
            data-testid={`mindstone-nav-${to.split('/').pop()}`}
            className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-text-primary transition-colors hover:bg-surface-hover',
              current && 'bg-surface-active-alt',
            )}
            onClick={(e) => {
              // A plain click stays in the app; a modified click opens a new tab as usual.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              // On a phone the sidebar covers the page: close it, then go.
              if (isSmallScreen) {
                setSidebarOpen(false, () => navigate(to));
              } else {
                navigate(to);
              }
            }}
          >
            <Icon className="h-4 w-4 text-text-secondary" aria-hidden="true" />
            <span>{localize(label)}</span>
          </a>
        );
      })}
    </nav>
  );
});

export default MindStoneSection;
