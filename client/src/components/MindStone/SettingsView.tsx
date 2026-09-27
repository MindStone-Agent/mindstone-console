/**
 * MindStone settings (MindStone-Agent #38, P2): the Console's view of the
 * gateway admin API, through the server-side proxy at /api/mindstone/admin.
 * Onboarding checklist, per-section config editing (secrets masked), secret
 * storage, and the advanced-settings permission.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import RestartGateway from './RestartGateway';

type Step = { done: boolean; detail: string };
type Status = { onboarded: boolean; steps: Record<string, Step> };
type Permissions = {
  advancedSettings: boolean;
  grantedBy?: string;
  grantedAt?: string;
  expiresAt?: string;
};
type FieldError = { path?: string; error: string };

const BASE = '/api/mindstone/admin';
const SECTIONS = [
  'routing',
  'agents',
  'memory',
  'channels',
  'session',
  'contextManagement',
  'personas',
  'workflows',
  'knowledgebases',
  'observability',
  'onboarding',
  'gateway',
  'skills',
  'packs',
  'workspace',
];
const CONFIRMATION = 'enable advanced settings';

function errorBody(error: unknown): { error?: string; errors?: FieldError[] } {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  return data && typeof data === 'object'
    ? (data as { error?: string; errors?: FieldError[] })
    : { error: String(error) };
}

export default function MindStoneSettingsView() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState('routing');
  const [draft, setDraft] = useState('');
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    text: string;
    errors?: FieldError[];
  } | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretResult, setSecretResult] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, c, p] = await Promise.all([
        request.get<Status>(`${BASE}/status`),
        request.get<{ config: Record<string, unknown>; etag?: string }>(`${BASE}/config`),
        request.get<{ permissions: Permissions }>(`${BASE}/permissions`),
      ]);
      setStatus(s);
      setConfig(c.config);
      setEtag(c.etag ?? null);
      setPermissions(p.permissions);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'));
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDraft(JSON.stringify(config?.[section] ?? {}, null, 2));
  }, [config, section]);

  // Clear the last save's message when the admin switches section, not when
  // the page reloads the config after a save (that would hide "Saved").
  useEffect(() => {
    setSaveResult(null);
  }, [section]);

  const draftError = useMemo(() => {
    try {
      const parsed = JSON.parse(draft);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? null
        : localize('com_mindstone_section_not_object');
    } catch (error) {
      return localize('com_mindstone_invalid_json', { 0: (error as Error).message });
    }
  }, [draft, localize]);

  const save = async () => {
    if (draftError) return;
    try {
      // The gateway refuses the save (412) if the config changed since this page read it.
      const query = etag ? `?ifMatch=${encodeURIComponent(etag)}` : '';
      const result = (await request.patch(
        `${BASE}/config/${section}${query}`,
        JSON.parse(draft),
      )) as {
        changed: string[];
        restartRequired: boolean;
      };
      if (result.restartRequired) setRestartNeeded(true);
      setSaveResult({
        ok: true,
        text: result.changed.length
          ? `${localize('com_mindstone_saved', { 0: result.changed.join(', ') })} ${localize(
              result.restartRequired
                ? 'com_mindstone_saved_restart'
                : 'com_mindstone_saved_next_message',
            )}`
          : localize('com_mindstone_no_changes'),
      });
      await load();
    } catch (error) {
      const body = errorBody(error);
      const stale = (error as { response?: { status?: number } })?.response?.status === 412;
      setSaveResult({
        ok: false,
        text: stale
          ? localize('com_mindstone_stale_save')
          : (body.error ?? localize('com_mindstone_not_saved')),
        errors: body.errors,
      });
    }
  };

  const storeSecret = async () => {
    try {
      const result = (await request.post(`${BASE}/secrets/${encodeURIComponent(secretName)}`, {
        value: secretValue,
      })) as {
        tokenFile: string;
      };
      setSecretValue('');
      setSecretResult(localize('com_mindstone_secret_stored', { 0: result.tokenFile }));
    } catch (error) {
      setSecretResult(errorBody(error).error ?? localize('com_mindstone_secret_not_stored'));
    }
  };

  const setAdvanced = async (enabled: boolean) => {
    try {
      await request.post(
        `${BASE}/permissions/advanced`,
        enabled ? { enabled, confirm: confirmText } : { enabled },
      );
      setConfirmText('');
      await load();
    } catch (error) {
      setSaveResult({
        ok: false,
        text: errorBody(error).error ?? localize('com_mindstone_not_changed'),
      });
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 text-text-primary">
        <h1 className="text-2xl font-semibold">{localize('com_mindstone_settings_title')}</h1>
        {loadError && (
          <div role="alert" className="rounded-lg border border-red-500 p-3 text-red-500">
            {loadError}
          </div>
        )}

        {status && (
          <section className={card} aria-labelledby="ms-onboarding">
            <h2 id="ms-onboarding" className="mb-2 text-lg font-medium">
              {localize(
                status.onboarded ? 'com_mindstone_set_up' : 'com_mindstone_getting_started',
              )}
            </h2>
            <ul className="flex flex-col gap-1">
              {Object.entries(status.steps).map(([name, step]) => (
                <li key={name} data-testid={`ms-step-${name}`}>
                  <span aria-hidden="true">{step.done ? '✓' : '○'}</span>{' '}
                  <strong className="capitalize">{name}</strong>: {step.detail}
                </li>
              ))}
            </ul>
            <Link
              to="/mindstone/onboarding"
              className={
                status.onboarded
                  ? 'mt-2 inline-block text-sm underline'
                  : 'mt-3 inline-block rounded bg-surface-submit px-4 py-2 text-white'
              }
            >
              {localize(status.onboarded ? 'com_mindstone_onb_rerun' : 'com_mindstone_onb_start')}
            </Link>{' '}
            <Link to="/mindstone/approvals" className="ml-3 mt-2 inline-block text-sm underline">
              {localize('com_mindstone_appr_title')}
            </Link>
          </section>
        )}

        {config && (
          <section className={card} aria-labelledby="ms-config">
            <h2 id="ms-config" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_configuration')}
            </h2>
            <label className="mb-2 flex items-center gap-2">
              {localize('com_mindstone_section')}
              <select
                className="rounded border border-border-medium bg-surface-secondary p-1"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                aria-label={localize('com_mindstone_config_section')}
              >
                {SECTIONS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_secrets_hint', { 0: '{ "set": true }' })}
            </p>
            <textarea
              className="h-72 w-full rounded border border-border-medium bg-surface-secondary p-2 font-mono text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={localize('com_mindstone_section_json', { 0: section })}
              spellCheck={false}
            />
            {draftError && <p className="text-sm text-red-500">{draftError}</p>}
            <button
              type="button"
              className="mt-2 rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
              onClick={() => void save()}
              disabled={Boolean(draftError)}
            >
              {localize('com_mindstone_save_section', { 0: section })}
            </button>
            {saveResult && (
              <div
                role="status"
                className={saveResult.ok ? 'mt-2 text-green-600' : 'mt-2 text-red-500'}
              >
                {saveResult.text}
                {saveResult.errors && (
                  <ul className="list-disc pl-5">
                    {saveResult.errors.map((e, i) => (
                      <li key={i}>{e.path ? `${e.path}: ${e.error}` : e.error}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        <section className={card} aria-labelledby="ms-secrets">
          <h2 id="ms-secrets" className="mb-2 text-lg font-medium">
            {localize('com_mindstone_store_secret')}
          </h2>
          <Link to="/mindstone/secrets" className="mb-2 inline-block text-sm underline">
            {localize('com_mindstone_sec_manage')}
          </Link>
          <p className="mb-2 text-sm text-text-secondary">
            {localize('com_mindstone_store_secret_hint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className="rounded border border-border-medium bg-surface-secondary p-2"
              placeholder={localize('com_mindstone_secret_name_placeholder')}
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              aria-label={localize('com_mindstone_secret_name')}
            />
            <input
              className="flex-1 rounded border border-border-medium bg-surface-secondary p-2"
              type="password"
              placeholder={localize('com_mindstone_secret_value_placeholder')}
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              aria-label={localize('com_mindstone_secret_value')}
              autoComplete="off"
            />
            <button
              type="button"
              className="rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
              disabled={!secretName || !secretValue}
              onClick={() => void storeSecret()}
            >
              {localize('com_mindstone_store')}
            </button>
          </div>
          {secretResult && (
            <p role="status" className="mt-2 text-sm">
              {secretResult}
            </p>
          )}
        </section>

        {permissions && (
          <section className={card} aria-labelledby="ms-advanced">
            <h2 id="ms-advanced" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_advanced_settings')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_advanced_hint')}
            </p>
            {permissions.advancedSettings ? (
              <div className="flex items-center gap-3">
                <span data-testid="ms-advanced-state">
                  {localize('com_mindstone_advanced_on')}
                  {permissions.grantedBy
                    ? localize(
                        permissions.grantedBy === user?.id
                          ? 'com_mindstone_granted_by_you'
                          : 'com_mindstone_granted_by_other',
                      )
                    : ''}
                  {permissions.expiresAt
                    ? localize('com_mindstone_until', {
                        0: new Date(permissions.expiresAt).toLocaleTimeString(),
                      })
                    : ''}
                  {'.'}
                </span>
                <button
                  type="button"
                  className="rounded border border-border-medium px-3 py-1"
                  onClick={() => void setAdvanced(false)}
                >
                  {localize('com_mindstone_turn_off')}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="ms-advanced-state">
                  {localize('com_mindstone_advanced_off')}
                </span>
                <label className="flex items-center gap-2 text-sm">
                  {localize('com_mindstone_type_to_turn_on', { 0: CONFIRMATION })}
                  <input
                    className="rounded border border-border-medium bg-surface-secondary p-1"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    aria-label={localize('com_mindstone_confirmation')}
                  />
                </label>
                <button
                  type="button"
                  className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
                  disabled={confirmText !== CONFIRMATION}
                  onClick={() => void setAdvanced(true)}
                >
                  {localize('com_mindstone_turn_on')}
                </button>
              </div>
            )}
          </section>
        )}

        <RestartGateway needed={restartNeeded} />
      </div>
    </div>
  );
}
