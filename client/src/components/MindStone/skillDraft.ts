/**
 * The Skill Builder's draft form (MindStone-Agent #104), shared by the Skills
 * page and the persona editor's skill picker (MindStone-Agent #125): what the
 * form holds, and the POST /admin/skills/drafts body it becomes.
 */
export type SkillDraftFields = {
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

export const EMPTY_SKILL_DRAFT: SkillDraftFields = {
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

/** One entry per non-empty line. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The draft request: only what was filled in, so a built-in keeps what isn't overridden. */
export function draftBody(form: SkillDraftFields, force: boolean): Record<string, unknown> {
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
