/**
 * A knowledge base the gateway is embedding again after a change of embedding
 * model, or has stopped trying to (MindStone-Agent #158). Until then recall
 * finds it by its words only. A given-up KB can be tried again from here
 * once the embedder is fixed.
 */
import { useState } from 'react';
import { request } from 'librechat-data-provider';
import type { KnowledgebaseSummary } from './personaForms';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

export default function KbReembedNote({
  reembed,
  kbId,
  testId,
  retryPath,
  onRetried,
}: {
  reembed: NonNullable<KnowledgebaseSummary['reembed']>;
  /** For the CLI hint when there is no retry here (MindStone-Agent #164). */
  kbId: string;
  testId: string;
  /** The gateway's reset for this KB; with it, a given-up KB gets a "Try again". */
  retryPath?: string;
  onRetried?: () => void;
}) {
  const localize = useLocalize();
  const [retry, setRetry] = useState<'idle' | 'busy' | 'failed'>('idle');
  /** The gateway's own refusal, shown as given (MindStone-Agent #164). */
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const next = typeof reembed.nextAttemptAt === 'string' ? new Date(reembed.nextAttemptAt) : undefined;
  const when = next && !Number.isNaN(next.getTime()) ? next.toLocaleString() : '';
  const failures = Number.isInteger(reembed.failures) ? String(reembed.failures) : '?';
  const reason = typeof reembed.reason === 'string' && reembed.reason ? reembed.reason : undefined;
  return (
    <span
      className={`block text-xs ${reembed.gaveUp ? 'text-red-600' : 'text-text-secondary'}`}
      data-testid={testId}
    >
      {reembed.gaveUp
        ? localize('com_mindstone_kb_reembed_gave_up', { 0: failures })
        : localize('com_mindstone_kb_reembed_waiting', { 0: when })}
      {reason ? ` ${localize('com_mindstone_kb_reembed_reason', { 0: visibleText(reason) })}` : ''}
      {reembed.gaveUp && retryPath && (
        <button
          type="button"
          className="ml-2 underline"
          disabled={retry === 'busy'}
          data-testid={`${testId}-retry`}
          onClick={async () => {
            setRetry('busy');
            setRefusal(undefined);
            try {
              await request.post(retryPath, {});
              setRetry('idle');
              onRetried?.();
            } catch (error) {
              const said = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
              setRefusal(typeof said === 'string' && said ? said : undefined);
              setRetry('failed');
            }
          }}
        >
          {localize('com_mindstone_kb_reembed_retry')}
        </button>
      )}
      {reembed.gaveUp && !retryPath && (
        <span className="block" data-testid={`${testId}-cli`}>
          {localize('com_mindstone_kb_reembed_cli', { 0: visibleText(kbId) })}
        </span>
      )}
      {retry === 'failed' && (
        <span className="ml-2" data-testid={`${testId}-retry-failed`}>
          {refusal
            ? localize('com_mindstone_kb_reembed_retry_refused', { 0: visibleText(refusal) })
            : localize('com_mindstone_kb_reembed_retry_failed')}
        </span>
      )}
    </span>
  );
}
