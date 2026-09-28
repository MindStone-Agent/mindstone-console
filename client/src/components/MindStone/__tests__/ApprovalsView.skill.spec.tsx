import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('MindStone approvals: a skill the agent proposed in chat', () => {
  beforeEach(() => {
    mockGet.mockImplementation((url: string) =>
      url.startsWith(`${BASE}/approvals/`)
        ? Promise.resolve({ action: DETAIL })
        : Promise.resolve({ actions: [SUMMARY], status: { pending: 1, approved: 0, rejected: 0 } }),
    );
  });
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  async function openIt() {
    render(
      <MemoryRouter>
        <ApprovalsView />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText(SUMMARY.summary));
    return screen.findByText(/WEEKLY-SKILL-BODY/);
  }

  it('shows every field that approving installs', async () => {
    const pre = await openIt();
    for (const text of [
      'Weekly report (weekly-report)',
      'Writes the weekly report',
      'Goal: A report every Friday',
      '- when asked for the weekly report',
      '- a markdown report',
      '- never send it anywhere',
    ]) {
      expect(pre).toHaveTextContent(text);
    }
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
