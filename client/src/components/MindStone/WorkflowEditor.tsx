/**
 * Create or edit a workflow (MindStone-Agent #125): an id, a name, and its
 * steps. A route step decides the turn when its condition matches (or
 * always, with none): it can hand the turn to a persona and narrow the skills
 * and knowledge bases in play. A gate step must pass before later steps
 * count. The gateway checks it all strictly and its refusal is shown as
 * given.
 */
import { useEffect, useState } from 'react';
import { request } from 'librechat-data-provider';
import type { ConditionForm, WorkflowForm, WorkflowStepForm } from './personaForms';
import { emptyStep, moveItem, nextStepId, stepForm, workflowBody } from './personaForms';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

const BASE = '/api/mindstone/admin';
const CONDITION_FIELDS: Array<keyof ConditionForm> = [
  'messagePrefix',
  'sourceChannel',
  'sourceSubstrate',
  'sessionKeyPrefix',
];

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function WorkflowEditor({
  workflowId,
  personas,
  onSaved,
  onCancel,
}: {
  /** The workflow to edit; absent to create one. */
  workflowId?: string;
  /** Persona ids a step can route to or gate on. */
  personas: Array<{ id: string; name: string }>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const localize = useLocalize();
  const [form, setForm] = useState<WorkflowForm>({
    id: '',
    name: '',
    description: '',
    steps: [emptyStep(0)],
  });
  const [loaded, setLoaded] = useState(!workflowId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    void (async () => {
      try {
        const result = await request.get<{
          id: string;
          workflow: {
            name?: string;
            description?: string;
            version?: string;
            steps: Array<Record<string, unknown>>;
          };
        }>(`${BASE}/workflows/${encodeURIComponent(workflowId)}`);
        setForm({
          id: result.id,
          name: result.workflow.name ?? '',
          description: result.workflow.description ?? '',
          version: result.workflow.version,
          steps: result.workflow.steps.map(stepForm),
        });
        setLoaded(true);
      } catch (error) {
        setMessage(errorText(error) ?? localize('com_mindstone_gateway_unreachable'));
      }
    })();
  }, [workflowId, localize]);

  const setStep = (index: number, patch: Partial<WorkflowStepForm>) =>
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)),
    }));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (workflowId) {
        await request.patch(
          `${BASE}/workflows/${encodeURIComponent(workflowId)}`,
          workflowBody(form, 'edit'),
        );
        onSaved(workflowId);
      } else {
        await request.post(`${BASE}/workflows`, workflowBody(form, 'create'));
        onSaved(form.id.trim());
      }
    } catch (error) {
      setMessage(errorText(error) ?? localize('com_mindstone_not_changed'));
    } finally {
      setBusy(false);
    }
  };

  const input = 'rounded border border-border-medium bg-surface-primary px-2 py-1 text-sm';
  const secondary = 'rounded border border-border-medium px-2 py-1 text-sm disabled:opacity-50';
  const primary = 'rounded bg-surface-submit px-3 py-1 text-white disabled:opacity-50';

  /**
   * The personas a step can name, plus the one it names now if that isn't
   * among them (it doesn't load, or isn't listed), so the page shows what a
   * save sends back.
   */
  const personaOptions = (current: string) => [
    ...personas.map((persona) => (
      <option key={persona.id} value={persona.id}>
        {`${visibleText(persona.name)} (${visibleText(persona.id)})`}
      </option>
    )),
    ...(current && !personas.some((persona) => persona.id === current)
      ? [
          <option key={`missing-${current}`} value={current}>
            {localize('com_mindstone_wf_persona_unavailable', { 0: visibleText(current) })}
          </option>,
        ]
      : []),
  ];

  const conditionInputs = (
    condition: ConditionForm,
    onChange: (next: ConditionForm) => void,
    prefix: string,
  ) => (
    <div className="grid grid-cols-2 gap-2">
      {CONDITION_FIELDS.map((field) => (
        <label key={field} className="flex flex-col gap-1 text-xs">
          {localize(`com_mindstone_wf_cond_${field}` as 'com_mindstone_wf_cond_messagePrefix')}
          <input
            className={input}
            value={condition[field]}
            data-testid={`${prefix}-${field}`}
            onChange={(event) => onChange({ ...condition, [field]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );

  if (!loaded) {
    return message ? (
      <div className="flex items-center gap-2" data-testid="ms-workflow-editor-failed">
        <p className="text-sm text-red-600">{visibleText(message)}</p>
        <button type="button" className={secondary} onClick={onCancel}>
          {localize('com_mindstone_cancel')}
        </button>
      </div>
    ) : null;
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border-light p-3"
      data-testid="ms-workflow-editor"
    >
      <h3 className="font-medium">
        {workflowId
          ? localize('com_mindstone_wf_edit_title', { 0: visibleText(workflowId) })
          : localize('com_mindstone_wf_new_title')}
      </h3>
      <p className="text-xs text-text-secondary">{localize('com_mindstone_wf_intro')}</p>
      <p className="text-xs text-text-secondary" data-testid="ms-wf-live-note">
        {localize('com_mindstone_wf_live_note')}
      </p>
      {!workflowId && (
        <label className="flex flex-col gap-1 text-sm">
          {localize('com_mindstone_wf_id')}
          <input
            className={input}
            value={form.id}
            data-testid="ms-wf-id"
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {localize('com_mindstone_wf_name')}
        <input
          className={input}
          value={form.name}
          data-testid="ms-wf-name"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </label>
      <ol className="flex flex-col gap-3">
        {form.steps.map((step, index) => (
          <li
            key={index}
            className="flex flex-col gap-2 rounded border border-border-light p-2"
            data-testid={`ms-wf-step-${index}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={input}
                value={step.id}
                aria-label={localize('com_mindstone_wf_step_id')}
                data-testid={`ms-wf-step-${index}-id`}
                onChange={(event) => setStep(index, { id: event.target.value })}
              />
              <select
                className={input}
                value={step.kind}
                aria-label={localize('com_mindstone_wf_step_kind')}
                data-testid={`ms-wf-step-${index}-kind`}
                onChange={(event) =>
                  setStep(index, { kind: event.target.value as 'route' | 'gate' })
                }
              >
                <option value="route">{localize('com_mindstone_wf_kind_route')}</option>
                <option value="gate">{localize('com_mindstone_wf_kind_gate')}</option>
              </select>
              <button
                type="button"
                className={secondary}
                disabled={index === 0}
                onClick={() => setForm({ ...form, steps: moveItem(form.steps, index, -1) })}
              >
                {localize('com_mindstone_move_up')}
              </button>
              <button
                type="button"
                className={secondary}
                disabled={index === form.steps.length - 1}
                onClick={() => setForm({ ...form, steps: moveItem(form.steps, index, 1) })}
              >
                {localize('com_mindstone_move_down')}
              </button>
              <button
                type="button"
                className={secondary}
                disabled={form.steps.length === 1}
                onClick={() =>
                  setForm({ ...form, steps: form.steps.filter((_, at) => at !== index) })
                }
              >
                {localize('com_mindstone_picker_remove_short')}
              </button>
            </div>
            {step.kind === 'route' ? (
              <>
                <p className="text-xs text-text-secondary">{localize('com_mindstone_wf_when')}</p>
                {conditionInputs(
                  step.when,
                  (when) => setStep(index, { when }),
                  `ms-wf-step-${index}-when`,
                )}
                <label className="flex flex-col gap-1 text-xs">
                  {localize('com_mindstone_wf_route_persona')}
                  <select
                    className={input}
                    value={step.personaId}
                    data-testid={`ms-wf-step-${index}-persona`}
                    onChange={(event) => setStep(index, { personaId: event.target.value })}
                  >
                    <option value="">{localize('com_mindstone_wf_route_persona_none')}</option>
                    {personaOptions(step.personaId)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {localize('com_mindstone_wf_step_skills')}
                  <input
                    className={input}
                    value={step.skills}
                    data-testid={`ms-wf-step-${index}-skills`}
                    onChange={(event) => setStep(index, { skills: event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {localize('com_mindstone_wf_step_kbs')}
                  <input
                    className={input}
                    value={step.knowledgebases}
                    data-testid={`ms-wf-step-${index}-kbs`}
                    onChange={(event) => setStep(index, { knowledgebases: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs">
                  {localize('com_mindstone_wf_gate_type')}
                  <select
                    className={input}
                    value={step.gateType}
                    data-testid={`ms-wf-step-${index}-gate-type`}
                    onChange={(event) =>
                      setStep(index, { gateType: event.target.value as 'condition' | 'persona' })
                    }
                  >
                    <option value="condition">{localize('com_mindstone_wf_gate_condition')}</option>
                    <option value="persona">{localize('com_mindstone_wf_gate_persona')}</option>
                  </select>
                </label>
                {step.gateType === 'persona' ? (
                  <select
                    className={input}
                    value={step.gatePersona}
                    aria-label={localize('com_mindstone_wf_gate_persona')}
                    data-testid={`ms-wf-step-${index}-gate-persona`}
                    onChange={(event) => setStep(index, { gatePersona: event.target.value })}
                  >
                    <option value="">{localize('com_mindstone_wf_route_persona_none')}</option>
                    {personaOptions(step.gatePersona)}
                  </select>
                ) : (
                  conditionInputs(
                    step.gateCondition,
                    (gateCondition) => setStep(index, { gateCondition }),
                    `ms-wf-step-${index}-gate`,
                  )
                )}
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-col gap-1 text-xs">
                    {localize('com_mindstone_wf_attempts')}
                    <select
                      className={input}
                      value={step.attempts}
                      onChange={(event) => setStep(index, { attempts: event.target.value })}
                    >
                      {[...new Set(['1', '2', '3', '4', '5', step.attempts])].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    {localize('com_mindstone_wf_on_fail')}
                    <select
                      className={input}
                      value={step.onFail}
                      onChange={(event) =>
                        setStep(index, { onFail: event.target.value as 'stop' | 'continue' })
                      }
                    >
                      <option value="stop">{localize('com_mindstone_wf_on_fail_stop')}</option>
                      <option value="continue">
                        {localize('com_mindstone_wf_on_fail_continue')}
                      </option>
                    </select>
                  </label>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondary}
          onClick={() =>
            setForm({
              ...form,
              steps: [
                ...form.steps,
                { ...emptyStep(form.steps.length), id: nextStepId(form.steps) },
              ],
            })
          }
        >
          {localize('com_mindstone_wf_add_step')}
        </button>
        <button
          type="button"
          className={primary}
          disabled={busy}
          data-testid="ms-wf-save"
          onClick={() => void save()}
        >
          {localize('com_mindstone_wf_save')}
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={onCancel}>
          {localize('com_mindstone_cancel')}
        </button>
      </div>
      {message && (
        <p role="alert" className="text-sm text-red-600">
          {visibleText(message)}
        </p>
      )}
    </div>
  );
}
