/**
 * MindStone approvals (MindStone-Agent #84): the Console side of
 * `mindstone approvals`. Lists proposed actions (a connector send, a
 * connector mutation or a memory write held for a decision), shows the full
 * draft, and approves or rejects it through the gateway admin API, which
 * applies the same guards as the CLI. The draft text is only held in this
 * page's state; nothing here writes it to browser storage or the console.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Summary = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  kind: 'connector_send' | 'connector_mutation' | 'memory_write';
  connectorId: string;
  summary: string;
  createdAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
};
type Detail = Summary & {
  send?: { text?: string; chatId?: string };
  memory?: { path: string; content: string };
  mutation?: { operation: string; resource: string; connectorId: string; data: unknown };
};
type Counts = { pending: number; approved: number; rejected: number };

const BASE = '/api/mindstone/admin';

function errorBody(error: unknown): { error?: string; code?: string } {
  const data = (error as { response?: { data?: { error?: unknown; code?: unknown } } })?.response
    ?.data;
  return {
    error: typeof data?.error === 'string' ? data.error : undefined,
    code: typeof data?.code === 'string' ? data.code : undefined,
  };
}

/** What the admin is about to approve or reject, as plain text. */
function payloadText(detail: Detail): string {
  if (detail.send) return detail.send.text ?? '';
  if (detail.memory) return detail.memory.content;
  if (detail.mutation) return JSON.stringify(detail.mutation, null, 2);
  return '';
}

export default function MindStoneApprovalsView() {
  const localize = useLocalize();
  const [actions, setActions] = useState<Summary[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await request.get<{ actions: Summary[]; status: Counts }>(
        `${BASE}/approvals${showAll ? '?all=1' : ''}`,
      );
      setActions(result.actions);
      setCounts(result.status);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'));
    }
  }, [localize, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setMessage(null);
    setConfirming(null);
    setNeedsForce(false);
    setNote('');
    try {
      const result = await request.get<{ action: Detail }>(
        `${BASE}/approvals/${encodeURIComponent(id)}`,
      );
      setDetail(result.action);
    } catch (error) {
      setDetail(null);
      setMessage({
        ok: false,
        text: errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'),
      });
    }
  };

  const decide = async (decision: 'approve' | 'reject', force = false) => {
    if (!detail) return;
    setBusy(true);
    try {
      const body: { force?: boolean; note?: string } = {};
      if (decision === 'approve' && force) body.force = true;
      if (decision === 'reject' && note.trim()) body.note = note;
      await request.post(`${BASE}/approvals/${encodeURIComponent(detail.id)}/${decision}`, body);
      setMessage({
        ok: true,
        text: localize(
          decision === 'approve' ? 'com_mindstone_appr_approved' : 'com_mindstone_appr_rejected',
        ),
      });
      setDetail(null);
      setConfirming(null);
      setNeedsForce(false);
      setNote('');
      await load();
    } catch (error) {
      const { error: text, code } = errorBody(error);
      // An existing memory file is only overwritten on a second, explicit click.
      setNeedsForce(decision === 'approve' && code === 'memory_exists');
      setMessage({ ok: false, text: text ?? localize('com_mindstone_not_changed') });
    } finally {
      setBusy(false);
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_appr_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_appr_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">{localize('com_mindstone_appr_intro')}</p>
        {loadError && (
          <p role="alert" className="text-red-600">
            {loadError}
          </p>
        )}
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}

        <section className={card} aria-labelledby="ms-appr-list">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="ms-appr-list" className="text-lg font-medium">
              {localize('com_mindstone_appr_list', { 0: String(counts?.pending ?? 0) })}
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              {localize('com_mindstone_appr_show_all')}
            </label>
          </div>
          {actions.length === 0 ? (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_appr_none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {actions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left hover:bg-surface-hover"
                    aria-current={detail?.id === action.id}
                    onClick={() => void open(action.id)}
                  >
                    <span className="font-mono text-xs">{action.id.slice(0, 8)}</span>{' '}
                    <span className="text-xs text-text-secondary">
                      [{action.status}] {action.kind} · {action.connectorId}
                    </span>
                    <br />
                    <span className="text-sm">{action.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {detail && (
          <section className={card} aria-labelledby="ms-appr-detail">
            <h2 id="ms-appr-detail" className="mb-1 text-lg font-medium">
              {detail.summary}
            </h2>
            <p className="mb-2 text-xs text-text-secondary">
              {detail.kind} · {detail.connectorId} · {detail.status}
              {detail.createdAt ? ` · ${detail.createdAt}` : ''}
              {detail.decidedBy ? ` · ${detail.decidedBy}` : ''}
            </p>
            {detail.memory && (
              <p className="mb-1 text-sm">
                {localize('com_mindstone_appr_memory_path', { 0: detail.memory.path })}
              </p>
            )}
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-sm">
              {payloadText(detail)}
            </pre>
            {detail.status === 'pending' && confirming === null && (
              <div className="mt-3 flex gap-2">
                <button type="button" className={primary} onClick={() => setConfirming('approve')}>
                  {localize('com_mindstone_appr_approve')}
                </button>
                <button type="button" className={secondary} onClick={() => setConfirming('reject')}>
                  {localize('com_mindstone_appr_reject')}
                </button>
              </div>
            )}
            {confirming === 'approve' && (
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-sm">
                  {localize(
                    detail.kind === 'memory_write'
                      ? 'com_mindstone_appr_confirm_memory'
                      : 'com_mindstone_appr_confirm_send',
                  )}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={primary}
                    disabled={busy}
                    onClick={() => void decide('approve')}
                  >
                    {localize('com_mindstone_appr_confirm_approve')}
                  </button>
                  {needsForce && (
                    <button
                      type="button"
                      className={secondary}
                      disabled={busy}
                      onClick={() => void decide('approve', true)}
                    >
                      {localize('com_mindstone_appr_overwrite')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    {localize('com_mindstone_appr_cancel')}
                  </button>
                </div>
              </div>
            )}
            {confirming === 'reject' && (
              <div className="mt-3 flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  {localize('com_mindstone_appr_note')}
                  <textarea
                    className="rounded border border-border-medium bg-surface-secondary p-2"
                    maxLength={2000}
                    rows={2}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={primary}
                    disabled={busy}
                    onClick={() => void decide('reject')}
                  >
                    {localize('com_mindstone_appr_confirm_reject')}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    {localize('com_mindstone_appr_cancel')}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
