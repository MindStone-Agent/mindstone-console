/**
 * MindStone onboarding (MindStone-Agent #38, P2): the guided first-run flow on
 * top of the gateway admin API. Access (the advanced-settings permission),
 * a model provider and its key, the default model, a base persona, memory
 * (required, with a live embed check), an optional connector, and what the
 * agent should know about you (MindStone-Agent #102). Each step is one or
 * two admin API writes, so leaving midway keeps a valid partial config.
 * The settings page links straight to a step with ?step=.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request } from 'librechat-data-provider';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { TranslationKeys } from '~/hooks';
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
type Status = {
  onboarded: boolean;
  profiles?: Profile[];
  steps?: Record<string, { done: boolean; detail: string }>;
};
type Permissions = { advancedSettings: boolean; expiresAt?: string };
type Config = {
  routing?: { mode?: string; defaultAgentId?: string; defaultModel?: string };
  onboarding?: { profile?: { id?: string } };
  memory?: { vectorStore?: string; embeddingProvider?: string; autoRecall?: boolean };
};
type EmbedKind = 'ollama' | 'openai' | 'openai-compatible';
type VectorStore = 'sqlite-vec' | 'lancedb';
type Connector = 'telegram' | 'slack' | 'discord';
type MemoryCheck = { spec: string; ok: boolean; text: string; missingModel?: boolean };
type MemoryCheckResult = {
  ok: boolean;
  dimensions?: number;
  error?: string;
  missingModel?: boolean;
};

const BASE = '/api/mindstone/admin';
const STEPS = [
  'access',
  'provider',
  'model',
  'persona',
  'memory',
  'connectors',
  'about',
  'finish',
] as const;
type Step = (typeof STEPS)[number];
const STEP_LABELS = {
  access: 'com_mindstone_onb_step_access',
  provider: 'com_mindstone_onb_step_provider',
  model: 'com_mindstone_onb_step_model',
  persona: 'com_mindstone_onb_step_persona',
  memory: 'com_mindstone_onb_step_memory',
  connectors: 'com_mindstone_onb_step_connectors',
  about: 'com_mindstone_onb_step_about',
  finish: 'com_mindstone_onb_step_finish',
} as const;
/** The steps ?step= can open, and the /admin/status steps that must be done first. */
const LINKABLE: Partial<Record<Step, string[]>> = {
  memory: ['provider', 'persona'],
  connectors: ['provider', 'persona', 'memory'],
  about: ['provider', 'persona', 'memory'],
};

/** The embedding choices `mindstone onboard` offers; the first is the default. */
const EMBED_KINDS: Array<{ kind: EmbedKind; label: TranslationKeys }> = [
  { kind: 'ollama', label: 'com_mindstone_onb_embed_ollama' },
  { kind: 'openai', label: 'com_mindstone_onb_embed_openai' },
  { kind: 'openai-compatible', label: 'com_mindstone_onb_embed_compatible' },
];
const EMBED_MODELS: Record<EmbedKind, string[]> = {
  ollama: ['nomic-embed-text', 'mxbai-embed-large'],
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  'openai-compatible': [],
};
const CUSTOM_MODEL = 'custom';
const COMPATIBLE_MODEL = 'nomic-embed-text';
const VECTOR_STORES: Array<{ id: VectorStore; label: TranslationKeys }> = [
  { id: 'sqlite-vec', label: 'com_mindstone_onb_vector_sqlite' },
  { id: 'lancedb', label: 'com_mindstone_onb_vector_lancedb' },
];

/** Each connector's tokens, stored as secrets; the connector reads them as secrets/<name>. */
const CONNECTORS: Array<{
  id: Connector;
  label: TranslationKeys;
  bot: string;
  app?: string;
}> = [
  { id: 'telegram', label: 'com_mindstone_onb_connector_telegram', bot: 'telegram-bot.token' },
  {
    id: 'slack',
    label: 'com_mindstone_onb_connector_slack',
    bot: 'slack-bot.token',
    app: 'slack-app.token',
  },
  { id: 'discord', label: 'com_mindstone_onb_connector_discord', bot: 'discord-bot.token' },
];
const PURPOSE_MAX = 2000;
const USER_CONTEXT_MAX = 4000;

/** A saved embedding spec ("ollama:nomic-embed-text") as the memory step's choices. */
function parseEmbedding(
  spec?: string,
): { kind: EmbedKind; choice: string; custom: string } | undefined {
  const [provider, ...rest] = (spec ?? '').split(':');
  const model = rest.join(':').trim();
  if (!model) return undefined;
  if (provider === 'openai-compatible')
    return { kind: provider, choice: CUSTOM_MODEL, custom: model };
  if (provider !== 'ollama' && provider !== 'openai') return undefined;
  return EMBED_MODELS[provider].includes(model)
    ? { kind: provider, choice: model, custom: '' }
    : { kind: provider, choice: CUSTOM_MODEL, custom: model };
}

/** Comma-separated sender ids as a list. */
function senderIds(text: string): string[] {
  return text
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

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
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>('access');
  // Where the access step continues to: a step the settings page linked to, or the provider.
  const [resumeAt, setResumeAt] = useState<Step>('provider');
  const linkChecked = useRef(false);
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
  // Memory step.
  const [embedKind, setEmbedKind] = useState<EmbedKind>('ollama');
  const [embedChoice, setEmbedChoice] = useState(EMBED_MODELS.ollama[0]);
  const [embedCustom, setEmbedCustom] = useState('');
  const [vectorStore, setVectorStore] = useState<VectorStore>('sqlite-vec');
  const [autoRecall, setAutoRecall] = useState(true);
  const [memoryCheck, setMemoryCheck] = useState<MemoryCheck | null>(null);
  const [pulling, setPulling] = useState(false);
  const memoryPrefilled = useRef(false);
  // Connectors step.
  const [connector, setConnector] = useState<Connector | ''>('');
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [owners, setOwners] = useState('');
  const [allowed, setAllowed] = useState('');
  const [allowedEdited, setAllowedEdited] = useState(false);
  // About step.
  const [purpose, setPurpose] = useState('');
  const [userContext, setUserContext] = useState('');

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

  // ?step= opens a later step once the steps before it are done; without
  // advanced settings, the access step comes first and then continues there.
  useEffect(() => {
    if (linkChecked.current || !status || !permissions) return;
    linkChecked.current = true;
    const wanted = searchParams.get('step') as Step | null;
    const needs = wanted ? LINKABLE[wanted] : undefined;
    if (!wanted || !needs || !needs.every((name) => status.steps?.[name]?.done)) return;
    setResumeAt(wanted);
    if (permissions.advancedSettings) setStep(wanted);
  }, [status, permissions, searchParams]);

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

  // A rerun starts from the memory settings already saved.
  useEffect(() => {
    const memory = config?.memory;
    if (memoryPrefilled.current || !config) return;
    memoryPrefilled.current = true;
    const saved = parseEmbedding(memory?.embeddingProvider);
    if (saved) {
      setEmbedKind(saved.kind);
      setEmbedChoice(saved.choice);
      setEmbedCustom(saved.custom);
    }
    if (memory?.vectorStore === 'sqlite-vec' || memory?.vectorStore === 'lancedb') {
      setVectorStore(memory.vectorStore);
    }
    if (typeof memory?.autoRecall === 'boolean') setAutoRecall(memory.autoRecall);
  }, [config]);

  const embedModel = embedChoice === CUSTOM_MODEL ? embedCustom.trim() : embedChoice;
  const embedSpec = embedModel ? `${embedKind}:${embedModel}` : '';
  // Only a check of exactly this spec counts: changing the provider or model undoes it.
  const currentCheck = memoryCheck?.spec === embedSpec ? memoryCheck : null;

  const chooseEmbedKind = (kind: EmbedKind) => {
    const first = EMBED_MODELS[kind][0];
    setEmbedKind(kind);
    setEmbedChoice(first ?? CUSTOM_MODEL);
    setEmbedCustom(first ? '' : COMPATIBLE_MODEL);
  };

  /** A token typed for one connector never carries over to another. */
  const chooseConnector = (id: Connector) => {
    setConnector(id);
    setBotToken('');
    setAppToken('');
    setOwners('');
    setAllowed('');
    setAllowedEdited(false);
  };

  /** PATCH one config section against the config as it is now (If-Match). */
  const patchSection = async (section: string, body: unknown) => {
    const current = await request.get<{ etag?: string }>(`${BASE}/config`);
    const query = current.etag ? `?ifMatch=${encodeURIComponent(current.etag)}` : '';
    return (await request.patch(`${BASE}/config/${section}${query}`, body)) as {
      restartRequired?: boolean;
    };
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
      goTo(resumeAt);
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
      goTo('memory');
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  /** Embed a test text with this spec on the gateway; the result counts for this spec only. */
  const checkMemory = async (spec: string) => {
    setBusy(true);
    try {
      const result = (await request.post(`${BASE}/memory/check`, {
        embeddingProvider: spec,
      })) as MemoryCheckResult;
      setMemoryCheck(
        result.ok
          ? {
              spec,
              ok: true,
              text: localize('com_mindstone_onb_memory_ok', { 0: String(result.dimensions) }),
            }
          : {
              spec,
              ok: false,
              text: result.error ?? localize('com_mindstone_onb_memory_failed'),
              missingModel: result.missingModel === true,
            },
      );
    } catch (error) {
      setMemoryCheck({
        spec,
        ok: false,
        text: errorText(error) ?? localize('com_mindstone_onb_memory_failed'),
      });
    } finally {
      setBusy(false);
    }
  };

  /** Download the Ollama model the check was missing, then check again. */
  const pullModel = async () => {
    const spec = embedSpec;
    setBusy(true);
    setPulling(true);
    let failure: string | undefined;
    try {
      const result = (await request.post(`${BASE}/memory/pull`, { model: embedModel })) as {
        ok?: boolean;
        error?: string;
      };
      if (result?.ok !== true) {
        failure = result?.error ?? localize('com_mindstone_onb_memory_pull_failed');
      }
    } catch (error) {
      failure = errorText(error) ?? localize('com_mindstone_onb_memory_pull_failed');
    } finally {
      setPulling(false);
      setBusy(false);
    }
    if (failure === undefined) {
      await checkMemory(spec);
      return;
    }
    setMemoryCheck({ spec, ok: false, text: failure, missingModel: true });
  };

  const saveMemory = async () => {
    if (!currentCheck?.ok) return;
    setBusy(true);
    try {
      await patchSection('memory', { vectorStore, embeddingProvider: embedSpec, autoRecall });
      await load();
      goTo('connectors');
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  const saveConnector = async () => {
    const chosen = CONNECTORS.find((candidate) => candidate.id === connector);
    if (!chosen) return;
    const tokens: Array<[string, string]> = [[chosen.bot, botToken]];
    if (chosen.app) tokens.push([chosen.app, appToken]);
    // The tokens leave the page's state as they are sent, whether or not the save works.
    setBotToken('');
    setAppToken('');
    setBusy(true);
    try {
      for (const [name, value] of tokens) {
        await request.post(`${BASE}/secrets/${encodeURIComponent(name)}`, { value });
      }
      const result = await patchSection('channels', {
        [chosen.id]: {
          enabled: true,
          tokenFile: `secrets/${chosen.bot}`,
          ...(chosen.app ? { appTokenFile: `secrets/${chosen.app}` } : {}),
          ownerSenders: senderIds(owners),
          allowedSenders: senderIds(allowed),
        },
      });
      await load();
      goTo('about');
      setMessage({
        ok: true,
        text: localize(
          result?.restartRequired
            ? 'com_mindstone_onb_connector_saved_restart'
            : 'com_mindstone_onb_connector_saved',
          { 0: localize(chosen.label) },
        ),
      });
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_saved') });
    } finally {
      setBusy(false);
    }
  };

  /** Finish setup on the gateway with what the agent should know; empty answers are left out. */
  const completeSetup = async () => {
    const body: { purpose?: string; userContext?: string } = {};
    if (purpose.trim()) body.purpose = purpose.trim();
    if (userContext.trim()) body.userContext = userContext.trim();
    setBusy(true);
    try {
      const result = (await request.post(`${BASE}/onboarding/complete`, body)) as {
        ok?: boolean;
        error?: string;
      };
      if (result?.ok !== true) {
        setMessage({ ok: false, text: result?.error ?? localize('com_mindstone_not_saved') });
        return;
      }
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
    // The chat form sends ?prompt= itself when submit=true (hooks/Input/useQueryParams),
    // so the first chat opens with a hello and the agent's answer.
    const query = new URLSearchParams({
      prompt: localize('com_mindstone_onb_first_message'),
      submit: 'true',
    });
    navigate(`/c/new?${query.toString()}`);
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1';
  const input = 'rounded border border-border-medium bg-surface-secondary p-2';
  const stepIndex = STEPS.indexOf(step);
  const confirmOk = confirmationMatches(confirmText);
  const confirmHint = confirmText !== '' && !confirmOk;
  const chosenConnector = CONNECTORS.find((candidate) => candidate.id === connector);
  const connectorReady =
    chosenConnector !== undefined &&
    botToken !== '' &&
    (!chosenConnector.app || appToken !== '') &&
    senderIds(owners).length > 0;

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
                <button type="button" className={primary} onClick={() => goTo(resumeAt)}>
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

        {step === 'memory' && (
          <section className={card} aria-labelledby="ms-onb-memory">
            <h2 id="ms-onb-memory" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_memory_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_onb_memory_hint')}
            </p>
            <fieldset disabled={pulling} className="mb-3 flex flex-col gap-3">
              <legend className="sr-only">{localize('com_mindstone_onb_memory_title')}</legend>
              <div
                role="radiogroup"
                aria-labelledby="ms-onb-embed-kind"
                className="flex flex-col gap-1"
              >
                <span id="ms-onb-embed-kind" className="text-sm text-text-secondary">
                  {localize('com_mindstone_onb_embed_provider')}
                </span>
                {EMBED_KINDS.map((candidate) => (
                  <label key={candidate.kind} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="ms-onb-embed-kind"
                      checked={embedKind === candidate.kind}
                      onChange={() => chooseEmbedKind(candidate.kind)}
                    />
                    {localize(candidate.label)}
                  </label>
                ))}
                {embedKind !== 'ollama' && (
                  <p className="text-sm text-text-secondary">
                    {localize('com_mindstone_onb_embed_host_note')}
                  </p>
                )}
              </div>
              {EMBED_MODELS[embedKind].length > 0 && (
                <label className="flex flex-col gap-1 text-sm">
                  {localize('com_mindstone_onb_embed_model')}
                  <select
                    className={input}
                    value={embedChoice}
                    onChange={(e) => setEmbedChoice(e.target.value)}
                  >
                    {EMBED_MODELS[embedKind].map((name, index) => (
                      <option key={name} value={name}>
                        {index === 0
                          ? localize('com_mindstone_onb_embed_recommended', { 0: name })
                          : name}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL}>
                      {localize('com_mindstone_onb_embed_custom')}
                    </option>
                  </select>
                </label>
              )}
              {embedChoice === CUSTOM_MODEL && (
                <label className="flex flex-col gap-1 text-sm">
                  {localize('com_mindstone_onb_embed_custom_name')}
                  <input
                    className={input}
                    value={embedCustom}
                    onChange={(e) => setEmbedCustom(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <div
                role="radiogroup"
                aria-labelledby="ms-onb-vector"
                className="flex flex-col gap-1"
              >
                <span id="ms-onb-vector" className="text-sm text-text-secondary">
                  {localize('com_mindstone_onb_vector_store')}
                </span>
                {VECTOR_STORES.map((candidate) => (
                  <label key={candidate.id} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="ms-onb-vector"
                      checked={vectorStore === candidate.id}
                      onChange={() => setVectorStore(candidate.id)}
                    />
                    {localize(candidate.label)}
                  </label>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoRecall}
                    onChange={(e) => setAutoRecall(e.target.checked)}
                    aria-describedby="ms-onb-recall-hint"
                  />
                  {localize('com_mindstone_onb_auto_recall')}
                </label>
                <p id="ms-onb-recall-hint" className="text-sm text-text-secondary">
                  {localize('com_mindstone_onb_auto_recall_hint')}
                </p>
              </div>
            </fieldset>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${secondary} disabled:opacity-50`}
                disabled={busy || !embedSpec}
                onClick={() => void checkMemory(embedSpec)}
              >
                {localize('com_mindstone_onb_memory_test')}
              </button>
              {currentCheck &&
                !currentCheck.ok &&
                currentCheck.missingModel &&
                embedKind === 'ollama' && (
                  <button
                    type="button"
                    className={`${secondary} disabled:opacity-50`}
                    disabled={busy}
                    onClick={() => void pullModel()}
                  >
                    {localize('com_mindstone_onb_memory_download')}
                  </button>
                )}
            </div>
            <div role="status" data-testid="ms-onb-memory-check" className="mb-3 text-sm">
              {pulling && localize('com_mindstone_onb_memory_downloading')}
              {!pulling && currentCheck && (
                <span className={currentCheck.ok ? 'text-green-600' : 'text-red-500'}>
                  {currentCheck.text}
                </span>
              )}
              {!pulling && !currentCheck && (
                <span className="text-text-secondary">
                  {localize('com_mindstone_onb_memory_test_first')}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => goTo('persona')}
              >
                {localize('com_mindstone_onb_back')}
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy || !currentCheck?.ok}
                onClick={() => void saveMemory()}
              >
                {localize('com_mindstone_onb_save_next')}
              </button>
            </div>
          </section>
        )}

        {step === 'connectors' && (
          <section className={card} aria-labelledby="ms-onb-connectors">
            <h2 id="ms-onb-connectors" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_connectors_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_onb_connectors_hint')}
            </p>
            <fieldset className="mb-3 flex flex-col gap-1">
              <legend className="sr-only">{localize('com_mindstone_onb_connectors_title')}</legend>
              {CONNECTORS.map((candidate) => (
                <label key={candidate.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ms-onb-connector"
                    checked={connector === candidate.id}
                    onChange={() => chooseConnector(candidate.id)}
                  />
                  {localize(candidate.label)}
                </label>
              ))}
            </fieldset>
            {chosenConnector && (
              <div className="mb-3 flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  {localize('com_mindstone_onb_bot_token')}
                  <input
                    className={input}
                    type="password"
                    autoComplete="off"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                  />
                </label>
                {chosenConnector.app && (
                  <label className="flex flex-col gap-1 text-sm">
                    {localize('com_mindstone_onb_slack_app_token')}
                    <input
                      className={input}
                      type="password"
                      autoComplete="off"
                      value={appToken}
                      onChange={(e) => setAppToken(e.target.value)}
                    />
                  </label>
                )}
                <div className="flex flex-col gap-1 text-sm">
                  <label className="flex flex-col gap-1">
                    {localize('com_mindstone_onb_owner_ids')}
                    <input
                      className={input}
                      value={owners}
                      onChange={(e) => {
                        setOwners(e.target.value);
                        if (!allowedEdited) setAllowed(e.target.value);
                      }}
                      aria-describedby="ms-onb-owner-hint"
                      spellCheck={false}
                    />
                  </label>
                  <span id="ms-onb-owner-hint" className="text-text-secondary">
                    {localize('com_mindstone_onb_owner_ids_hint')}
                  </span>
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <label className="flex flex-col gap-1">
                    {localize('com_mindstone_onb_allowed_ids')}
                    <input
                      className={input}
                      value={allowed}
                      onChange={(e) => {
                        setAllowed(e.target.value);
                        setAllowedEdited(true);
                      }}
                      aria-describedby="ms-onb-allowed-hint"
                      spellCheck={false}
                    />
                  </label>
                  <span id="ms-onb-allowed-hint" className="text-text-secondary">
                    {localize('com_mindstone_onb_allowed_ids_hint')}
                  </span>
                </div>
              </div>
            )}
            <p className="mb-3 text-sm text-text-secondary">
              {localize('com_mindstone_onb_email_calendar')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => goTo('memory')}
              >
                {localize('com_mindstone_onb_back')}
              </button>
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => goTo('about')}
              >
                {localize('com_mindstone_onb_skip')}
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy || !connectorReady}
                onClick={() => void saveConnector()}
              >
                {localize('com_mindstone_onb_save_next')}
              </button>
            </div>
          </section>
        )}

        {step === 'about' && (
          <section className={card} aria-labelledby="ms-onb-about">
            <h2 id="ms-onb-about" className="mb-2 text-lg font-medium">
              {localize('com_mindstone_onb_about_title')}
            </h2>
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_onb_about_hint')}
            </p>
            <label className="mb-2 flex flex-col gap-1 text-sm">
              {localize('com_mindstone_onb_purpose')}
              <textarea
                className={`${input} h-24`}
                maxLength={PURPOSE_MAX}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </label>
            <label className="mb-3 flex flex-col gap-1 text-sm">
              {localize('com_mindstone_onb_user_context')}
              <textarea
                className={`${input} h-32`}
                maxLength={USER_CONTEXT_MAX}
                value={userContext}
                onChange={(e) => setUserContext(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => goTo('connectors')}
              >
                {localize('com_mindstone_onb_back')}
              </button>
              <button
                type="button"
                className={primary}
                disabled={busy}
                onClick={() => void completeSetup()}
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
            <p className="mb-2 text-sm">{localize('com_mindstone_onb_say_hello')}</p>
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
