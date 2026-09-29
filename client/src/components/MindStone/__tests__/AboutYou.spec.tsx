/**
 * What the agent knows about you (MindStone-Agent #140): USER.md read from
 * GET /admin/user and replaced with PATCH /admin/user and the etag it was read
 * with. A file the agent changed meanwhile is never overwritten: the typed
 * text stays, and saving waits until the current file is loaded.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AboutYou, { USER_MD_MAX_BYTES } from '../AboutYou';

const mockGet = jest.fn();
const mockPatch = jest.fn();

jest.mock('librechat-data-provider', () => ({
  request: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
  },
}));
const mockLocalize = (key: string, values?: Record<string, string>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key;
jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
}));

const BASE = '/api/mindstone/admin';
const FILE = {
  exists: true,
  bytes: 30,
  etag: '"e1"',
  markdown: '# User Context\n\nLikes tables.\n',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockGet.mockResolvedValue(FILE);
});

const text = () => screen.getByTestId('ms-about-text');
const save = () => screen.getByTestId('ms-about-save');

describe('AboutYou', () => {
  it('shows USER.md and saves a change with the etag it was read with', async () => {
    mockPatch.mockResolvedValue({ ok: true, bytes: 40, etag: '"e2"' });
    render(<AboutYou advanced />);
    await waitFor(() => expect(text()).toHaveValue(FILE.markdown));
    expect(save()).toBeDisabled();
    fireEvent.change(text(), { target: { value: '# User Context\n\nLikes lists.\n' } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(await screen.findByText('com_mindstone_about_saved')).toBeInTheDocument();
    expect(mockPatch).toHaveBeenCalledWith(`${BASE}/user?ifMatch=%22e1%22`, {
      markdown: '# User Context\n\nLikes lists.\n',
    });
    // The next save uses the etag the save returned.
    fireEvent.change(text(), { target: { value: 'again' } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(mockPatch).toHaveBeenLastCalledWith(`${BASE}/user?ifMatch=%22e2%22`, {
        markdown: 'again',
      }),
    );
  });

  it('never overwrites a file changed meanwhile: the text stays, Save waits for a reload', async () => {
    mockPatch.mockRejectedValue({ response: { status: 412, data: { error: 'changed' } } });
    render(<AboutYou advanced />);
    await waitFor(() => expect(text()).toHaveValue(FILE.markdown));
    fireEvent.change(text(), { target: { value: 'my edit' } });
    fireEvent.click(save());
    expect(await screen.findByText('com_mindstone_about_stale')).toBeInTheDocument();
    expect(text()).toHaveValue('my edit');
    expect(save()).toBeDisabled();

    mockGet.mockResolvedValue({ ...FILE, etag: '"e3"', markdown: 'the agent wrote this' });
    fireEvent.click(screen.getByTestId('ms-about-reload'));
    await waitFor(() => expect(text()).toHaveValue('the agent wrote this'));
    fireEvent.change(text(), { target: { value: 'my edit' } });
    expect(save()).toBeEnabled();
  });

  it('needs advanced settings to save, and says so', async () => {
    render(<AboutYou advanced={false} />);
    await waitFor(() => expect(text()).toHaveValue(FILE.markdown));
    fireEvent.change(text(), { target: { value: 'changed' } });
    expect(save()).toBeDisabled();
    expect(screen.getByText('com_mindstone_about_need_advanced')).toBeInTheDocument();
  });

  it('holds a save over the size limit, counting bytes not characters', async () => {
    render(<AboutYou advanced />);
    await waitFor(() => expect(text()).toHaveValue(FILE.markdown));
    // Two bytes each in UTF-8: just over the limit in bytes, under it in characters.
    fireEvent.change(text(), { target: { value: 'é'.repeat(USER_MD_MAX_BYTES / 2 + 1) } });
    expect(save()).toBeDisabled();
    fireEvent.change(text(), { target: { value: 'é'.repeat(USER_MD_MAX_BYTES / 2) } });
    expect(save()).toBeEnabled();
  });

  it("shows characters that don't print", async () => {
    render(<AboutYou advanced />);
    await waitFor(() => expect(text()).toHaveValue(FILE.markdown));
    expect(screen.queryByTestId('ms-about-hidden')).toBeNull();
    fireEvent.change(text(), { target: { value: 'safe‮text' } });
    expect(screen.getByTestId('ms-about-hidden')).toHaveTextContent('safe\\u{202E}text');
  });

  it("shows the gateway's refusal to read it", async () => {
    mockGet.mockRejectedValue({
      response: { status: 409, data: { error: 'the default agent has no USER.md set up yet' } },
    });
    render(<AboutYou advanced />);
    expect(
      await screen.findByText('the default agent has no USER.md set up yet'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ms-about-text')).toBeNull();
  });

  it('an unexpected answer is an error, not a broken page', async () => {
    mockGet.mockResolvedValue(undefined);
    render(<AboutYou advanced />);
    expect(await screen.findByRole('alert')).toHaveTextContent('com_mindstone_gateway_unreachable');
    expect(screen.queryByTestId('ms-about-text')).toBeNull();
  });

  it("says when the gateway doesn't have the route yet", async () => {
    mockGet.mockRejectedValue({
      response: { status: 404, data: { ok: false, error: 'unknown admin endpoint' } },
    });
    render(<AboutYou advanced />);
    expect(await screen.findByText('com_mindstone_about_unsupported')).toBeInTheDocument();
  });

  it('creates USER.md when there is none', async () => {
    mockGet.mockResolvedValue({ exists: false, bytes: 0, etag: '"e0"' });
    mockPatch.mockResolvedValue({ ok: true, bytes: 5, etag: '"e4"' });
    render(<AboutYou advanced />);
    expect(await screen.findByText('com_mindstone_about_none')).toBeInTheDocument();
    fireEvent.change(text(), { target: { value: 'hello' } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(`${BASE}/user?ifMatch=%22e0%22`, {
        markdown: 'hello',
      }),
    );
  });
});
