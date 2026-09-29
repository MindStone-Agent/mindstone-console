import {
  EMPTY_CONDITION,
  conditionBody,
  emptyStep,
  idList,
  moveItem,
  nextStepId,
  personaBody,
  stepBody,
  stepForm,
  toggleId,
  workflowBody,
} from '../personaForms';

describe('persona builder forms (MindStone-Agent #125)', () => {
  const form = {
    id: ' analyst ',
    name: ' Analyst ',
    description: '  ',
    personaMarkdown: '# Analyst\n',
    skills: ['a', 'a', 'b'],
    workflows: ['wf-1'],
    knowledgebases: [],
  };

  it('a create sends the id, trimmed text and lists without repeats, and no empty description', () => {
    expect(personaBody(form, 'create')).toEqual({
      id: 'analyst',
      name: 'Analyst',
      personaMarkdown: '# Analyst\n',
      skills: ['a', 'b'],
      workflows: ['wf-1'],
      knowledgebases: [],
    });
  });

  it('an edit never sends the id, and sends every list so the persona holds exactly what is shown', () => {
    const body = personaBody({ ...form, description: 'One line' }, 'edit');
    expect(body).not.toHaveProperty('id');
    expect(body).toMatchObject({ description: 'One line', knowledgebases: [] });
  });

  it('a route step sends only its own fields, and no empty condition', () => {
    const step = {
      ...emptyStep(0),
      id: ' s1 ',
      personaId: 'analyst',
      skills: 'a, b  a',
      knowledgebases: '',
    };
    expect(stepBody(step)).toEqual({
      id: 's1',
      kind: 'route',
      personaId: 'analyst',
      skills: ['a', 'b'],
    });
    const when = { ...EMPTY_CONDITION, messagePrefix: ' sec: ' };
    expect(stepBody({ ...step, when })).toMatchObject({ when: { messagePrefix: 'sec:' } });
  });

  it('a gate step sends one kind of gate, attempts over 1 and its onFail', () => {
    const gate = {
      ...emptyStep(1, 'gate'),
      gateCondition: { ...EMPTY_CONDITION, sourceChannel: 'api' },
      attempts: '3',
    };
    expect(stepBody(gate)).toEqual({
      id: 'step-2',
      kind: 'gate',
      gate: { condition: { sourceChannel: 'api' } },
      retry: { maxAttempts: 3 },
      onFail: 'stop',
    });
    expect(
      stepBody({ ...gate, gateType: 'persona', gatePersona: 'analyst', attempts: '1' }),
    ).toEqual({
      id: 'step-2',
      kind: 'gate',
      gate: { personaLoadable: 'analyst' },
      onFail: 'stop',
    });
  });

  it('an empty gate condition is sent as {}, so the gateway says why it is refused', () => {
    expect(stepBody(emptyStep(0, 'gate')).gate).toEqual({ condition: {} });
  });

  it('a workflow read from the gateway comes back as the same body', () => {
    const steps = [
      {
        id: 'g',
        kind: 'gate',
        gate: { condition: { messagePrefix: 'go' } },
        retry: { maxAttempts: 2 },
        onFail: 'continue',
      },
      {
        id: 'r',
        kind: 'route',
        when: { sourceChannel: 'api' },
        personaId: 'analyst',
        skills: ['a'],
        knowledgebases: ['kb'],
      },
    ];
    const body = workflowBody(
      { id: 'wf', name: 'WF', description: '', steps: steps.map(stepForm) },
      'edit',
    );
    expect(body).toEqual({ name: 'WF', steps });
  });

  it('an edit sends only the text fields that changed, and an emptied description as ""', () => {
    const original = { ...form, description: 'Old' };
    expect(personaBody({ ...original, description: '' }, 'edit', original)).toEqual({
      description: '',
      skills: ['a', 'b'],
      workflows: ['wf-1'],
      knowledgebases: [],
    });
    expect(personaBody(original, 'edit', original)).not.toHaveProperty('name');
  });

  it('keeps a workflow version, and never repeats a step id', () => {
    expect(
      workflowBody(
        { id: 'wf', name: '', description: '', version: '3', steps: [emptyStep(0)] },
        'edit',
      ),
    ).toMatchObject({ version: '3' });
    expect(nextStepId([{ ...emptyStep(0), id: 'step-2' }])).toBe('step-3');
    expect(nextStepId([emptyStep(0), emptyStep(1)])).toBe('step-3');
  });

  it('small helpers', () => {
    expect(conditionBody(EMPTY_CONDITION)).toBeUndefined();
    expect(idList(' a,b c ,, a ')).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(toggleId(['a'], 'a', true)).toEqual(['a']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});
