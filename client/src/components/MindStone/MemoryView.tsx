/**
 * The Memory page (#53): how memory is set up (the embedding model and
 * automatic recall) and whether it's working (the memory store's status),
 * with a link to change the setup. Reads the same gateway status and config
 * as the settings page, through the admin proxy.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import type { SystemStatusData } from './SystemStatus';
import type { StatusSteps } from './steps';
import { MemoryStatus } from './SystemStatus';
import { visibleText } from './visibleText';
import { setupChoices } from './YourSetup';
import { useLocalize } from '~/hooks';

type Status = { onboarded: boolean; steps: StatusSteps; system?: SystemStatusData };

const BASE = '/api/mindstone/admin';
const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';

export default function MindStoneMemoryView() {
  const localize = useLocalize();
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        request.get<Status>(`${BASE}/status`),
        request.get<{ config: Record<string, unknown> }>(`${BASE}/config`),
      ]);
      setStatus(s);
      setConfig(c.config);
      setLoadError(null);
    } catch (error) {
      // The proxy refuses non-admins (403) before the gateway is ever asked.
      const response = (error as { response?: { status?: number; data?: { error?: string } } })
        ?.response;
      setLoadError(
        response?.status === 403
          ? localize('com_mindstone_admin_only')
          : (response?.data?.error ?? localize('com_mindstone_gateway_unreachable')),
      );
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  const memoryChoice = status
    ? setupChoices(config, status.steps, {
        on: localize('com_mindstone_ys_on'),
        off: localize('com_mindstone_ys_off'),
        recall: localize('com_mindstone_ys_recall'),
        none: localize('com_mindstone_ys_none'),
        host: localize('com_mindstone_ys_host'),
      }).find((choice) => choice.key === 'memory')
    : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6 text-text-primary">
        <h1 className="text-2xl font-semibold">{localize('com_mindstone_mem_title')}</h1>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_mem_hint')}</p>

        {loadError && (
          <p role="alert" className="text-red-500" data-testid="ms-mem-error">
            {loadError}
          </p>
        )}
        {!loadError && !status && (
          <p className="text-text-secondary">{localize('com_mindstone_loading')}</p>
        )}

        {status && (
          <>
            <section className={card} aria-labelledby="ms-mem-setup" data-testid="ms-mem-setup">
              <h2 id="ms-mem-setup" className="mb-1 text-lg font-medium">
                {localize('com_mindstone_mem_setup')}
              </h2>
              <p className="text-sm">
                {memoryChoice?.value !== undefined ? (
                  <span className="break-all font-mono" data-testid="ms-mem-embedding">
                    {visibleText(memoryChoice.value)}
                  </span>
                ) : (
                  <span className="text-text-secondary" data-testid="ms-mem-not-set">
                    {localize('com_mindstone_mem_not_set')}
                  </span>
                )}
              </p>
              <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
                {memoryChoice?.change && (
                  <Link
                    to={`/mindstone/onboarding?change=${memoryChoice.change}&from=memory`}
                    className="underline"
                    data-testid="ms-mem-change"
                  >
                    {localize('com_mindstone_mem_change')}
                  </Link>
                )}
                <Link to="/mindstone" className="underline" data-testid="ms-mem-settings">
                  {localize('com_mindstone_mem_all_settings')}
                </Link>
              </p>
            </section>

            <section className={card} data-testid="ms-mem-status">
              <MemoryStatus memory={status.system?.memory} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
