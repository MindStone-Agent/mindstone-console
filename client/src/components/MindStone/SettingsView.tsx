/**
 * MindStone settings (MindStone-Agent #38, P2): the Console's view of the
 * gateway admin API, through the server-side proxy at /api/mindstone/admin.
 * Onboarding checklist, per-section config editing (secrets masked), secret
 * storage, and the advanced-settings permission.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from 'librechat-data-provider';

type Step = { done: boolean; detail: string };
type Status = { onboarded: boolean; steps: Record<string, Step> };
type Permissions = { advancedSettings: boolean; grantedBy?: string; grantedAt?: string };
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
  return data && typeof data === 'object' ? (data as { error?: string; errors?: FieldError[] }) : { error: String(error) };
}

export default function MindStoneSettingsView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState('routing');
  const [draft, setDraft] = useState('');
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string; errors?: FieldError[] } | null>(null);
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
      setLoadError(errorBody(error).error ?? 'Could not reach the MindStone gateway.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDraft(JSON.stringify(config?.[section] ?? {}, null, 2));
    setSaveResult(null);
  }, [config, section]);

  const draftError = useMemo(() => {
    try {
      const parsed = JSON.parse(draft);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'The section must be a JSON object.';
    } catch (error) {
      return `Not valid JSON: ${(error as Error).message}`;
    }
  }, [draft]);

  const save = async () => {
    if (draftError) return;
    try {
      // The gateway refuses the save (412) if the config changed since this page read it.
      const query = etag ? `?ifMatch=${encodeURIComponent(etag)}` : '';
      const result = (await request.patch(`${BASE}/config/${section}${query}`, JSON.parse(draft))) as {
        changed: string[];
        restartRequired: boolean;
      };
      setSaveResult({
        ok: true,
        text: result.changed.length
          ? `Saved: ${result.changed.join(', ')}.${result.restartRequired ? ' Restart the gateway for these to take effect.' : ' Applies on the next message.'}`
          : 'No changes.',
      });
      await load();
    } catch (error) {
      const body = errorBody(error);
      const stale = (error as { response?: { status?: number } })?.response?.status === 412;
      setSaveResult({
        ok: false,
        text: stale ? 'The settings changed since you opened them, so nothing was saved. Reload to see the current values, then make your change again.' : body.error ?? 'Not saved.',
        errors: body.errors,
      });
    }
  };

  const storeSecret = async () => {
    try {
      const result = (await request.post(`${BASE}/secrets/${encodeURIComponent(secretName)}`, { value: secretValue })) as {
        tokenFile: string;
      };
      setSecretValue('');
      setSecretResult(`Stored. Reference it in config as tokenFile: "${result.tokenFile}".`);
    } catch (error) {
      setSecretResult(errorBody(error).error ?? 'Not stored.');
    }
  };

  const setAdvanced = async (enabled: boolean) => {
    try {
      await request.post(`${BASE}/permissions/advanced`, enabled ? { enabled, confirm: confirmText } : { enabled });
      setConfirmText('');
      await load();
    } catch (error) {
      setSaveResult({ ok: false, text: errorBody(error).error ?? 'Not changed.' });
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 text-text-primary">
        <h1 className="text-2xl font-semibold">MindStone settings</h1>
        {loadError && (
          <div role="alert" className="rounded-lg border border-red-500 p-3 text-red-500">
            {loadError}
          </div>
        )}

        {status && (
          <section className={card} aria-labelledby="ms-onboarding">
            <h2 id="ms-onboarding" className="mb-2 text-lg font-medium">
              {status.onboarded ? 'Set up' : 'Getting started'}
            </h2>
            <ul className="flex flex-col gap-1">
              {Object.entries(status.steps).map(([name, step]) => (
                <li key={name} data-testid={`ms-step-${name}`}>
                  <span aria-hidden="true">{step.done ? '✓' : '○'}</span>{' '}
                  <strong className="capitalize">{name}</strong>: {step.detail}
                </li>
              ))}
            </ul>
          </section>
        )}

        {config && (
          <section className={card} aria-labelledby="ms-config">
            <h2 id="ms-config" className="mb-2 text-lg font-medium">
              Configuration
            </h2>
            <label className="mb-2 flex items-center gap-2">
              Section
              <select
                className="rounded border border-border-medium bg-surface-secondary p-1"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                aria-label="Config section"
              >
                {SECTIONS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <p className="mb-2 text-sm text-text-secondary">
              Secrets show as {'{ "set": true }'}. Leave them as they are to keep them; store a new one below. Set a key to null to remove it.
            </p>
            <textarea
              className="h-72 w-full rounded border border-border-medium bg-surface-secondary p-2 font-mono text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`${section} settings (JSON)`}
              spellCheck={false}
            />
            {draftError && <p className="text-sm text-red-500">{draftError}</p>}
            <button
              type="button"
              className="mt-2 rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
              onClick={() => void save()}
              disabled={Boolean(draftError)}
            >
              Save {section}
            </button>
            {saveResult && (
              <div role="status" className={saveResult.ok ? 'mt-2 text-green-600' : 'mt-2 text-red-500'}>
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
            Store a secret
          </h2>
          <p className="mb-2 text-sm text-text-secondary">API keys and bot tokens are stored on the gateway, never shown again.</p>
          <div className="flex flex-wrap gap-2">
            <input
              className="rounded border border-border-medium bg-surface-secondary p-2"
              placeholder="name, e.g. telegram.token"
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              aria-label="Secret name"
            />
            <input
              className="flex-1 rounded border border-border-medium bg-surface-secondary p-2"
              type="password"
              placeholder="value"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              aria-label="Secret value"
              autoComplete="off"
            />
            <button
              type="button"
              className="rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
              disabled={!secretName || !secretValue}
              onClick={() => void storeSecret()}
            >
              Store
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
              Advanced settings
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              File paths, Pi extensions and built-in tools, the workspace, packs, skills and gateway auth can run code or read files on the
              gateway's machine. They can be edited here only while this is on.
            </p>
            {permissions.advancedSettings ? (
              <div className="flex items-center gap-3">
                <span data-testid="ms-advanced-state">
                  On{permissions.grantedBy ? `, granted by ${permissions.grantedBy}` : ''}
                  {permissions.grantedAt ? ` at ${new Date(permissions.grantedAt).toLocaleString()}` : ''}.
                </span>
                <button type="button" className="rounded border border-border-medium px-3 py-1" onClick={() => void setAdvanced(false)}>
                  Turn off
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="ms-advanced-state">Off.</span>
                <label className="flex items-center gap-2 text-sm">
                  Type <code>{CONFIRMATION}</code> to turn on:
                  <input
                    className="rounded border border-border-medium bg-surface-secondary p-1"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    aria-label="Confirmation"
                  />
                </label>
                <button
                  type="button"
                  className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
                  disabled={confirmText !== CONFIRMATION}
                  onClick={() => void setAdvanced(true)}
                >
                  Turn on
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
