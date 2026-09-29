/**
 * "Your setup" on Settings (MindStone-Agent #140): each guided-setup choice
 * as saved, and a Change link into just that step, shown only when the step
 * can be opened.
 */
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import YourSetup, { setupChoices } from '../YourSetup';

const mockLocalize = (key: string, values?: Record<string, string>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
}));

const DONE = { done: true, detail: 'done' };
const NOT_DONE = { done: false, detail: 'not done' };
const WORDS = {
  on: 'on',
  off: 'off',
  recall: 'automatic recall',
  none: 'none',
  host: 'set on the gateway host',
};
const CONFIG = {
  routing: { defaultModel: 'ollama/llama3' },
  onboarding: { profile: { id: 'assistant', label: 'Assistant' } },
  memory: {
    vectorStore: 'sqlite-vec',
    embeddingProvider: 'ollama:nomic-embed-text',
    autoRecall: false,
  },
  channels: { telegram: { enabled: true }, slack: { enabled: false }, discord: {} },
};
const ALL_DONE = { provider: DONE, persona: DONE, memory: DONE, connectors: DONE };

describe('setupChoices', () => {
  it('reads each choice from the saved config', () => {
    const byKey = Object.fromEntries(setupChoices(CONFIG, ALL_DONE, WORDS).map((c) => [c.key, c]));
    expect(byKey.model.value).toBe('ollama/llama3');
    expect(byKey.persona.value).toBe('Assistant');
    expect(byKey.memory.value).toBe('ollama:nomic-embed-text; automatic recall off');
    expect(byKey.connectors.value).toBe('discord, telegram');
    expect(Object.values(byKey).map((c) => c.change)).toEqual([
      'provider',
      'model',
      'persona',
      'memory',
      'connectors',
    ]);
  });

  it('reads memory as the gateway does: set on the host, and recall on when unset', () => {
    const byKey = Object.fromEntries(
      setupChoices({ memory: { vectorStore: 'sqlite-vec' } }, ALL_DONE, WORDS).map((c) => [
        c.key,
        c,
      ]),
    );
    expect(byKey.memory.value).toBe('set on the gateway host; automatic recall on');
    const notDone = Object.fromEntries(
      setupChoices({}, { ...ALL_DONE, memory: NOT_DONE }, WORDS).map((c) => [c.key, c]),
    );
    expect(notDone.memory.value).toBeUndefined();
  });

  it('says what is not set, and none for no connector', () => {
    const byKey = Object.fromEntries(setupChoices({}, ALL_DONE, WORDS).map((c) => [c.key, c]));
    expect(byKey.model.value).toBeUndefined();
    expect(byKey.persona.value).toBeUndefined();
    expect(byKey.memory.value).toBe('set on the gateway host; automatic recall on');
    expect(byKey.connectors.value).toBe('none');
  });

  it('offers no change a setup step could not open yet', () => {
    const byKey = Object.fromEntries(
      setupChoices(CONFIG, { provider: DONE, persona: NOT_DONE }, WORDS).map((c) => [c.key, c]),
    );
    expect(byKey.model.change).toBe('model');
    expect(byKey.memory.change).toBeUndefined();
    expect(byKey.connectors.change).toBeUndefined();
  });
});

describe('YourSetup', () => {
  it('links each change to its own step, from Settings', () => {
    render(
      <MemoryRouter>
        <YourSetup config={CONFIG} steps={ALL_DONE} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ms-setup-model-change')).toHaveAttribute(
      'href',
      '/mindstone/onboarding?change=model&from=settings',
    );
    expect(screen.getByTestId('ms-setup-memory-change')).toHaveAttribute(
      'href',
      '/mindstone/onboarding?change=memory&from=settings',
    );
    expect(
      within(screen.getByTestId('ms-setup-model')).getByText('ollama/llama3'),
    ).toBeInTheDocument();
  });

  it('shows a non-printing character in a saved value', () => {
    render(
      <MemoryRouter>
        <YourSetup config={{ routing: { defaultModel: 'ollama/llama3‮' } }} steps={ALL_DONE} />
      </MemoryRouter>,
    );
    expect(
      within(screen.getByTestId('ms-setup-model')).getByText('ollama/llama3\\u{202E}'),
    ).toBeInTheDocument();
  });
});
