/**
 * MindStone model providers (MindStone-Agent #126): the providers the agent
 * can use, a live Test for each (one short message through the agent's own
 * path), and enterprise endpoints (Azure OpenAI / AI Foundry, Amazon Bedrock,
 * Google Vertex AI, an OpenAI-compatible enterprise gateway) to add or
 * remove. Adding, testing and removing need advanced settings; keys are only
 * ever named, never shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import type { EnterpriseKind, ProviderTest } from './EnterpriseEndpointForm';
import EnterpriseEndpointForm, { TestResult, testProvider } from './EnterpriseEndpointForm';
import { useLocalize } from '~/hooks';

type Registered = {
  providerId: string;
  name?: string;
  baseUrl?: string;
  modelCount: number;
  auth: string;
  kind?: string;
};
type ModelsInfo = {
  registered?: Registered[];
  registeredError?: string;
  enterprise?: EnterpriseKind[];
  error?: string;
};

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function MindStoneProvidersView() {
  const localize = useLocalize();
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [kindId, setKindId] = useState('');
  const [tests, setTests] = useState<Record<string, ProviderTest>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [models, permissions] = await Promise.all([
        request.get<ModelsInfo>(`${BASE}/models`),
        request.get<{ permissions: { advancedSettings: boolean } }>(`${BASE}/permissions`),
      ]);
      setInfo(models);
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

  const kind = info?.enterprise?.find((candidate) => candidate.kind === kindId);

  const runTest = async (providerId: string) => {
    setTesting(providerId);
    const result = await testProvider(providerId);
    setTests((current) => ({ ...current, [providerId]: result }));
    setTesting(null);
  };

  const remove = async (providerId: string) => {
    setBusy(true);
    try {
      await request.delete(`${BASE}/providers/${encodeURIComponent(providerId)}`);
      setConfirming(null);
      setTests(({ [providerId]: _gone, ...rest }) => rest);
      setMessage({ ok: true, text: localize('com_mindstone_prov_removed', { 0: providerId }) });
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
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_prov_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_sec_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_prov_intro')}</p>
        <p className="text-sm">
          {/* A local provider (Ollama, LM Studio, a compatible server) is added with setup's own step (#140). */}
          <Link
            to="/mindstone/onboarding?change=provider&from=providers"
            className="underline"
            data-testid="ms-prov-add-local"
          >
            {localize('com_mindstone_prov_add_local')}
          </Link>
        </p>
        {!advanced && (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_prov_need_advanced')}
          </p>
        )}
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}
        <section className={card} aria-labelledby="ms-prov-list">
          <h2 id="ms-prov-list" className="mb-2 text-lg font-medium">
            {localize('com_mindstone_prov_list', { 0: String(info?.registered?.length ?? 0) })}
          </h2>
          {info?.registeredError && <p className="text-sm text-red-600">{info.registeredError}</p>}
          {info?.registered?.length === 0 && (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_prov_none')}</p>
          )}
          <ul className="flex flex-col divide-y divide-border-light">
            {info?.registered?.map((provider) => (
              <li
                key={provider.providerId}
                className="flex flex-col gap-1 py-2"
                data-testid={`ms-provider-${provider.providerId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{provider.name ?? provider.providerId}</span>{' '}
                    <span className="font-mono text-xs text-text-secondary">
                      {provider.providerId}
                    </span>
                    <div className="break-words text-xs text-text-secondary [overflow-wrap:anywhere]">
                      {localize('com_mindstone_prov_detail', {
                        0: provider.baseUrl ?? '',
                        1: String(provider.modelCount),
                        2: provider.auth,
                      })}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={secondary}
                      disabled={!advanced || testing !== null || provider.modelCount === 0}
                      onClick={() => void runTest(provider.providerId)}
                    >
                      {localize(
                        testing === provider.providerId
                          ? 'com_mindstone_ent_testing'
                          : 'com_mindstone_ent_test',
                      )}
                    </button>
                    {provider.kind && confirming !== provider.providerId && (
                      <button
                        type="button"
                        className={secondary}
                        disabled={!advanced || busy}
                        onClick={() => setConfirming(provider.providerId)}
                      >
                        {localize('com_mindstone_prov_remove')}
                      </button>
                    )}
                  </div>
                </div>
                {tests[provider.providerId] && <TestResult result={tests[provider.providerId]} />}
                {confirming === provider.providerId && (
                  <div className="flex flex-col gap-2 rounded bg-surface-secondary p-2">
                    <p className="text-sm">
                      {localize('com_mindstone_prov_confirm', { 0: provider.providerId })}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={danger}
                        disabled={busy}
                        onClick={() => void remove(provider.providerId)}
                      >
                        {localize('com_mindstone_prov_confirm_remove')}
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
        {info?.enterprise && info.enterprise.length > 0 && (
          <section className={card} aria-labelledby="ms-prov-enterprise">
            <h2 id="ms-prov-enterprise" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_ent_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">{localize('com_mindstone_ent_hint')}</p>
            <fieldset className="mb-3 flex flex-col gap-1">
              <legend className="sr-only">{localize('com_mindstone_ent_title')}</legend>
              {info.enterprise.map((candidate) => (
                <label key={candidate.kind} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ms-prov-kind"
                    value={candidate.kind}
                    checked={kindId === candidate.kind}
                    onChange={() => setKindId(candidate.kind)}
                  />
                  {candidate.name}
                </label>
              ))}
            </fieldset>
            {kind && (
              <EnterpriseEndpointForm
                kind={kind}
                disabled={!advanced}
                onRegistered={async (result) => {
                  setMessage({
                    ok: true,
                    text: localize('com_mindstone_ent_registered', {
                      0: result.providerId,
                      1: String(result.models.length),
                      2: result.host,
                    }),
                  });
                  setTests(({ [result.providerId]: _old, ...rest }) => rest);
                  setKindId('');
                  await load();
                }}
                onError={(error) =>
                  setMessage({
                    ok: false,
                    text: errorText(error) ?? localize('com_mindstone_not_saved'),
                  })
                }
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
