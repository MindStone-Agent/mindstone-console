/**
 * MindStone diagnostics (MindStone-Agent #86): `mindstone doctor` and
 * `mindstone gateway logs` in the Console. Both come from the gateway admin
 * API, which masks credentials in the text before it leaves the gateway.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Check = {
  id: string;
  severity: 'pass' | 'warn' | 'fail' | 'info';
  title: string;
  detail?: string;
};
type Report = {
  ok: boolean;
  checks: Check[];
  summary: { pass: number; warn: number; fail: number; info: number };
};
type Logs = { available: boolean; path: string; lines: string[]; note?: string };

const BASE = '/api/mindstone/admin';
const LINE_COUNTS = [50, 80, 200, 500];
const SEVERITY_MARK = { pass: '✓', warn: '!', fail: '✗', info: 'i' } as const;
const SEVERITY_CLASS = {
  pass: 'text-green-600',
  warn: 'text-yellow-600',
  fail: 'text-red-600',
  info: 'text-text-secondary',
} as const;

function errorText(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

export default function MindStoneDiagnosticsView() {
  const localize = useLocalize();
  const [report, setReport] = useState<Report | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Logs | null>(null);
  const [lineCount, setLineCount] = useState(80);
  const [logsError, setLogsError] = useState<string | null>(null);

  const runDoctor = async () => {
    setDoctorBusy(true);
    setDoctorError(null);
    try {
      const result = await request.get<{ report: Report }>(`${BASE}/doctor`);
      setReport(result.report);
    } catch (error) {
      setDoctorError(errorText(error) ?? localize('com_mindstone_gateway_unreachable'));
    } finally {
      setDoctorBusy(false);
    }
  };

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await request.get<Logs>(`${BASE}/logs?lines=${lineCount}`));
      setLogsError(null);
    } catch (error) {
      setLogsError(errorText(error) ?? localize('com_mindstone_gateway_unreachable'));
    }
  }, [lineCount, localize]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const card = 'rounded-xl border border-border-medium bg-surface-primary p-4';
  const primary = 'rounded bg-surface-submit px-4 py-2 text-white disabled:opacity-50';
  const secondary = 'rounded border border-border-medium px-3 py-1';

  return (
    <div className="h-full overflow-y-auto p-6 text-text-primary">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{localize('com_mindstone_diag_title')}</h1>
          <Link to="/mindstone" className="text-sm underline">
            {localize('com_mindstone_diag_back')}
          </Link>
        </div>

        <section className={card} aria-labelledby="ms-diag-doctor">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="ms-diag-doctor" className="text-lg font-medium">
              {localize('com_mindstone_diag_doctor')}
            </h2>
            <button
              type="button"
              className={primary}
              disabled={doctorBusy}
              onClick={() => void runDoctor()}
            >
              {localize(doctorBusy ? 'com_mindstone_diag_running' : 'com_mindstone_diag_run')}
            </button>
          </div>
          <p className="mb-2 text-sm text-text-secondary">
            {localize('com_mindstone_diag_doctor_hint')}
          </p>
          {doctorError && (
            <p role="alert" className="text-red-600">
              {doctorError}
            </p>
          )}
          {report && (
            <>
              <p role="status" className={report.ok ? 'text-green-600' : 'text-red-600'}>
                {localize(report.ok ? 'com_mindstone_diag_ok' : 'com_mindstone_diag_not_ok', {
                  0: String(report.summary.pass),
                  1: String(report.summary.warn),
                  2: String(report.summary.fail),
                  3: String(report.summary.info),
                })}
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {report.checks.map((check, index) => (
                  <li key={`${check.id}-${index}`} data-testid={`ms-check-${check.id}`}>
                    <span className={SEVERITY_CLASS[check.severity]} aria-label={check.severity}>
                      {SEVERITY_MARK[check.severity]}
                    </span>{' '}
                    {check.title}
                    {check.detail ? (
                      <span className="break-all text-text-secondary"> ({check.detail})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className={card} aria-labelledby="ms-diag-logs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="ms-diag-logs" className="text-lg font-medium">
              {localize('com_mindstone_diag_logs')}
            </h2>
            <div className="flex items-center gap-2 text-sm">
              <label className="flex items-center gap-1">
                {localize('com_mindstone_diag_lines')}
                <select
                  className="rounded border border-border-medium bg-surface-secondary p-1"
                  value={lineCount}
                  onChange={(event) => setLineCount(Number(event.target.value))}
                >
                  {LINE_COUNTS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className={secondary} onClick={() => void loadLogs()}>
                {localize('com_mindstone_diag_refresh')}
              </button>
            </div>
          </div>
          {logsError && (
            <p role="alert" className="text-red-600">
              {logsError}
            </p>
          )}
          {logs && !logs.available && (
            <p className="text-sm text-text-secondary">{logs.note ?? logs.path}</p>
          )}
          {logs?.available && (
            <>
              <p className="mb-1 break-all text-xs text-text-secondary">{logs.path}</p>
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-xs">
                {logs.lines.join('\n')}
              </pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
