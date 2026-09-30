/**
 * MindStone system status (mindstone-console #6): renders the `system` block
 * the gateway already returns from /admin/status. Read-only; every section is
 * optional so an older or newer gateway cannot blank the settings page.
 */
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

type Connector = {
  connectorId: string;
  enabled?: boolean;
  credential?: {
    configured?: boolean;
    present?: boolean;
    source?: string;
    error?: string;
    warning?: string;
  };
  sendPolicy?: { effective?: string; overridden?: boolean; warning?: string };
  runtime?: { state?: string; lastError?: string; updatedAt?: string };
  /** `error` is set when the queue file can't be read; the counts are then unknown, not 0. */
  queue?: { pending?: number; delivered?: number; dead?: number; error?: string };
};

export type SystemStatusData = {
  ok?: boolean;
  config?: { path?: string; exists?: boolean; error?: string; agentCount?: number };
  agents?: Array<{
    agentId: string;
    name?: string;
    identityExists?: boolean;
    userExists?: boolean;
    error?: string;
  }>;
  handoff?: { exists?: boolean; bytes?: number; updatedAt?: string; tokenEstimate?: number };
  gateway?: {
    baseUrl?: string;
    auth?: { mode?: string; required?: boolean };
    http?: {
      modelsEnabled?: boolean;
      chatCompletionsEnabled?: boolean;
      responsesEnabled?: boolean;
    };
  };
  webchat?: { enabled?: boolean; url?: string; apiAuthApplies?: boolean };
  memory?: {
    sqlite?: {
      present?: boolean;
      sources?: number;
      chunks?: number;
      embeddedChunks?: number;
      duplicateTextChunks?: number;
      vectorBackend?: string;
      sqliteVec?: { available?: boolean; version?: string; error?: string };
      updatedAt?: string;
      error?: string;
    };
  };
  routing?: { mode?: string; defaultAgentId?: string; defaultModel?: string };
  piSessionSafety?: {
    active?: boolean;
    routingMode?: string;
    usesGlobalPiAgentDir?: boolean;
    resumeCap?: { enabled?: boolean; maxEntries?: number };
  };
  personas?: {
    count?: number;
    brokenCount?: number;
    configuredActive?: string;
    routeRules?: number;
  };
  skills?: {
    builtinCount?: number;
    installedCount?: number;
    draftCount?: number;
    brokenCount?: number;
  };
  knowledgebases?: {
    count?: number;
    indexedCount?: number;
    brokenCount?: number;
    entryCount?: number;
  };
  connectors?: Connector[];
};

/** Gateway text as a string, whatever arrives: a wrong type must not blank the page. */
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value == null ? '' : JSON.stringify(value);
};
/**
 * Gateway error text with credential shapes masked. The gateway is meant to
 * keep credentials out of what it reports; this is a second layer for text
 * such as a failed request URL that carried a bot token.
 */
const SECRET_SHAPES: RegExp[] = [
  /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token, also inside a /bot<token>/ URL
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const masked = (value: unknown): string => {
  let out = text(value).replace(/(\/\/)[^/\s@]+@/g, '$1***@'); // URL user info
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (match, scheme?: string) =>
      typeof scheme === 'string' && /^(Bearer|Basic)$/i.test(scheme) ? `${scheme} ***` : '***',
    );
  }
  return out;
};
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const n = (value: unknown) => new Intl.NumberFormat().format(count(value));
const when = (iso: unknown) => {
  const date = typeof iso === 'string' ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : text(iso);
};

const STATES: Record<string, TranslationKeys> = {
  running: 'com_mindstone_sys_state_running',
  stopped: 'com_mindstone_sys_state_stopped',
  error: 'com_mindstone_sys_state_error',
  never_started: 'com_mindstone_sys_state_never_started',
};
const POLICIES: Record<string, TranslationKeys> = {
  auto: 'com_mindstone_sys_policy_auto',
  approval_required: 'com_mindstone_sys_policy_approval',
};

/** A note is information, not a problem: it isn't counted. */
type Issue = { tone: 'error' | 'warning' | 'note'; text: string };

function Issues({ issues }: { issues: Issue[] }) {
  return (
    <>
      {issues.map((issue, i) => (
        <p
          key={i}
          className={
            issue.tone === 'error'
              ? 'text-sm text-red-500'
              : issue.tone === 'warning'
                ? 'text-sm text-orange-500'
                : 'text-sm text-text-secondary'
          }
        >
          {issue.text}
        </p>
      ))}
    </>
  );
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm" data-testid={testId}>
      <dt className="text-text-secondary">{label}:</dt>
      <dd>{children}</dd>
    </div>
  );
}

type Localize = ReturnType<typeof useLocalize>;
type SqliteStatus = NonNullable<NonNullable<SystemStatusData['memory']>['sqlite']>;

/** What's wrong with the memory store, if anything. */
function memoryIssuesOf(sqlite: SqliteStatus | undefined, localize: Localize): Issue[] {
  const issues: Issue[] = [];
  if (sqlite && sqlite.present !== false && sqlite.sqliteVec?.available === false) {
    if (sqlite.vectorBackend === 'js-cosine') {
      // Vector search works without the extension (built-in cosine search): a note, not a problem.
      issues.push({ tone: 'note', text: localize('com_mindstone_sys_sqlite_vec_note') });
    } else if (sqlite.sqliteVec.error) {
      issues.push({
        tone: 'warning',
        text: localize('com_mindstone_sys_sqlite_vec', { 0: masked(sqlite.sqliteVec.error) }),
      });
    }
  }
  if (sqlite?.error) issues.push({ tone: 'error', text: masked(sqlite.error) });
  return issues;
}

/**
 * The memory store's status: search backend, what's indexed and embedded, and
 * any problem. Shown in the system status and on the Memory page (#53).
 */
export function MemoryStatus({ memory }: { memory?: SystemStatusData['memory'] }) {
  const localize = useLocalize();
  const sqlite = memory?.sqlite;
  if (!sqlite) {
    return (
      <p className="text-sm text-text-secondary" data-testid="ms-sys-memory-unknown">
        {localize('com_mindstone_sys_none')}
      </p>
    );
  }
  const heading = 'mb-1 mt-3 font-medium';
  const memoryIssues = memoryIssuesOf(sqlite, localize);
  return (
    <section aria-labelledby="ms-sys-memory" data-testid="ms-sys-memory">
      <h3 id="ms-sys-memory" className={heading}>
        {localize('com_mindstone_sys_memory')}
      </h3>
      {sqlite.present === false ? (
        <p className="text-sm text-text-secondary">{localize('com_mindstone_sys_memory_none')}</p>
      ) : (
        <dl>
          <Row label={localize('com_mindstone_sys_search')}>{text(sqlite.vectorBackend)}</Row>
          <Row label={localize('com_mindstone_sys_indexed')}>
            {localize('com_mindstone_sys_memory_counts', {
              0: n(sqlite.sources),
              1: n(sqlite.chunks),
              2: n(sqlite.embeddedChunks),
            })}
          </Row>
          {Boolean(count(sqlite.duplicateTextChunks)) && (
            <Row label={localize('com_mindstone_sys_duplicates')}>
              {n(sqlite.duplicateTextChunks)}
            </Row>
          )}
          {Boolean(sqlite.updatedAt) && (
            <Row label={localize('com_mindstone_sys_updated')}>{when(sqlite.updatedAt)}</Row>
          )}
        </dl>
      )}
      <Issues issues={memoryIssues} />
    </section>
  );
}

export default function SystemStatus({ system }: { system?: SystemStatusData | null }) {
  const localize = useLocalize();
  if (!system || typeof system !== 'object') {
    return (
      <p className="text-sm text-text-secondary" data-testid="ms-system-empty">
        {localize('com_mindstone_sys_none')}
      </p>
    );
  }
  const yes = (value: boolean | undefined) =>
    localize(value ? 'com_mindstone_sys_yes' : 'com_mindstone_sys_no');
  const on = (value: boolean | undefined) =>
    localize(value ? 'com_mindstone_sys_on' : 'com_mindstone_sys_off');
  const heading = 'mb-1 mt-3 font-medium';
  const {
    config,
    gateway,
    webchat,
    memory,
    routing,
    piSessionSafety: pi,
    personas,
    skills,
    knowledgebases: kbs,
    connectors,
    handoff,
    agents,
  } = system;
  const sqlite = memory?.sqlite;
  const isRow = <T,>(row: T | null | undefined): row is T =>
    Boolean(row) && typeof row === 'object';
  const connectorRows = Array.isArray(connectors) ? connectors.filter(isRow) : null;
  const agentRows = Array.isArray(agents) ? agents.filter(isRow) : [];

  // Every problem shown below, collected once so the top line can count them.
  const configIssues: Issue[] = [];
  if (config?.exists === false) {
    configIssues.push({
      tone: 'error',
      text: localize('com_mindstone_sys_config_missing', { 0: text(config.path) }),
    });
  }
  if (config?.error) configIssues.push({ tone: 'error', text: masked(config.error) });

  const memoryIssues = memoryIssuesOf(sqlite, localize);

  const piIssues: Issue[] =
    pi?.active && pi.usesGlobalPiAgentDir
      ? [{ tone: 'warning', text: localize('com_mindstone_sys_pi_global') }]
      : [];

  const contentIssues: Issue[] = [];
  const broken = [personas?.brokenCount, skills?.brokenCount, kbs?.brokenCount].map(count);
  if (broken.some(Boolean)) {
    contentIssues.push({
      tone: 'warning',
      text: localize('com_mindstone_sys_broken', {
        0: n(broken[0]),
        1: n(broken[1]),
        2: n(broken[2]),
      }),
    });
  }
  if (personas?.configuredActive && count(personas.count) === 0) {
    contentIssues.push({
      tone: 'warning',
      text: localize('com_mindstone_sys_persona_missing', { 0: text(personas.configuredActive) }),
    });
  }

  const connectorIssues = (c: Connector): Issue[] => {
    const issues: Issue[] = [];
    // The queue is read now, so an unreadable one is a problem whether or not the connector runs.
    if (c.queue?.error) {
      issues.push({
        tone: 'error',
        text: localize('com_mindstone_sys_queue_unreadable', { 0: masked(c.queue.error) }),
      });
    }
    // A disabled connector isn't run, so what it last reported isn't a problem now.
    if (!c.enabled) return issues;
    const state = text(c.runtime?.state);
    const lastError = masked(c.runtime?.lastError);
    const credentialError = masked(c.credential?.error);
    if (c.credential?.configured && !c.credential.present) {
      // The runtime error usually repeats the credential error; show it once.
      if (!(credentialError && lastError.includes(credentialError))) {
        issues.push({
          tone: 'error',
          text: credentialError || localize('com_mindstone_sys_credential_missing'),
        });
      }
    }
    if (c.credential?.warning) issues.push({ tone: 'warning', text: masked(c.credential.warning) });
    if (c.sendPolicy?.warning) issues.push({ tone: 'warning', text: masked(c.sendPolicy.warning) });
    if (lastError) issues.push({ tone: 'error', text: lastError });
    if (state === 'error') {
      issues.push({ tone: 'warning', text: localize('com_mindstone_sys_failed_restart') });
    }
    if (state === 'never_started' || state === 'stopped') {
      issues.push({ tone: 'warning', text: localize('com_mindstone_sys_not_running') });
    }
    const dead = count(c.queue?.dead);
    if (dead) {
      issues.push({
        tone: 'warning',
        text: localize(dead === 1 ? 'com_mindstone_sys_dead_one' : 'com_mindstone_sys_dead', {
          count: dead,
        }),
      });
    }
    return issues;
  };

  const agentIssues = (a: { identityExists?: boolean; error?: string }): Issue[] => [
    ...(a.identityExists === false
      ? [{ tone: 'warning' as const, text: localize('com_mindstone_sys_no_identity') }]
      : []),
    ...(a.error ? [{ tone: 'error' as const, text: masked(a.error) }] : []),
  ];

  const problemCount =
    configIssues.length +
    memoryIssues.filter((issue) => issue.tone !== 'note').length +
    piIssues.length +
    contentIssues.length +
    (connectorRows ?? []).reduce((total, c) => total + connectorIssues(c).length, 0) +
    agentRows.reduce((total, a) => total + agentIssues(a).length, 0);

  let overall: { className: string; message: string };
  if (system.ok === false) {
    overall = { className: 'text-red-500', message: localize('com_mindstone_sys_not_ok') };
  } else if (problemCount > 0) {
    overall = {
      className: 'text-orange-500',
      message: localize(
        problemCount === 1 ? 'com_mindstone_sys_issues_one' : 'com_mindstone_sys_issues',
        { count: problemCount },
      ),
    };
    if (system.ok === true) {
      overall.message = localize(
        problemCount === 1 ? 'com_mindstone_sys_ok_issues_one' : 'com_mindstone_sys_ok_issues',
        { count: problemCount },
      );
    }
  } else if (system.ok === true) {
    overall = { className: 'text-green-600', message: localize('com_mindstone_sys_ok') };
  } else {
    // A status without `ok` says nothing about the core checks either way.
    overall = {
      className: 'text-text-secondary',
      message: localize('com_mindstone_sys_ok_unknown'),
    };
  }

  return (
    <div data-testid="ms-system">
      <p data-testid="ms-system-overall" className={overall.className}>
        {overall.message}
      </p>
      <Issues issues={configIssues} />

      {gateway && (
        <section aria-labelledby="ms-sys-gateway">
          <h3 id="ms-sys-gateway" className={heading}>
            {localize('com_mindstone_sys_gateway')}
          </h3>
          <dl>
            <Row label={localize('com_mindstone_sys_address')}>{text(gateway.baseUrl)}</Row>
            <Row label={localize('com_mindstone_sys_sign_in')} testId="ms-sys-signin">
              {text(gateway.auth?.mode)}
              {gateway.auth?.required === false
                ? ` (${localize('com_mindstone_sys_not_required')})`
                : ''}
            </Row>
            <Row label={localize('com_mindstone_sys_http_api')} testId="ms-sys-http">
              {localize('com_mindstone_sys_http_detail', {
                0: on(gateway.http?.modelsEnabled),
                1: on(gateway.http?.chatCompletionsEnabled),
                2: on(gateway.http?.responsesEnabled),
              })}
            </Row>
            {routing && (
              <Row label={localize('com_mindstone_sys_routing')} testId="ms-sys-routing">
                {[routing.mode, routing.defaultAgentId, routing.defaultModel]
                  .map(text)
                  .filter(Boolean)
                  .join(', ')}
              </Row>
            )}
          </dl>
        </section>
      )}

      {webchat && (
        <section aria-labelledby="ms-sys-webchat">
          <h3 id="ms-sys-webchat" className={heading}>
            {localize('com_mindstone_sys_webchat')}
          </h3>
          <dl>
            <Row label={localize('com_mindstone_sys_enabled')} testId="ms-sys-webchat-enabled">
              {yes(webchat.enabled)}
            </Row>
            {webchat.url && (
              <Row label={localize('com_mindstone_sys_address')}>{text(webchat.url)}</Row>
            )}
            <Row label={localize('com_mindstone_sys_api_sign_in')}>
              {yes(webchat.apiAuthApplies)}
            </Row>
          </dl>
        </section>
      )}

      {sqlite && <MemoryStatus memory={memory} />}

      {pi && (
        <section aria-labelledby="ms-sys-pi" data-testid="ms-sys-pi">
          <h3 id="ms-sys-pi" className={heading}>
            {localize('com_mindstone_sys_pi')}
          </h3>
          <dl>
            <Row label={localize('com_mindstone_sys_pi_sessions')}>
              {pi.active
                ? localize('com_mindstone_sys_pi_in_use')
                : localize('com_mindstone_sys_pi_not_used', { 0: text(pi.routingMode) })}
            </Row>
            {pi.active && (
              <Row label={localize('com_mindstone_sys_pi_dir_isolated')}>
                {yes(!pi.usesGlobalPiAgentDir)}
              </Row>
            )}
            {pi.active && pi.resumeCap && (
              <Row label={localize('com_mindstone_sys_resume_cap')}>
                {pi.resumeCap.enabled
                  ? localize('com_mindstone_sys_entries', { 0: n(pi.resumeCap.maxEntries) })
                  : on(false)}
              </Row>
            )}
          </dl>
          <Issues issues={piIssues} />
        </section>
      )}

      {(personas || skills || kbs) && (
        <section aria-labelledby="ms-sys-content">
          <h3 id="ms-sys-content" className={heading}>
            {localize('com_mindstone_sys_content')}
          </h3>
          <dl>
            {personas && (
              <Row label={localize('com_mindstone_sys_personas')} testId="ms-sys-personas">
                {localize('com_mindstone_sys_personas_count', { 0: n(personas.count) })}
              </Row>
            )}
            {personas?.configuredActive && (
              <Row
                label={localize('com_mindstone_sys_persona_active')}
                testId="ms-sys-persona-active"
              >
                {text(personas.configuredActive)}
              </Row>
            )}
            {Boolean(count(personas?.routeRules)) && (
              <Row label={localize('com_mindstone_sys_persona_routes')}>
                {n(personas?.routeRules)}
              </Row>
            )}
            {skills && (
              <Row label={localize('com_mindstone_sys_skills')} testId="ms-sys-skills">
                {localize('com_mindstone_sys_skills_detail', {
                  0: n(skills.builtinCount),
                  1: n(skills.installedCount),
                  2: n(skills.draftCount),
                })}
              </Row>
            )}
            {kbs && (
              <Row label={localize('com_mindstone_sys_kbs')}>
                {localize('com_mindstone_sys_kbs_detail', {
                  0: n(kbs.count),
                  1: n(kbs.indexedCount),
                  2: n(kbs.entryCount),
                })}
              </Row>
            )}
          </dl>
          <Issues issues={contentIssues} />
        </section>
      )}

      {connectorRows && (
        <section aria-labelledby="ms-sys-connectors">
          <h3 id="ms-sys-connectors" className={heading}>
            {localize('com_mindstone_sys_connectors')}
          </h3>
          {connectorRows.length === 0 ? (
            <p className="text-sm text-text-secondary">
              {localize('com_mindstone_sys_connectors_none')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {connectorRows.map((c, index) => {
                const state = text(c.runtime?.state);
                const stateLabel = Object.hasOwn(STATES, state) ? localize(STATES[state]) : state;
                const policy = text(c.sendPolicy?.effective);
                // Only a policy worth knowing: approval required, or a default overridden.
                // (A connector with no replies, like calendar, reports its default "auto".)
                const showPolicy =
                  policy === 'approval_required' || c.sendPolicy?.overridden === true;
                return (
                  <li
                    key={`${text(c.connectorId)}:${index}`}
                    data-testid={`ms-sys-connector-${text(c.connectorId)}`}
                    className="text-sm"
                  >
                    <strong>{text(c.connectorId)}</strong>{' '}
                    {localize(
                      c.enabled ? 'com_mindstone_sys_enabled_lc' : 'com_mindstone_sys_disabled_lc',
                    )}
                    {stateLabel
                      ? `, ${
                          c.runtime?.updatedAt
                            ? localize('com_mindstone_sys_state_as_of', {
                                0: stateLabel,
                                1: when(c.runtime.updatedAt),
                              })
                            : stateLabel
                        }`
                      : ''}
                    <div className="text-text-secondary">
                      {/* An unreadable queue has unknown counts, not zero; its error shows below. */}
                      {c.queue?.error
                        ? localize('com_mindstone_sys_queue_unknown')
                        : localize('com_mindstone_sys_queue', {
                            0: n(c.queue?.pending),
                            1: n(c.queue?.delivered),
                            2: n(c.queue?.dead),
                          })}
                      {policy && showPolicy
                        ? ` ${localize('com_mindstone_sys_send_policy', {
                            0: Object.hasOwn(POLICIES, policy)
                              ? localize(POLICIES[policy])
                              : policy,
                          })}`
                        : ''}
                    </div>
                    <Issues issues={connectorIssues(c)} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {agentRows.length > 0 && (
        <section aria-labelledby="ms-sys-agents">
          <h3 id="ms-sys-agents" className={heading}>
            {localize('com_mindstone_sys_agents')}
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {agentRows.map((a, index) => (
              <li
                key={`${text(a.agentId)}:${index}`}
                data-testid={`ms-sys-agent-${text(a.agentId)}`}
              >
                <strong>{text(a.name) || text(a.agentId)}</strong>
                <Issues issues={agentIssues(a)} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {handoff && (
        <section aria-labelledby="ms-sys-handoff">
          <h3 id="ms-sys-handoff" className={heading}>
            {localize('com_mindstone_sys_handoff')}
          </h3>
          <p className="text-sm">
            {handoff.exists
              ? localize('com_mindstone_sys_handoff_detail', {
                  0: n(handoff.tokenEstimate),
                  1: when(handoff.updatedAt),
                })
              : localize('com_mindstone_sys_handoff_none')}
          </p>
        </section>
      )}
    </div>
  );
}
