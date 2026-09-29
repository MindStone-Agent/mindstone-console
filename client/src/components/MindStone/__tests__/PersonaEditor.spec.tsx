import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PersonaEditor from '../PersonaEditor';

const mockLocalize = (key: string, values?: Record<string, string>) =>
  values ? `${key}:${Object.values(values).join('|')}` : key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));

const BASE = '/api/mindstone/admin';
const PERSONAS = [{ id: 'atlas', name: 'Atlas' }];

/** The gateway as the editor reads it; `privateKbs` is what the persona's KB list returns. */
function serve({
  persona,
  privateKbs = [],
  advanced = false,
}: {
  persona?: Record<string, unknown>;
  privateKbs?: Array<Record<string, unknown>>;
  advanced?: boolean;
} = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === `${BASE}/permissions`)
      return Promise.resolve({ permissions: { advancedSettings: advanced } });
    if (url === `${BASE}/knowledgebases`)
      return Promise.resolve({
        knowledgebases: [
          { id: 'g1', name: 'Plant handbook', indexed: true, entryCount: 3, sourceCount: 1 },
        ],
      });
    if (url === `${BASE}/skills`)
      return Promise.resolve({ skills: [{ id: 'alpha', label: 'Alpha', source: 'installed' }] });
    if (url === `${BASE}/workflows`)
      return Promise.resolve({ workflows: [{ id: 'triage', name: 'Triage', stepCount: 2 }] });
    if (url.endsWith('/knowledgebases') && url.startsWith(`${BASE}/personas/`))
      return Promise.resolve({ knowledgebases: privateKbs });
    if (url.endsWith('/sources')) return Promise.resolve({ sources: { text: [], urls: [] } });
    if (persona && url === `${BASE}/personas/${persona.id}`) return Promise.resolve({ persona });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

async function renderEditor(personaId?: string, onSaved = jest.fn()) {
  render(
    <PersonaEditor
      personaId={personaId}
      personas={PERSONAS}
      onSaved={onSaved}
      onClose={jest.fn()}
    />,
  );
  await screen.findByTestId('ms-persona-editor');
  return onSaved;
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('persona editor (MindStone-Agent #125)', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
  });

  it('builds a persona with a global KB and an existing workflow; saving says it is not active', async () => {
    serve();
    mockPost.mockResolvedValue({ ok: true, persona: { id: 'analyst', active: false } });
    const onSaved = await renderEditor();
    expect(screen.getByText('com_mindstone_pe_not_active_note')).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_pe_private_after_save')).toBeInTheDocument();
    expect(screen.getByText('com_mindstone_pe_connectors_later')).toBeInTheDocument();
    type('ms-pe-id', 'analyst');
    type('ms-pe-name', 'Analyst');
    type('ms-pe-markdown', '# Analyst\n');
    fireEvent.click(screen.getByTestId('ms-pe-global-kb-g1'));
    type('ms-pe-workflow-choose', 'triage');
    fireEvent.click(screen.getByTestId('ms-pe-workflow-add'));
    expect(screen.getByTestId('ms-pe-workflow-triage')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas`, {
        id: 'analyst',
        name: 'Analyst',
        personaMarkdown: '# Analyst\n',
        skills: [],
        workflows: ['triage'],
        knowledgebases: ['g1'],
      }),
    );
    expect(await screen.findByText('com_mindstone_pe_created:analyst')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith('analyst', false);
    // Now saved, its own knowledge bases can be added.
    expect(await screen.findByTestId('ms-private-kbs')).toBeInTheDocument();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('shows the gateway refusal as given', async () => {
    serve();
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'a persona named analyst already exists' } },
    });
    await renderEditor();
    type('ms-pe-id', 'analyst');
    type('ms-pe-name', 'Analyst');
    type('ms-pe-markdown', 'x');
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    expect(await screen.findByText('a persona named analyst already exists')).toBeInTheDocument();
    expect(screen.queryByTestId('ms-private-kbs')).not.toBeInTheDocument();
  });

  it('edits a persona: loads its lists, sends every list back, and says when it is the active one', async () => {
    serve({
      persona: {
        id: 'atlas',
        name: 'Atlas',
        personaMarkdown: '# Atlas\n',
        skills: ['alpha'],
        workflows: ['triage'],
        knowledgebases: ['g1'],
        privateKnowledgebases: [],
        active: true,
      },
    });
    mockPatch.mockResolvedValue({ ok: true, persona: { id: 'atlas', active: true } });
    await renderEditor('atlas');
    expect(screen.queryByTestId('ms-pe-id')).not.toBeInTheDocument();
    expect(screen.getByTestId('ms-pe-global-kb-g1')).toBeChecked();
    type('ms-pe-name', 'Atlas Two');
    fireEvent.click(screen.getByTestId('ms-pe-global-kb-g1'));
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/personas/atlas`, {
        name: 'Atlas Two',
        personaMarkdown: '# Atlas\n',
        skills: ['alpha'],
        workflows: ['triage'],
        knowledgebases: [],
      }),
    );
    expect(await screen.findByText('com_mindstone_pe_saved_active')).toBeInTheDocument();
  });

  it('builds a new workflow in place and lists it', async () => {
    serve();
    mockPost.mockResolvedValue({ ok: true, workflow: { id: 'handoff' } });
    await renderEditor();
    fireEvent.click(screen.getByTestId('ms-pe-workflow-new'));
    const editor = await screen.findByTestId('ms-workflow-editor');
    type('ms-wf-id', 'handoff');
    fireEvent.change(within(editor).getByTestId('ms-wf-step-0-persona'), {
      target: { value: 'atlas' },
    });
    fireEvent.change(within(editor).getByTestId('ms-wf-step-0-when-messagePrefix'), {
      target: { value: 'ops:' },
    });
    fireEvent.click(screen.getByTestId('ms-wf-save'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/workflows`, {
        id: 'handoff',
        steps: [
          { id: 'step-1', kind: 'route', when: { messagePrefix: 'ops:' }, personaId: 'atlas' },
        ],
      }),
    );
    expect(await screen.findByTestId('ms-pe-workflow-handoff')).toBeInTheDocument();
    expect(screen.queryByTestId('ms-workflow-editor')).not.toBeInTheDocument();
  });

  it('adds a private knowledge base with a text source, then ingests it', async () => {
    serve({
      persona: {
        id: 'atlas',
        name: 'Atlas',
        personaMarkdown: '# Atlas\n',
        skills: [],
        workflows: [],
        knowledgebases: [],
        privateKnowledgebases: [],
        active: false,
      },
      privateKbs: [{ id: 'notes', name: 'notes', indexed: false, entryCount: 0, sourceCount: 0 }],
    });
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/ingest')
          ? { ok: true, knowledgebase: { id: 'notes', entryCount: 4 } }
          : { ok: true },
      ),
    );
    await renderEditor('atlas');
    const kbs = await screen.findByTestId('ms-private-kbs');
    fireEvent.change(within(kbs).getByTestId('ms-pkb-new-id'), { target: { value: 'notes' } });
    fireEvent.click(within(kbs).getByTestId('ms-pkb-create'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas/atlas/knowledgebases`, {
        id: 'notes',
      }),
    );
    fireEvent.change(await within(kbs).findByTestId('ms-pkb-notes-text-name'), {
      target: { value: 'facts' },
    });
    fireEvent.change(within(kbs).getByTestId('ms-pkb-notes-text'), {
      target: { value: '# Facts\n\nA fact.' },
    });
    fireEvent.click(within(kbs).getByTestId('ms-pkb-notes-add-text'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas/atlas/knowledgebases/notes/sources`, {
        kind: 'text',
        name: 'facts',
        text: '# Facts\n\nA fact.',
      }),
    );
    fireEvent.click(within(kbs).getByTestId('ms-pkb-notes-ingest'));
    expect(await within(kbs).findByText('com_mindstone_pkb_ingested:4')).toBeInTheDocument();
    // Without advanced settings, a URL can't be added.
    expect(within(kbs).getByText('com_mindstone_pkb_url_advanced')).toBeInTheDocument();
  });
});
