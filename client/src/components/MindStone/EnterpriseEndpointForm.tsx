/**
 * An enterprise model endpoint (MindStone-Agent #126): Azure OpenAI / AI
 * Foundry, Amazon Bedrock, Google Vertex AI or an OpenAI-compatible enterprise
 * gateway. The gateway describes each kind's fields (GET /admin/models); every
 * key or token typed here goes to the secrets endpoint first and the provider
 * names it, so no value is ever sent with the registration. After it is
 * registered, Test sends one short message through the agent's own path.
 */
import { useEffect, useState } from 'react';
import { request } from 'librechat-data-provider';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

export type EnterpriseField = {
  name: string;
  label: string;
  type: 'url' | 'text' | 'secret' | 'list' | 'headers';
  required: boolean | 'one-of';
  group?: string;
  hint?: string;
  multiline?: boolean;
};
export type EnterpriseKind = {
  kind: string;
  providerId: string;
  name: string;
  listsModels: boolean;
  fields: EnterpriseField[];
};
export type EnterpriseRegistered = { providerId: string; host: string; models: string[] };
type HeaderRow = { name: string; value: string; secret: boolean };
export type ProviderTest = {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
  latencyMs?: number;
};

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

/** The groups a kind asks the admin to choose between (Vertex: an API key or a service account). */
export function credentialGroups(kind: EnterpriseKind): string[] {
  return [...new Set(kind.fields.flatMap((field) => (field.group ? [field.group] : [])))];
}

/** A stored secret's name for one field of one provider: `enterprise-azure.secret`. */
export function secretNameFor(providerId: string, field: string): string {
  return `${providerId}.${field}`;
}

/** Splits a list typed as commas or lines. */
export function listValue(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The registration body and the secrets to store first. Only the chosen
 * credential group's fields are sent; an empty optional field is left out.
 */
export function registrationPlan(
  kind: EnterpriseKind,
  values: Record<string, string>,
  group: string | undefined,
  headers: HeaderRow[],
): { body: Record<string, unknown>; secrets: Array<{ name: string; value: string }> } {
  const body: Record<string, unknown> = {};
  const secrets: Array<{ name: string; value: string }> = [];
  for (const field of kind.fields) {
    if (field.group && field.group !== group) continue;
    if (field.type === 'headers') {
      const rows = headers.filter((row) => row.name.trim());
      if (!rows.length) continue;
      body.headers = Object.fromEntries(
        rows.map((row) => {
          const name = row.name.trim();
          if (!row.secret) return [name, row.value];
          const secret = secretNameFor(kind.providerId, `header-${name.toLowerCase()}`);
          secrets.push({ name: secret, value: row.value });
          return [name, { secret }];
        }),
      );
      continue;
    }
    const raw = values[field.name] ?? '';
    // A key keeps its exact characters; everything else is trimmed.
    const value = field.type === 'secret' ? raw : raw.trim();
    if (!value.trim()) continue;
    if (field.type === 'secret') {
      const secret = secretNameFor(kind.providerId, field.name);
      secrets.push({ name: secret, value });
      body[field.name] = secret;
    } else if (field.type === 'list') {
      body[field.name] = listValue(value);
    } else {
      body[field.name] = value;
    }
  }
  return { body, secrets };
}

/** What still has to be filled in before the form can be sent. */
export function missingFields(
  kind: EnterpriseKind,
  values: Record<string, string>,
  group: string | undefined,
): string[] {
  return kind.fields
    .filter((field) => field.type !== 'headers')
    .filter((field) => (field.group ? field.group === group : field.required === true))
    .filter((field) => !(values[field.name] ?? '').trim())
    .map((field) => field.label);
}

/** Run the gateway's live test for one provider (and model, if given). */
export async function testProvider(providerId: string, model?: string): Promise<ProviderTest> {
  try {
    return (await request.post(
      `${BASE}/providers/${encodeURIComponent(providerId)}/test`,
      model ? { model } : {},
    )) as ProviderTest;
  } catch (error) {
    return { ok: false, error: errorText(error) ?? String(error) };
  }
}

export function TestResult({ result }: { result: ProviderTest }) {
  const localize = useLocalize();
  return (
    <p
      role="status"
      data-testid="ms-ent-test-result"
      className={`break-words text-sm [overflow-wrap:anywhere] ${result.ok ? 'text-green-600' : 'text-red-600'}`}
    >
      {result.ok
        ? localize('com_mindstone_ent_test_ok', {
            0: result.model ?? '',
            1: String(result.latencyMs ?? 0),
            2: visibleText(result.reply ?? ''),
          })
        : localize('com_mindstone_ent_test_failed', {
            0: result.model ?? '',
            1: visibleText(result.error ?? ''),
          })}
    </p>
  );
}

export default function EnterpriseEndpointForm({
  kind,
  disabled,
  onRegistered,
  onError,
}: {
  kind: EnterpriseKind;
  disabled?: boolean;
  onRegistered: (result: EnterpriseRegistered) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  const localize = useLocalize();
  const groups = credentialGroups(kind);
  const [values, setValues] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<string | undefined>(groups[0]);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [busy, setBusy] = useState(false);

  // Nothing typed for one kind carries over to another.
  useEffect(() => {
    setValues({});
    setHeaders([]);
    setGroup(credentialGroups(kind)[0]);
  }, [kind]);

  const set = (name: string, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));
  const missing = missingFields(kind, values, group);
  const input = 'w-full rounded border border-border-medium bg-surface-secondary p-2';

  const register = async () => {
    setBusy(true);
    try {
      const plan = registrationPlan(kind, values, group, headers);
      for (const secret of plan.secrets) {
        await request.post(`${BASE}/secrets/${encodeURIComponent(secret.name)}`, {
          value: secret.value,
        });
      }
      const result = (await request.post(
        `${BASE}/providers/enterprise/${encodeURIComponent(kind.kind)}`,
        plan.body,
      )) as EnterpriseRegistered;
      // Typed keys are gone once they are stored.
      setValues((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([name]) => kind.fields.find((field) => field.name === name)?.type !== 'secret',
          ),
        ),
      );
      setHeaders((rows) => rows.map((row) => (row.secret ? { ...row, value: '' } : row)));
      await onRegistered(result);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const field = (spec: EnterpriseField) => {
    const id = `ms-ent-${kind.kind}-${spec.name}`;
    if (spec.type === 'headers') {
      return (
        <fieldset key={spec.name} className="flex flex-col gap-1 text-sm">
          <legend>{spec.label}</legend>
          {spec.hint && <span className="text-text-secondary">{spec.hint}</span>}
          {headers.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input
                className="rounded border border-border-medium bg-surface-secondary p-1"
                value={row.name}
                aria-label={localize('com_mindstone_ent_header_name')}
                placeholder={localize('com_mindstone_ent_header_name')}
                onChange={(e) =>
                  setHeaders((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)),
                  )
                }
              />
              <input
                className="flex-1 rounded border border-border-medium bg-surface-secondary p-1"
                type={row.secret ? 'password' : 'text'}
                autoComplete="off"
                value={row.value}
                aria-label={localize('com_mindstone_ent_header_value')}
                placeholder={localize('com_mindstone_ent_header_value')}
                onChange={(e) =>
                  setHeaders((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                  )
                }
              />
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={row.secret}
                  onChange={(e) =>
                    setHeaders((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, secret: e.target.checked } : r)),
                    )
                  }
                />
                {localize('com_mindstone_ent_header_secret')}
              </label>
              <button
                type="button"
                className="rounded border border-border-medium px-2"
                aria-label={localize('com_mindstone_ent_header_remove')}
                onClick={() => setHeaders((rows) => rows.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="self-start rounded border border-border-medium px-3 py-1"
            disabled={headers.length >= 20}
            onClick={() => setHeaders((rows) => [...rows, { name: '', value: '', secret: true }])}
          >
            {localize('com_mindstone_ent_header_add')}
          </button>
        </fieldset>
      );
    }
    const common = {
      id,
      className: input,
      value: values[spec.name] ?? '',
      'aria-describedby': spec.hint ? `${id}-hint` : undefined,
    };
    return (
      <label key={spec.name} htmlFor={id} className="flex flex-col gap-1 text-sm">
        {spec.label}
        {spec.type === 'secret' && spec.multiline ? (
          <textarea
            {...common}
            className={`${input} h-28 font-mono`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set(spec.name, e.target.value)}
          />
        ) : (
          <input
            {...common}
            type={spec.type === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            onChange={(e) => set(spec.name, e.target.value)}
          />
        )}
        {spec.hint && (
          <span id={`${id}-hint`} className="text-text-secondary">
            {spec.hint}
          </span>
        )}
      </label>
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`ms-ent-form-${kind.kind}`}>
      {kind.fields.filter((spec) => !spec.group).map(field)}
      {groups.length > 1 && (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1">{localize('com_mindstone_ent_credentials')}</legend>
          <div className="flex flex-wrap gap-4">
            {groups.map((name) => (
              <label key={name} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`ms-ent-${kind.kind}-group`}
                  checked={group === name}
                  onChange={() => setGroup(name)}
                />
                {kind.fields
                  .filter((spec) => spec.group === name)
                  .map((spec) => spec.label)
                  .join(' + ')}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {kind.fields.filter((spec) => spec.group && spec.group === group).map(field)}
      {missing.length > 0 && (
        <p className="text-sm text-text-secondary">
          {localize('com_mindstone_ent_missing', { 0: missing.join(', ') })}
        </p>
      )}
      <button
        type="button"
        className="self-start rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
        disabled={disabled || busy || missing.length > 0}
        onClick={() => void register()}
      >
        {localize('com_mindstone_ent_register')}
      </button>
    </div>
  );
}
