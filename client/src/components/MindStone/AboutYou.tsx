/**
 * What the agent knows about you (MindStone-Agent #140): the default agent's
 * USER.md, read and replaced through GET/PATCH /admin/user. Guided setup's
 * About you step only seeds this file on the first setup; here it can be read
 * and changed any time. The agent updates the file too, so a save sends the
 * etag it was read with, and a file changed meanwhile is never overwritten:
 * the typed text stays on the page until the admin loads the current file.
 */
import { useCallback, useEffect, useState } from 'react';
import { request } from 'librechat-data-provider';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

const BASE = '/api/mindstone/admin';
/** The gateway's limit (#140). */
export const USER_MD_MAX_BYTES = 64 * 1024;

type UserFile = {
  exists: boolean;
  bytes: number;
  etag: string;
  markdown?: string;
  tooLarge?: boolean;
};

function errorOf(error: unknown): { status?: number; text?: string } {
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } })
    ?.response;
  return {
    status: response?.status,
    text: typeof response?.data?.error === 'string' ? response.data.error : undefined,
  };
}

export const byteLength = (text: string) => new TextEncoder().encode(text).length;

export default function AboutYou({ advanced }: { advanced: boolean }) {
  const localize = useLocalize();
  const [file, setFile] = useState<UserFile | null>(null);
  const [draft, setDraft] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** The file changed since it was read: saving is off until the current one is loaded. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await request.get<UserFile>(`${BASE}/user`);
      // Anything but the gateway's answer is an error here, never a broken Settings page.
      if (!result || typeof result.etag !== 'string' || typeof result.exists !== 'boolean') {
        throw new Error('unexpected answer');
      }
      setFile(result);
      setDraft(typeof result.markdown === 'string' ? result.markdown : '');
      setStale(false);
      setLoadError(null);
    } catch (error) {
      const { status, text } = errorOf(error);
      setLoadError(
        status === 404
          ? localize('com_mindstone_about_unsupported')
          : (text ?? localize('com_mindstone_gateway_unreachable')),
      );
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = (await request.patch(`${BASE}/user?ifMatch=${encodeURIComponent(file.etag)}`, {
        markdown: draft,
      })) as { bytes: number; etag: string };
      setFile({ exists: true, bytes: result.bytes, etag: result.etag, markdown: draft });
      setMessage({ ok: true, text: localize('com_mindstone_about_saved') });
    } catch (error) {
      const { status, text } = errorOf(error);
      if (status === 412) setStale(true);
      setMessage({
        ok: false,
        text:
          status === 412
            ? localize('com_mindstone_about_stale')
            : (text ?? localize('com_mindstone_not_saved')),
      });
    } finally {
      setBusy(false);
    }
  };

  const bytes = byteLength(draft);
  const tooBig = bytes > USER_MD_MAX_BYTES;
  const changed = file !== null && draft !== (file.markdown ?? '');
  const hidden = visibleText(draft) !== draft;
  return (
    <section
      className="rounded-xl border border-border-medium bg-surface-primary p-4"
      aria-labelledby="ms-about"
      data-testid="ms-about"
    >
      <h2 id="ms-about" className="mb-1 text-lg font-medium">
        {localize('com_mindstone_about_title')}
      </h2>
      <p className="mb-2 text-sm text-text-secondary">{localize('com_mindstone_about_hint')}</p>
      {loadError && (
        <p role="alert" className="text-sm text-red-600">
          {visibleText(loadError)}
        </p>
      )}
      {file && (
        <div className="flex flex-col gap-2">
          {file.tooLarge && (
            <p className="text-sm text-red-600">
              {localize('com_mindstone_about_too_large', { 0: String(file.bytes) })}
            </p>
          )}
          {!file.exists && (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_about_none')}</p>
          )}
          <textarea
            className="h-64 w-full rounded border border-border-medium bg-surface-secondary p-2 font-mono text-sm"
            value={draft}
            aria-label={localize('com_mindstone_about_title')}
            data-testid="ms-about-text"
            onChange={(event) => setDraft(event.target.value)}
          />
          {hidden && (
            <p className="text-sm text-text-secondary" data-testid="ms-about-hidden">
              {localize('com_mindstone_about_hidden')}{' '}
              <span className="break-all font-mono">{visibleText(draft)}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className="rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50"
              disabled={busy || !advanced || stale || tooBig || !changed}
              data-testid="ms-about-save"
              onClick={() => void save()}
            >
              {localize('com_mindstone_about_save')}
            </button>
            {stale && (
              <button
                type="button"
                className="rounded border border-border-medium px-3 py-1"
                disabled={busy}
                data-testid="ms-about-reload"
                onClick={() => void load()}
              >
                {localize('com_mindstone_about_reload')}
              </button>
            )}
            <span className={tooBig ? 'text-red-600' : 'text-text-secondary'}>
              {localize('com_mindstone_about_size', {
                0: String(bytes),
                1: String(USER_MD_MAX_BYTES),
              })}
            </span>
          </div>
          {!advanced && (
            <p className="text-sm text-text-secondary">
              {localize('com_mindstone_about_need_advanced')}
            </p>
          )}
          {message && (
            <p
              role="status"
              data-testid="ms-about-status"
              className={message.ok ? 'text-sm text-green-600' : 'text-sm text-red-600'}
            >
              {visibleText(message.text)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
