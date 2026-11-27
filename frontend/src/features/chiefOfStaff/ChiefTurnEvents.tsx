import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { ConversationEventView } from '@/features/workitem/clarification/ConversationEventView';
import { AutoConversationQuestionHistory } from '@/shared/ui/AutoConversationQuestionHistory';
import { projectQuestionHistory, withoutCoveredQuestions, type QuestionHistoryEntry } from '@/features/workitem/clarification/answerHistory';
import type { ClarificationElicitation } from '@/features/workitem/clarification/types';
import { EventSyncStatus } from '@/features/workitem/clarification/EventSyncStatus';
import { createEventDisplaySource } from '@/features/workitem/clarification/eventDisplay';
import { useEventSummaryFeed } from '@/features/workitem/clarification/useEventSummaryFeed';
import { useEventViewport } from '@/features/workitem/clarification/useEventViewport';

export function ChiefTurnEvents({ conversationId, turnId, processing, onContentChange, questionHistory, questionHistoryPaged, questionRefreshKey, answerDeliveries, onContinue, canContinue, onSettledQuestions, onExpiredQuestions }: {
  onSettledQuestions?: (conversationId: number, turnId: number, requestIds: readonly string[]) => void;
  onExpiredQuestions?: (conversationId: number, turnId: number, requestIds: readonly string[]) => void;
  questionHistory?: ClarificationElicitation[] | null;
  questionHistoryPaged?: boolean;
  questionRefreshKey?: string;
  answerDeliveries?: ClarificationElicitation[] | null;
  onContinue?: (entry: QuestionHistoryEntry) => void;
  canContinue?: boolean;
  onContentChange?: () => void;
  scope: readonly unknown[]; conversationId: number; turnId: number; processing: boolean;
}) {
  const { t } = useTranslation('workitem');
  const viewport = useEventViewport();
  // 历史工具详情默认收起，点开才读取；运行中展开实时过程，运行转完成随状态立即收起。
  // 轮次状态变化时丢弃手动选择，避免上一态的选择把完成后的过程留在展开位置。
  const [manual, setManual] = useState<'open' | 'closed' | null>(null);
  const [runState, setRunState] = useState(processing);
  if (runState !== processing) { setRunState(processing); setManual(null); }
  const open = manual === null ? processing : manual === 'open';
  const source = useMemo(
    () => createEventDisplaySource(`/api/platform/conversations/${conversationId}`),
    [conversationId],
  );
  // 已显示过程不因 1000 事件窗口被裁剪或整批替换；完成态一次读完再呈现。
  const feed = useEventSummaryFeed({
    source, conversationId, turnId, enabled: open, processing,
    keepAllEvents: true, atomicHistory: !processing,
  });
  const nodes = useMemo(() => {
    const attempt = feed.timeline.reduce((max, node) => Math.max(max, node.dispatchAttempt ?? 0), 0);
    return feed.timeline.filter(node => node.kind !== 'thinking'
      && (node.kind !== 'text' || !!node.contentWindow || (processing && (node.dispatchAttempt ?? 0) === attempt)));
  }, [feed.timeline, processing]);
  const history = useMemo(() => projectQuestionHistory(turnId, questionHistory, nodes), [turnId, questionHistory, nodes]);
  const settledRequestIds = useMemo(() => nodes.filter(node => node.elicitation?.resolved)
    .map(node => node.elicitation!.requestId), [nodes]);
  // 折叠时不读事件：结算判定以问题历史分页的结论为准，二者取并集，避免回写空集把卡片重新放出。
  const questionSettled = useRef<readonly string[]>([]);
  const recordQuestions = useCallback((id: number, ids: readonly string[]) => {
    if (id === turnId) questionSettled.current = ids;
    onSettledQuestions?.(conversationId, id, [...new Set([...settledRequestIds, ...ids])]);
  }, [conversationId, onSettledQuestions, settledRequestIds, turnId]);
  useEffect(() => { onSettledQuestions?.(conversationId, turnId,
    [...new Set([...questionSettled.current, ...settledRequestIds])]); },
    [conversationId, turnId, settledRequestIds, onSettledQuestions]);
  const expiredRequestIds = useMemo(() => nodes.filter(node => node.elicitation?.resolved
    && node.elicitation.status === 'EXPIRED').map(node => node.elicitation!.requestId), [nodes]);
  useEffect(() => { onExpiredQuestions?.(conversationId, turnId, expiredRequestIds); },
    [conversationId, turnId, expiredRequestIds, onExpiredQuestions]);
  useLayoutEffect(() => { onContentChange?.(); }, [nodes, history, onContentChange]);
  return <div ref={viewport.ref} style={{ minHeight: processing ? 1 : viewport.height }}>
    <AutoConversationQuestionHistory base={`/api/platform/conversations/${conversationId}`} conversationId={conversationId}
      turnId={turnId} paged={!!questionHistoryPaged} enabled={viewport.visible || processing}
      refreshKey={questionRefreshKey} deliveryStatuses={answerDeliveries}
      entries={history} onContinue={onContinue} canContinue={canContinue} onSettledQuestions={recordQuestions} />
    <div style={{ marginTop: 4 }}>
      <Button type="link" size="small" data-testid={`chief-turn-detail-toggle-${turnId}`}
        style={{ padding: 0, height: 'auto', fontSize: 13 }}
        onClick={() => setManual(open ? 'closed' : 'open')}>
        {open ? t('clarification.hideDetails') : t('clarification.showDetails')}
      </Button>
      {open && <div data-testid={`chief-turn-detail-${turnId}`} style={{ marginTop: 4 }}>
        <ConversationEventView
          nodes={withoutCoveredQuestions(nodes, history)}
          isProcessing={false}
          foldScope={`chief:${conversationId}`}
        />
        <EventSyncStatus
          preparationStatus={feed.preparationStatus}
          syncing={feed.syncing}
          error={feed.error}
          onRetry={() => void feed.reload()}
        />
      </div>}
    </div>
  </div>;
}
