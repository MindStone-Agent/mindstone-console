/**
 * "Your setup" on Settings (MindStone-Agent #140): each choice guided setup
 * makes, as it is saved now, with a link that changes just that one
 * (onboarding ?change=<step>&from=settings: the same controls and requests as
 * setup). Values come from the config Settings already reads; they are shown
 * as text, with any non-printing character visible.
 */
import { Link } from 'react-router-dom';
import type { ChangeableStep, StatusSteps } from './steps';
import type { TranslationKeys } from '~/hooks';
import { visibleText } from './visibleText';
import { changeableStep } from './steps';
import { useLocalize } from '~/hooks';

export type SetupChoice = {
  key: string;
  label: TranslationKeys;
  /** What is saved, as text; undefined when nothing is. */
  value?: string;
  /** The setup step that changes it, when that step can be opened now. */
  change?: ChangeableStep;
  /** Another page that manages it. */
  manage?: { to: string; label: TranslationKeys };
};

type Config = Record<string, unknown>;

function section(config: Config | null, name: string): Record<string, unknown> {
  const value = config?.[name];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The setup choices, from the saved config and the status checklist. */
export function setupChoices(
  config: Config | null,
  steps: StatusSteps | undefined,
  words: { on: string; off: string; recall: string; none: string; host: string },
): SetupChoice[] {
  const routing = section(config, 'routing');
  const onboarding = section(config, 'onboarding');
  const memory = section(config, 'memory');
  const channels = section(config, 'channels');
  const profile = (onboarding.profile ?? {}) as Record<string, unknown>;
  // Set in the config, or on the gateway host (MINDSTONE_EMBEDDING_PROVIDER) when the memory step is done.
  const embedding =
    text(memory.embeddingProvider) ?? (steps?.memory?.done ? words.host : undefined);
  // The gateway treats an unset autoRecall as on.
  const recall = `${words.recall} ${memory.autoRecall === false ? words.off : words.on}`;
  // As the gateway runs them: a connector section is on unless it says enabled: false.
  const connectors = Object.entries(channels)
    .filter(
      ([, value]) =>
        value && typeof value === 'object' && (value as { enabled?: unknown }).enabled !== false,
    )
    .map(([name]) => name)
    .sort();
  return [
    {
      key: 'provider',
      label: 'com_mindstone_ys_provider',
      change: changeableStep('provider', steps),
      manage: { to: '/mindstone/providers', label: 'com_mindstone_prov_title' },
    },
    {
      key: 'model',
      label: 'com_mindstone_ys_model',
      value: text(routing.defaultModel),
      change: changeableStep('model', steps),
    },
    {
      key: 'persona',
      label: 'com_mindstone_ys_persona',
      value: text(profile.label) ?? text(profile.id),
      change: changeableStep('persona', steps),
    },
    {
      key: 'memory',
      label: 'com_mindstone_ys_memory',
      value: embedding ? `${embedding}; ${recall}` : undefined,
      change: changeableStep('memory', steps),
    },
    {
      key: 'connectors',
      label: 'com_mindstone_ys_connectors',
      value: connectors.length ? connectors.join(', ') : words.none,
      change: changeableStep('connectors', steps),
    },
  ];
}

export default function YourSetup({
  config,
  steps,
}: {
  config: Config | null;
  steps: StatusSteps | undefined;
}) {
  const localize = useLocalize();
  const choices = setupChoices(config, steps, {
    on: localize('com_mindstone_ys_on'),
    off: localize('com_mindstone_ys_off'),
    recall: localize('com_mindstone_ys_recall'),
    none: localize('com_mindstone_ys_none'),
    host: localize('com_mindstone_ys_host'),
  });
  return (
    <section
      className="rounded-xl border border-border-medium bg-surface-primary p-4"
      aria-labelledby="ms-your-setup"
    >
      <h2 id="ms-your-setup" className="mb-1 text-lg font-medium">
        {localize('com_mindstone_ys_title')}
      </h2>
      <p className="mb-2 text-sm text-text-secondary">{localize('com_mindstone_ys_hint')}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {choices.map((choice) => (
          <div key={choice.key} className="contents" data-testid={`ms-setup-${choice.key}`}>
            <dt className="font-medium">{localize(choice.label)}</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {choice.value !== undefined ? (
                <span className="break-all font-mono">{visibleText(choice.value)}</span>
              ) : (
                choice.key !== 'provider' && (
                  <span className="text-text-secondary">
                    {localize('com_mindstone_ys_not_set')}
                  </span>
                )
              )}
              {choice.manage && (
                <Link to={choice.manage.to} className="underline">
                  {localize(choice.manage.label)}
                </Link>
              )}
              {choice.change && (
                <Link
                  to={`/mindstone/onboarding?change=${choice.change}&from=settings`}
                  className="underline"
                  data-testid={`ms-setup-${choice.key}-change`}
                  aria-label={
                    choice.key === 'provider'
                      ? localize('com_mindstone_ys_add_local')
                      : localize('com_mindstone_ys_change_named', { 0: localize(choice.label) })
                  }
                >
                  {localize(
                    choice.key === 'provider'
                      ? 'com_mindstone_ys_add_local'
                      : 'com_mindstone_ys_change',
                  )}
                </Link>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
