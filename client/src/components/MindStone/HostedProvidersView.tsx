/**
 * Hosted model providers (MindStone-Agent #98): Anthropic, OpenAI, Google and
 * the others that take an API key. The key is stored as a gateway secret and
 * then linked to the provider, so it never comes back to the browser. An
 * OAuth login stays on the gateway host (mindstone auth login).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Provider = { providerId: string; name: string; env: string; auth: string | null };

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

/** The secret a provider's key is stored under. */
function secretName(providerId: string): string {
  return `provider-${providerId}.key`;
}

export default function MindStoneHostedProvidersView() {
  const localize = useLocalize();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, permissions] = await Promise.all([
        request.get<{ providers: Provider[] }>(`${BASE}/auth`),
        request.get<{ permissions: { advancedSettings: boolean } }>(`${BASE}/permissions`),
      ]);
      setProviders(list.providers);
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

  const cancel = () => {
    setEditing(null);
    setKeyValue('');
  };

  const saveKey = async (provider: Provider) => {
    if (!keyValue.trim()) return;
    setBusy(true);
    try {
      // The key goes to the secrets endpoint; the provider refers to it by name.
      const secret = secretName(provider.providerId);
      await request.post(`${BASE}/secrets/${encodeURIComponent(secret)}`, { value: keyValue });
      setKeyValue('');
      await request.post(`${BASE}/auth/${encodeURIComponent(provider.providerId)}`, { secret });
      setMessage({ ok: true, text: localize('com_mindstone_hp_saved', { 0: provider.name }) });
      setEditing(null);
      await load();
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setKeyValue('');
      setBusy(false);
    }
  };

  const removeKey = async (provider: Provider) => {
    setBusy(true);
    try {
      await request.delete(`${BASE}/auth/${encodeURIComponent(provider.providerId)}`);
      setMessage({ ok: true, text: localize('com_mindstone_hp_removed', { 0: provider.name }) });
      await load();
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-3 py-1 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';
  const input = 'rounded border border-border-medium bg-surface-secondary p-1 text-sm';

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_hp_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_hp_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_hp_intro')}</p>
        {!advanced && (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_hp_need_advanced')}
          </p>
        )}
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}
        <section className={card} aria-labelledby="ms-hp-list">
          <h2 id="ms-hp-list" className="mb-2 text-lg font-medium">
            {localize('com_mindstone_hp_list')}
          </h2>
          <ul className="flex flex-col divide-y divide-border-light">
            {providers?.map((provider) => {
              const oauth = provider.auth === 'signed in (OAuth)';
              const stored = provider.auth === 'stored key';
              return (
                <li
                  key={provider.providerId}
                  className="flex flex-col gap-2 py-2"
                  data-testid={`ms-hp-${provider.providerId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">{provider.name}</span>{' '}
                      <span className="text-xs text-text-secondary">
                        {provider.auth ?? localize('com_mindstone_hp_not_set')}
                      </span>
                    </div>
                    {oauth ? (
                      <span className="text-xs text-text-secondary">
                        {localize('com_mindstone_hp_oauth_host')}
                      </span>
                    ) : (
                      editing !== provider.providerId && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className={secondary}
                            disabled={!advanced || busy}
                            onClick={() => {
                              setEditing(provider.providerId);
                              setKeyValue('');
                            }}
                          >
                            {localize(stored ? 'com_mindstone_hp_replace' : 'com_mindstone_hp_set')}
                          </button>
                          {stored && (
                            <button
                              type="button"
                              className={secondary}
                              disabled={!advanced || busy}
                              onClick={() => void removeKey(provider)}
                            >
                              {localize('com_mindstone_hp_remove')}
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                  {editing === provider.providerId && (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="password"
                        autoComplete="off"
                        className={input}
                        aria-label={localize('com_mindstone_hp_key_label', { 0: provider.name })}
                        value={keyValue}
                        onChange={(event) => setKeyValue(event.target.value)}
                      />
                      <button
                        type="button"
                        className={primary}
                        disabled={busy || !keyValue.trim()}
                        onClick={() => void saveKey(provider)}
                      >
                        {localize('com_mindstone_hp_save')}
                      </button>
                      <button type="button" className={secondary} disabled={busy} onClick={cancel}>
                        {localize('com_mindstone_hp_cancel')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
