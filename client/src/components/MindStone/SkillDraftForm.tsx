/**
 * The Skill Builder's draft form (MindStone-Agent #104), shared by the Skills
 * page and the persona editor's skill picker (MindStone-Agent #125): start
 * from a built-in or from scratch, and ask the gateway for a draft. The parent
 * holds the fields and does the request.
 */
import type { SkillDraftFields } from './skillDraft';
import type { TranslationKeys } from '~/hooks';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

export type BuiltinSkill = { id: string; label: string };

export default function SkillDraftForm({
  form,
  builtins,
  busy,
  draftExists,
  onEdit,
  onSubmit,
  onCancel,
}: {
  form: SkillDraftFields;
  builtins: BuiltinSkill[];
  busy: boolean;
  /** A draft (or installed skill) with this id exists: offer to replace it, on an explicit second click. */
  draftExists: boolean;
  onEdit: (patch: Partial<SkillDraftFields>) => void;
  onSubmit: (force: boolean) => void;
  onCancel: () => void;
}) {
  const localize = useLocalize();
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';
  const input = 'rounded border border-border-medium bg-surface-secondary p-2';
  const field = (
    key: keyof SkillDraftFields,
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
          onChange={(event) => onEdit({ [key]: event.target.value })}
        />
      ) : (
        <input
          className={input}
          value={form[key]}
          onChange={(event) => onEdit({ [key]: event.target.value })}
        />
      )}
      {hint && <span className="text-xs text-text-secondary">{localize(hint)}</span>}
    </label>
  );

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(false);
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {localize('com_mindstone_skill_from')}
        <select
          className={input}
          value={form.fromBuiltin}
          onChange={(event) => onEdit({ fromBuiltin: event.target.value })}
        >
          <option value="">{localize('com_mindstone_skill_from_scratch')}</option>
          {builtins.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {localize('com_mindstone_skill_from_builtin', {
                0: visibleText(skill.label),
              })}
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
            onClick={() => onSubmit(true)}
          >
            {localize('com_mindstone_skill_replace_draft')}
          </button>
        )}
        <button type="button" className={secondary} disabled={busy} onClick={onCancel}>
          {localize('com_mindstone_skill_cancel')}
        </button>
      </div>
    </form>
  );
}
