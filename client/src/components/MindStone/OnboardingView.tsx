/**
 * MindStone onboarding (MindStone-Agent #38, P2): the guided first-run flow on
 * top of the gateway admin API. Access (the advanced-settings permission),
 * a model provider and its key, the default model, and a base persona. Each
 * step is one or two admin API writes, so leaving midway keeps a valid
 * partial config. Memory and connectors are optional and live on the
 * settings page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from 'librechat-data-provider';
import { Link, useNavigate } from 'react-router-dom';
import { CONFIRMATION, confirmationMatches, normalizeConfirmation } from './confirmation';
import { useLocalize } from '~/hooks';

type Preset = {
  presetId: string;
  providerId: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
};
type PiProvider = { id: string; name: string; configured: boolean; availableModelCount: number };
type PiModel = { id: string; provider: string; name?: string };
type ModelsInfo = { presets: Preset[]; providers: PiProvider[]; models: PiModel[]; error?: string };
type Profile = { id: string; label: string; description: string };
type Status = { onboarded: boolean; profiles?: Profile[] };
type Permissions = { advancedSettings: boolean; expiresAt?: string };
type Config = {
  routing?: { mode?: string; defaultAgentId?: string; defaultModel?: string };
  onboarding?: { profile?: { id?: string } };
};

const BASE = '/api/mindstone/admin';
const STEPS = ['access', 'provider', 'model', 'persona', 'finish'] as const;
type Step = (typeof STEPS)[number];
const STEP_LABELS = {
  access: 'com_mindstone_onb_step_access',
  provider: 'com_mindstone_onb_step_provider',
  model: 'com_mindstone_onb_step_model',
  persona: 'com_mindstone_onb_step_persona',
  finish: 'com_mindstone_onb_step_finish',
} as const;

/** The current step bold, finished steps dimmed. */
function stepClass(index: number, current: number): string {
  if (index === current) return 'font-semibold';
  return index < current ? 'text-text-secondary' : '';
}

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function MindStoneOnboardingView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('access');
  const [status, setStatus] = useState<Status | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Access step.
  const [confirmText, setConfirmText] = useState('');
  // Provider step.
  const [presetId, setPresetId] = useState('');
  const [keySource, setKeySource] = useState<'paste' | 'env'>('paste');
  const [keyValue, setKeyValue] = useState('');
  const [envName, setEnvName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [listFailed, setListFailed] = useState(false);
  // Model and persona steps.
  const [model, setModel] = useState('');
  const [profileId, setProfileId] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, p, m, c] = await Promise.all([
        request.get<Status>(`${BASE}/status`),
        request.get<{ permissions: Permissions }>(`${BASE}/permissions`),
        request.get<ModelsInfo>(`${BASE}/models`),
        request.get<{ config: Config }>(`${BASE}/config`),
      ]);
      setStatus(s);
      setPermissions(p.permissions);
      setInfo(m);
      setConfig(c.config);
      return { models: m, config: c.config };
    } catch (error) {
      setMessage({
        ok: false,
        text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
      });
      return undefined;
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Move to a step; a message from the step being left is cleared. */
  const goTo = (next: Step) => {
    setMessage(null);
    setStep(next);
  };

  const preset = info?.presets.find((candidate) => candidate.presetId === presetId);
  // A key entered for one preset never carries over to another.
  useEffect(() => {
    setBaseUrl(preset?.baseUrl ?? '');
    setListFailed(false);
    setKeyValue('');
    setEnvName('');
    setKeySource('paste');
  }, [presetId, preset?.baseUrl]);

  // Models the agent can use now: from providers with a key (registered here or set up in the terminal).
  const usableModels = useMemo(() => {
    const configured = new Set(
      (info?.providers ?? [])
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    );
    return (info?.models ?? []).filter((candidate) => configured.has(candidate.provider));
  }, [info]);

  useEffect(() => {
    if (!model && config?.routing?.defaultModel) setModel(config.routing.defaultModel);
    if (!profileId && config?.onboarding?.profile?.id) setProfileId(config.onboarding.profile.id);
  }, [config, model, profileId]);

  /** PATCH one config section against the config as it is now (If-Match). */
  const patchSection = async (section: string, body: unknown) => {
    const current = await request.get<{ etag?: string }>(`${BASE}/config`);
    const query = current.etag ? `?ifMatch=${encodeURIComponent(current.etag)}` : '';
    await request.patch(`${BASE}/config/${section}${query}`, body);
  };

  const turnOnAccess = async () => {
    setBusy(true);
    try {
      await request.post(`${BASE}/permissions/advanced`, {
        enabled: true,
        confirm: normalizeConfirmation(confirmText),
      });
      setConfirmText('');
      await load();
      goTo('provider');
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const connectProvider = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (!preset.needsKey && baseUrl && baseUrl !== preset.baseUrl) body.baseUrl = baseUrl;
      if (preset.needsKey) {
        if (keySource === 'paste' && keyValue) {
          // The key goes to the secrets endpoint, then the provider refers to it by name.
          const secret = `${preset.providerId}.key`;
          await request.post(`${BASE}/secrets/${encodeURIComponent(secret)}`, { value: keyValue });
          body.secret = secret;
        } else if (keySource === 'env' && envName) {
          body.env = envName;
        }
      }
      if (listFailed && manualModel.trim()) body.models = [manualModel.trim()];
      const result = (await request.post(
        `${BASE}/providers/${encodeURIComponent(preset.presetId)}`,
        body,
      )) as {
        models: string[];
      };
      setKeyValue('');
      await load();
      if (result.models?.length) setModel(result.models[0]);
      goTo('model');
      setMessage({
        ok: true,
        text: localize('com_mindstone_onb_connected', { 0: String(result.models?.length ?? 0) }),
      });
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 422) setListFailed(true);
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async () => {
    setBusy(true);
    try {
      await patchSection('routing', {
        mode: 'pi-session',
        defaultAgentId: config?.routing?.defaultAgentId ?? 'default',
        defaultModel: model,
      });
      await load();
      goTo('persona');
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  const savePersona = async () => {
    const profile = status?.profiles?.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    setBusy(true);
    try {
      const agentId = config?.routing?.defaultAgentId ?? 'default';
      await patchSection('onboarding', {
        profile: {
          id: profile.id,
          label: profile.label,
          description: profile.description,
          selectedAt: new Date().toISOString(),
        },
      });
      await patchSection('agents', { [agentId]: { id: agentId, profileId: profile.id } });
      await load();
      goTo('finish');
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  /** Turn advanced settings off; false if that failed (the error is shown). */
  const turnOffAccess = async () => {
    setBusy(true);
    try {
      await request.post(`${BASE}/permissions/advanced`, { enabled: false });
      await load();
      return true;
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Onboarding is done: advanced settings go off before the first chat,
   * whatever this page last saw (a grant made in another tab counts too).
   * If that fails while the page saw them on, it stays here with the error;
   * a read-only admin, who can't change them, still gets to the chat.
   */
  const startChat = async () => {
    if (!(await turnOffAccess()) && permissions?.advancedSettings !== false) return;
    navigate('/c/new');
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1';
  const input = 'rounded border border-border-medium bg-surface-secondary p-2';
  const stepIndex = STEPS.indexOf(step);
  const confirmOk = confirmationMatches(confirmText);
  const confirmHint = confirmText !== '' && !confirmOk;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6 text-text-primary">
        <h1 className="text-2xl font-semibold">{localize('com_mindstone_onb_title')}</h1>
        <ol
          className="flex flex-wrap gap-2 text-sm"
          aria-label={localize('com_mindstone_onb_steps')}
        >
          {STEPS.map((name, index) => (
            <li
              key={name}
              aria-current={name === step ? 'step' : undefined}
              className={stepClass(index, stepIndex)}
            >
              {index + 1}. {localize(STEP_LABELS[name])}
            </li>
          ))}
        </ol>
        {message && (
          <div role="status" className={message.ok ? 'text-green-600' : 'text-red-500'}>
            {message.text}
          </div>
        )}

        {step === 'access' && permissions && (
          <section className={card} aria-labelledby="ms-onb-access">
            <h2 id="ms-onb-access" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_access_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_onb_access_hint')}
            </p>
            {permissions.advancedSettings ? (
              <div className="flex items-center gap-3">
                <span data-testid="ms-onb-access-state">
                  {permissions.expiresAt
                    ? localize('com_mindstone_onb_access_on_until', {
                        0: new Date(permissions.expiresAt).toLocaleTimeString(),
                      })
                    : localize('com_mindstone_advanced_on')}
                </span>
                <button type="button" className={primary} onClick={() => goTo('provider')}>
                  {localize('com_mindstone_onb_next')}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  {localize('com_mindstone_type_to_turn_on', { 0: CONFIRMATION })}
                  <input
                    className="rounded border border-border-medium bg-surface-secondary p-1"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    aria-label={localize('com_mindstone_confirmation')}
                    aria-describedby={confirmHint ? 'ms-onb-confirm-hint' : undefined}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className={primary}
                  disabled={busy || !confirmOk}
                  onClick={() => void turnOnAccess()}
                >
                  {localize('com_mindstone_turn_on')}
                </button>
                {confirmHint && (
                  <p id="ms-onb-confirm-hint" className="w-full text-sm text-text-secondary">
                    {localize('com_mindstone_confirmation_hint', { 0: CONFIRMATION })}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {step === 'provider' && info && (
          <section className={card} aria-labelledby="ms-onb-provider">
            <h2 id="ms-onb-provider" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_provider_title')}
            </h2>
            <fieldset className="mb-3 flex flex-col gap-1">
              <legend className="mb-1 text-sm text-text-secondary">
                {localize('com_mindstone_onb_provider_hint')}
              </legend>
              {info.presets.map((candidate) => (
                <label key={candidate.presetId} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ms-onb-preset"
                    value={candidate.presetId}
                    checked={presetId === candidate.presetId}
                    onChange={() => setPresetId(candidate.presetId)}
                  />
                  {candidate.name}
                </label>
              ))}
            </fieldset>
            {preset && (
              <div className="flex flex-col gap-2">
                {preset.needsKey && (
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="ms-onb-key"
                          checked={keySource === 'paste'}
                          onChange={() => setKeySource('paste')}
                        />
                        {localize('com_mindstone_onb_key_paste')}
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="ms-onb-key"
                          checked={keySource === 'env'}
                          onChange={() => setKeySource('env')}
                        />
                        {localize('com_mindstone_onb_key_env')}
                      </label>
                    </div>
                    {keySource === 'paste' ? (
                      <input
                        className={input}
                        type="password"
                        autoComplete="off"
                        value={keyValue}
                        onChange={(e) => setKeyValue(e.target.value)}
                        aria-label={localize('com_mindstone_onb_api_key')}
                        placeholder={localize('com_mindstone_onb_api_key')}
                      />
                    ) : (
                      <input
                        className={input}
                        value={envName}
                        onChange={(e) => setEnvName(e.target.value)}
                        aria-label={localize('com_mindstone_onb_env_name')}
                        placeholder="OLLAMA_API_KEY"
                      />
                    )}
                  </div>
                )}
                <label className="flex flex-col gap-1 text-sm">
                  {localize('com_mindstone_onb_base_url')}
                  {/* A hosted provider's address is fixed by the gateway; a local server's can change (on this machine or a private network). */}
                  <input
                    className={input}
                    value={baseUrl}
                    readOnly={preset.needsKey}
                    aria-readonly={preset.needsKey}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>
                {listFailed && (
                  <label className="flex flex-col gap-1 text-sm">
                    {localize('com_mindstone_onb_manual_model')}
                    <input
                      className={input}
                      value={manualModel}
                      onChange={(e) => setManualModel(e.target.value)}
                    />
                  </label>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={primary}
                    disabled={
                      busy ||
                      (preset.needsKey && (keySource === 'paste' ? !keyValue : !envName)) ||
                      (listFailed && !manualModel.trim())
                    }
                    onClick={() => void connectProvider()}
                  >
                    {localize('com_mindstone_onb_connect')}
                  </button>
                </div>
              </div>
            )}
            <p className="mt-3 text-sm text-text-secondary">
              {localize('com_mindstone_onb_oauth_hint')}
            </p>
            {usableModels.length > 0 && (
              <button type="button" className={`${secondary} mt-2`} onClick={() => goTo('model')}>
                {localize('com_mindstone_onb_use_existing')}
              </button>
            )}
          </section>
        )}

        {step === 'model' && info && (
          <section className={card} aria-labelledby="ms-onb-model">
            <h2 id="ms-onb-model" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_model_title')}
            </h2>
            {usableModels.length === 0 ? (
              <p className="text-sm">
                {info.error
                  ? localize('com_mindstone_onb_models_error', { 0: info.error })
                  : localize('com_mindstone_onb_no_models')}
              </p>
            ) : (
              <select
                className="mb-2 w-full rounded border border-border-medium bg-surface-secondary p-2"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                aria-label={localize('com_mindstone_onb_model_title')}
              >
                <option value="">{localize('com_mindstone_onb_pick_model')}</option>
                {usableModels.map((candidate) => (
                  // Pi's model ids already name their provider ("ollama-cloud/model").
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-2">
              <button type="button" className={secondary} onClick={() => goTo('provider')}>
                {localize('com_mindstone_onb_back')}
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy || !model}
                onClick={() => void saveModel()}
              >
                {localize('com_mindstone_onb_save_next')}
              </button>
            </div>
          </section>
        )}

        {step === 'persona' && status && (
          <section className={card} aria-labelledby="ms-onb-persona">
            <h2 id="ms-onb-persona" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_persona_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_onb_persona_hint')}
            </p>
            <fieldset className="mb-3 flex flex-col gap-2">
              <legend className="sr-only">{localize('com_mindstone_onb_persona_title')}</legend>
              {(status.profiles ?? []).map((profile) => (
                <label key={profile.id} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="ms-onb-profile"
                    className="mt-1"
                    checked={profileId === profile.id}
                    onChange={() => setProfileId(profile.id)}
                  />
                  <span>
                    <strong>{profile.label}</strong>
                    <span className="block text-sm text-text-secondary">{profile.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex gap-2">
              <button type="button" className={secondary} onClick={() => goTo('model')}>
                {localize('com_mindstone_onb_back')}
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy || !profileId}
                onClick={() => void savePersona()}
              >
                {localize('com_mindstone_onb_save_next')}
              </button>
            </div>
          </section>
        )}

        {step === 'finish' && status && (
          <section className={card} aria-labelledby="ms-onb-finish">
            <h2 id="ms-onb-finish" className="mb-2 text-lg font-medium">
              {localize(
                status.onboarded
                  ? 'com_mindstone_onb_done_title'
                  : 'com_mindstone_onb_not_done_title',
              )}
            </h2>
            <p className="mb-3 text-sm text-text-secondary">
              {localize('com_mindstone_onb_optional_hint')}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={!status.onboarded || busy}
                onClick={() => void startChat()}
              >
                {localize('com_mindstone_onb_start_chat')}
              </button>
              <Link to="/mindstone" className={secondary}>
                {localize('com_mindstone_onb_open_settings')}
              </Link>
              {permissions?.advancedSettings && (
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  onClick={() => void turnOffAccess()}
                >
                  {localize('com_mindstone_onb_turn_off_access')}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
