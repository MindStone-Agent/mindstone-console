/**
 * The persona builder's form state and the request bodies built from it
 * (MindStone-Agent #125). The gateway checks everything again; these only
 * shape what the editor sends: trimmed text, id lists without repeats, and
 * no empty condition (an empty one would match every turn, so the gateway
 * refuses it).
 */

export type PersonaForm = {
  id: string;
  name: string;
  description: string;
  personaMarkdown: string;
  skills: string[];
  workflows: string[];
  knowledgebases: string[];
};

export const EMPTY_PERSONA: PersonaForm = {
  id: '',
  name: '',
  description: '',
  personaMarkdown: '',
  skills: [],
  workflows: [],
  knowledgebases: [],
};

/** The persona as the gateway returns it (GET /admin/personas/<id>). */
export type LoadedPersona = {
  id: string;
  name: string;
  description?: string;
  personaMarkdown: string;
  skills: string[];
  workflows: string[];
  knowledgebases: string[];
  privateKnowledgebases: KnowledgebaseSummary[];
  active: boolean;
};

export type KnowledgebaseSummary = {
  id: string;
  name: string;
  description?: string;
  indexed: boolean;
  entryCount: number;
  sourceCount: number;
  error?: string;
  /** Being embedded again after a change of embedding model, or given up on (MindStone-Agent #158). */
  reembed?: { failures: number; nextAttemptAt?: string; gaveUp?: boolean; reason?: string };
};

export function formFromPersona(persona: LoadedPersona): PersonaForm {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description ?? '',
    personaMarkdown: persona.personaMarkdown,
    skills: [...persona.skills],
    workflows: [...persona.workflows],
    knowledgebases: [...persona.knowledgebases],
  };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * POST /admin/personas (create) or PATCH /admin/personas/<id> (edit).
 * - An edit sends every list, so the persona holds exactly what the page
 *   shows; an empty list clears it (then all skills, all global collections).
 * - An edit sends a text field only when it changed from `original`, so a
 *   persona whose text the gateway wouldn't accept today (a pack persona over
 *   a limit) can still have its components changed. A description emptied
 *   is sent as "", which clears it.
 */
export function personaBody(
  form: PersonaForm,
  mode: 'create' | 'edit',
  original?: PersonaForm,
): Record<string, unknown> {
  const lists = {
    skills: unique(form.skills),
    workflows: unique(form.workflows),
    knowledgebases: unique(form.knowledgebases),
  };
  const name = form.name.trim();
  const description = form.description.trim();
  if (mode === 'create') {
    return {
      id: form.id.trim(),
      name,
      ...(description ? { description } : {}),
      personaMarkdown: form.personaMarkdown,
      ...lists,
    };
  }
  return {
    ...(!original || name !== original.name.trim() ? { name } : {}),
    ...(!original || description !== original.description.trim() ? { description } : {}),
    ...(!original || form.personaMarkdown !== original.personaMarkdown
      ? { personaMarkdown: form.personaMarkdown }
      : {}),
    ...lists,
  };
}

/** Move one entry up (-1) or down (+1); the order of a persona's workflows is the order they're tried. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function toggleId(list: string[], id: string, on: boolean): string[] {
  if (!on) return list.filter((entry) => entry !== id);
  return list.includes(id) ? list : [...list, id];
}

export type ConditionForm = {
  messagePrefix: string;
  sourceChannel: string;
  sourceSubstrate: string;
  sessionKeyPrefix: string;
};

export const EMPTY_CONDITION: ConditionForm = {
  messagePrefix: '',
  sourceChannel: '',
  sourceSubstrate: '',
  sessionKeyPrefix: '',
};

export type WorkflowStepForm = {
  id: string;
  kind: 'route' | 'gate';
  when: ConditionForm;
  personaId: string;
  skills: string;
  knowledgebases: string;
  gateType: 'condition' | 'persona';
  gatePersona: string;
  gateCondition: ConditionForm;
  attempts: string;
  onFail: 'stop' | 'continue';
};

export function emptyStep(index: number, kind: 'route' | 'gate' = 'route'): WorkflowStepForm {
  return {
    id: `step-${index + 1}`,
    kind,
    when: { ...EMPTY_CONDITION },
    personaId: '',
    skills: '',
    knowledgebases: '',
    gateType: 'condition',
    gatePersona: '',
    gateCondition: { ...EMPTY_CONDITION },
    attempts: '1',
    onFail: 'stop',
  };
}

export type WorkflowForm = {
  id: string;
  name: string;
  description: string;
  /** Kept as read, so a save doesn't drop it (the page doesn't edit it). */
  version?: string;
  steps: WorkflowStepForm[];
};

/** A condition's filled-in fields; undefined when none is filled in. */
export function conditionBody(condition: ConditionForm): Record<string, string> | undefined {
  const entries = Object.entries(condition)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value.length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Ids from a comma- or space-separated field, without repeats. */
export function idList(text: string): string[] {
  return unique(
    text
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** One step as the gateway takes it: only the fields its kind allows. */
export function stepBody(step: WorkflowStepForm): Record<string, unknown> {
  if (step.kind === 'route') {
    const when = conditionBody(step.when);
    const skills = idList(step.skills);
    const knowledgebases = idList(step.knowledgebases);
    return {
      id: step.id.trim(),
      kind: 'route',
      ...(when ? { when } : {}),
      ...(step.personaId ? { personaId: step.personaId } : {}),
      ...(skills.length ? { skills } : {}),
      ...(knowledgebases.length ? { knowledgebases } : {}),
    };
  }
  const attempts = Number(step.attempts);
  const condition = conditionBody(step.gateCondition);
  return {
    id: step.id.trim(),
    kind: 'gate',
    // An empty condition is sent as {}, so the gateway says why it's refused.
    gate:
      step.gateType === 'persona'
        ? { personaLoadable: step.gatePersona }
        : { condition: condition ?? {} },
    ...(Number.isInteger(attempts) && attempts > 1 ? { retry: { maxAttempts: attempts } } : {}),
    onFail: step.onFail,
  };
}

/** POST /admin/workflows (with the id) or PATCH /admin/workflows/<id> (without). */
export function workflowBody(form: WorkflowForm, mode: 'create' | 'edit'): Record<string, unknown> {
  const name = form.name.trim();
  const description = form.description.trim();
  return {
    ...(mode === 'create' ? { id: form.id.trim() } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(form.version ? { version: form.version } : {}),
    steps: form.steps.map(stepBody),
  };
}

/** A workflow's steps back into the form (GET /admin/workflows/<id>). */
export function stepForm(step: Record<string, unknown>, index: number): WorkflowStepForm {
  const base = emptyStep(index, step.kind === 'gate' ? 'gate' : 'route');
  const condition = (value: unknown): ConditionForm => ({
    ...EMPTY_CONDITION,
    ...(value && typeof value === 'object' ? (value as Partial<ConditionForm>) : {}),
  });
  const gate = (step.gate ?? {}) as { personaLoadable?: string; condition?: unknown };
  return {
    ...base,
    id: typeof step.id === 'string' ? step.id : base.id,
    when: condition(step.when),
    personaId: typeof step.personaId === 'string' ? step.personaId : '',
    skills: Array.isArray(step.skills) ? step.skills.join(', ') : '',
    knowledgebases: Array.isArray(step.knowledgebases) ? step.knowledgebases.join(', ') : '',
    gateType: gate.personaLoadable ? 'persona' : 'condition',
    gatePersona: gate.personaLoadable ?? '',
    gateCondition: condition(gate.condition),
    attempts: String((step.retry as { maxAttempts?: number } | undefined)?.maxAttempts ?? 1),
    onFail: step.onFail === 'continue' ? 'continue' : 'stop',
  };
}

/** The first `step-N` id no step has, so an added step never repeats one. */
export function nextStepId(steps: WorkflowStepForm[]): string {
  const taken = new Set(steps.map((step) => step.id.trim()));
  let n = steps.length + 1;
  while (taken.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}
