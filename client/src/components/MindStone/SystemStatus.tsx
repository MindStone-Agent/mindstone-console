/**
 * MindStone system status (mindstone-console #6): renders the `system` block
 * the gateway already returns from /admin/status. Read-only; every section is
 * optional so an older or newer gateway cannot blank the settings page.
 */
import type { ReactNode } from 'react';
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
  runtime?: { state?: string; lastError?: string; inboundCount?: number; deniedCount?: number };
  queue?: { pending?: number; delivered?: number; dead?: number };
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
    resolvedForDefaultSession?: { personaId?: string; reason?: string };
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

const n = (value: number | undefined) => new Intl.NumberFormat().format(value ?? 0);
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : '');

function Problem({ tone, children }: { tone: 'error' | 'warning'; children: ReactNode }) {
  return (
    <p className={tone === 'error' ? 'text-sm text-red-500' : 'text-sm text-orange-500'}>
      {children}
    </p>
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

  return (
    <div data-testid="ms-system">
      <p data-testid="ms-system-overall" className={system.ok ? 'text-green-600' : 'text-red-500'}>
        {localize(system.ok ? 'com_mindstone_sys_ok' : 'com_mindstone_sys_not_ok')}
      </p>
      {config && (
        <>
          {config.exists === false && (
            <Problem tone="error">
              {localize('com_mindstone_sys_config_missing', { 0: config.path ?? '' })}
            </Problem>
          )}
          {config.error && <Problem tone="error">{config.error}</Problem>}
        </>
      )}

      {gateway && (
        <section aria-labelledby="ms-sys-gateway">
          <h3 id="ms-sys-gateway" className={heading}>
            {localize('com_mindstone_sys_gateway')}
          </h3>
          <dl>
            <Row label={localize('com_mindstone_sys_address')}>{gateway.baseUrl}</Row>
            <Row label={localize('com_mindstone_sys_sign_in')}>
              {gateway.auth?.mode ?? ''}
              {gateway.auth?.required === false
                ? ` (${localize('com_mindstone_sys_not_required')})`
                : ''}
            </Row>
            <Row label={localize('com_mindstone_sys_http_api')}>
              {localize('com_mindstone_sys_http_detail', {
                0: on(gateway.http?.modelsEnabled),
                1: on(gateway.http?.chatCompletionsEnabled),
                2: on(gateway.http?.responsesEnabled),
              })}
            </Row>
            {routing && (
              <Row label={localize('com_mindstone_sys_routing')}>
                {[routing.mode, routing.defaultAgentId, routing.defaultModel]
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
            <Row label={localize('com_mindstone_sys_enabled')}>{yes(webchat.enabled)}</Row>
            {webchat.url && <Row label={localize('com_mindstone_sys_address')}>{webchat.url}</Row>}
            <Row label={localize('com_mindstone_sys_api_sign_in')}>
              {yes(webchat.apiAuthApplies)}
            </Row>
          </dl>
        </section>
      )}

      {sqlite && (
        <section aria-labelledby="ms-sys-memory" data-testid="ms-sys-memory">
          <h3 id="ms-sys-memory" className={heading}>
            {localize('com_mindstone_sys_memory')}
          </h3>
          {sqlite.present === false ? (
            <p className="text-sm text-text-secondary">
              {localize('com_mindstone_sys_memory_none')}
            </p>
          ) : (
            <dl>
              <Row label={localize('com_mindstone_sys_search')}>{sqlite.vectorBackend}</Row>
              <Row label={localize('com_mindstone_sys_indexed')}>
                {localize('com_mindstone_sys_memory_counts', {
                  0: n(sqlite.sources),
                  1: n(sqlite.chunks),
                  2: n(sqlite.embeddedChunks),
                })}
              </Row>
              {Boolean(sqlite.duplicateTextChunks) && (
                <Row label={localize('com_mindstone_sys_duplicates')}>
                  {n(sqlite.duplicateTextChunks)}
                </Row>
              )}
              {sqlite.updatedAt && (
                <Row label={localize('com_mindstone_sys_updated')}>{when(sqlite.updatedAt)}</Row>
              )}
            </dl>
          )}
          {sqlite.present !== false &&
            sqlite.sqliteVec?.available === false &&
            sqlite.sqliteVec.error && (
              <Problem tone="warning">
                {localize('com_mindstone_sys_sqlite_vec', { 0: sqlite.sqliteVec.error })}
              </Problem>
            )}
          {sqlite.error && <Problem tone="error">{sqlite.error}</Problem>}
        </section>
      )}

      {pi && (
        <section aria-labelledby="ms-sys-pi">
          <h3 id="ms-sys-pi" className={heading}>
            {localize('com_mindstone_sys_pi')}
          </h3>
          <dl>
            <Row label={localize('com_mindstone_sys_isolated')}>{yes(pi.active)}</Row>
            {pi.resumeCap && (
              <Row label={localize('com_mindstone_sys_resume_cap')}>
                {pi.resumeCap.enabled
                  ? localize('com_mindstone_sys_entries', { 0: n(pi.resumeCap.maxEntries) })
                  : on(false)}
              </Row>
            )}
          </dl>
          {pi.usesGlobalPiAgentDir && (
            <Problem tone="warning">{localize('com_mindstone_sys_pi_global')}</Problem>
          )}
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
                {(personas.resolvedForDefaultSession?.personaId ?? personas.configuredActive)
                  ? localize('com_mindstone_sys_personas_detail', {
                      0: n(personas.count),
                      1:
                        personas.resolvedForDefaultSession?.personaId ??
                        personas.configuredActive ??
                        '',
                    })
                  : localize('com_mindstone_sys_personas_count', { 0: n(personas.count) })}
              </Row>
            )}
            {skills && (
              <Row label={localize('com_mindstone_sys_skills')}>
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
          {[personas?.brokenCount, skills?.brokenCount, kbs?.brokenCount].some(Boolean) && (
            <Problem tone="warning">
              {localize('com_mindstone_sys_broken', {
                0: n(personas?.brokenCount),
                1: n(skills?.brokenCount),
                2: n(kbs?.brokenCount),
              })}
            </Problem>
          )}
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
              {connectorRows.map((c) => (
                <li
                  key={c.connectorId}
                  data-testid={`ms-sys-connector-${c.connectorId}`}
                  className="text-sm"
                >
                  <strong>{c.connectorId}</strong>{' '}
                  {localize(
                    c.enabled ? 'com_mindstone_sys_enabled_lc' : 'com_mindstone_sys_disabled_lc',
                  )}
                  {c.runtime?.state ? `, ${c.runtime.state.replace(/_/g, ' ')}` : ''}
                  <div className="text-text-secondary">
                    {localize('com_mindstone_sys_queue', {
                      0: n(c.queue?.pending),
                      1: n(c.queue?.delivered),
                      2: n(c.queue?.dead),
                    })}
                    {c.sendPolicy?.effective
                      ? ` ${localize('com_mindstone_sys_send_policy', { 0: c.sendPolicy.effective })}`
                      : ''}
                  </div>
                  {c.credential?.configured &&
                    !c.credential.present &&
                    !(c.credential.error && c.runtime?.lastError?.includes(c.credential.error)) && (
                      <Problem tone="error">
                        {c.credential.error ?? localize('com_mindstone_sys_credential_missing')}
                      </Problem>
                    )}
                  {c.credential?.warning && (
                    <Problem tone="warning">{c.credential.warning}</Problem>
                  )}
                  {c.sendPolicy?.warning && (
                    <Problem tone="warning">{c.sendPolicy.warning}</Problem>
                  )}
                  {c.runtime?.lastError && <Problem tone="error">{c.runtime.lastError}</Problem>}
                  {Boolean(c.queue?.dead) && (
                    <Problem tone="warning">
                      {localize('com_mindstone_sys_dead', { 0: n(c.queue?.dead) })}
                    </Problem>
                  )}
                </li>
              ))}
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
            {agentRows.map((a) => (
              <li key={a.agentId} data-testid={`ms-sys-agent-${a.agentId}`}>
                <strong>{a.name ?? a.agentId}</strong>
                {a.identityExists === false ? `: ${localize('com_mindstone_sys_no_identity')}` : ''}
                {a.error && <Problem tone="error">{a.error}</Problem>}
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
