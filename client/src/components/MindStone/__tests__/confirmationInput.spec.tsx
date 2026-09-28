/**
 * The advanced-settings confirmation on the onboarding and settings pages
 * (mindstone-console #18): tolerant of case and whitespace, says why the
 * button is disabled, and sends the normalized phrase.
 */
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MindStoneOnboardingView from '../OnboardingView';
import MindStoneSettingsView from '../SettingsView';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('librechat-data-provider', () => ({
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: jest.fn(),
  },
}));
const mockLocalize = (key: string) => key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
  useAuthContext: () => ({ user: { id: 'u1', role: 'ADMIN' } }),
}));
jest.mock('../RestartGateway', () => () => null);

const RESPONSES: Record<string, unknown> = {
  '/api/mindstone/admin/status': { ok: true, onboarded: false, steps: {}, profiles: [] },
  '/api/mindstone/admin/permissions': { permissions: { advancedSettings: false } },
  '/api/mindstone/admin/models': { presets: [], providers: [], models: [] },
  '/api/mindstone/admin/config': { config: {}, etag: '"abc"' },
};

const VIEWS = [
  ['onboarding', MindStoneOnboardingView],
  ['settings', MindStoneSettingsView],
] as const;

describe.each(VIEWS)('%s view: advanced-settings confirmation', (_name, View) => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation(async (url: string) => RESPONSES[url]);
    mockPost.mockResolvedValue({ ok: true });
  });

  async function setup() {
    render(
      <MemoryRouter>
        <View />
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText('com_mindstone_confirmation');
    const button = screen.getByRole('button', { name: 'com_mindstone_turn_on' });
    return { input, button };
  }

  it('turns off autocapitalize, autocorrect and spellcheck on the input', async () => {
    const { input } = await setup();
    expect(input).toHaveAttribute('autocapitalize', 'none');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  it('shows no hint while the field is empty', async () => {
    const { button } = await setup();
    expect(button).toBeDisabled();
    expect(screen.queryByText('com_mindstone_confirmation_hint')).toBeNull();
  });

  it('explains a wrong phrase and keeps the button disabled', async () => {
    const { input, button } = await setup();
    fireEvent.change(input, { target: { value: 'enable advanced setting' } });
    expect(button).toBeDisabled();
    expect(screen.getByText('com_mindstone_confirmation_hint')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-describedby');
  });

  it.each(['Enable Advanced Settings', 'Enable advanced settings ', 'enable  advanced settings'])(
    'accepts %j and sends the normalized phrase',
    async (typed) => {
      const { input, button } = await setup();
      fireEvent.change(input, { target: { value: typed } });
      expect(screen.queryByText('com_mindstone_confirmation_hint')).toBeNull();
      expect(button).toBeEnabled();
      const loads = mockGet.mock.calls.length;
      fireEvent.click(button);
      expect(mockPost).toHaveBeenCalledWith('/api/mindstone/admin/permissions/advanced', {
        enabled: true,
        confirm: 'enable advanced settings',
      });
      // Let the reload after the grant settle before the test ends.
      await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(loads));
      await act(async () => {});
    },
  );
});
