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
import type { SkillDraftFields } from './skillDraft';
import type { TranslationKeys } from '~/hooks';
import { EMPTY_SKILL_DRAFT, draftBody } from './skillDraft';
import SkillDraftForm from './SkillDraftForm';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

type Source = 'installed' | 'draft' | 'builtin';
type Summary = {
  id: string;
  label: string;
  description?: string;
  version?: string;
  source: Source;
  /** Installed skills only: false when it is over the prompt budget and only listed by name. */
  inPrompt?: boolean;
  error?: string;
};
type Detail = Summary & {
  goal?: string;
  whenToUse?: string[];
  outputs?: string[];
  safetyNotes?: string[];
  skillMarkdown: string;
};
const BASE = '/api/mindstone/admin';
const SOURCES: Source[] = ['installed', 'draft', 'builtin'];
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

export { draftBody } from './skillDraft';

export default function MindStoneSkillsView() {
  const localize = useLocalize();
  const [skills, setSkills] = useState<Summary[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<SkillDraftFields>(EMPTY_SKILL_DRAFT);
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
    setForm({ ...EMPTY_SKILL_DRAFT, fromBuiltin: builtin });
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
      setForm(EMPTY_SKILL_DRAFT);
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
      const { error: text, code, status } = errorBody(error);
      setInstallExists(code === 'skill_exists');
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
      // Advanced settings may have run out (they last an hour): read them again, so the page says so.
      if (status === 403) await load();
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
  // A changed form is a different draft: Replace no longer applies to it.
  const edit = (patch: Partial<SkillDraftFields>) => {
    setForm({ ...form, ...patch });
    setDraftExists(false);
  };
  // Installed and in the prompt is Active; installed past the budget says so.
  const stateOf = (skill: Pick<Summary, 'id' | 'source' | 'inPrompt'>): TranslationKeys => {
    const listed = skills?.find((entry) => entry.id === skill.id && entry.source === skill.source);
    return skill.source === 'installed' && (skill.inPrompt ?? listed?.inPrompt) === false
      ? 'com_mindstone_skill_state_over_budget'
      : state[skill.source];
  };
  const list = (label: TranslationKeys, items?: string[]) =>
    items && items.length > 0 ? (
      <div className="mb-2 text-sm">
        <span className="font-medium">{localize(label)}</span>
        <ul className="ml-5 list-disc">
          {items.map((item, index) => (
            <li key={index}>{visibleText(item)}</li>
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
                        <span className="text-sm font-medium">{visibleText(skill.label)}</span>{' '}
                        <span className="font-mono text-xs text-text-secondary">{skill.id}</span>{' '}
                        <span className="text-xs text-text-secondary">
                          · {localize(stateOf(skill))}
                        </span>
                        <br />
                        <span className="text-xs text-text-secondary">
                          {skill.error ?? visibleText(skill.description ?? '')}
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
            <SkillDraftForm
              form={form}
              builtins={builtins}
              busy={busy}
              draftExists={draftExists}
              onEdit={edit}
              onSubmit={(force) => void createDraft(force)}
              onCancel={() => {
                setFormOpen(false);
                setDraftExists(false);
              }}
            />
          )}
        </section>

        {detail && (
          <section className={card} aria-labelledby="ms-skill-detail">
            <h2 id="ms-skill-detail" className="mb-1 text-lg font-medium">
              {visibleText(detail.label)}
            </h2>
            <p className="mb-2 text-xs text-text-secondary">
              <span className="font-mono">{detail.id}</span> · {localize(stateOf(detail))}
              {detail.version ? ` · ${detail.version}` : ''}
            </p>
            {detail.description && (
              <p className="mb-2 break-words text-sm">{visibleText(detail.description)}</p>
            )}
            {detail.goal && (
              <p className="mb-2 text-sm">
                <span className="font-medium">{localize('com_mindstone_skill_field_goal')}</span>{' '}
                {visibleText(detail.goal)}
              </p>
            )}
            {list('com_mindstone_skill_field_when', detail.whenToUse)}
            {list('com_mindstone_skill_field_outputs', detail.outputs)}
            {list('com_mindstone_skill_field_safety', detail.safetyNotes)}
            <p className="mb-1 text-sm font-medium">{localize('com_mindstone_skill_markdown')}</p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-sm [overflow-wrap:anywhere]">
              {visibleText(detail.skillMarkdown)}
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
