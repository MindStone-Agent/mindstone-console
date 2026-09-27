/**
 * MindStone stored secrets (MindStone-Agent #88): the secrets the gateway
 * holds, by name only (no value ever leaves the gateway), which connectors
 * read each one, and delete. Deleting needs advanced settings, like
 * replacing a secret; the gateway's own credentials and links made on the
 * host are refused there.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Secret = {
  name: string;
  kind: 'file' | 'link' | 'other';
  size?: number;
  modifiedAt?: string;
  tokenFile: string;
  usedBy: string[];
  gatewayCredential: boolean;
};

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function MindStoneSecretsView() {
  const localize = useLocalize();
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, permissions] = await Promise.all([
        request.get<{ secrets: Secret[] }>(`${BASE}/secrets`),
        request.get<{ permissions: { advancedSettings: boolean } }>(`${BASE}/permissions`),
      ]);
      setSecrets(list.secrets);
      setAdvanced(permissions.permissions.advancedSettings);
    } catch (error) {
      setMessage({
        ok: false,
        text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
      });
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (name: string) => {
    setBusy(true);
    try {
      const result = (await request.delete(`${BASE}/secrets/${encodeURIComponent(name)}`)) as {
        usedBy: string[];
      };
      setMessage({
        ok: true,
        text: result.usedBy?.length
          ? localize('com_mindstone_sec_deleted_used', { 0: name, 1: result.usedBy.join(', ') })
          : localize('com_mindstone_sec_deleted', { 0: name }),
      });
      setConfirming(null);
      await load();
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const danger = 'rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_sec_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_sec_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_sec_intro')}</p>
        {!advanced && (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_sec_need_advanced')}
          </p>
        )}
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}
        <section className={card} aria-labelledby="ms-sec-list">
          <h2 id="ms-sec-list" className="mb-2 text-lg font-medium">
            {localize('com_mindstone_sec_list', { 0: String(secrets?.length ?? 0) })}
          </h2>
          {secrets && secrets.length === 0 && (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_sec_none')}</p>
          )}
          <ul className="flex flex-col divide-y divide-border-light">
            {secrets?.map((secret) => (
              <li
                key={secret.name}
                className="flex flex-col gap-1 py-2"
                data-testid={`ms-secret-${secret.name}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-mono text-sm">{secret.name}</span>{' '}
                    <span className="text-xs text-text-secondary">
                      {secret.kind}
                      {secret.size !== undefined ? ` · ${secret.size} B` : ''}
                      {secret.modifiedAt
                        ? ` · ${new Date(secret.modifiedAt).toLocaleString()}`
                        : ''}
                    </span>
                  </div>
                  {secret.gatewayCredential || secret.kind !== 'file' ? (
                    <span className="text-xs text-text-secondary">
                      {localize(
                        secret.gatewayCredential
                          ? 'com_mindstone_sec_gateway_credential'
                          : 'com_mindstone_sec_host_only',
                      )}
                    </span>
                  ) : (
                    confirming !== secret.name && (
                      <button
                        type="button"
                        className={secondary}
                        disabled={!advanced || busy}
                        onClick={() => setConfirming(secret.name)}
                      >
                        {localize('com_mindstone_sec_delete')}
                      </button>
                    )
                  )}
                </div>
                <span className="text-xs text-text-secondary">
                  {secret.usedBy.length
                    ? localize('com_mindstone_sec_used_by', { 0: secret.usedBy.join(', ') })
                    : localize('com_mindstone_sec_unused')}
                </span>
                {confirming === secret.name && (
                  <div className="flex flex-col gap-2 rounded bg-surface-secondary p-2">
                    <p className="text-sm">
                      {secret.usedBy.length
                        ? localize('com_mindstone_sec_confirm_used', {
                            0: secret.name,
                            1: secret.usedBy.join(', '),
                          })
                        : localize('com_mindstone_sec_confirm', { 0: secret.name })}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={danger}
                        disabled={busy}
                        onClick={() => void remove(secret.name)}
                      >
                        {localize('com_mindstone_sec_confirm_delete')}
                      </button>
                      <button
                        type="button"
                        className={secondary}
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {localize('com_mindstone_sec_cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
