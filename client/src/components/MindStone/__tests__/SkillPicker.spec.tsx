/**
 * The persona editor's skill picker (MindStone-Agent #125): it lists and hands
 * back installed skill ids only. A skill made here goes through the Skill
 * Builder's draft and install, and joins the list only once installed.
 */
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PickerSkill } from '../SkillPicker';
import SkillPicker, { withSkill } from '../SkillPicker';

const mockPost = jest.fn();
jest.mock('librechat-data-provider', () => ({
  request: { post: (...args: unknown[]) => mockPost(...args) },
}));
jest.mock('~/hooks', () => {
  // One function, as the real hook keeps it.
  const localize = (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key;
  return { useLocalize: () => localize };
});

const BASE = '/api/mindstone/admin';
const SKILLS: PickerSkill[] = [
  { id: 'weekly-report', label: 'Weekly report', source: 'installed' },
  { id: 'triage', label: 'Triage ‮evil', source: 'installed' },
  { id: 'draft-only', label: 'Draft only', source: 'draft' },
  { id: 'integration-builder', label: 'Integration Builder', source: 'builtin' },
  { id: 'broken', label: 'broken', source: 'installed', error: 'bad JSON' },
];

let skills: PickerSkill[];
const onChange = jest.fn();
const onSkillsChanged = jest.fn();

/** The editor around the picker: it holds the list, as the persona editor will. */
function Editor({ initial, advanced }: { initial: string[]; advanced: boolean }) {
  const [selected, setSelected] = useState(initial);
  const [list, setList] = useState(skills);
  return (
    <SkillPicker
      skills={list}
      selected={selected}
      advanced={advanced}
      onChange={(ids) => {
        onChange(ids);
        setSelected(ids);
      }}
      onSkillsChanged={async () => {
        await onSkillsChanged();
        setList(skills);
      }}
    />
  );
}

function fillNewSkill(id: string) {
  fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_picker_create' }));
  fireEvent.change(screen.getByLabelText(/^com_mindstone_skill_field_id/), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText(/^com_mindstone_skill_field_label/), {
    target: { value: 'New one' },
  });
  fireEvent.change(screen.getByLabelText(/^com_mindstone_skill_field_description/), {
    target: { value: 'Does a thing' },
  });
  fireEvent.change(screen.getByLabelText(/^com_mindstone_skill_field_instructions/), {
    target: { value: '# New one' },
  });
}

beforeEach(() => {
  mockPost.mockReset();
  onChange.mockReset();
  onSkillsChanged.mockReset();
  skills = [...SKILLS];
});

describe('withSkill', () => {
  it('adds an id once, at the end', () => {
    expect(withSkill(['a'], 'b')).toEqual(['a', 'b']);
    expect(withSkill(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });
});

describe('SkillPicker', () => {
  it('says only that nothing is selected when the list is empty', () => {
    render(<Editor initial={[]} advanced />);
    expect(screen.getByText('com_mindstone_picker_none')).toBeInTheDocument();
  });

  it("shows the persona's skills with hidden characters visible, and flags one that isn't installed", () => {
    render(<Editor initial={['triage', 'gone-away']} advanced />);
    expect(screen.getByTestId('ms-skill-picker-selected-triage')).toHaveTextContent(
      'Triage \\u{202E}evil',
    );
    const gone = screen.getByTestId('ms-skill-picker-selected-gone-away');
    expect(within(gone).getByText('com_mindstone_picker_not_installed')).toBeInTheDocument();
  });

  it('offers only installed, working skills that are not listed yet, and adds the one chosen', () => {
    render(<Editor initial={['weekly-report']} advanced />);
    const select = screen.getByRole('combobox', { name: 'com_mindstone_picker_choose' });
    const values = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    expect(values).toEqual(['triage']);
    fireEvent.change(select, { target: { value: 'triage' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_picker_add' }));
    expect(onChange).toHaveBeenLastCalledWith(['weekly-report', 'triage']);
  });

  it('removes a skill from the list', () => {
    render(<Editor initial={['weekly-report', 'triage']} advanced />);
    fireEvent.click(
      screen.getByRole('button', { name: 'com_mindstone_picker_remove weekly-report' }),
    );
    expect(onChange).toHaveBeenLastCalledWith(['triage']);
  });

  it('with advanced settings: drafts through the Skill Builder, installs, then adds it', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/skills/drafts`) return { skill: { id: 'new-one' } };
      if (url === `${BASE}/skills/new-one/install`) {
        skills = [...skills, { id: 'new-one', label: 'New one', source: 'installed' }];
        return { ok: true };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    render(<Editor initial={['weekly-report']} advanced />);
    fillNewSkill('new-one');
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(['weekly-report', 'new-one']));
    expect(mockPost.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/skills/drafts`,
      `${BASE}/skills/new-one/install`,
    ]);
    // The Skill Builder's own request body.
    expect(mockPost.mock.calls[0][1]).toEqual({
      id: 'new-one',
      label: 'New one',
      description: 'Does a thing',
      instructions: '# New one',
    });
    expect(onSkillsChanged).toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'com_mindstone_picker_installed new-one',
    );
    expect(screen.getByTestId('ms-skill-picker-selected-new-one')).toHaveTextContent('New one');
  });

  it('without advanced settings: drafts only, and the draft waits here, never handed back', async () => {
    mockPost.mockResolvedValue({ skill: { id: 'new-one' } });
    render(<Editor initial={[]} advanced={false} />);
    fillNewSkill('new-one');
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    const pending = await screen.findByTestId('ms-skill-picker-pending-new-one');
    expect(pending).toHaveTextContent('com_mindstone_picker_pending_advanced');
    expect(
      within(pending).getByRole('button', { name: 'com_mindstone_skill_install' }),
    ).toBeDisabled();
    expect(mockPost.mock.calls.map(([url]) => url)).toEqual([`${BASE}/skills/drafts`]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('com_mindstone_picker_none')).toBeInTheDocument();
  });

  it('an install the gateway refuses leaves the skill pending, with its reason, and the list unchanged', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `${BASE}/skills/drafts`) return { skill: { id: 'new-one' } };
      throw {
        response: {
          status: 403,
          data: { error: 'installing a skill needs the advanced-settings permission' },
        },
      };
    });
    render(<Editor initial={['weekly-report']} advanced />);
    fillNewSkill('new-one');
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'needs the advanced-settings permission',
    );
    expect(screen.getByTestId('ms-skill-picker-pending-new-one')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replaces an existing draft only on a second, explicit click', async () => {
    mockPost
      .mockRejectedValueOnce({
        response: { status: 409, data: { error: 'a draft with that id exists' } },
      })
      .mockResolvedValueOnce({ skill: { id: 'new-one' } });
    render(<Editor initial={[]} advanced={false} />);
    fillNewSkill('new-one');
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_skill_create_draft' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'com_mindstone_skill_replace_draft' }),
    );
    await screen.findByTestId('ms-skill-picker-pending-new-one');
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('force');
    expect(mockPost.mock.calls[1][1]).toMatchObject({ id: 'new-one', force: true });
  });
});
