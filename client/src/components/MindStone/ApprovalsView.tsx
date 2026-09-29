/**
 * MindStone approvals (MindStone-Agent #84): the Console side of
 * `mindstone approvals`. Lists proposed actions (a connector send, a
 * connector mutation, a memory write, a persona the agent drafted or a skill it
 * proposed in chat, held for
 * a decision), shows the full draft, and approves or rejects it through the
 * gateway admin API, which applies the same guards as the CLI. The draft text
 * is only held in this page's state; nothing here writes it to browser storage
 * or the console. A persona proposal (MindStone-Agent #105) is shown field by
 * field as plain text, never as HTML or markdown, with any non-printing
 * character shown as \u{XXXX}. Approving one only saves it to the personas;
 * making it active is a separate switch on the Personas page. A persona can
 * bring new components (MindStone-Agent #125): each is its own card (a skill,
 * a workflow, a private knowledge base), marked as part of the persona,
 * approved after it, and shown as plain text.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

type Summary = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  kind:
    | 'connector_send'
    | 'connector_mutation'
    | 'memory_write'
    | 'persona_create'
    | 'skill_install'
    | 'workflow_create'
    | 'persona_kb_create';
  connectorId: string;
  summary: string;
  createdAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  /** A persona's component card (MindStone-Agent #125): its persona card. */
  parentApprovalId?: string;
};
type Detail = Summary & {
  send?: { text?: string; chatId?: string };
  memory?: { path: string; content: string };
  mutation?: { operation: string; resource: string; connectorId: string; data: unknown };
  skill?: {
    id: string;
    label: string;
    description: string;
    goal?: string;
    whenToUse?: string[];
    outputs?: string[];
    safetyNotes?: string[];
    instructions?: string;
  };
  persona?: Persona;
  /** A proposed persona's existing components (#125). */
  components?: { skills: string[]; workflows: string[]; knowledgebases: string[] };
  /** The steps of each workflow a proposed persona lists; null when it doesn't exist (#125). */
  listedWorkflows?: Array<{ id: string; steps: unknown[] | null }>;
  /** A workflow proposed with a persona (#125). */
  workflow?: {
    id: string;
    personaId: string;
    definition: { name?: string; description?: string; steps: unknown[] };
  };
  /** A private knowledge base proposed with a persona (#125). */
  knowledgebase?: {
    personaId: string;
    id: string;
    name?: string;
    sources: Array<{ name: string; text: string }>;
  };
};
/** A persona the agent proposed (the gateway's PersonaProposalPayload). */
type Persona = {
  id: string;
  name: string;
  description?: string;
  voice?: string;
  workingStyle?: string;
  boundaries?: string[];
};
type Counts = { pending: number; approved: number; rejected: number };

const BASE = '/api/mindstone/admin';

/** What approving does, by kind; a send or a mutation is queued for its connector. */
const CONFIRM_APPROVE: Partial<Record<Summary['kind'], TranslationKeys>> = {
  memory_write: 'com_mindstone_appr_confirm_memory',
  persona_create: 'com_mindstone_appr_persona_effect',
  skill_install: 'com_mindstone_appr_confirm_skill',
  workflow_create: 'com_mindstone_appr_confirm_workflow',
  persona_kb_create: 'com_mindstone_appr_confirm_kb',
};

function errorBody(error: unknown): { error?: string; code?: string; heard: boolean } {
  const response = (
    error as {
      response?: { status?: number; data?: { error?: unknown; code?: unknown; message?: unknown } };
    }
  )?.response;
  const data = response?.data;
  // The gateway's text, or a Console refusal's own (a 403 says "Forbidden").
  let text: string | undefined;
  if (typeof data?.error === 'string') text = data.error;
  else if (typeof data?.message === 'string') text = data.message;
  return {
    error: text,
    code: typeof data?.code === 'string' ? data.code : undefined,
    // An answer from the Console or the gateway (JSON, or a status below 500).
    // No response, or a front proxy's own 502/504 page, leaves the outcome
    // unknown: the gateway may still be working on it (#125 review).
    heard:
      Boolean(response) &&
      ((response?.status ?? 0) < 500 ||
        (typeof data === 'object' &&
          data !== null &&
          (data.error !== undefined || data.code !== undefined || data.message !== undefined))),
  };
}

/** What the admin is about to approve or reject, as plain text. */
function payloadText(detail: Detail): string {
  if (detail.send) return detail.send.text ?? '';
  if (detail.memory) return detail.memory.content;
  if (detail.mutation) return JSON.stringify(detail.mutation, null, 2);
  return '';
}

/** A persona's or a skill's summary carries text the agent wrote, so it is shown the same way. */
function summaryText(action: Summary): string {
  return action.kind === 'persona_create' ||
    action.kind === 'skill_install' ||
    action.kind === 'workflow_create' ||
    action.kind === 'persona_kb_create'
    ? visibleText(action.summary)
    : action.summary;
}

/** More than two blank lines in a row are shown as a marker, so text can't hide below them. */
export function collapseBlankRuns(text: string, marker: (count: number) => string): string {
  return text.replace(/\n(?:[ \t]*\n){3,}/g, (run) => {
    const blank = run.split('\n').length - 2;
    return `\n\n${marker(blank)}\n\n`;
  });
}

/**
 * The proposed skill, field by field (MindStone-Agent #104), so a field can't
 * pose as another: React renders every value as text, non-printing characters
 * are shown, long runs of blank lines are marked, and nothing is pushed out of
 * view sideways.
 */
function SkillFields({ skill }: { skill: NonNullable<Detail['skill']> }) {
  const localize = useLocalize();
  const cell = 'overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm';
  const shown = (value: string) =>
    collapseBlankRuns(visibleText(value), (count) =>
      localize('com_mindstone_appr_skill_blank_lines', { 0: String(count) }),
    );
  const row = (label: TranslationKeys, value: string | undefined) =>
    value ? (
      <div>
        <dt className="text-xs font-medium text-text-secondary">{localize(label)}</dt>
        <dd className={cell}>{shown(value)}</dd>
      </div>
    ) : null;
  const list = (label: TranslationKeys, items?: string[]) =>
    items?.length ? (
      <div>
        <dt className="text-xs font-medium text-text-secondary">{localize(label)}</dt>
        <dd className="overflow-hidden break-words [overflow-wrap:anywhere]">
          <ul className="list-disc pl-5 text-sm">
            {items.map((item, index) => (
              <li key={index} className="whitespace-pre-wrap">
                {shown(item)}
              </li>
            ))}
          </ul>
        </dd>
      </div>
    ) : null;
  const instructions = skill.instructions ?? '';
  return (
    <dl
      className="flex flex-col gap-2 rounded bg-surface-secondary p-2"
      data-testid="ms-appr-skill"
    >
      {row('com_mindstone_skill_field_label', skill.label)}
      {row('com_mindstone_skill_field_id', skill.id)}
      {row('com_mindstone_skill_field_description', skill.description)}
      {row('com_mindstone_skill_field_goal', skill.goal)}
      {list('com_mindstone_skill_field_when', skill.whenToUse)}
      {list('com_mindstone_skill_field_outputs', skill.outputs)}
      {list('com_mindstone_skill_field_safety', skill.safetyNotes)}
      {instructions ? (
        <div>
          <dt className="text-xs font-medium text-text-secondary">
            {localize('com_mindstone_skill_field_instructions')}{' '}
            <span data-testid="ms-appr-skill-size">
              {localize('com_mindstone_appr_skill_size', {
                0: String(instructions.length),
                1: String(instructions.split('\n').length),
              })}
            </span>
          </dt>
          <dd
            className={`${cell} max-h-80 overflow-y-auto font-mono`}
            data-testid="ms-appr-skill-instructions"
          >
            {shown(instructions)}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** The proposed persona, field by field. React renders every value as text. */
function PersonaFields({ persona }: { persona: Persona }) {
  const localize = useLocalize();
  const row = (label: string, value: string | undefined) =>
    value ? (
      <div>
        <dt className="text-xs font-medium text-text-secondary">{label}</dt>
        <dd className="overflow-hidden whitespace-pre-wrap break-words text-sm">
          {visibleText(value)}
        </dd>
      </div>
    ) : null;
  return (
    <dl
      className="flex flex-col gap-2 rounded bg-surface-secondary p-2"
      data-testid="ms-appr-persona"
    >
      {row(localize('com_mindstone_appr_persona_name'), persona.name)}
      {row(localize('com_mindstone_appr_persona_id'), persona.id)}
      {row(localize('com_mindstone_appr_persona_description'), persona.description)}
      {row(localize('com_mindstone_appr_persona_voice'), persona.voice)}
      {row(localize('com_mindstone_appr_persona_working_style'), persona.workingStyle)}
      {persona.boundaries?.length ? (
        <div>
          <dt className="text-xs font-medium text-text-secondary">
            {localize('com_mindstone_appr_persona_boundaries')}
          </dt>
          <dd className="overflow-hidden break-words">
            <ul className="list-disc pl-5 text-sm">
              {persona.boundaries.map((item, index) => (
                <li key={index}>{visibleText(item)}</li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * A persona's component card (MindStone-Agent #125): the proposed workflow's
 * steps or knowledge base's sources, as plain text with non-printing
 * characters shown.
 */
function ComponentFields({ detail }: { detail: Detail }) {
  const localize = useLocalize();
  const block =
    'max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-sm';
  if (detail.workflow) {
    return (
      <div className="flex flex-col gap-1" data-testid="ms-appr-workflow">
        <p className="text-sm">
          {localize('com_mindstone_appr_workflow_for', {
            0: visibleText(detail.workflow.id),
            1: visibleText(detail.workflow.personaId),
          })}
        </p>
        <pre className={block}>
          {visibleText(JSON.stringify(detail.workflow.definition, null, 2))}
        </pre>
      </div>
    );
  }
  if (detail.knowledgebase) {
    const kb = detail.knowledgebase;
    return (
      <div className="flex flex-col gap-1" data-testid="ms-appr-kb">
        <p className="text-sm">
          {localize('com_mindstone_appr_kb_for', {
            0: visibleText(kb.id),
            1: visibleText(kb.personaId),
          })}
        </p>
        {kb.name && (
          <p className="text-sm" data-testid="ms-appr-kb-name">
            {localize('com_mindstone_appr_kb_name', { 0: visibleText(kb.name) })}
          </p>
        )}
        {kb.sources.map((source) => (
          <pre key={source.name} className={block}>
            {collapseBlankRuns(visibleText(source.text), (count) =>
              localize('com_mindstone_appr_skill_blank_lines', { 0: String(count) }),
            )}
          </pre>
        ))}
      </div>
    );
  }
  return null;
}

/** What the gateway answers for an approved component card (#125). */
type ApproveResult = {
  kind?: string;
  listed?: boolean;
  note?: string;
  persona?: { id: string; listed: boolean; note: string };
  ingested?: { entryCount?: number; error?: string };
};

/**
 * The outcome of approving a persona's component, as the gateway said it: a
 * KB whose ingest failed, or a component that couldn't join its persona, is
 * not a plain "Approved." (#125 review).
 */
function componentOutcome(
  result: ApproveResult | undefined,
): { ok: boolean; text: (localize: ReturnType<typeof useLocalize>) => string } | undefined {
  if (!result) return undefined;
  if (result.kind === 'persona_kb_create' && result.ingested) {
    const { error, entryCount } = result.ingested;
    // Written into a persona that doesn't load: not in use, whatever the ingest did.
    const unused = result.listed === false;
    const notInUse = (l: ReturnType<typeof useLocalize>) =>
      unused
        ? ` ${l('com_mindstone_appr_kb_not_in_use', {
            0: visibleText(result.note?.trim() || l('com_mindstone_appr_persona_not_loading')),
          })}`
        : '';
    return typeof error === 'string'
      ? {
          ok: false,
          text: (l) =>
            `${l('com_mindstone_appr_kb_ingest_failed', { 0: visibleText(error) })}${notInUse(l)}`,
        }
      : {
          ok: !unused,
          text: (l) =>
            `${l('com_mindstone_appr_kb_ingested', { 0: String(entryCount ?? 0) })}${notInUse(l)}`,
        };
  }
  const joined =
    result.kind === 'workflow_create' && typeof result.listed === 'boolean'
      ? { listed: result.listed, note: result.note ?? '' }
      : result.persona;
  if (joined && !joined.listed) {
    return {
      ok: false,
      text: (l) => l('com_mindstone_appr_component_not_joined', { 0: visibleText(joined.note) }),
    };
  }
  return undefined;
}

/**
 * The existing components a proposed persona lists (#125): what an empty
 * list means, and each listed workflow's steps, since a workflow can route a
 * turn to another persona.
 */
function PersonaComponents({
  components,
  listedWorkflows,
  pending,
}: {
  components: NonNullable<Detail['components']>;
  listedWorkflows?: Detail['listedWorkflows'];
  /** Only a pending card's approval can still be refused for a missing workflow. */
  pending: boolean;
}) {
  const localize = useLocalize();
  const line = (label: TranslationKeys, ids: string[], empty?: TranslationKeys) => {
    if (!ids.length) {
      return empty ? <p className="text-sm">{localize(empty)}</p> : null;
    }
    return (
      <p className="text-sm">
        {localize(label)}:{' '}
        <span className="font-mono">{ids.map((id) => visibleText(id)).join(', ')}</span>
      </p>
    );
  };
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="ms-appr-persona-components">
      {line(
        'com_mindstone_appr_persona_skills',
        components.skills,
        'com_mindstone_appr_persona_all_skills',
      )}
      {line('com_mindstone_appr_persona_workflows', components.workflows)}
      {listedWorkflows?.map((workflow) =>
        workflow.steps ? (
          <pre
            key={workflow.id}
            className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-xs"
            data-testid={`ms-appr-listed-workflow-${workflow.id}`}
          >
            {visibleText(`${workflow.id}:\n${JSON.stringify(workflow.steps, null, 2)}`)}
          </pre>
        ) : (
          <p key={workflow.id} className="text-sm text-text-secondary">
            {localize(
              pending
                ? 'com_mindstone_appr_persona_workflow_missing'
                : 'com_mindstone_appr_persona_workflow_unreadable',
              { 0: visibleText(workflow.id) },
            )}
          </p>
        ),
      )}
      {line(
        'com_mindstone_appr_persona_kbs',
        components.knowledgebases,
        'com_mindstone_appr_persona_all_kbs',
      )}
    </div>
  );
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
  // After a persona is approved, the Personas page is where to make it active.
  const [personasLink, setPersonasLink] = useState(false);

  // Only the latest list read is shown: an older one answering late never
  // puts a decided card back to pending (#125 review).
  const listRead = useRef(0);
  const load = useCallback(async () => {
    const read = ++listRead.current;
    try {
      const result = await request.get<{ actions: Summary[]; status: Counts }>(
        `${BASE}/approvals${showAll ? '?all=1' : ''}`,
      );
      if (read !== listRead.current) return;
      setActions(result.actions);
      setCounts(result.status);
      setLoadError(null);
    } catch (error) {
      if (read !== listRead.current) return;
      setLoadError(errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'));
    }
  }, [localize, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  // The card clicked last: an answer for an earlier click is dropped (#125 review).
  const opening = useRef<string | null>(null);
  // After a decision, focus goes to what it says, not back to the top of the page.
  const statusLine = useRef<HTMLParagraphElement>(null);
  // Only when focus was lost (the card it was in went away), never away from
  // wherever the owner has gone meanwhile (#125 review).
  useEffect(() => {
    const active = document.activeElement;
    if (message && (!active || active === document.body)) statusLine.current?.focus();
  }, [message]);
  // The gateway said this card's persona card no longer exists (persona_missing).
  const [parentGone, setParentGone] = useState(false);
  // Each card read is numbered: an older read of the same card answering
  // late never replaces a newer one (#125 review).
  const cardRead = useRef(0);
  /**
   * `keepForm`: a re-read of the same card after a decision keeps the reject
   * note typed for a retry. Resolves to what became of this read: shown, or
   * superseded (a newer read, or another card, won), or failed (its own error
   * is shown).
   */
  const open = async (id: string, keepForm = false): Promise<'shown' | 'superseded' | 'failed'> => {
    const read = ++cardRead.current;
    // A re-read of the same card keeps what the gateway said about its persona.
    if (opening.current !== id) setParentGone(false);
    opening.current = id;
    setMessage(null);
    setPersonasLink(false);
    setNeedsForce(false);
    if (!keepForm) {
      setConfirming(null);
      setNote('');
    }
    // The previous card goes at once, so its buttons can't act while this one loads.
    setDetail(null);
    try {
      const result = await request.get<{ action: Detail }>(
        `${BASE}/approvals/${encodeURIComponent(id)}`,
      );
      if (opening.current !== id || read !== cardRead.current) return 'superseded';
      setDetail(result.action);
      if (keepForm && result.action.status !== 'pending') setConfirming(null);
      return 'shown';
    } catch (error) {
      if (opening.current !== id || read !== cardRead.current) return 'superseded';
      setDetail(null);
      setMessage({
        ok: false,
        text: errorBody(error).error ?? localize('com_mindstone_gateway_unreachable'),
      });
      return 'failed';
    }
  };

  const decide = async (decision: 'approve' | 'reject', force = false) => {
    if (!detail) return;
    // The card this decision is for. If the owner opens another card while it
    // is in flight (an approve can take minutes), its answer never touches
    // that card: no message, no force offer, no close (#125 review).
    const decided = detail;
    const stillOpen = () => opening.current === decided.id;
    setBusy(true);
    try {
      const body: { force?: boolean; note?: string } = {};
      if (decision === 'approve' && force) body.force = true;
      if (decision === 'reject' && note.trim()) body.note = note;
      const answer = (await request.post(
        `${BASE}/approvals/${encodeURIComponent(decided.id)}/${decision}`,
        body,
      )) as { result?: ApproveResult } | undefined;
      if (!stillOpen()) {
        await load();
        return;
      }
      const persona = decision === 'approve' ? decided.persona : undefined;
      const outcome = decision === 'approve' ? componentOutcome(answer?.result) : undefined;
      let text: string;
      if (persona) {
        text = localize('com_mindstone_appr_persona_saved', { 0: visibleText(persona.name) });
      } else if (outcome) {
        text = outcome.text(localize);
      } else {
        text = localize(
          decision === 'approve' ? 'com_mindstone_appr_approved' : 'com_mindstone_appr_rejected',
        );
      }
      setMessage({ ok: outcome?.ok ?? true, text });
      setPersonasLink(Boolean(persona));
      setDetail(null);
      setConfirming(null);
      setNeedsForce(false);
      setNote('');
      await load();
    } catch (error) {
      if (!stillOpen()) {
        void load();
        return;
      }
      const { error: text, code, heard } = errorBody(error);
      // No answer at all (a dropped connection): the decision may have gone
      // through, so the page doesn't say it didn't.
      const shown =
        text ??
        localize(heard ? 'com_mindstone_not_changed' : 'com_mindstone_appr_outcome_unknown');
      // An existing memory file or installed skill is only replaced on a second,
      // explicit click; a persona's new skill never replaces one (#125).
      setNeedsForce(
        decision === 'approve' &&
          (code === 'memory_exists' || (code === 'skill_exists' && !decided.parentApprovalId)),
      );
      // The persona card or folder is gone: "approve the persona first" no longer
      // applies. Set once for the card, cleared only when a card is opened.
      if (code === 'persona_missing' || code === 'invalid_persona') setParentGone(true);
      // Refusals that changed the card anyway (its persona was rejected, so it
      // was too; or the Console stopped waiting on an approve that went on):
      // the list and the card are read again (#125 review).
      // A reject keeps the owner's note and form across the re-read, for a retry.
      if (
        code === 'persona_rejected' ||
        code === 'gateway_timeout' ||
        code === 'already_decided' ||
        code === 'queue_busy' ||
        code === 'changed' ||
        code === undefined
      ) {
        void load();
        void open(decided.id, decision === 'reject').then((read) => {
          // A newer read of the card says its own; otherwise the decision's
          // outcome is what the owner needs, over the card or in its place.
          if (read === 'superseded' || !stillOpen()) return;
          if (read === 'shown' || heard) setMessage({ ok: false, text: shown });
          else setMessage({ ok: false, text: localize('com_mindstone_appr_no_answer_no_card') });
        });
      }
      // The card is gone: it leaves the page, and the list is read again.
      if (code === 'not_found') {
        void load();
        setDetail(null);
      }
      // A persona id that exists (persona_exists) is never overwritten, and
      // one the config already uses (persona_referenced) is never saved: the
      // gateway's text says to ask for a new name or reject.
      setPersonasLink(false);
      setMessage({ ok: false, text: shown });
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
          <p
            role="status"
            ref={statusLine}
            tabIndex={-1}
            className={message.ok ? 'text-green-600' : 'text-red-600'}
          >
            {message.text}
            {personasLink && (
              <>
                {' '}
                <Link to="/mindstone/personas" className="underline">
                  {localize('com_mindstone_appr_personas_link')}
                </Link>
              </>
            )}
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
                // Locked with the list: the decision's own list read would undo it.
                disabled={busy}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              {localize('com_mindstone_appr_show_all')}
            </label>
          </div>
          {/* Always mounted, so a screen reader announces the text when it appears. */}
          <p className="text-sm text-text-secondary" aria-live="polite">
            {busy && (
              <span data-testid="ms-appr-deciding">{localize('com_mindstone_appr_deciding')}</span>
            )}
          </p>
          {actions.length === 0 ? (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_appr_none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {actions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                    aria-current={detail?.id === action.id}
                    // One decision at a time: while it is in flight the list
                    // is locked, so its answer always lands on its own card.
                    disabled={busy}
                    onClick={() => void open(action.id)}
                  >
                    <span className="font-mono text-xs">{action.id.slice(0, 8)}</span>{' '}
                    <span className="text-xs text-text-secondary">
                      [{action.status}] {action.kind} · {action.connectorId}
                    </span>
                    <br />
                    <span className="text-sm">{summaryText(action)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {detail && (
          <section className={card} aria-labelledby="ms-appr-detail">
            <h2 id="ms-appr-detail" className="mb-1 text-lg font-medium">
              {summaryText(detail)}
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
            {detail.parentApprovalId && detail.status === 'pending' && !parentGone && (
              <p className="mb-1 text-sm text-text-secondary" data-testid="ms-appr-part-of-persona">
                {localize('com_mindstone_appr_part_of_persona')}
              </p>
            )}
            {detail.persona ? (
              <>
                <PersonaFields persona={detail.persona} />
                {detail.components && (
                  <PersonaComponents
                    components={detail.components}
                    listedWorkflows={detail.listedWorkflows}
                    pending={detail.status === 'pending'}
                  />
                )}
                {detail.status === 'pending' && (
                  <>
                    {/* The approve confirmation says the same, so it isn't shown twice. */}
                    {confirming !== 'approve' && (
                      <p className="mt-2 text-sm">
                        {localize('com_mindstone_appr_persona_effect')}
                      </p>
                    )}
                    <p className="mt-1 text-sm text-text-secondary">
                      {localize('com_mindstone_persona_routes_note')}
                    </p>
                  </>
                )}
              </>
            ) : null}
            {detail.skill && <SkillFields skill={detail.skill} />}
            {detail.skill && detail.parentApprovalId && detail.status === 'pending' && (
              <p className="mt-1 text-sm" data-testid="ms-appr-skill-everyone">
                {localize('com_mindstone_appr_skill_everyone')}
              </p>
            )}
            {(detail.workflow || detail.knowledgebase) && <ComponentFields detail={detail} />}
            {!detail.persona && !detail.skill && !detail.workflow && !detail.knowledgebase && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-secondary p-2 text-sm">
                {payloadText(detail)}
              </pre>
            )}
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
            {confirming === 'approve' && detail.status === 'pending' && (
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-sm">
                  {localize(CONFIRM_APPROVE[detail.kind] ?? 'com_mindstone_appr_confirm_send')}
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
                      {localize(
                        detail.kind === 'skill_install'
                          ? 'com_mindstone_appr_skill_replace'
                          : 'com_mindstone_appr_overwrite',
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      setNeedsForce(false);
                    }}
                  >
                    {localize('com_mindstone_appr_cancel')}
                  </button>
                </div>
              </div>
            )}
            {confirming === 'reject' && detail.status === 'pending' && (
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
                    onClick={() => {
                      setConfirming(null);
                      setNeedsForce(false);
                    }}
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
