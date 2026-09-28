/**
 * MindStone Skill Builder (MindStone-Agent #104): the skills the gateway
 * knows (installed, drafts and built-ins), a form that drafts a new one from
 * a built-in or from scratch, and the draft review: read it, then install or
 * discard it. An installed skill is active: the agent sees it on the owner's
 * turns. Installing needs advanced settings, as approving a skill that the
 * agent proposed in chat does; drafting doesn't.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

type Source = 'installed' | 'draft' | 'builtin';
type Summary = {
  id: string;
  label: string;
  description?: string;
  version?: string;
  source: Source;
  error?: string;
};
type Detail = Summary & {
  goal?: string;
  whenToUse?: string[];
  outputs?: string[];
  safetyNotes?: string[];
  skillMarkdown: string;
};
type Form = {
  fromBuiltin: string;
  id: string;
  label: string;
  description: string;
  goal: string;
  whenToUse: string;
  outputs: string;
  safetyNotes: string;
  instructions: string;
};

const BASE = '/api/mindstone/admin';
const SOURCES: Source[] = ['installed', 'draft', 'builtin'];
const EMPTY: Form = {
  fromBuiltin: '',
  id: '',
  label: '',
  description: '',
  goal: '',
  whenToUse: '',
  outputs: '',
  safetyNotes: '',
  instructions: '',
};

function errorBody(error: unknown): { error?: string; code?: string; status?: number } {
  const response = (
    error as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } }
  )?.response;
  return {
    error: typeof response?.data?.error === 'string' ? response.data.error : undefined,
    code: typeof response?.data?.code === 'string' ? response.data.code : undefined,
    status: response?.status,
  };
}

/** One entry per non-empty line. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The draft request: only what was filled in, so a built-in keeps what isn't overridden. */
export function draftBody(form: Form, force: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text = { id: form.id, label: form.label, description: form.description, goal: form.goal };
  for (const [key, value] of Object.entries(text)) {
    if (value.trim()) body[key] = value.trim();
  }
  if (form.fromBuiltin) {
    body.fromBuiltin = form.fromBuiltin;
  } else {
    for (const key of ['whenToUse', 'outputs', 'safetyNotes'] as const) {
      const list = lines(form[key]);
      if (list.length) body[key] = list;
    }
    if (form.instructions.trim()) body.instructions = form.instructions;
  }
  if (force) body.force = true;
  return body;
}

export default function MindStoneSkillsView() {
  const localize = useLocalize();
  const [skills, setSkills] = useState<Summary[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formOpen, setFormOpen] = useState(false);
  const [draftExists, setDraftExists] = useState(false);
  const [installExists, setInstallExists] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, permissions] = await Promise.all([
        request.get<{ skills: Summary[] }>(`${BASE}/skills`),
        request.get<{ permissions: { advancedSettings: boolean } }>(`${BASE}/permissions`),
      ]);
      setSkills(list.skills);
      setAdvanced(permissions.permissions.advancedSettings);
      setLoadError(null);
    } catch (error) {
      const { error: text, status } = errorBody(error);
      // The Console's own 403 (not an admin) has no gateway error text.
      setLoadError(
        text ??
          localize(
            status === 403 ? 'com_mindstone_admin_only' : 'com_mindstone_gateway_unreachable',
          ),
      );
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string, source: Source) => {
    setInstallExists(false);
    setConfirmDiscard(false);
    try {
      const result = await request.get<{ skill: Detail }>(
        `${BASE}/skills/${encodeURIComponent(id)}?source=${source}`,
      );
      setDetail(result.skill);
    } catch (error) {
      setDetail(null);
      setMessage({
        ok: false,
        text: errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'),
      });
    }
  };

  const startFrom = (builtin: string) => {
    setForm({ ...EMPTY, fromBuiltin: builtin });
    setFormOpen(true);
    setDraftExists(false);
    setMessage(null);
  };

  const createDraft = async (force = false) => {
    setBusy(true);
    try {
      const result = (await request.post(`${BASE}/skills/drafts`, draftBody(form, force))) as {
        skill: { id: string };
      };
      setMessage({
        ok: true,
        text: localize('com_mindstone_skill_drafted', { 0: result.skill.id }),
      });
      setForm(EMPTY);
      setFormOpen(false);
      setDraftExists(false);
      await load();
      await open(result.skill.id, 'draft');
    } catch (error) {
      const { error: text, status } = errorBody(error);
      // A draft (or an installed skill) with that id is only replaced on a second, explicit click.
      setDraftExists(status === 409);
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const install = async (force = false) => {
    if (!detail) return;
    setBusy(true);
    try {
      await request.post(
        `${BASE}/skills/${encodeURIComponent(detail.id)}/install`,
        force ? { force: true } : {},
      );
      setMessage({ ok: true, text: localize('com_mindstone_skill_installed', { 0: detail.id }) });
      setInstallExists(false);
      await load();
      await open(detail.id, 'installed');
    } catch (error) {
      const { error: text, code } = errorBody(error);
      setInstallExists(code === 'skill_exists');
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await request.delete(`${BASE}/skills/drafts/${encodeURIComponent(detail.id)}`);
      setMessage({ ok: true, text: localize('com_mindstone_skill_discarded', { 0: detail.id }) });
      setDetail(null);
      setConfirmDiscard(false);
      await load();
    } catch (error) {
      setMessage({
        ok: false,
        text: errorBody(error).error ?? localize('com_mindstone_not_changed'),
      });
    } finally {
      setBusy(false);
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';
  const danger = 'rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50';
  const input = 'rounded border border-border-medium bg-surface-secondary p-2';
  const builtins = skills?.filter((skill) => skill.source === 'builtin' && !skill.error) ?? [];
  const heading: Record<Source, TranslationKeys> = {
    installed: 'com_mindstone_skill_installed_list',
    draft: 'com_mindstone_skill_draft_list',
    builtin: 'com_mindstone_skill_builtin_list',
  };
  const state: Record<Source, TranslationKeys> = {
    installed: 'com_mindstone_skill_state_active',
    draft: 'com_mindstone_skill_state_draft',
    builtin: 'com_mindstone_skill_state_builtin',
  };
  const field = (
    key: keyof Form,
    label: TranslationKeys,
    rows?: number,
    hint?: TranslationKeys,
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      {localize(label)}
      {rows ? (
        <textarea
          className={input}
          rows={rows}
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
      ) : (
        <input
          className={input}
          value={form[key]}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        />
      )}
      {hint && <span className="text-xs text-text-secondary">{localize(hint)}</span>}
    </label>
  );
  const list = (label: TranslationKeys, items?: string[]) =>
    items && items.length > 0 ? (
      <div className="mb-2 text-sm">
        <span className="font-medium">{localize(label)}</span>
        <ul className="ml-5 list-disc">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_skill_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_skill_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_skill_intro')}</p>
        {!advanced && (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_skill_need_advanced')}
          </p>
        )}
        {loadError && (
          <p role="alert" className="text-red-600">
            {loadError}
          </p>
        )}
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}

        {SOURCES.map((source) => {
          const group = skills?.filter((skill) => skill.source === source) ?? [];
          return (
            <section key={source} className={card} aria-labelledby={`ms-skills-${source}`}>
              <h2 id={`ms-skills-${source}`} className="mb-2 text-lg font-medium">
                {localize(heading[source], { 0: String(group.length) })}
              </h2>
              {group.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  {localize('com_mindstone_skill_none')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border-light">
                  {group.map((skill) => (
                    <li
                      key={skill.id}
                      className="flex items-center justify-between gap-2 py-2"
                      data-testid={`ms-skill-${source}-${skill.id}`}
                    >
                      <button
                        type="button"
                        className="flex-1 rounded px-2 py-1 text-left hover:bg-surface-hover"
                        aria-current={detail?.id === skill.id && detail.source === source}
                        disabled={Boolean(skill.error)}
                        onClick={() => void open(skill.id, source)}
                      >
                        <span className="text-sm font-medium">{skill.label}</span>{' '}
                        <span className="font-mono text-xs text-text-secondary">{skill.id}</span>{' '}
                        <span className="text-xs text-text-secondary">
                          · {localize(state[source])}
                        </span>
                        <br />
                        <span className="text-xs text-text-secondary">
                          {skill.error ?? skill.description}
                        </span>
                      </button>
                      {source === 'builtin' && !skill.error && (
                        <button
                          type="button"
                          className={secondary}
                          onClick={() => startFrom(skill.id)}
                        >
                          {localize('com_mindstone_skill_start_from')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        <section className={card} aria-labelledby="ms-skill-new">
          <div className="flex items-center justify-between">
            <h2 id="ms-skill-new" className="text-lg font-medium">
              {localize('com_mindstone_skill_new')}
            </h2>
            {!formOpen && (
              <button type="button" className={secondary} onClick={() => startFrom('')}>
                {localize('com_mindstone_skill_new_start')}
              </button>
            )}
          </div>
          {formOpen && (
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createDraft();
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                {localize('com_mindstone_skill_from')}
                <select
                  className={input}
                  value={form.fromBuiltin}
                  onChange={(event) => setForm({ ...form, fromBuiltin: event.target.value })}
                >
                  <option value="">{localize('com_mindstone_skill_from_scratch')}</option>
                  {builtins.map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      {localize('com_mindstone_skill_from_builtin', { 0: skill.label })}
                    </option>
                  ))}
                </select>
              </label>
              {field(
                'id',
                'com_mindstone_skill_field_id',
                undefined,
                form.fromBuiltin
                  ? 'com_mindstone_skill_field_optional'
                  : 'com_mindstone_skill_field_id_hint',
              )}
              {field(
                'label',
                'com_mindstone_skill_field_label',
                undefined,
                form.fromBuiltin ? 'com_mindstone_skill_field_optional' : undefined,
              )}
              {field(
                'description',
                'com_mindstone_skill_field_description',
                2,
                form.fromBuiltin ? 'com_mindstone_skill_field_optional' : undefined,
              )}
              {field('goal', 'com_mindstone_skill_field_goal', 2)}
              {!form.fromBuiltin && (
                <>
                  {field(
                    'whenToUse',
                    'com_mindstone_skill_field_when',
                    3,
                    'com_mindstone_skill_field_lines',
                  )}
                  {field(
                    'outputs',
                    'com_mindstone_skill_field_outputs',
                    3,
                    'com_mindstone_skill_field_lines',
                  )}
                  {field(
                    'safetyNotes',
                    'com_mindstone_skill_field_safety',
                    3,
                    'com_mindstone_skill_field_lines',
                  )}
                  {field(
                    'instructions',
                    'com_mindstone_skill_field_instructions',
                    8,
                    'com_mindstone_skill_field_instructions_hint',
                  )}
                </>
              )}
              <div className="flex gap-2">
                <button type="submit" className={primary} disabled={busy}>
                  {localize('com_mindstone_skill_create_draft')}
                </button>
                {draftExists && (
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy}
                    onClick={() => void createDraft(true)}
                  >
                    {localize('com_mindstone_skill_replace_draft')}
                  </button>
                )}
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  onClick={() => {
                    setFormOpen(false);
                    setDraftExists(false);
                  }}
                >
                  {localize('com_mindstone_skill_cancel')}
                </button>
              </div>
            </form>
          )}
        </section>

        {detail && (
          <section className={card} aria-labelledby="ms-skill-detail">
            <h2 id="ms-skill-detail" className="mb-1 text-lg font-medium">
              {detail.label}
            </h2>
            <p className="mb-2 text-xs text-text-secondary">
              <span className="font-mono">{detail.id}</span> · {localize(state[detail.source])}
              {detail.version ? ` · ${detail.version}` : ''}
            </p>
            {detail.description && <p className="mb-2 text-sm">{detail.description}</p>}
            {detail.goal && (
              <p className="mb-2 text-sm">
                <span className="font-medium">{localize('com_mindstone_skill_field_goal')}</span>{' '}
                {detail.goal}
              </p>
            )}
            {list('com_mindstone_skill_field_when', detail.whenToUse)}
            {list('com_mindstone_skill_field_outputs', detail.outputs)}
            {list('com_mindstone_skill_field_safety', detail.safetyNotes)}
            <p className="mb-1 text-sm font-medium">{localize('com_mindstone_skill_markdown')}</p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-sm">
              {detail.skillMarkdown}
            </pre>
            {detail.source === 'draft' && !confirmDiscard && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={!advanced || busy}
                  onClick={() => void install()}
                >
                  {localize('com_mindstone_skill_install')}
                </button>
                {installExists && (
                  <button
                    type="button"
                    className={secondary}
                    disabled={!advanced || busy}
                    onClick={() => void install(true)}
                  >
                    {localize('com_mindstone_skill_replace_installed')}
                  </button>
                )}
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  onClick={() => setConfirmDiscard(true)}
                >
                  {localize('com_mindstone_skill_discard')}
                </button>
              </div>
            )}
            {detail.source === 'draft' && confirmDiscard && (
              <div className="mt-3 flex flex-col gap-2 rounded bg-surface-secondary p-2">
                <p className="text-sm">
                  {localize('com_mindstone_skill_confirm_discard', { 0: detail.id })}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={danger}
                    disabled={busy}
                    onClick={() => void discard()}
                  >
                    {localize('com_mindstone_skill_confirm_discard_yes')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    {localize('com_mindstone_skill_cancel')}
                  </button>
                </div>
              </div>
            )}
            {detail.source === 'builtin' && (
              <button
                type="button"
                className={`${secondary} mt-3`}
                onClick={() => startFrom(detail.id)}
              >
                {localize('com_mindstone_skill_start_from')}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
