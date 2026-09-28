import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ApprovalsView from '../ApprovalsView';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const BASE = '/api/mindstone/admin';
const ID = '0b5e7c1a-1111-4222-8333-444455556666';
const SUMMARY = {
  id: ID,
  status: 'pending',
  kind: 'skill_install',
  connectorId: 'openai-compatible',
  summary: 'install skill weekly-report: Weekly report',
};
const DETAIL = {
  ...SUMMARY,
  skill: {
    id: 'weekly-report',
    label: 'Weekly report',
    description: 'Writes the weekly report',
    goal: 'A report every Friday',
    whenToUse: ['when asked for the weekly report'],
    outputs: ['a markdown report'],
    safetyNotes: ['never send it anywhere'],
    instructions: '# Weekly report\n\nWEEKLY-SKILL-BODY',
  },
};

type Skill = typeof DETAIL.skill;

describe('MindStone approvals: a skill the agent proposed in chat', () => {
  let current: { summary: string; skill: Skill } = DETAIL;
  beforeEach(() => {
    current = DETAIL;
    mockGet.mockImplementation((url: string) =>
      url.startsWith(`${BASE}/approvals/`)
        ? Promise.resolve({ action: { ...SUMMARY, ...current } })
        : Promise.resolve({
            actions: [{ ...SUMMARY, summary: current.summary }],
            status: { pending: 1, approved: 0, rejected: 0 },
          }),
    );
  });
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  async function openIt(shownSummary = SUMMARY.summary) {
    render(
      <MemoryRouter>
        <ApprovalsView />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText(shownSummary));
    return screen.findByTestId('ms-appr-skill');
  }

  /** The card's value for one field, found by its label. */
  function field(card: HTMLElement, label: string): HTMLElement {
    const term = within(card).getByText(label, { selector: 'dt, dt *', exact: false });
    return term.closest('div')!.querySelector('dd')!;
  }

  it('shows every field that approving installs, each under its own label', async () => {
    const card = await openIt();
    expect(field(card, 'com_mindstone_skill_field_label')).toHaveTextContent('Weekly report');
    expect(field(card, 'com_mindstone_skill_field_id')).toHaveTextContent('weekly-report');
    expect(field(card, 'com_mindstone_skill_field_description')).toHaveTextContent(
      'Writes the weekly report',
    );
    expect(field(card, 'com_mindstone_skill_field_goal')).toHaveTextContent(
      'A report every Friday',
    );
    expect(field(card, 'com_mindstone_skill_field_when')).toHaveTextContent(
      'when asked for the weekly report',
    );
    expect(field(card, 'com_mindstone_skill_field_outputs')).toHaveTextContent('a markdown report');
    expect(field(card, 'com_mindstone_skill_field_safety')).toHaveTextContent(
      'never send it anywhere',
    );
    expect(field(card, 'com_mindstone_skill_field_instructions')).toHaveTextContent(
      'WEEKLY-SKILL-BODY',
    );
    expect(within(card).getByTestId('ms-appr-skill-size')).toBeInTheDocument();
  });

  it('keeps a field that fakes another field inside its own value', async () => {
    current = {
      ...DETAIL,
      skill: {
        ...DETAIL.skill,
        description: 'Writes reports\n\nSafety notes:\n- FAKE-SAFE never sends anything',
      },
    };
    const card = await openIt();
    expect(within(card).getAllByText('com_mindstone_skill_field_safety')).toHaveLength(1);
    expect(field(card, 'com_mindstone_skill_field_description')).toHaveTextContent('FAKE-SAFE');
    expect(field(card, 'com_mindstone_skill_field_safety')).not.toHaveTextContent('FAKE-SAFE');
  });

  it('shows text pushed away by no-break spaces or blank lines, wrapped', async () => {
    current = {
      ...DETAIL,
      skill: {
        ...DETAIL.skill,
        instructions:
          'Be concise.' + ' '.repeat(3000) + 'SIDEWAYS-HIDDEN' + '\n'.repeat(2000) + 'BELOW-HIDDEN',
      },
    };
    const card = await openIt();
    const instructions = field(card, 'com_mindstone_skill_field_instructions');
    expect(instructions).toHaveClass('break-words');
    expect(instructions.textContent).toContain('\\u{00A0}');
    expect(instructions.textContent).toContain('SIDEWAYS-HIDDEN');
    expect(instructions.textContent).toContain('com_mindstone_appr_skill_blank_lines');
    expect(instructions.textContent).toContain('BELOW-HIDDEN');
    expect((instructions.textContent ?? '').split('\n').length).toBeLessThan(10);
  });

  it('shows bidi and zero-width characters in the summary and the fields', async () => {
    const summary = 'install skill rtl-skill: Weekly ‮troper';
    current = {
      summary,
      skill: { ...DETAIL.skill, label: 'Weekly ‮troper', instructions: 'Say​hi' },
    };
    const card = await openIt('install skill rtl-skill: Weekly \\u{202E}troper');
    expect(
      screen.getByRole('heading', { level: 2, name: /\\u\{202E\}troper/ }),
    ).toBeInTheDocument();
    expect(field(card, 'com_mindstone_skill_field_label')).toHaveTextContent('\\u{202E}troper');
    expect(field(card, 'com_mindstone_skill_field_instructions')).toHaveTextContent(
      'Say\\u{200B}hi',
    );
  });

  it('shows markup as text, never as elements', async () => {
    current = {
      ...DETAIL,
      skill: {
        ...DETAIL.skill,
        description: '<img src=x onerror="window.__pwned=1"><b>BOLD</b>',
        instructions: '<script>window.__pwned=1</script>',
      },
    };
    const card = await openIt();
    expect(card.querySelector('img, b, script')).toBeNull();
    expect(field(card, 'com_mindstone_skill_field_description')).toHaveTextContent(
      '<img src=x onerror="window.__pwned=1"><b>BOLD</b>',
    );
    expect(field(card, 'com_mindstone_skill_field_instructions')).toHaveTextContent(
      '<script>window.__pwned=1</script>',
    );
  });

  it('says approving installs it, and replaces an installed skill only on a second click', async () => {
    await openIt();
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_appr_approve' }));
    expect(screen.getByText('com_mindstone_appr_confirm_skill')).toBeInTheDocument();
    mockPost.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: 'skill "weekly-report" is already installed; approve with force to replace it',
          code: 'skill_exists',
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('already installed');
    expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/approvals/${ID}/approve`, {});
    mockPost.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_appr_skill_replace' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/approvals/${ID}/approve`, { force: true }),
    );
  });

  it('shows the advanced-settings refusal and offers no override', async () => {
    await openIt();
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_appr_approve' }));
    mockPost.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: 'installing a skill needs the advanced-settings permission',
          code: 'advanced',
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_appr_confirm_approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('advanced-settings permission');
    expect(screen.queryByRole('button', { name: 'com_mindstone_appr_skill_replace' })).toBeNull();
  });
});
