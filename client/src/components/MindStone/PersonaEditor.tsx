/**
 * Build or edit a persona (MindStone-Agent #125): its text, and its
 * components. For each kind, attach an existing one or create a new one:
 * - skills: Plumb's SkillPicker (installed skills; a new one goes through the
 *   Skill Builder and the advanced-settings install);
 * - workflows: tried in the order listed; a new one is made in place;
 * - knowledge bases: global collections to attach, and the persona's own
 *   private ones (once the persona is saved);
 * - connectors: a slot for later (#119).
 * Saving never makes the persona active: that stays on the Personas list.
 */
import { useCallback, useEffect, useState } from 'react';
import { request } from 'librechat-data-provider';
import type { KnowledgebaseSummary, LoadedPersona, PersonaForm } from './personaForms';
import type { PickerSkill } from './SkillPicker';
import { EMPTY_PERSONA, formFromPersona, moveItem, personaBody, toggleId } from './personaForms';
import KbReembedNote from './KbReembedNote';
import PrivateKnowledgebases from './PrivateKnowledgebases';
import WorkflowEditor from './WorkflowEditor';
import { visibleText } from './visibleText';
import SkillPicker from './SkillPicker';
import { useLocalize } from '~/hooks';

const BASE = '/api/mindstone/admin';
/** A shared KB id the gateway's reset route and the proxy take: its folder name (MindStone-Agent #158). */

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

type WorkflowSummary = { id: string; name: string; stepCount: number; error?: string };

export default function PersonaEditor({
  personaId,
  personas,
  onSaved,
  onClose,
}: {
  /** The persona to edit; absent to build a new one. */
  personaId?: string;
  /** Every persona, for a workflow step's persona choice. */
  personas: Array<{ id: string; name: string }>;
  /** After a save: the persona's id and whether it is the active one. */
  onSaved: (id: string, active: boolean) => void;
  onClose: () => void;
}) {
  const localize = useLocalize();
  // After a create, the editor stays open on the saved persona, so its own KBs can be added.
  const [editingId, setEditingId] = useState<string | undefined>(personaId);
  const [form, setForm] = useState<PersonaForm>(EMPTY_PERSONA);
  const [skills, setSkills] = useState<PickerSkill[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [globalKbs, setGlobalKbs] = useState<KnowledgebaseSummary[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [workflowEditor, setWorkflowEditor] = useState<{ id?: string } | null>(null);
  const [addWorkflow, setAddWorkflow] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** The persona as last loaded or saved: an edit sends only the text fields changed since. */
  const [original, setOriginal] = useState<PersonaForm | undefined>(undefined);

  const loadSkills = useCallback(async () => {
    const result = await request.get<{ skills: PickerSkill[] }>(`${BASE}/skills`);
    setSkills(result.skills);
  }, []);
  const loadWorkflows = useCallback(async () => {
    const result = await request.get<{ workflows: WorkflowSummary[] }>(`${BASE}/workflows`);
    setWorkflows(result.workflows);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [permissions, kbs, persona] = await Promise.all([
          request.get<{ permissions: { advancedSettings: boolean } }>(`${BASE}/permissions`),
          request.get<{ knowledgebases: KnowledgebaseSummary[] }>(`${BASE}/knowledgebases`),
          personaId
            ? request.get<{ persona: LoadedPersona }>(
                `${BASE}/personas/${encodeURIComponent(personaId)}`,
              )
            : Promise.resolve(undefined),
          loadSkills(),
          loadWorkflows(),
        ]);
        setAdvanced(permissions.permissions.advancedSettings);
        setGlobalKbs(kbs.knowledgebases);
        if (persona) {
          setForm(formFromPersona(persona.persona));
          setOriginal(formFromPersona(persona.persona));
        }
        setLoaded(true);
      } catch (error) {
        setMessage({
          ok: false,
          text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
        });
      }
    })();
  }, [personaId, loadSkills, loadWorkflows, localize]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (editingId) {
        const result = (await request.patch(
          `${BASE}/personas/${encodeURIComponent(editingId)}`,
          personaBody(form, 'edit', original),
        )) as { persona: { active: boolean } };
        setOriginal(form);
        setMessage({
          ok: true,
          text: localize(
            result.persona.active ? 'com_mindstone_pe_saved_active' : 'com_mindstone_pe_saved',
          ),
        });
        onSaved(editingId, result.persona.active);
      } else {
        const id = form.id.trim();
        await request.post(`${BASE}/personas`, personaBody(form, 'create'));
        setEditingId(id);
        setOriginal({ ...form, id });
        setMessage({ ok: true, text: localize('com_mindstone_pe_created', { 0: id }) });
        onSaved(id, false);
      }
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const input = 'rounded border border-border-medium bg-surface-primary px-2 py-1 text-sm';
  const secondary = 'rounded border border-border-medium px-2 py-1 text-sm disabled:opacity-50';
  const primary = 'rounded bg-surface-submit px-3 py-1 text-white disabled:opacity-50';
  const section = 'flex flex-col gap-2 border-t border-border-light pt-3';
  const workflowName = (id: string) => workflows.find((workflow) => workflow.id === id)?.name;
  /** A listed workflow that no longer loads (or is gone): marked, so Remove can fix a save the gateway refuses. */
  const workflowBroken = (id: string) => {
    const found = workflows.find((workflow) => workflow.id === id);
    return !found || Boolean(found.error);
  };
  const attachable = workflows.filter(
    (workflow) => !workflow.error && !form.workflows.includes(workflow.id),
  );

  if (!loaded) {
    // A failed load can still be closed, so the list is usable again.
    return message ? (
      <div className="flex items-center gap-2" data-testid="ms-persona-editor-failed">
        <p className="text-sm text-red-600">{visibleText(message.text)}</p>
        <button type="button" className={secondary} onClick={onClose}>
          {localize('com_mindstone_pe_close')}
        </button>
      </div>
    ) : null;
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border-medium bg-surface-primary p-4"
      aria-labelledby="ms-pe-title"
      data-testid="ms-persona-editor"
    >
      <div className="flex items-center justify-between">
        <h2 id="ms-pe-title" className="text-lg font-medium">
          {editingId
            ? localize('com_mindstone_pe_edit_title', { 0: visibleText(form.name || editingId) })
            : localize('com_mindstone_pe_new_title')}
        </h2>
        <button type="button" className={secondary} onClick={onClose}>
          {localize('com_mindstone_pe_close')}
        </button>
      </div>
      <p className="text-xs text-text-secondary">{localize('com_mindstone_pe_not_active_note')}</p>

      {!editingId && (
        <label className="flex flex-col gap-1 text-sm">
          {localize('com_mindstone_pe_id')}
          <input
            className={input}
            value={form.id}
            data-testid="ms-pe-id"
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
          <span className="text-xs text-text-secondary">
            {localize('com_mindstone_pe_id_hint')}
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {localize('com_mindstone_pe_name')}
        <input
          className={input}
          value={form.name}
          data-testid="ms-pe-name"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {localize('com_mindstone_pe_description')}
        <input
          className={input}
          value={form.description}
          data-testid="ms-pe-description"
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {localize('com_mindstone_pe_markdown')}
        <textarea
          className={`${input} font-mono`}
          rows={8}
          value={form.personaMarkdown}
          data-testid="ms-pe-markdown"
          onChange={(event) => setForm({ ...form, personaMarkdown: event.target.value })}
        />
      </label>

      <div className={section}>
        <h3 className="font-medium">{localize('com_mindstone_pe_skills')}</h3>
        <p className="text-xs text-text-secondary">{localize('com_mindstone_pe_skills_hint')}</p>
        <SkillPicker
          skills={skills}
          selected={form.skills}
          advanced={advanced}
          disabled={busy}
          onChange={(ids) => setForm((current) => ({ ...current, skills: ids }))}
          onSkillsChanged={loadSkills}
        />
      </div>

      <div className={section}>
        <h3 className="font-medium">{localize('com_mindstone_pe_workflows')}</h3>
        <p className="text-xs text-text-secondary">{localize('com_mindstone_pe_workflows_hint')}</p>
        {form.workflows.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_pe_workflows_none')}
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {form.workflows.map((id, index) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid={`ms-pe-workflow-${id}`}
              >
                <span>
                  {index + 1}. {visibleText(workflowName(id) ?? id)}{' '}
                  {workflowBroken(id) && (
                    <span
                      className="text-xs text-red-600"
                      data-testid={`ms-pe-workflow-broken-${id}`}
                    >
                      {localize('com_mindstone_pe_workflow_broken')}
                    </span>
                  )}{' '}
                  <span className="font-mono text-xs text-text-secondary">{visibleText(id)}</span>
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className={secondary}
                    disabled={index === 0}
                    aria-label={localize('com_mindstone_move_up_named', { 0: id })}
                    onClick={() =>
                      setForm({ ...form, workflows: moveItem(form.workflows, index, -1) })
                    }
                  >
                    {localize('com_mindstone_move_up')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    disabled={index === form.workflows.length - 1}
                    aria-label={localize('com_mindstone_move_down_named', { 0: id })}
                    onClick={() =>
                      setForm({ ...form, workflows: moveItem(form.workflows, index, 1) })
                    }
                  >
                    {localize('com_mindstone_move_down')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    aria-label={localize('com_mindstone_pe_edit_named', { 0: id })}
                    onClick={() => setWorkflowEditor({ id })}
                  >
                    {localize('com_mindstone_pe_edit')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    aria-label={localize('com_mindstone_picker_remove', { 0: id })}
                    onClick={() =>
                      setForm({ ...form, workflows: toggleId(form.workflows, id, false) })
                    }
                  >
                    {localize('com_mindstone_picker_remove_short')}
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            className={input}
            value={addWorkflow}
            aria-label={localize('com_mindstone_pe_workflow_choose')}
            data-testid="ms-pe-workflow-choose"
            onChange={(event) => setAddWorkflow(event.target.value)}
          >
            <option value="">
              {attachable.length
                ? localize('com_mindstone_pe_workflow_choose')
                : localize('com_mindstone_pe_workflow_all_added')}
            </option>
            {attachable.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {visibleText(workflow.name)} ({visibleText(workflow.id)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className={secondary}
            disabled={!addWorkflow}
            data-testid="ms-pe-workflow-add"
            onClick={() => {
              setForm({ ...form, workflows: toggleId(form.workflows, addWorkflow, true) });
              setAddWorkflow('');
            }}
          >
            {localize('com_mindstone_picker_add')}
          </button>
          <button
            type="button"
            className={secondary}
            data-testid="ms-pe-workflow-new"
            onClick={() => setWorkflowEditor({})}
          >
            {localize('com_mindstone_pe_workflow_new')}
          </button>
        </div>
        {workflowEditor && (
          <WorkflowEditor
            key={workflowEditor.id ?? 'new'}
            workflowId={workflowEditor.id}
            personas={personas}
            onCancel={() => setWorkflowEditor(null)}
            onSaved={(id) => {
              setWorkflowEditor(null);
              setForm((current) => ({
                ...current,
                workflows: toggleId(current.workflows, id, true),
              }));
              setMessage({
                ok: true,
                text: localize('com_mindstone_pe_workflow_saved', { 0: id }),
              });
              void loadWorkflows();
            }}
          />
        )}
      </div>

      <div className={section}>
        <h3 className="font-medium">{localize('com_mindstone_pe_kbs')}</h3>
        <p className="text-xs text-text-secondary">
          {localize('com_mindstone_pe_global_kbs_hint')}
        </p>
        {globalKbs.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_pe_global_kbs_none')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {globalKbs.map((kb) => (
              <li key={kb.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.knowledgebases.includes(kb.id)}
                    disabled={Boolean(kb.error) && !form.knowledgebases.includes(kb.id)}
                    data-testid={`ms-pe-global-kb-${kb.id}`}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        knowledgebases: toggleId(form.knowledgebases, kb.id, event.target.checked),
                      })
                    }
                  />
                  {visibleText(kb.name)}{' '}
                  {kb.error && (
                    <span className="text-xs text-red-600">
                      {localize('com_mindstone_pe_kb_broken')}
                    </span>
                  )}{' '}
                  <span className="font-mono text-xs text-text-secondary">
                    {visibleText(kb.id)}
                  </span>
                </label>
                {/* Outside the label, so the checkbox's name is the KB's alone (MindStone-Agent #158 review). */}
                {kb.reembed && (
                  <KbReembedNote
                    reembed={kb.reembed}
                    testId={`ms-pe-global-kb-reembed-${kb.id}`}
                    // Any folder name the list shows, as one encoded segment (MindStone-Agent #166).
                    retryPath={`${BASE}/knowledgebases/${encodeURIComponent(kb.id)}/reembed`}
                    onRetried={() => {
                      void request
                        .get<{ knowledgebases: KnowledgebaseSummary[] }>(`${BASE}/knowledgebases`)
                        .then((result) => setGlobalKbs(result.knowledgebases))
                        .catch(() => undefined);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {form.knowledgebases
          .filter((id) => !globalKbs.some((kb) => kb.id === id))
          .map((id) => (
            <div
              key={id}
              className="flex items-center justify-between gap-2 text-sm"
              data-testid={`ms-pe-global-kb-missing-${id}`}
            >
              <span>
                <span className="font-mono">{visibleText(id)}</span>{' '}
                <span className="text-xs text-red-600">
                  {localize('com_mindstone_pe_kb_missing')}
                </span>
              </span>
              <button
                type="button"
                className={secondary}
                aria-label={localize('com_mindstone_picker_remove', { 0: id })}
                onClick={() =>
                  setForm({ ...form, knowledgebases: toggleId(form.knowledgebases, id, false) })
                }
              >
                {localize('com_mindstone_picker_remove_short')}
              </button>
            </div>
          ))}
        <h4 className="text-sm font-medium">{localize('com_mindstone_pe_private_kbs')}</h4>
        {editingId ? (
          <PrivateKnowledgebases personaId={editingId} advanced={advanced} />
        ) : (
          <p className="text-sm text-text-secondary">
            {localize('com_mindstone_pe_private_after_save')}
          </p>
        )}
      </div>

      <div className={section}>
        <h3 className="font-medium">{localize('com_mindstone_pe_connectors')}</h3>
        <p className="text-sm text-text-secondary">
          {localize('com_mindstone_pe_connectors_later')}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          disabled={busy}
          data-testid="ms-pe-save"
          onClick={() => void save()}
        >
          {localize(editingId ? 'com_mindstone_pe_save' : 'com_mindstone_pe_create')}
        </button>
      </div>
      {message && (
        <p role="status" className={message.ok ? 'text-sm text-green-600' : 'text-sm text-red-600'}>
          {visibleText(message.text)}
        </p>
      )}
    </section>
  );
}
