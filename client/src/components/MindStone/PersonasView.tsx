/**
 * MindStone personas (MindStone-Agent #105): the personas the gateway can
 * load and which one is active, and switching between them. The agent
 * proposes a persona in chat and the admin approves it on the Approvals page,
 * which only saves it; this page is the only place one is made active.
 * Nothing here creates, edits or deletes one. Switching is a PATCH of
 * personas.active, which needs no advanced-settings permission, against the
 * config as it was when the list was loaded (If-Match). Persona text shows
 * any non-printing character as \u{XXXX}.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { visibleText } from './visibleText';

type Persona = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  /** Set when the gateway can't load this persona; it can't be made active. */
  error?: string;
};

const BASE = '/api/mindstone/admin';

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function MindStonePersonasView() {
  const localize = useLocalize();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // The config etag read with the list: a switch is refused (412) if the
  // config changed since then, not just since the click.
  const [etag, setEtag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [result, config] = await Promise.all([
        request.get<{ active: string | null; personas: Persona[] }>(`${BASE}/personas`),
        request.get<{ etag?: string }>(`${BASE}/config`),
      ]);
      setPersonas(result.personas);
      setActive(result.active ?? null);
      setEtag(config.etag ?? null);
    } catch (error) {
      setMessage({
        ok: false,
        text: errorText(error) ?? localize('com_mindstone_gateway_unreachable'),
      });
    }
  }, [localize]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Set personas.active against the config as loaded with the list (If-Match); null clears it. */
  const switchTo = async (persona: Persona | null) => {
    setBusy(true);
    try {
      const query = etag ? `?ifMatch=${encodeURIComponent(etag)}` : '';
      await request.patch(`${BASE}/config/personas${query}`, { active: persona?.id ?? null });
      setMessage({
        ok: true,
        text: persona
          ? localize('com_mindstone_per_activated', { 0: visibleText(persona.name) })
          : localize('com_mindstone_per_cleared'),
      });
      await load();
    } catch (error) {
      const stale = (error as { response?: { status?: number } })?.response?.status === 412;
      setMessage({
        ok: false,
        text: stale
          ? localize('com_mindstone_per_stale')
          : (errorText(error) ?? localize('com_mindstone_not_changed')),
      });
      // A stale list is reloaded, so the next click uses the current config.
      if (stale) await load();
    } finally {
      setBusy(false);
    }
  };

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const secondary = 'rounded border border-border-medium px-3 py-1 disabled:opacity-50';
  const activeMissing =
    personas !== null && active !== null && !personas.some((persona) => persona.id === active);

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_per_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_per_back')}
          </Link>
        </div>
        <p className="text-sm text-text-secondary">
          {localize('com_mindstone_per_intro')} {localize('com_mindstone_persona_routes_note')}
        </p>
        {message && (
          <p role="status" className={message.ok ? 'text-green-600' : 'text-red-600'}>
            {message.text}
          </p>
        )}
        <section className={card} aria-labelledby="ms-per-list">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="ms-per-list" className="text-lg font-medium">
              {localize('com_mindstone_per_list', { 0: String(personas?.length ?? 0) })}
            </h2>
            {personas && (
              <button
                type="button"
                className={secondary}
                disabled={busy || active === null}
                onClick={() => void switchTo(null)}
              >
                {localize('com_mindstone_per_use_none')}
              </button>
            )}
          </div>
          {personas && active === null && (
            <p className="mb-2 text-sm text-text-secondary">
              {localize('com_mindstone_per_active_none')}
            </p>
          )}
          {activeMissing && (
            <p className="mb-2 text-sm text-red-600">
              {localize('com_mindstone_per_active_missing', { 0: visibleText(active ?? '') })}
            </p>
          )}
          {personas && personas.length === 0 && (
            <p className="text-sm text-text-secondary">{localize('com_mindstone_per_none')}</p>
          )}
          <ul className="flex flex-col divide-y divide-border-light">
            {personas?.map((persona) => {
              const isActive = persona.id === active;
              return (
                <li
                  key={persona.id}
                  className="flex items-start justify-between gap-2 py-2"
                  data-testid={`ms-persona-${persona.id}`}
                >
                  <div className="flex flex-col gap-1">
                    <div>
                      <span className="font-medium">{visibleText(persona.name)}</span>{' '}
                      <span className="font-mono text-xs text-text-secondary">
                        {visibleText(persona.id)}
                      </span>
                      {isActive && (
                        <span className="ml-2 rounded bg-surface-secondary px-2 py-0.5 text-xs">
                          {localize('com_mindstone_per_active')}
                        </span>
                      )}
                    </div>
                    {persona.description && (
                      <span className="text-sm">{visibleText(persona.description)}</span>
                    )}
                    {persona.error && (
                      <span className="text-xs text-red-600">
                        {localize('com_mindstone_per_broken')}
                      </span>
                    )}
                  </div>
                  {!isActive && !persona.error && (
                    <button
                      type="button"
                      className={secondary}
                      disabled={busy}
                      onClick={() => void switchTo(persona)}
                    >
                      {localize('com_mindstone_per_make_active')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
