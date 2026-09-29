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

/**
 * The setup choices Settings can change one at a time (MindStone-Agent #140):
 * onboarding ?change=<step> opens just that step, once the steps it needs are
 * done. About you isn't one: it only seeds USER.md on the first setup, so
 * Settings edits USER.md itself.
 */
const CHANGEABLE = {
  provider: [],
  model: ['provider'],
  persona: ['provider'],
  memory: ['provider', 'persona'],
  connectors: ['provider', 'persona', 'memory'],
} as const;

export type ChangeableStep = keyof typeof CHANGEABLE;

/** The step ?change= may open, if it is one and the steps it needs are done. */
export function changeableStep(
  step: string | null | undefined,
  steps: StatusSteps | undefined,
): ChangeableStep | undefined {
  if (!step || !Object.hasOwn(CHANGEABLE, step)) return undefined;
  const wanted = step as ChangeableStep;
  return CHANGEABLE[wanted].every((name) => steps?.[name]?.done === true) ? wanted : undefined;
}

/** Where a change goes back to (?from=): only these pages, never a path from the query. */
const RETURN_PAGES = {
  settings: { path: '/mindstone', label: 'com_mindstone_onb_change_back_settings' },
  providers: { path: '/mindstone/providers', label: 'com_mindstone_onb_change_back_providers' },
} as const;

export type ReturnPage = (typeof RETURN_PAGES)[keyof typeof RETURN_PAGES];

export function returnPage(from: string | null | undefined): ReturnPage {
  return from && Object.hasOwn(RETURN_PAGES, from)
    ? RETURN_PAGES[from as keyof typeof RETURN_PAGES]
    : RETURN_PAGES.settings;
}
