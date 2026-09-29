import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const ATLAS = {
  id: 'atlas',
  name: 'Atlas',
  personaMarkdown: '# Atlas\n',
  skills: [],
  workflows: [],
  knowledgebases: [],
  privateKnowledgebases: [],
  active: false,
};
const PERSONAS = [{ id: 'atlas', name: 'Atlas' }];

/** The gateway as the editor reads it; `privateKbs` is what the persona's KB list returns. */
function serve({
  persona,
  privateKbs = [],
  advanced = false,
  globalKbs = [{ id: 'g1', name: 'Plant handbook', indexed: true, entryCount: 3, sourceCount: 1 }],
}: {
  persona?: Record<string, unknown>;
  privateKbs?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>);
  advanced?: boolean;
  globalKbs?: Array<Record<string, unknown>>;
} = {}) {
  mockGet.mockImplementation((url: string) => {
    if (url === `${BASE}/permissions`)
      return Promise.resolve({ permissions: { advancedSettings: advanced } });
    if (url === `${BASE}/knowledgebases`) return Promise.resolve({ knowledgebases: globalKbs });
    if (url === `${BASE}/skills`)
      return Promise.resolve({ skills: [{ id: 'alpha', label: 'Alpha', source: 'installed' }] });
    if (url === `${BASE}/workflows`)
      return Promise.resolve({ workflows: [{ id: 'triage', name: 'Triage', stepCount: 2 }] });
    if (url.endsWith('/knowledgebases') && url.startsWith(`${BASE}/personas/`))
      return Promise.resolve({
        knowledgebases: typeof privateKbs === 'function' ? privateKbs() : privateKbs,
      });
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
      // Only the text that changed; every list.
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/personas/atlas`, {
        name: 'Atlas Two',
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

  it('says when a knowledge base waits to be embedded again, or was given up on (MindStone-Agent #158)', async () => {
    serve({
      persona: ATLAS,
      globalKbs: [
        {
          id: 'g1',
          name: 'Plant handbook',
          indexed: true,
          entryCount: 3,
          sourceCount: 1,
          reembed: { failures: 0, nextAttemptAt: '2026-09-29T12:00:00.000Z', reason: 'the embedder failed' },
        },
      ],
      privateKbs: [
        { id: 'notes', name: 'Notes', indexed: true, entryCount: 2, sourceCount: 1, reembed: { failures: 5, gaveUp: true, reason: 'bad\u202Etext' } },
        { id: 'plain', name: 'Plain', indexed: true, entryCount: 1, sourceCount: 1 },
      ],
    });
    await renderEditor('atlas');
    const waiting = await screen.findByTestId('ms-pe-global-kb-reembed-g1');
    expect(waiting.textContent).toMatch(/^com_mindstone_kb_reembed_waiting:\S.* com_mindstone_kb_reembed_reason:the embedder failed$/);
    const gaveUp = await screen.findByTestId('ms-pkb-reembed-notes');
    expect(gaveUp.textContent).toMatch(/^com_mindstone_kb_reembed_gave_up:5 /);
    expect(gaveUp.textContent).not.toContain('\u202E');
    expect(screen.queryByTestId('ms-pkb-reembed-plain')).not.toBeInTheDocument();
  });

  it('adds a private knowledge base with a text source, then ingests it', async () => {
    // The gateway's KB list, as each step changes it.
    let kbs: Array<Record<string, unknown>> = [];
    serve({ persona: ATLAS, privateKbs: () => kbs });
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/knowledgebases')) {
        kbs = [{ id: 'notes', name: 'notes', indexed: false, entryCount: 0, sourceCount: 0 }];
      } else if (url.endsWith('/sources')) {
        kbs = [{ id: 'notes', name: 'notes', indexed: false, entryCount: 0, sourceCount: 1 }];
      } else if (url.endsWith('/ingest')) {
        return Promise.resolve({ ok: true, knowledgebase: { id: 'notes', entryCount: 4 } });
      }
      return Promise.resolve({ ok: true });
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    expect(within(kbs$).getByText('com_mindstone_pkb_none')).toBeInTheDocument();
    fireEvent.change(within(kbs$).getByTestId('ms-pkb-new-id'), { target: { value: 'notes' } });
    fireEvent.click(within(kbs$).getByTestId('ms-pkb-create'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas/atlas/knowledgebases`, {
        id: 'notes',
      }),
    );
    // The list is read again, so the new KB shows; with no source yet it can't be ingested.
    expect(await within(kbs$).findByTestId('ms-pkb-notes-ingest')).toBeDisabled();
    fireEvent.change(await within(kbs$).findByTestId('ms-pkb-notes-text-name'), {
      target: { value: 'facts' },
    });
    fireEvent.change(within(kbs$).getByTestId('ms-pkb-notes-text'), {
      target: { value: '# Facts\n\nA fact.' },
    });
    fireEvent.click(within(kbs$).getByTestId('ms-pkb-notes-add-text'));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas/atlas/knowledgebases/notes/sources`, {
        kind: 'text',
        name: 'facts',
        text: '# Facts\n\nA fact.',
      }),
    );
    await waitFor(() => expect(within(kbs$).getByTestId('ms-pkb-notes-ingest')).toBeEnabled());
    fireEvent.click(within(kbs$).getByTestId('ms-pkb-notes-ingest'));
    expect(await within(kbs$).findByText('com_mindstone_pkb_ingested:4')).toBeInTheDocument();
    // Without advanced settings, a URL can't be added.
    expect(within(kbs$).getByText('com_mindstone_pkb_url_advanced')).toBeInTheDocument();
  });

  it('with advanced settings, adds a URL source', async () => {
    serve({
      persona: ATLAS,
      advanced: true,
      privateKbs: [{ id: 'notes', name: 'notes', indexed: true, entryCount: 1, sourceCount: 1 }],
    });
    mockPost.mockResolvedValue({ ok: true });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(
      await within(kbs$).findByRole('button', { name: 'com_mindstone_pkb_sources_named:notes' }),
    );
    fireEvent.change(
      within(kbs$).getByRole('textbox', { name: 'com_mindstone_pkb_url_name_label' }),
      {
        target: { value: 'web' },
      },
    );
    fireEvent.change(within(kbs$).getByRole('textbox', { name: 'com_mindstone_pkb_url_label' }), {
      target: { value: 'https://example.invalid/doc.md' },
    });
    fireEvent.click(within(kbs$).getByRole('button', { name: 'com_mindstone_pkb_add_url' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(`${BASE}/personas/atlas/knowledgebases/notes/sources`, {
        kind: 'url',
        name: 'web',
        url: 'https://example.invalid/doc.md',
      }),
    );
  });

  it('after a create, the next save edits the new persona, sending only what changed', async () => {
    serve();
    mockPost.mockResolvedValue({ ok: true, persona: { id: 'analyst', active: false } });
    mockPatch.mockResolvedValue({ ok: true, persona: { id: 'analyst', active: false } });
    await renderEditor();
    type('ms-pe-id', 'analyst');
    type('ms-pe-name', 'Analyst');
    type('ms-pe-markdown', '# Analyst\n');
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await screen.findByText('com_mindstone_pe_created:analyst');
    fireEvent.click(screen.getByTestId('ms-pe-global-kb-g1'));
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/personas/analyst`, {
        skills: [],
        workflows: [],
        knowledgebases: ['g1'],
      }),
    );
  });

  it('clearing the description sends it empty, so the gateway clears it', async () => {
    serve({ persona: { ...ATLAS, description: 'Steady.' } });
    mockPatch.mockResolvedValue({ ok: true, persona: { id: 'atlas', active: false } });
    await renderEditor('atlas');
    type('ms-pe-description', '');
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/personas/atlas`, {
        description: '',
        skills: [],
        workflows: [],
        knowledgebases: [],
      }),
    );
  });

  it('an attached global KB that is gone is listed so it can be removed, and the save leaves it out', async () => {
    serve({ persona: { ...ATLAS, knowledgebases: ['gone'] } });
    mockPatch.mockResolvedValue({ ok: true, persona: { id: 'atlas', active: false } });
    await renderEditor('atlas');
    const gone = screen.getByTestId('ms-pe-global-kb-missing-gone');
    fireEvent.click(within(gone).getByRole('button', { name: 'com_mindstone_picker_remove:gone' }));
    fireEvent.click(screen.getByTestId('ms-pe-save'));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/personas/atlas`, {
        skills: [],
        workflows: [],
        knowledgebases: [],
      }),
    );
  });

  it('a load that fails can be closed', async () => {
    serve();
    mockGet.mockImplementation(() => Promise.reject({ response: { status: 502, data: {} } }));
    const onClose = jest.fn();
    render(
      <PersonaEditor personaId="atlas" personas={PERSONAS} onSaved={jest.fn()} onClose={onClose} />,
    );
    const failed = await screen.findByTestId('ms-persona-editor-failed');
    fireEvent.click(within(failed).getByRole('button', { name: 'com_mindstone_pe_close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('edits a listed workflow: reads it, keeps its version, and names a persona that is not listed', async () => {
    serve({ persona: { ...ATLAS, workflows: ['triage'] } });
    const read = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) =>
      url === `${BASE}/workflows/triage`
        ? Promise.resolve({
            id: 'triage',
            workflow: {
              name: 'Triage',
              version: '3',
              steps: [{ id: 'step-2', kind: 'route', personaId: 'ghost' }],
            },
          })
        : read(url),
    );
    mockPatch.mockResolvedValue({ ok: true, workflow: { id: 'triage' } });
    await renderEditor('atlas');
    fireEvent.click(screen.getByRole('button', { name: 'com_mindstone_pe_edit_named:triage' }));
    const editor = await screen.findByTestId('ms-workflow-editor');
    expect(within(editor).getByTestId('ms-wf-live-note')).toBeInTheDocument();
    expect(within(editor).getByTestId('ms-wf-step-0-persona')).toHaveValue('ghost');
    expect(
      within(editor).getByText('com_mindstone_wf_persona_unavailable:ghost'),
    ).toBeInTheDocument();
    // An added step never repeats an id already there.
    fireEvent.click(within(editor).getByRole('button', { name: 'com_mindstone_wf_add_step' }));
    expect(within(editor).getByTestId('ms-wf-step-1-id')).toHaveValue('step-3');
    fireEvent.click(within(editor).getByTestId('ms-wf-save'));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        `${BASE}/workflows/triage`,
        expect.objectContaining({ name: 'Triage', version: '3' }),
      ),
    );
  });

  it('marks a listed workflow that is gone, and a broken global KB can not be newly ticked', async () => {
    serve({ persona: { ...ATLAS, workflows: ['gone'] } });
    const read = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) =>
      url === `${BASE}/knowledgebases`
        ? Promise.resolve({
            knowledgebases: [
              { id: 'g1', name: 'Plant handbook', indexed: true, entryCount: 3, sourceCount: 1 },
              { id: 'bad', name: 'bad', indexed: false, entryCount: 0, sourceCount: 0, error: 'x' },
            ],
          })
        : read(url),
    );
    await renderEditor('atlas');
    expect(screen.getByTestId('ms-pe-workflow-broken-gone')).toBeInTheDocument();
    expect(screen.getByTestId('ms-pe-global-kb-bad')).toBeDisabled();
    expect(screen.getByTestId('ms-pe-global-kb-g1')).toBeEnabled();
  });

  it("a slow answer for one KB's sources never replaces the open KB's", async () => {
    serve({
      persona: ATLAS,
      privateKbs: [
        { id: 'aaa', name: 'aaa', indexed: true, entryCount: 1, sourceCount: 1 },
        { id: 'bbb', name: 'bbb', indexed: true, entryCount: 1, sourceCount: 1 },
      ],
    });
    const read = mockGet.getMockImplementation()!;
    let releaseA: (value: unknown) => void = () => undefined;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/aaa/sources')) return new Promise((resolve) => (releaseA = resolve));
      if (url.endsWith('/bbb/sources'))
        return Promise.resolve({ sources: { text: ['b-source'], urls: [] } });
      return read(url);
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(
      await within(kbs$).findByRole('button', { name: 'com_mindstone_pkb_sources_named:aaa' }),
    );
    fireEvent.click(
      within(kbs$).getByRole('button', { name: 'com_mindstone_pkb_sources_named:bbb' }),
    );
    expect(await within(kbs$).findByText('b-source.md')).toBeInTheDocument();
    await act(async () => {
      releaseA({ sources: { text: ['a-source'], urls: [] } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(kbs$).getByText('b-source.md')).toBeInTheDocument();
    expect(within(kbs$).queryByText('a-source.md')).not.toBeInTheDocument();
  });

  const TWO_KBS = [
    { id: 'aaa', name: 'aaa', indexed: true, entryCount: 1, sourceCount: 1 },
    { id: 'bbb', name: 'bbb', indexed: true, entryCount: 1, sourceCount: 1 },
  ];

  it('an ingest the Console stopped waiting for says it may still finish; a gateway that is down says so', async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS });
    mockPost.mockRejectedValueOnce({
      response: {
        status: 504,
        data: { ok: false, error: 'proxy text', code: 'gateway_timeout' },
      },
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(await within(kbs$).findByTestId('ms-pkb-aaa-ingest'));
    expect(await within(kbs$).findByText('com_mindstone_pkb_ingest_slow')).toBeInTheDocument();
    mockPost.mockRejectedValueOnce({
      response: { status: 502, data: { ok: false, error: "the MindStone gateway didn't answer" } },
    });
    fireEvent.click(within(kbs$).getByTestId('ms-pkb-aaa-ingest'));
    expect(
      await within(kbs$).findByText("the MindStone gateway didn't answer"),
    ).toBeInTheDocument();
    expect(within(kbs$).queryByText('com_mindstone_pkb_ingest_slow')).not.toBeInTheDocument();
  });

  it('a front proxy\'s own 504 page (no JSON) on an ingest says it may still finish, not "not changed"', async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS });
    mockPost.mockRejectedValueOnce({
      response: { status: 504, data: '<html><body>504 Gateway Time-out</body></html>' },
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(await within(kbs$).findByTestId('ms-pkb-aaa-ingest'));
    expect(await within(kbs$).findByText('com_mindstone_pkb_ingest_slow')).toBeInTheDocument();
    expect(within(kbs$).queryByText('com_mindstone_not_changed')).not.toBeInTheDocument();
  });

  it("an ingest with no answer at all, or a 5xx JSON that isn't the Console's, may still be running", async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    for (const failure of [
      { message: 'Network Error' },
      { response: { status: 504, data: { message: 'Endpoint request timed out' } } },
    ]) {
      mockPost.mockRejectedValueOnce(failure);
      fireEvent.click(await within(kbs$).findByTestId('ms-pkb-aaa-ingest'));
      expect(await within(kbs$).findByText('com_mindstone_pkb_ingest_slow')).toBeInTheDocument();
      expect(within(kbs$).queryByText('com_mindstone_not_changed')).not.toBeInTheDocument();
    }
  });

  it("a draft typed for one KB is cleared when another KB's sources are opened", async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(
      await within(kbs$).findByRole('button', { name: 'com_mindstone_pkb_sources_named:aaa' }),
    );
    fireEvent.change(await within(kbs$).findByTestId('ms-pkb-aaa-text-name'), {
      target: { value: 'draft-for-a' },
    });
    fireEvent.change(within(kbs$).getByTestId('ms-pkb-aaa-text'), {
      target: { value: 'Text meant for aaa.' },
    });
    fireEvent.click(
      within(kbs$).getByRole('button', { name: 'com_mindstone_pkb_sources_named:bbb' }),
    );
    expect(await within(kbs$).findByTestId('ms-pkb-bbb-text-name')).toHaveValue('');
    expect(within(kbs$).getByTestId('ms-pkb-bbb-text')).toHaveValue('');
  });

  it('without advanced settings, a KB whose open sources include a URL cannot be ingested', async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS });
    const read = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/aaa/sources'))
        return Promise.resolve({
          sources: { text: [], urls: [{ id: 'web', url: 'https://example.com/doc' }] },
        });
      return read(url);
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    expect(await within(kbs$).findByTestId('ms-pkb-aaa-ingest')).toBeEnabled();
    fireEvent.click(
      within(kbs$).getByRole('button', { name: 'com_mindstone_pkb_sources_named:aaa' }),
    );
    await waitFor(() => expect(within(kbs$).getByTestId('ms-pkb-aaa-ingest')).toBeDisabled());
    // A KB with only text sources is unaffected.
    expect(within(kbs$).getByTestId('ms-pkb-bbb-ingest')).toBeEnabled();
  });

  it('with advanced settings, a KB with a URL source can be ingested', async () => {
    serve({ persona: ATLAS, privateKbs: TWO_KBS, advanced: true });
    const read = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/aaa/sources'))
        return Promise.resolve({
          sources: { text: [], urls: [{ id: 'web', url: 'https://example.com/doc' }] },
        });
      return read(url);
    });
    await renderEditor('atlas');
    const kbs$ = await screen.findByTestId('ms-private-kbs');
    fireEvent.click(
      await within(kbs$).findByRole('button', { name: 'com_mindstone_pkb_sources_named:aaa' }),
    );
    expect(await within(kbs$).findByText(/example\.com/)).toBeInTheDocument();
    expect(within(kbs$).getByTestId('ms-pkb-aaa-ingest')).toBeEnabled();
  });
});
