import { Button, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import type { QuestionHistoryEntry } from '../answerHistory';
import { ElicitationCard } from './ElicitationCard';

export function AnswerHistory({ entries, onContinue, canContinue = false }: {
  entries: readonly QuestionHistoryEntry[];
  onContinue?: (entry: QuestionHistoryEntry) => void;
  canContinue?: boolean;
}) {
  const { t } = useTranslation('workitem');
  const history = entries.map(entry => {
    const expired = entry.status === 'EXPIRED';
    // 超时、系统取消、用户跳过都保留历史卡，用户仍可改选后按文本发送。
    const continuable = expired || entry.status === 'CANCELED' || entry.status === 'DECLINED'
      || entry.action === 'cancel' || entry.action === 'decline';
    const issue = entry.deliveryStatus === 'UNKNOWN' || entry.deliveryStatus === 'UNAVAILABLE'
      ? t(`clarification.answerDelivery.${entry.deliveryStatus}`) : null;
    return <div key={`${entry.turnId}:${entry.requestId}`} data-testid={`question-history-${entry.turnId}-${entry.requestId}`}>
    <ElicitationCard requestId={entry.requestId} message={entry.message} schema={entry.requestedSchema}
      resolved action={entry.action} answers={entry.content} expired={expired}>
      {entry.rawAnswer && <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--aw-text-3)' }}>{t('clarification.history.originalAnswer')}</summary>
        <pre className="aw-cl-pre" style={{ marginTop: 4 }}>{entry.rawAnswer}</pre>
      </details>}
      {issue && <div className="aw-cl-note warn" style={{ marginTop: 8 }}>
        <span className="ic"><AwStrokeIcon name="alert-t" size={14} /></span>
        <span className="grow">{issue}</span>
      </div>}
      {continuable && onContinue && <div className="aw-cl-qa-foot">
        <Button size="small" disabled={!canContinue} onClick={() => onContinue(entry)}>{t('clarification.history.continue')}</Button>
        {!canContinue && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('clarification.history.continueUnavailable')}</Typography.Text>}
      </div>}
    </ElicitationCard>
  </div>; });
  return <>{history}</>;
}
