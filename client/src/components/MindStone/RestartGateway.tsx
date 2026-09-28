/**
 * Restart the MindStone gateway from the Console (MindStone-Agent #90). The
 * gateway restarts itself only when whoever started it declared a supervisor
 * and the evidence matches; otherwise this shows what to run on the host.
 * After a restart it polls the status until a new start time shows up.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Status = {
  supervisor?: string | null;
  supervisorConfirmed?: boolean;
  supervisorDetail?: string;
  startedAt?: string;
  recentStarts?: number;
};

const BASE = '/api/mindstone/admin';
/** launchd can hold a quick restart back for its ThrottleInterval (10 s), so wait well past it. */
const COME_BACK_MS = 60_000;
const POLL_MS = 2_000;

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function RestartGateway({ needed }: { needed: boolean }) {
  const localize = useLocalize();
  const [status, setStatus] = useState<Status | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'done' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      setStatus(await request.get<Status>(`${BASE}/status`));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void load();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  const restart = async () => {
    setConfirming(false);
    setMessage(null);
    const before = status?.startedAt;
    try {
      await request.post(`${BASE}/restart`, {});
    } catch (error) {
      setPhase('failed');
      setMessage(errorText(error) ?? localize('com_mindstone_not_changed'));
      return;
    }
    setPhase('restarting');
    const deadline = Date.now() + COME_BACK_MS;
    while (!cancelled.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      try {
        const next = await request.get<Status>(`${BASE}/status`);
        if (next.startedAt && next.startedAt !== before) {
          setStatus(next);
          setPhase('done');
          return;
        }
      } catch {
        // Down while it restarts: keep polling.
      }
    }
    if (!cancelled.current) {
      setPhase('failed');
      setMessage(localize('com_mindstone_rst_not_back'));
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1';
  const canRestart = Boolean(status?.supervisor && status.supervisorConfirmed);

  return (
    <section className={card} aria-labelledby="ms-restart">
      <h2 id="ms-restart" className="mb-2 text-lg font-medium">
        {localize('com_mindstone_rst_title')}
      </h2>
      {needed && <p className="mb-2 text-sm font-medium">{localize('com_mindstone_rst_needed')}</p>}
      {status && (
        <p className="mb-2 text-sm text-text-secondary">
          {status.supervisor
            ? localize(
                status.supervisorConfirmed
                  ? 'com_mindstone_rst_supervised'
                  : 'com_mindstone_rst_unconfirmed',
                { 0: status.supervisor, 1: status.supervisorDetail ?? '' },
              )
            : localize('com_mindstone_rst_unsupervised')}
          {status.startedAt
            ? ` ${localize('com_mindstone_rst_started', { 0: new Date(status.startedAt).toLocaleString() })}`
            : ''}
        </p>
      )}
      {(status?.recentStarts ?? 0) >= 3 && (
        <p className="mb-2 text-sm text-yellow-600">
          {localize('com_mindstone_rst_crash_loop', { 0: String(status?.recentStarts) })}
        </p>
      )}
      {canRestart && phase !== 'restarting' && !confirming && (
        <button type="button" className={primary} onClick={() => setConfirming(true)}>
          {localize('com_mindstone_rst_button')}
        </button>
      )}
      {confirming && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{localize('com_mindstone_rst_confirm')}</p>
          <div className="flex gap-2">
            <button type="button" className={primary} onClick={() => void restart()}>
              {localize('com_mindstone_rst_confirm_button')}
            </button>
            <button type="button" className={secondary} onClick={() => setConfirming(false)}>
              {localize('com_mindstone_rst_cancel')}
            </button>
          </div>
        </div>
      )}
      {!canRestart && status && (
        <p className="text-sm">{localize('com_mindstone_rst_host_command')}</p>
      )}
      {phase === 'restarting' && (
        <p role="status" className="text-sm">
          {localize('com_mindstone_rst_restarting')}
        </p>
      )}
      {phase === 'done' && (
        <p role="status" className="text-sm text-green-600">
          {localize('com_mindstone_rst_done')}
        </p>
      )}
      {phase === 'failed' && message && (
        <p role="alert" className="text-sm text-red-600">
          {message}
        </p>
      )}
    </section>
  );
}
