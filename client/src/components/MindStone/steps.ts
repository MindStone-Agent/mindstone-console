/**
 * Which guided-setup steps can be opened directly (onboarding ?step=, and the
 * settings checklist's links to it), and the GET /admin/status `steps` that
 * must be done first (MindStone-Agent #102). One list, so a link is only
 * shown where the setup page will actually open it.
 */
export type StatusSteps = Record<string, { done: boolean; detail: string }>;

const LINKABLE = {
  memory: ['provider', 'persona'],
  connectors: ['provider', 'persona', 'memory'],
  about: ['provider', 'persona', 'memory'],
} as const;

export type LinkableStep = keyof typeof LINKABLE;

/** The setup step to open, if it is one a link can open and the steps before it are done. */
export function linkableStep(
  step: string | null | undefined,
  steps: StatusSteps | undefined,
): LinkableStep | undefined {
  if (!step || !Object.hasOwn(LINKABLE, step)) return undefined;
  const wanted = step as LinkableStep;
  return LINKABLE[wanted].every((name) => steps?.[name]?.done === true) ? wanted : undefined;
}
