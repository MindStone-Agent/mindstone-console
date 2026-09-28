import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SkillsView, { draftBody } from '../SkillsView';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const BASE = '/api/mindstone/admin';
const SKILLS = [
  {
    id: 'weekly-report',
    label: 'Weekly report',
    description: 'Writes the report',
    source: 'installed',
  },
  { id: 'triage', label: 'Triage', description: 'Sorts the inbox', source: 'draft' },
  {
    id: 'integration-builder',
    label: 'Integration Builder',
    description: 'Builds integrations',
    source: 'builtin',
  },
  {
    id: 'broken',
    label: 'broken',
    source: 'draft',
    error: 'skills/drafts/broken/skill.json: bad JSON',
  },
];
const DRAFT = {
  id: 'triage',
  label: 'Triage',
  description: 'Sorts the inbox',
  goal: 'An empty inbox',
  whenToUse: ['when mail piles up'],
  outputs: [],
  safetyNotes: ['never delete mail'],
  source: 'draft',
  skillMarkdown: '# Triage\n\nTRIAGE-SKILL-BODY',
};

function gateway(advanced: boolean, detail: Record<string, unknown> = DRAFT) {
  mockGet.mockImplementation((url: string) => {
    if (url === `${BASE}/skills`) return Promise.resolve({ skills: SKILLS });
    if (url === `${BASE}/permissions`)
      return Promise.resolve({ permissions: { advancedSettings: advanced } });
    if (url.startsWith(`${BASE}/skills/`)) return Promise.resolve({ skill: detail });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderPage() {
  render(
    <MemoryRouter>
      <SkillsView />
    </MemoryRouter>,
  );
}

const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe('MindStone Skill Builder page', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  it('lists installed skills as active, drafts as not active, and the built-ins', async () => {
    gateway(false);
    renderPage();
    const installed = await screen.findByTestId('ms-skill-installed-weekly-report');
    expect(installed).toHaveTextContent('com_mindstone_skill_state_active');
    expect(screen.getByTestId('ms-skill-draft-triage')).toHaveTextContent(
      'com_mindstone_skill_state_draft',
    );
    expect(screen.getByTestId('ms-skill-builtin-integration-builder')).toHaveTextContent(
      'com_mindstone_skill_state_builtin',
    );
    expect(screen.getByText('com_mindstone_skill_installed_list 1')).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_skill_draft_list 2')).toBeInTheDocument();
    // A broken skill shows its error and can't be opened.
    const broken = screen.getByTestId('ms-skill-draft-broken');
    expect(broken).toHaveTextContent('bad JSON');
    expect(within(broken).getByRole('button')).toBeDisabled();
    expect(screen.getByText('com_mindstone_skill_need_advanced')).toBeInTheDocument();
  });

  it('tells a non-admin the page is for admins', async () => {
    mockGet.mockRejectedValue(refusal(403, { message: 'Forbidden' }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('com_mindstone_admin_only');
  });

  it('opens a draft for review with its SKILL.md; Install needs advanced settings', async () => {
    gateway(false);
    renderPage();
    fireEvent.click(within(await screen.findByTestId('ms-skill-draft-triage')).getByRole('button'));
    expect(await screen.findByText(/TRIAGE-SKILL-BODY/)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(`${BASE}/skills/triage?source=draft`);
    expect(screen.getByText('An empty inbox')).toBeInTheDocument();
    expect(screen.getByText('never delete mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_mindstone_skill_install' })).toBeDisabled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('installs a draft, and replaces an installed one only on a second click', async () => {
    gateway(true);
    renderPage();
    fireEvent.click(within(await screen.findByTestId('ms-skill-draft-triage')).getByRole('button'));
    await screen.findByText(/TRIAGE-SKILL-BODY/);
    mockPost.mockRejectedValueOnce(
      refusal(409, {
        error: 'skill "triage" is already installed; send force to replace it',
        code: 'skill_exists',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_install' }));
    expect(await screen.findByRole('status')).toHaveTextContent('already installed');
    expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/skills/triage/install`, {});
    mockPost.mockResolvedValueOnce({ ok: true, skill: { id: 'triage', source: 'installed' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_replace_installed' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('com_mindstone_skill_installed triage'),
    );
    expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/skills/triage/install`, { force: true });
    expect(mockGet).toHaveBeenCalledWith(`${BASE}/skills/triage?source=installed`);
  });

  it('shows the gateway refusal when installing without advanced settings', async () => {
    gateway(true);
    renderPage();
    fireEvent.click(within(await screen.findByTestId('ms-skill-draft-triage')).getByRole('button'));
    await screen.findByText(/TRIAGE-SKILL-BODY/);
    mockPost.mockRejectedValueOnce(
      refusal(403, { error: 'installing a skill needs the advanced-settings permission' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_install' }));
    expect(await screen.findByRole('status')).toHaveTextContent('advanced-settings permission');
    expect(
      screen.queryByRole('button', { name: 'com_mindstone_skill_replace_installed' }),
    ).toBeNull();
  });

  it('discards a draft only after confirming', async () => {
    gateway(true);
    renderPage();
    fireEvent.click(within(await screen.findByTestId('ms-skill-draft-triage')).getByRole('button'));
    await screen.findByText(/TRIAGE-SKILL-BODY/);
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_discard' }));
    expect(mockDelete).not.toHaveBeenCalled();
    mockDelete.mockResolvedValueOnce({ ok: true });
    fireEvent.click(
      screen.getByRole('button', { name: 'com_mindstone_skill_confirm_discard_yes' }),
    );
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(`${BASE}/skills/drafts/triage`));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_skill_discarded triage',
    );
  });

  it('drafts a skill from scratch, then opens the draft for review', async () => {
    gateway(true);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'com_mindstone_skill_new_start' }));
    const type = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
    type('com_mindstone_skill_field_id', 'triage');
    type('com_mindstone_skill_field_label', 'Triage');
    type('com_mindstone_skill_field_description', 'Sorts the inbox');
    type('com_mindstone_skill_field_goal', 'An empty inbox');
    type('com_mindstone_skill_field_when', 'when mail piles up\n\n  on Mondays  ');
    mockPost.mockResolvedValueOnce({ ok: true, skill: { id: 'triage', source: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/skills/drafts`, {
        id: 'triage',
        label: 'Triage',
        description: 'Sorts the inbox',
        goal: 'An empty inbox',
        whenToUse: ['when mail piles up', 'on Mondays'],
      }),
    );
    expect(await screen.findByText(/TRIAGE-SKILL-BODY/)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith(`${BASE}/skills/triage?source=draft`);
  });

  it('drafts from a built-in, and replaces an existing draft only on a second click', async () => {
    gateway(true);
    renderPage();
    const row = await screen.findByTestId('ms-skill-builtin-integration-builder');
    fireEvent.click(within(row).getByRole('button', { name: 'com_mindstone_skill_start_from' }));
    // A built-in brings its own lists and instructions.
    expect(screen.queryByLabelText(/^com_mindstone_skill_field_instructions/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^com_mindstone_skill_field_goal/), {
      target: { value: 'Connect the CRM' },
    });
    mockPost.mockRejectedValueOnce(
      refusal(409, { error: 'Draft already exists; send force to replace it' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Draft already exists');
    expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/skills/drafts`, {
      fromBuiltin: 'integration-builder',
      goal: 'Connect the CRM',
    });
    mockPost.mockResolvedValueOnce({
      ok: true,
      skill: { id: 'integration-builder', source: 'draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_replace_draft' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith(`${BASE}/skills/drafts`, {
        fromBuiltin: 'integration-builder',
        goal: 'Connect the CRM',
        force: true,
      }),
    );
  });
});

describe('draftBody', () => {
  const empty = {
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

  it('sends only what was filled in, trimmed', () => {
    expect(
      draftBody({ ...empty, id: ' a ', label: 'L', description: 'D', goal: '   ' }, false),
    ).toEqual({
      id: 'a',
      label: 'L',
      description: 'D',
    });
  });

  it('keeps instructions as written and splits lists by line', () => {
    expect(
      draftBody(
        {
          ...empty,
          id: 'a',
          outputs: 'one\n two \n',
          instructions: '  # Keep\n',
          safetyNotes: '\n',
        },
        true,
      ),
    ).toEqual({ id: 'a', outputs: ['one', 'two'], instructions: '  # Keep\n', force: true });
  });

  it('never sends lists or instructions with a built-in', () => {
    expect(
      draftBody(
        { ...empty, fromBuiltin: 'integration-builder', outputs: 'x', instructions: 'y' },
        false,
      ),
    ).toEqual({ fromBuiltin: 'integration-builder' });
  });
});
