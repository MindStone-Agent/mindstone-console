/**
 * The persona editor's skill picker (MindStone-Agent #125): the installed
 * skills a persona lists. It takes the gateway's skills (GET /admin/skills)
 * and the persona's current list, and hands back the new list of ids; the
 * editor saves it.
 *
 * A skill can also be made here, through the Skill Builder's own form and
 * requests: a draft, then an install (which needs advanced settings, like the
 * Skills page). Only an installed skill joins the list. Until then it waits
 * here, marked pending, and is never handed back.
 */
import { useState } from 'react';
import { request } from 'librechat-data-provider';
import type { SkillDraftFields } from './skillDraft';
import type { BuiltinSkill } from './SkillDraftForm';
import { EMPTY_SKILL_DRAFT, draftBody } from './skillDraft';
import SkillDraftForm from './SkillDraftForm';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

export type PickerSkill = {
  id: string;
  label: string;
  description?: string;
  source: 'installed' | 'draft' | 'builtin';
  error?: string;
};

const BASE = '/api/mindstone/admin';

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

/** The list with `id` added once, in the order chosen. */
export function withSkill(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected : [...selected, id];
}

export default function SkillPicker({
  skills,
  selected,
  advanced,
  onChange,
  onSkillsChanged,
  disabled = false,
}: {
  /** GET /admin/skills: installed skills are the ones a persona can list; built-ins seed a new draft. */
  skills: PickerSkill[];
  /** The persona's skills, as installed skill ids. */
  selected: string[];
  /** The advanced-settings permission: installing needs it. */
  advanced: boolean;
  onChange: (ids: string[]) => void;
  /** Read GET /admin/skills again (after an install). */
  onSkillsChanged: () => Promise<void>;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const [choice, setChoice] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<SkillDraftFields>(EMPTY_SKILL_DRAFT);
  const [draftExists, setDraftExists] = useState(false);
  /** Drafted here, not installed yet: shown, never handed back. */
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const installed = skills.filter((skill) => skill.source === 'installed' && !skill.error);
  const builtins: BuiltinSkill[] = skills.filter(
    (skill) => skill.source === 'builtin' && !skill.error,
  );
  const byId = new Map(installed.map((skill) => [skill.id, skill]));
  const addable = installed.filter((skill) => !selected.includes(skill.id));
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';
  const primary = 'rounded bg-surface-submit px-3 py-1 text-white disabled:opacity-50';

  /** Install a drafted skill and add it; on a refusal it stays pending, saying why. */
  const install = async (id: string) => {
    setBusy(true);
    try {
      await request.post(`${BASE}/skills/${encodeURIComponent(id)}/install`, {});
      await onSkillsChanged();
      setPending((list) => list.filter((entry) => entry !== id));
      onChange(withSkill(selected, id));
      setMessage({ ok: true, text: localize('com_mindstone_picker_installed', { 0: id }) });
    } catch (error) {
      const { error: text } = errorBody(error);
      setPending((list) => (list.includes(id) ? list : [...list, id]));
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async (force: boolean) => {
    setBusy(true);
    let id: string | undefined;
    try {
      const result = (await request.post(`${BASE}/skills/drafts`, draftBody(form, force))) as {
        skill: { id: string };
      };
      id = result.skill.id;
      setForm(EMPTY_SKILL_DRAFT);
      setCreating(false);
      setDraftExists(false);
    } catch (error) {
      const { error: text, status } = errorBody(error);
      // A draft (or an installed skill) with that id is only replaced on a second, explicit click.
      setDraftExists(status === 409);
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
    if (!id) return;
    if (advanced) {
      await install(id);
    } else {
      setPending((list) => (list.includes(id) ? list : [...list, id]));
      setMessage({ ok: true, text: localize('com_mindstone_picker_drafted', { 0: id }) });
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="ms-skill-picker">
      {selected.length === 0 ? (
        <p className="text-sm text-text-secondary">{localize('com_mindstone_picker_none')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {selected.map((id) => {
            const skill = byId.get(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid={`ms-skill-picker-selected-${id}`}
              >
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {skill ? visibleText(skill.label) : visibleText(id)}{' '}
                  <span className="font-mono text-xs text-text-secondary">{visibleText(id)}</span>
                  {!skill && (
                    <span className="ml-2 text-xs text-red-600">
                      {localize('com_mindstone_picker_not_installed')}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={secondary}
                  disabled={disabled || busy}
                  aria-label={localize('com_mindstone_picker_remove', { 0: id })}
                  onClick={() => onChange(selected.filter((entry) => entry !== id))}
                >
                  {localize('com_mindstone_picker_remove_short')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {pending.length > 0 && (
        <ul className="flex flex-col gap-1">
          {pending.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-2 text-sm"
              data-testid={`ms-skill-picker-pending-${id}`}
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                <span className="font-mono">{visibleText(id)}</span>{' '}
                <span className="text-xs text-text-secondary">
                  {localize(
                    advanced
                      ? 'com_mindstone_picker_pending'
                      : 'com_mindstone_picker_pending_advanced',
                  )}
                </span>
              </span>
              <button
                type="button"
                className={primary}
                disabled={disabled || busy || !advanced}
                onClick={() => void install(id)}
              >
                {localize('com_mindstone_skill_install')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-border-medium bg-surface-secondary p-1 text-sm"
          value={choice}
          disabled={disabled || busy || addable.length === 0}
          onChange={(event) => setChoice(event.target.value)}
          aria-label={localize('com_mindstone_picker_choose')}
        >
          <option value="">
            {localize(
              addable.length ? 'com_mindstone_picker_choose' : 'com_mindstone_picker_all_added',
            )}
          </option>
          {addable.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {visibleText(skill.label)} ({skill.id})
            </option>
          ))}
        </select>
        <button
          type="button"
          className={secondary}
          disabled={disabled || busy || !choice}
          onClick={() => {
            onChange(withSkill(selected, choice));
            setChoice('');
          }}
        >
          {localize('com_mindstone_picker_add')}
        </button>
        {!creating && (
          <button
            type="button"
            className={secondary}
            disabled={disabled || busy}
            onClick={() => {
              setCreating(true);
              setMessage(null);
            }}
          >
            {localize('com_mindstone_picker_create')}
          </button>
        )}
      </div>
      {creating && (
        <div className="rounded border border-border-light p-3">
          <p className="text-xs text-text-secondary">
            {localize(
              advanced
                ? 'com_mindstone_picker_create_hint'
                : 'com_mindstone_picker_create_hint_advanced',
            )}
          </p>
          <SkillDraftForm
            form={form}
            builtins={builtins}
            busy={busy || disabled}
            draftExists={draftExists}
            onEdit={(patch) => {
              setForm((current) => ({ ...current, ...patch }));
              setDraftExists(false);
            }}
            onSubmit={(force) => void createDraft(force)}
            onCancel={() => {
              setCreating(false);
              setDraftExists(false);
            }}
          />
        </div>
      )}
      {message && (
        <p
          role="status"
          className={`break-words text-sm [overflow-wrap:anywhere] ${message.ok ? 'text-green-600' : 'text-red-600'}`}
        >
          {visibleText(message.text)}
        </p>
      )}
    </div>
  );
}
