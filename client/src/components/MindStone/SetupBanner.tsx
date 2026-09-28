/**
 * MindStone setup banner (mindstone-console #18): on the chat view, an admin
 * whose gateway reports setup incomplete gets a way into guided setup. It
 * reads the same onboarding status as the settings page (/admin/status,
 * `onboarded`). Non-admins never see it, and it stays hidden if the status
 * call fails for any reason, so it can never get in the way of chat.
 * Dismissing it lasts for this browser session.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { request, SystemRoles } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

export const SETUP_BANNER_DISMISSED_KEY = 'mindstone:setup-banner-dismissed';
const STATUS_URL = '/api/mindstone/admin/status';

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(SETUP_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export default function MindStoneSetupBanner() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const navigate = useNavigate();
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    if (!isAdmin || dismissed) return;
    let active = true;
    request
      .get<{ onboarded?: unknown }>(STATUS_URL)
      .then((status) => {
        // Only an explicit "not onboarded" shows the banner; anything else keeps it hidden.
        if (active) setNeedsSetup(status?.onboarded === false);
      })
      .catch(() => {
        if (active) setNeedsSetup(false);
      });
    return () => {
      active = false;
    };
  }, [isAdmin, dismissed]);

  if (!isAdmin || dismissed || !needsSetup) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(SETUP_BANNER_DISMISSED_KEY, '1');
    } catch {
      // Storage refused: it is still dismissed until the page reloads.
    }
    setDismissed(true);
  };

  return (
    <div className="relative z-10 mx-auto mt-[52px] w-full max-w-3xl px-4 xl:max-w-4xl">
      <section
        aria-label={localize('com_mindstone_setup_banner')}
        data-testid="mindstone-setup-banner"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border-medium bg-surface-secondary px-4 py-3 text-sm text-text-primary"
      >
        <p className="min-w-0 flex-1">{localize('com_mindstone_setup_banner')}</p>
        <button
          type="button"
          className="rounded bg-surface-submit px-3 py-1.5 text-white"
          onClick={() => navigate('/mindstone/onboarding')}
        >
          {localize('com_mindstone_setup_banner_action')}
        </button>
        <button
          type="button"
          className="rounded p-1 text-text-secondary hover:bg-surface-hover"
          aria-label={localize('com_mindstone_setup_banner_dismiss')}
          onClick={dismiss}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </section>
    </div>
  );
}
