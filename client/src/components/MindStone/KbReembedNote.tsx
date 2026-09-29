/**
 * A knowledge base the gateway is embedding again after a change of embedding
 * model, or has stopped trying to (MindStone-Agent #158). Until then recall
 * finds it by its words only.
 */
import type { KnowledgebaseSummary } from './personaForms';
import { visibleText } from './visibleText';
import { useLocalize } from '~/hooks';

export default function KbReembedNote({
  reembed,
  testId,
}: {
  reembed: NonNullable<KnowledgebaseSummary['reembed']>;
  testId: string;
}) {
  const localize = useLocalize();
  const next = reembed.nextAttemptAt ? new Date(reembed.nextAttemptAt) : undefined;
  const when = next && !Number.isNaN(next.getTime()) ? next.toLocaleString() : '';
  return (
    <span
      className={`block text-xs ${reembed.gaveUp ? 'text-red-600' : 'text-text-secondary'}`}
      data-testid={testId}
    >
      {reembed.gaveUp
        ? localize('com_mindstone_kb_reembed_gave_up', { 0: String(reembed.failures) })
        : localize('com_mindstone_kb_reembed_waiting', { 0: when })}
      {reembed.reason
        ? ` ${localize('com_mindstone_kb_reembed_reason', { 0: visibleText(reembed.reason) })}`
        : ''}
    </span>
  );
}
