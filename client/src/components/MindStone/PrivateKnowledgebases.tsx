/**
 * A persona's own knowledge bases (MindStone-Agent #125): searched only while
 * this persona answers, never under another. Create one, add markdown text
 * or a URL (a URL needs advanced settings: the gateway host fetches it), then
 * ingest it. Nothing added is used until it is ingested.
 */
import { useCallback, useEffect, useState } from 'react';
import { request } from 'librechat-data-provider';
import type { KnowledgebaseSummary } from './personaForms';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

type Sources = { text: string[]; urls: Array<{ id: string; url: string }> };

export default function PrivateKnowledgebases({
  personaId,
  advanced,
}: {
  personaId: string;
  /** The advanced-settings permission: URL sources and ingesting them need it. */
  advanced: boolean;
}) {
  const localize = useLocalize();
  const personaPath = `${BASE}/personas/${encodeURIComponent(personaId)}/knowledgebases`;
  const [knowledgebases, setKnowledgebases] = useState<KnowledgebaseSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** The open KB's sources, with the KB they belong to (a slow answer for another KB is ignored). */
  const [sources, setSources] = useState<{ kbId: string; list: Sources } | null>(null);
  const [newKb, setNewKb] = useState({ id: '', name: '' });
  const [text, setText] = useState({ name: '', text: '' });
  const [url, setUrl] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await request.get<{ knowledgebases: KnowledgebaseSummary[] }>(personaPath);
      setKnowledgebases(result.knowledgebases);
    } catch (error) {
      setMessage({
        ok: false,
        text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
      });
    }
  }, [personaPath, localize]);

  const loadSources = useCallback(
    async (kbId: string) => {
      try {
        const result = await request.get<{ sources: Sources }>(
          `${personaPath}/${encodeURIComponent(kbId)}/sources`,
        );
        setSources({ kbId, list: result.sources });
      } catch (error) {
        setMessage({
          ok: false,
          text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
        });
      }
    },
    [personaPath, localize],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ ok: true, text: done });
      return true;
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) ?? localize('com_mindstone_not_changed') });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createKb = async () => {
    const id = newKb.id.trim();
    const ok = await run(
      () =>
        request.post(personaPath, {
          id,
          ...(newKb.name.trim() ? { name: newKb.name.trim() } : {}),
        }),
      localize('com_mindstone_pkb_created', { 0: id }),
    );
    if (ok) {
      setNewKb({ id: '', name: '' });
      await load();
      setOpen(id);
      await loadSources(id);
    }
  };

  const addSource = async (kbId: string, body: Record<string, unknown>, reset: () => void) => {
    const ok = await run(
      () => request.post(`${personaPath}/${encodeURIComponent(kbId)}/sources`, body),
      localize('com_mindstone_pkb_source_added'),
    );
    if (ok) {
      reset();
      await Promise.all([loadSources(kbId), load()]);
    }
  };

  const ingest = async (kbId: string) => {
    let entries = 0;
    const ok = await run(async () => {
      const result = (await request.post(
        `${personaPath}/${encodeURIComponent(kbId)}/ingest`,
        {},
      )) as {
        knowledgebase: { entryCount: number };
      };
      entries = result.knowledgebase.entryCount;
    }, '');
    if (ok) {
      setMessage({
        ok: true,
        text: localize('com_mindstone_pkb_ingested', { 0: String(entries) }),
      });
      await load();
    }
  };

  const input = 'rounded border border-border-medium bg-surface-primary px-2 py-1 text-sm';
  const secondary = 'rounded border border-border-medium px-2 py-1 text-sm disabled:opacity-50';
  const primary = 'rounded bg-surface-submit px-3 py-1 text-sm text-white disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2" data-testid="ms-private-kbs">
      <p className="text-xs text-text-secondary">{localize('com_mindstone_pkb_intro')}</p>
      {knowledgebases && knowledgebases.length === 0 && (
        <p className="text-sm text-text-secondary">{localize('com_mindstone_pkb_none')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {knowledgebases?.map((kb) => (
          <li
            key={kb.id}
            className="rounded border border-border-light p-2"
            data-testid={`ms-pkb-${kb.id}`}
          >
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium">{visibleText(kb.name)}</span>{' '}
                <span className="font-mono text-xs text-text-secondary">{visibleText(kb.id)}</span>{' '}
                <span className="text-xs text-text-secondary">
                  {kb.indexed
                    ? localize('com_mindstone_pkb_indexed', { 0: String(kb.entryCount) })
                    : localize('com_mindstone_pkb_not_indexed')}
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className={secondary}
                  aria-label={localize(
                    open === kb.id
                      ? 'com_mindstone_pkb_close_named'
                      : 'com_mindstone_pkb_sources_named',
                    { 0: kb.id },
                  )}
                  onClick={() => {
                    const next = open === kb.id ? null : kb.id;
                    setOpen(next);
                    setSources(null);
                    if (next) void loadSources(next);
                  }}
                >
                  {localize(
                    open === kb.id ? 'com_mindstone_pkb_close' : 'com_mindstone_pkb_sources',
                  )}
                </button>
                <button
                  type="button"
                  className={primary}
                  // Nothing to ingest until it has a source.
                  disabled={busy || kb.sourceCount === 0}
                  aria-label={localize('com_mindstone_pkb_ingest_named', { 0: kb.id })}
                  data-testid={`ms-pkb-${kb.id}-ingest`}
                  onClick={() => void ingest(kb.id)}
                >
                  {localize('com_mindstone_pkb_ingest')}
                </button>
              </span>
            </div>
            {open === kb.id && (
              <div className="mt-2 flex flex-col gap-2">
                {sources && sources.kbId === kb.id && (
                  <ul className="text-xs">
                    {sources.list.text.map((name) => (
                      <li key={`t-${name}`} className="font-mono">
                        {`${visibleText(name)}.md`}
                      </li>
                    ))}
                    {sources.list.urls.map((source) => (
                      <li key={`u-${source.id}`} className="font-mono">
                        {visibleText(source.id)}: {visibleText(source.url)}
                      </li>
                    ))}
                    {sources.list.text.length + sources.list.urls.length === 0 && (
                      <li className="text-text-secondary">
                        {localize('com_mindstone_pkb_no_sources')}
                      </li>
                    )}
                  </ul>
                )}
                <div className="flex flex-col gap-1">
                  <input
                    className={input}
                    placeholder={localize('com_mindstone_pkb_source_name')}
                    aria-label={localize('com_mindstone_pkb_text_name_label')}
                    value={text.name}
                    data-testid={`ms-pkb-${kb.id}-text-name`}
                    onChange={(event) => setText({ ...text, name: event.target.value })}
                  />
                  <textarea
                    className={input}
                    rows={5}
                    placeholder={localize('com_mindstone_pkb_text_placeholder')}
                    aria-label={localize('com_mindstone_pkb_text_label')}
                    value={text.text}
                    data-testid={`ms-pkb-${kb.id}-text`}
                    onChange={(event) => setText({ ...text, text: event.target.value })}
                  />
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy || !text.name.trim() || !text.text.trim()}
                    data-testid={`ms-pkb-${kb.id}-add-text`}
                    onClick={() =>
                      void addSource(
                        kb.id,
                        { kind: 'text', name: text.name.trim(), text: text.text },
                        () => setText({ name: '', text: '' }),
                      )
                    }
                  >
                    {localize('com_mindstone_pkb_add_text')}
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <input
                      className={input}
                      placeholder={localize('com_mindstone_pkb_source_name')}
                      aria-label={localize('com_mindstone_pkb_url_name_label')}
                      value={url.name}
                      disabled={!advanced}
                      onChange={(event) => setUrl({ ...url, name: event.target.value })}
                    />
                    <input
                      className={`${input} flex-1`}
                      placeholder="https://"
                      aria-label={localize('com_mindstone_pkb_url_label')}
                      value={url.url}
                      disabled={!advanced}
                      onChange={(event) => setUrl({ ...url, url: event.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy || !advanced || !url.name.trim() || !url.url.trim()}
                    onClick={() =>
                      void addSource(
                        kb.id,
                        { kind: 'url', name: url.name.trim(), url: url.url.trim() },
                        () => setUrl({ name: '', url: '' }),
                      )
                    }
                  >
                    {localize('com_mindstone_pkb_add_url')}
                  </button>
                  {!advanced && (
                    <p className="text-xs text-text-secondary">
                      {localize('com_mindstone_pkb_url_advanced')}
                    </p>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          {localize('com_mindstone_pkb_new_id')}
          <input
            className={input}
            value={newKb.id}
            data-testid="ms-pkb-new-id"
            onChange={(event) => setNewKb({ ...newKb, id: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {localize('com_mindstone_pkb_new_name')}
          <input
            className={input}
            value={newKb.name}
            onChange={(event) => setNewKb({ ...newKb, name: event.target.value })}
          />
        </label>
        <button
          type="button"
          className={secondary}
          disabled={busy || !newKb.id.trim()}
          data-testid="ms-pkb-create"
          onClick={() => void createKb()}
        >
          {localize('com_mindstone_pkb_create')}
        </button>
      </div>
      {message && (
        <p role="status" className={message.ok ? 'text-sm text-green-600' : 'text-sm text-red-600'}>
          {visibleText(message.text)}
        </p>
      )}
    </div>
  );
}
