import { useAuthStore } from '@/shared/auth/store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRealtime } from '@/shared/realtime/useRealtime';
import { ApiError, ErrorCodes } from '@/shared/types/common';
import * as api from './api';
import { buildTimeline } from './timeline';
import { createEventDisplaySource, summaryItemsToEvents } from './eventDisplay';
import { useEventSummaryFeed } from './useEventSummaryFeed';
import type {
  AcpSlashCommand,
  ClarificationTurnEvent,
  ConversationRealtimeEvent,
  ProviderEventPayload,
} from './types';

/** 临时故障（网络/5xx）的自动重试上限：之后交给显式错误态 + 手动重试，避免请求风暴。 */
export const CLARIFICATION_QUERY_MAX_RETRY = 2;
/** 固定短间隔重试：临时抖动通常亚秒级恢复，指数退避在这里只会拖慢首屏错误反馈。 */
export const CLARIFICATION_QUERY_RETRY_DELAY_MS = 300;

/** 客户端/权限类业务码：重试无意义（401/403/404/归属校验失败），按真实原因直接失败。 */
const CLARIFICATION_NON_RETRYABLE_CODES = new Set([
  ErrorCodes.UNAUTHORIZED,
  ErrorCodes.NO_PERMISSION,
  ErrorCodes.NOT_FOUND,
  ErrorCodes.WORKSPACE_NOT_MEMBER,
  ErrorCodes.WORKSPACE_ACCESS_INSUFFICIENT,
  ErrorCodes.ORG_NOT_FOUND_OR_NO_PERMISSION,
  '10001', // PARAM_INVALID：会话不存在或不属于当前工单
]);

export function isClarificationNonRetryableError(error: unknown): boolean {
  return error instanceof ApiError && CLARIFICATION_NON_RETRYABLE_CODES.has(error.code);
}

/** 历史列表/详情的有界重试：客户端错误立即失败，其余最多自动重试 2 次。 */
export function clarificationQueryRetry(failureCount: number, error: unknown): boolean {
  if (isClarificationNonRetryableError(error)) return false;
  return failureCount < CLARIFICATION_QUERY_MAX_RETRY;
}

export function useClarificationConversations(workitemId: number | string, agentId: number | null) {
  return useQuery({
    queryKey: ['workitem', workitemId, 'clarification-conversations', agentId],
    queryFn: () => api.listClarificationConversations(workitemId, agentId!),
    enabled: !!workitemId && !!agentId,
    retry: clarificationQueryRetry,
    retryDelay: () => CLARIFICATION_QUERY_RETRY_DELAY_MS,
  });
}

/**
 * 工单维度最近一次澄清会话（跨数字人）：进入面板时先解析它，命中就跳过选人页。
 * 只在没有 URL 上下文时启用；失败与「没有会话」都交给调用方回落到本地记忆链路。
 */
export function useLatestClarificationConversation(
  workitemId: number | string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['workitem', workitemId, 'clarification-latest-conversation'],
    queryFn: () => api.getLatestClarificationConversation(workitemId),
    enabled: !!workitemId && enabled,
    retry: clarificationQueryRetry,
    retryDelay: () => CLARIFICATION_QUERY_RETRY_DELAY_MS,
    staleTime: 0,
  });
}

export function useClarificationConversation(workitemId: number | string, conversationId: number | null) {
  return useQuery({
    queryKey: ['workitem', workitemId, 'clarification-conversation', conversationId],
    queryFn: () => api.getClarificationConversation(workitemId, conversationId!),
    enabled: !!workitemId && !!conversationId,
    // 回复中期间定期轮询兜底：终态实时事件丢失（断连/推送失败）时，
    // 仅靠事件触发的失效会让会话永久停留在 PROCESSING，loading 与输入禁用卡死。
    refetchInterval: (query) => clarificationConversationRefetchInterval(query.state.data),
    retry: clarificationQueryRetry,
    retryDelay: () => CLARIFICATION_QUERY_RETRY_DELAY_MS,
  });
}

export const CLARIFICATION_PROCESSING_POLL_MS = 3000;

/** 处理中与排队中都属于“回复未结束”，是输入可用性的判定口径。 */
export function isClarificationReplyingStatus(status: string | null | undefined): boolean {
  return status === 'PROCESSING' || status === 'QUEUED';
}

/** 回复中返回轮询间隔，否则关闭轮询。 */
export function clarificationConversationRefetchInterval(
  data: { processingStatus?: string | null; answerDeliveries?: { deliveryStatus?: string | null }[] | null } | null | undefined,
): number | false {
  return (isClarificationReplyingStatus(data?.processingStatus)
    || data?.answerDeliveries?.some(card => card.deliveryStatus === 'SAVED' || card.deliveryStatus === 'RECEIVED'))
    ? CLARIFICATION_PROCESSING_POLL_MS
    : false;
}

export function useCreateClarificationConversation(workitemId: number | string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: number) => api.getOrCreateClarificationConversation(workitemId, agentId),
    onSuccess: (_data, agentId) => {
      queryClient.invalidateQueries({
        queryKey: ['workitem', workitemId, 'clarification-conversations', agentId],
      });
    },
  });
}

export interface SubmitClarificationTurnVariables {
  content: string;
  attachmentIds?: number[];
  clientMessageId?: string;
}

export function useSubmitClarificationTurn(workitemId: number | string, conversationId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: SubmitClarificationTurnVariables) =>
      api.submitClarificationTurn(workitemId, conversationId!, variables.content, {
        attachmentIds: variables.attachmentIds,
        clientMessageId: variables.clientMessageId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['workitem', workitemId, 'clarification-conversation', conversationId],
      });
    },
  });
}

export interface UploadClarificationAttachmentVariables {
  file: File;
  signal?: AbortSignal;
}

/** 上传即落服务端（尚未绑定轮次）；发送失败重试不需要重新上传。 */
export function useUploadClarificationAttachment(
  workitemId: number | string,
  conversationId: number | null,
) {
  return useMutation({
    mutationFn: (variables: UploadClarificationAttachmentVariables) =>
      api.uploadClarificationAttachment(
        workitemId, conversationId!, variables.file, { signal: variables.signal },
      ),
  });
}

export function useDeleteClarificationAttachment(
  workitemId: number | string,
  conversationId: number | null,
) {
  return useMutation({
    mutationFn: (attachmentId: number) =>
      api.deleteClarificationAttachment(workitemId, conversationId!, attachmentId),
  });
}

export function useCancelClarificationTurn(workitemId: number | string, conversationId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (turnId: number) =>
      api.cancelClarificationTurn(workitemId, conversationId!, turnId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['workitem', workitemId, 'clarification-conversation', conversationId],
      });
    },
  });
}

export function useRetryClarificationTurn(workitemId: number | string, conversationId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (turnId: number) =>
      api.retryClarificationTurn(workitemId, conversationId!, turnId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['workitem', workitemId, 'clarification-conversation', conversationId],
      });
    },
  });
}

/** 服务端单轮可达数千条 token 级事件，实时数组只保留最近窗口，避免内存与渲染无限增长。 */
export const MAX_STREAMED_EVENTS = 2000;

export interface StreamedEvent {
  dispatchAttempt?: number;
  eventSeq: number;
  turnId: number;
  eventType: string;
  payload: ProviderEventPayload | null;
  receivedAt: number;
}

export function useClarificationEvents(
  workitemId: number | string,
  conversationId: number | null,
  processingTurnId: number | null | undefined,
) {
  const workspaceId = useAuthStore(state => state.currentWorkspace?.id);
  const userId = useAuthStore(state => state.user?.id);
  const queryClient = useQueryClient();
  const [streamedEvents, setStreamedEvents] = useState<StreamedEvent[]>([]);
  // 斜杠命令是会话级能力，独立于轮次事件流存放：由实时 acp_commands 事件写入，
  // 只在切换会话时重置，绝不被每轮 resetStreamedEvents 清空（否则输入可用时 `/`
  // 早已没有候选）。
  // null = 执行器尚未上报（此时该用会话详情带回的快照种子）；[] = 上报过且确实
  // 没有命令（权威结论，不能被种子覆盖）。两者语义不同，不能合并成空数组。
  const [durableCommands, setDurableCommands] = useState<AcpSlashCommand[] | null>(null);
  const lastEventSeqRef = useRef(0);
  const seenEventsRef = useRef(new Set<string>());
  const invalidationTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const retryTimer1Ref = useRef<ReturnType<typeof setTimeout>>();
  const retryTimer2Ref = useRef<ReturnType<typeof setTimeout>>();

  const recoverRef = useRef<() => void>(() => {});
  const channel = conversationId ? `conversation:${conversationId}` : null;

  // 活动流已迁到统一摘要/正文管线：控制消息仍走实时事件独立处理，
  // 正文与工具过程按发布游标增量补齐，不再依赖旧数组接口与 15 秒全量恢复。
  const summarySource = useMemo(
    () => createEventDisplaySource(
      `/api/workitems/${workitemId}/clarification-conversations/${conversationId ?? 0}`,
    ),
    [conversationId, workitemId],
  );
  // 摘要 feed 跟随「当前展示的轮次」而不是 processingTurnId：轮次结束后仍要补偿到
  // 扫描与发布完成（隐藏页/断线/丢通知的尾部），不能一终态就停轮询丢尾。
  const [feedTurnId, setFeedTurnId] = useState<number | null>(processingTurnId ?? null);
  const processingTurnIdRef = useRef(processingTurnId);
  processingTurnIdRef.current = processingTurnId;
  useEffect(() => {
    setFeedTurnId(processingTurnIdRef.current ?? null);
  }, [conversationId]);
  useEffect(() => {
    if (processingTurnId != null) setFeedTurnId(processingTurnId);
  }, [processingTurnId]);
  useEffect(() => {
    if (streamedEvents.length === 0) return;
    const latestTurnId = streamedEvents[streamedEvents.length - 1].turnId;
    setFeedTurnId((previous) => (previous == null || latestTurnId > previous
      ? latestTurnId : previous));
  }, [streamedEvents]);
  const summaryFeed = useEventSummaryFeed({
    source: summarySource,
    conversationId,
    turnId: feedTurnId,
    enabled: !!conversationId && feedTurnId != null,
    // 只有仍在执行的轮次才需要持续高频轮询；终态窗口内 feed 靠准备状态决定何时停。
    processing: feedTurnId != null && feedTurnId === processingTurnId,
    // 实时过程只追加：已显示事件不因窗口上限被裁剪，运行转完成时也不重建。
    keepAllEvents: true,
  });
  const pendingOrdinary = useRef<ConversationRealtimeEvent[]>([]);
  useEffect(() => {
    const matching = pendingOrdinary.current.filter(event => event.turnId === feedTurnId);
    pendingOrdinary.current = [];
    for (const event of matching) summaryFeed.receive(event);
  }, [feedTurnId, summaryFeed.receive]);
  recoverRef.current = summaryFeed.resume;

  useRealtime(channel, {
    enabled: !!conversationId,
    onReconnect: () => recoverRef.current(),
    onEvent: useCallback((event) => {
      if (event.type !== 'CONVERSATION_TURN_EVENT') return;
      const payload = event.payload as ConversationRealtimeEvent | null;
      if (!payload || payload.conversationId !== conversationId) return;
      lastEventSeqRef.current = payload.eventSeq;
      // Ordinary public content is owned by the bounded shared feed, including its live tail.
      if (!['status', 'error', 'acp_commands'].includes(payload.eventType)
        && !payload.eventType.startsWith('acp_elicitation')) {
        if (feedTurnId === payload.turnId) summaryFeed.receive(payload);
        else {
          pendingOrdinary.current = [...pendingOrdinary.current.slice(-127), payload];
          setFeedTurnId(previous => previous == null || payload.turnId > previous ? payload.turnId : previous);
        }
        return;
      }

      const dedupKey = `${payload.turnId}:${payload.dispatchAttempt ?? 0}:${payload.eventSeq}`;
      if (seenEventsRef.current.has(dedupKey)) return;
      seenEventsRef.current.add(dedupKey);
      if (seenEventsRef.current.size > 2048) {
        seenEventsRef.current.delete(seenEventsRef.current.values().next().value!);
      }

      lastEventSeqRef.current = payload.eventSeq;

      if (payload.eventType === 'acp_commands') {
        // 命令是会话级能力，走独立耐久态；绝不进轮次事件流（服务端直推的 turnId:0
        // 会污染 targetTurnId/streamedText）。去重与 seq 仍按统一口径推进。
        setDurableCommands(payload.payload?.data?.availableCommands ?? []);
        return;
      }

      setStreamedEvents((prev) => [
        ...prev.filter(previous => previous.turnId === payload.turnId).slice(-255),
        {
          dispatchAttempt: payload.dispatchAttempt ?? 0,
          eventSeq: payload.eventSeq,
          turnId: payload.turnId,
          eventType: payload.eventType,
          payload: payload.payload,
          receivedAt: Date.now(),
        },
      ].slice(-MAX_STREAMED_EVENTS));

      if (payload.eventType === 'status' || payload.eventType === 'error') {
        const queryKey = ['workitem', workitemId, 'clarification-conversation', conversationId];
        clearTimeout(invalidationTimerRef.current);
        clearTimeout(retryTimer1Ref.current);
        clearTimeout(retryTimer2Ref.current);
        invalidationTimerRef.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey });
        }, 1500);
        retryTimer1Ref.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey });
        }, 4000);
        retryTimer2Ref.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey });
        }, 7000);
      }
    }, [conversationId, workitemId, queryClient, feedTurnId, summaryFeed.receive]),
  });

  useEffect(() => {
    setStreamedEvents([]);
    pendingOrdinary.current = [];
    setDurableCommands(null);
    lastEventSeqRef.current = 0;
    seenEventsRef.current = new Set();
    return () => {
      clearTimeout(invalidationTimerRef.current);
      clearTimeout(retryTimer1Ref.current);
      clearTimeout(retryTimer2Ref.current);
    };
  }, [conversationId, workspaceId, userId]);

  // 统一摘要管线补齐当前轮次：按 eventId/revision 合并，滞后到达的正文会覆盖
  // 旧条目而不是被 seen 集合丢弃；acp_commands 仍只走会话级耐久通道。
  useEffect(() => {
    // 合并到「当前展示的轮次」而不是处理中轮次：终态后补到的尾部也要进当前气泡。
    if (feedTurnId == null) return;
    const additions = summaryItemsToEvents(summaryFeed.items, feedTurnId)
      .filter(event => event.eventType !== 'acp_commands')
      .map(event => ({ ...event, receivedAt: Date.now() }));
    setStreamedEvents(previous => {
      const controls = previous.filter(event => event.turnId === feedTurnId
        && (['status', 'error'].includes(event.eventType) || event.eventType.startsWith('acp_elicitation'))).slice(-256);
      const merged = new Map<string, StreamedEvent>(controls.map(event => [
        `${event.turnId}:${event.dispatchAttempt ?? 0}:${event.eventSeq}`, event,
      ]));
      for (const event of additions) {
        merged.set(`${event.turnId}:${event.dispatchAttempt ?? 0}:${event.eventSeq}`, event);
      }
      return [...merged.values()].sort((a, b) =>
        a.turnId - b.turnId
        || (a.dispatchAttempt ?? 0) - (b.dispatchAttempt ?? 0)
        || a.eventSeq - b.eventSeq);
    });
  }, [summaryFeed.items, feedTurnId]);

  const visibleEvents = useMemo(() => {
    if (streamedEvents.length === 0) return streamedEvents;
    // 无处理中轮次时（终态后、会话查询还没翻出下一个 processingTurnId），
    // 回退到事件流中最后一个 turnId，而不是放开全部累积事件——否则跨轮次的
    // text 事件会被拼进 streamedText，产生重复气泡（工单 50720 返工根因）。
    const targetTurnId = processingTurnId ?? streamedEvents[streamedEvents.length - 1].turnId;
    return streamedEvents.filter((e) => e.turnId === targetTurnId);
  }, [streamedEvents, processingTurnId]);

  const currentAttemptEvents = useMemo(() => {
    const attempt = visibleEvents.reduce((highest, event) => Math.max(highest, event.dispatchAttempt ?? 0), 0);
    return visibleEvents.filter(event => (event.dispatchAttempt ?? 0) === attempt
      || ((event.dispatchAttempt ?? 0) === 0 && event.eventType === 'status'));
  }, [visibleEvents]);

  const streamedText = useMemo(() => {
    let text = '';
    for (const ev of currentAttemptEvents) {
      if (ev.eventType === 'text' && ev.payload?.content) {
        text += ev.payload.content;
      }
    }
    return text;
  }, [currentAttemptEvents]);

  const terminalStatusOf = (ev: StreamedEvent): string | null =>
    ev.eventType === 'status' ? (ev.payload?.status?.toLowerCase() ?? null) : null;

  const streamedTurnCompleted = useMemo(
    () => currentAttemptEvents.some((ev) => terminalStatusOf(ev) === 'completed'),
    [currentAttemptEvents],
  );

  const streamedTurnCanceled = useMemo(
    () => currentAttemptEvents.some((ev) => terminalStatusOf(ev) === 'canceled'),
    [currentAttemptEvents],
  );

  /** 任意终态（完成/失败/已终止）都结束回复中状态：恢复输入、隐藏动态指示。 */
  const streamedTurnTerminated = useMemo(
    () => currentAttemptEvents.some((ev) => {
      const status = terminalStatusOf(ev);
      return status === 'completed' || status === 'failed' || status === 'canceled';
    }),
    [currentAttemptEvents],
  );

  const timeline = useMemo(() => [
    ...summaryFeed.timeline.filter(node => node.id === 'history-earlier'),
    ...buildTimeline(visibleEvents),
    ...summaryFeed.timeline.filter(node => node.id === 'history-later' || node.id === 'history-latest'),
  ], [summaryFeed.timeline, visibleEvents]);

  /** 斜杠命令是会话级能力：直接暴露耐久态（实时 acp_commands 事件写入、仅切换
   *  会话时重置），不再从每轮都会被清空的 streamedEvents 派生 —— 否则输入框可用
   *  时 `/` 候选早已消失。
   *
   *  <p>null = 本会话还没收到任何 acp_commands（调用方应退回会话详情的快照种子）；
   *  [] = 执行器上报过且确实没有命令，属权威结论，不该被种子盖回去。 */
  const availableCommands: AcpSlashCommand[] | null = durableCommands;

  const streamedTurnId = useMemo(() => {
    if (processingTurnId != null) return processingTurnId;
    return visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1].turnId : null;
  }, [processingTurnId, visibleEvents]);

  /** 清空会话级累积事件（与切换会话的重置等价）：流式回复落库后调用，
   *  避免残留事件在下一轮被误渲染，同时让新一轮从干净状态累积。 */
  const resetStreamedEvents = useCallback(() => {
    setStreamedEvents([]);
    setFeedTurnId(null);
    pendingOrdinary.current = [];
    lastEventSeqRef.current = 0;
    seenEventsRef.current = new Set();
  }, []);

  return {
    streamedEvents: visibleEvents,
    timeline,
    availableCommands,
    streamedTurnId,
    lastEventSeq: lastEventSeqRef.current,
    streamedText,
    streamedTurnCompleted,
    streamedTurnCanceled,
    streamedTurnTerminated,
    /** 准备/部分同步/不可用与同步中状态，供面板显示有意义的过程提示。 */
    preparationStatus: summaryFeed.preparationStatus,
    syncing: summaryFeed.syncing,
    detailsError: summaryFeed.error,
    reloadDetails: summaryFeed.reload,
    resetStreamedEvents,
  };
}

const TERMINAL_TURN_STATUS = new Set(['COMPLETED', 'SUCCESS', 'CANCELED', 'FAILED']);

export function isOutboundTurnDirection(direction: string): boolean {
  return direction !== 'IN' && direction !== 'INBOUND';
}

/**
 * 找出某个 OUT 轮次配对的 IN 轮次 id。
 *
 * 事件全部按 IN 轮次落库（服务端用 findProcessingInbound 校验后才落 turnId），
 * 而 OUT 轮次是在它的 IN 轮次被 ACK 时才插入的，因此配对关系就是「紧邻的前一个
 * IN 轮次」。拿 OUT 轮次 id 去查按轮次事件端点只会永远返回空。
 */
export function findPairedInboundTurnId(
  turns: ReadonlyArray<{ id: number; direction: string; status?: string }>,
  outboundIndex: number,
  retryingInboundId?: number | null,
): number | null {
  for (let i = outboundIndex - 1; i >= 0; i -= 1) {
    const candidate = turns[i];
    if (isOutboundTurnDirection(candidate.direction)) continue;
    // 卡片挂起时用户再输入会立刻插入一个 QUEUED 的 IN 轮次。它排在这个 OUT
    // 之前，但还没被处理过，不可能产出它 —— 配上去详情就又是空的。
    // 例外是用户手动重试的那一轮：重试后它也会短暂停在 QUEUED，
    // 调用方明确传入 retryingInboundId 时才允许越过这条排除规则。
    // CANCELED 同理：要么在 QUEUED 时就被取消（从未执行），要么已经带着自己的
    // 「已取消」OUT 气泡，都不该吃掉真正在跑的那一轮产出的 OUT。
    const status = (candidate.status ?? '').toUpperCase();
    if (status === 'QUEUED' && candidate.id !== retryingInboundId) continue;
    if (status === 'CANCELED') continue;
    return candidate.id;
  }
  return null;
}

/**
 * 重试语义下的旧失败气泡隐藏：同一 IN 轮次只保留最后一条失败 OUT。
 *
 * <p>只有「该 IN 已重新派发（PROCESSING / QUEUED）或已另有成功回复」才隐藏失败 OUT；
 * IN 成功却只有失败 OUT 的是普通执行失败，必须保留——它不是重试残留，
 * 也没有重试入口，隐藏后用户看不到失败原因。
 *
 * <p>retryingInboundId 是用户刚点过重试的 IN：重试被接受后它可能短暂停在
 * QUEUED 等空位，这段窗口也要按重试中处理。不传时保持旧行为。
 */
export function hiddenFailedOutboundTurnIds(
  turns: ReadonlyArray<{ id: number; direction: string; status?: string }>,
  retryingInboundId?: number | null,
): ReadonlySet<number> {
  const statusById = new Map(turns.map(turn => [turn.id, (turn.status ?? '').toUpperCase()]));
  const groups = new Map<number, { inboundStatus: string; outboundIds: number[] }>();
  const answered = new Set<number>();
  turns.forEach((turn, index) => {
    if (!isOutboundTurnDirection(turn.direction)) return;
    const inboundId = findPairedInboundTurnId(turns, index, retryingInboundId);
    if (inboundId == null) return;
    if ((turn.status ?? '').toUpperCase() !== 'FAILED') {
      answered.add(inboundId);
      return;
    }
    const group = groups.get(inboundId);
    if (group) group.outboundIds.push(turn.id);
    else groups.set(inboundId, {
      inboundStatus: statusById.get(inboundId) ?? '',
      outboundIds: [turn.id],
    });
  });
  const hidden = new Set<number>();
  for (const [inboundId, { inboundStatus, outboundIds }] of groups) {
    const redelivering = inboundStatus === 'PROCESSING' || inboundId === retryingInboundId;
    const keep = inboundStatus !== 'FAILED' && (redelivering || answered.has(inboundId))
      ? null
      : outboundIds[outboundIds.length - 1];
    for (const id of outboundIds) {
      if (id !== keep) hidden.add(id);
    }
  }
  return hidden;
}

/**
 * 判断流式轮次的回复是否已落库。
 *
 * 此前用纯文本相等（`turn.content === streamedText`）判断：引入非文本事件后
 * 落库正文与流式文本不再逐字相同，会误判成「还没落库」而多出一个重复气泡，
 * 反向也可能把别的轮次的回复错认成本轮的而丢掉气泡。改为按 turnId 顺序 +
 * 轮次终态判定。
 */
export function hasPersistedReplyForTurn(
  turns: ReadonlyArray<{ id: number; direction: string; status: string }>,
  streamedTurnId: number | null | undefined,
): boolean {
  if (streamedTurnId == null) return false;
  return turns.some((turn) =>
    isOutboundTurnDirection(turn.direction)
    && turn.id > streamedTurnId
    && TERMINAL_TURN_STATUS.has((turn.status ?? '').toUpperCase()));
}

/**
 * 把按轮次端点返回的原始事件行重组成逻辑事件：服务端只保存分片，浏览器拿到的
 * 是 (turnId, dispatchAttempt, eventSeq) 三元组下的若干 payloadFragment。
 *
 * 重派会重新执行模型，序号从头开始；各批次是不同历史，不能相互覆盖。
 */
export function assembleTurnEvents(
  rows: readonly ClarificationTurnEvent[],
): StreamedEvent[] {
  const groups = new Map<string, ClarificationTurnEvent[]>();
  for (const row of rows) {
    const logicalKey = `${row.turnId}:${row.dispatchAttempt ?? 0}:${row.eventSeq}`;
    const bucket = groups.get(logicalKey);
    if (bucket) bucket.push(row);
    else groups.set(logicalKey, [row]);
  }

  const events: StreamedEvent[] = [];
  for (const chunks of groups.values()) {
    const head = chunks[0];
    const expected = head.chunkCount ?? 1;
    // 分片不全就整条丢弃：拼出半截 JSON 只会让整个详情面板炸掉。
    if (chunks.length < expected) continue;
    const text = [...chunks]
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((chunk) => chunk.payloadFragment)
      .join('');
    events.push({
      dispatchAttempt: head.dispatchAttempt ?? 0,
      eventSeq: head.eventSeq,
      turnId: head.turnId,
      eventType: head.eventType,
      payload: parsePayload(text),
      receivedAt: 0,
    });
  }
  // eventSeq 每轮从 1 重新递增，排序键必须带 turnId。
  return events.sort((a, b) => a.turnId - b.turnId || (a.dispatchAttempt ?? 0) - (b.dispatchAttempt ?? 0) || a.eventSeq - b.eventSeq);
}

function parsePayload(text: string): ProviderEventPayload | null {
  try {
    return JSON.parse(text) as ProviderEventPayload;
  } catch {
    return null;
  }
}

/**
 * 历史轮次的执行事件按需加载：首次进入可视区后整轮读完并一次性呈现，
 * 之后切走/滚动/切标签页都保留已加载过程，不再清空或整批替换窗口。
 */
export function useTurnEvents(
  workitemId: number | string,
  conversationId: number | null,
  turnId: number | null,
  enabled: boolean,
) {
  const source = useMemo(
    () => createEventDisplaySource(
      `/api/workitems/${workitemId}/clarification-conversations/${conversationId ?? 0}`,
    ),
    [conversationId, workitemId],
  );
  const feed = useEventSummaryFeed({
    source,
    conversationId,
    turnId,
    enabled: enabled && !!conversationId && !!turnId,
    processing: false,
    keepAllEvents: true,
    atomicHistory: true,
  });
  return {
    timeline: feed.timeline,
    isLoading: feed.loading,
    isError: feed.error,
    hasNextPage: feed.hasMore,
    fetchNextPage: feed.loadMore,
    isFetchingNextPage: feed.isFetchingMore,
    preparationStatus: feed.preparationStatus,
    syncing: feed.syncing,
    reload: feed.reload,
  };
}

export interface ElicitationReplyVariables {
  requestId: string;
  action: 'accept' | 'decline';
  content?: Record<string, unknown>;
}

export function useReplyElicitation(workitemId: number | string, conversationId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: ElicitationReplyVariables) =>
      api.replyClarificationElicitation(
        workitemId, conversationId!, vars.requestId, vars.action, vars.content,
      ),
    onSuccess: () => {
      // 回答会唤醒挂起的 Agent 继续本轮，轮次状态随即变化，必须重新拉会话。
      queryClient.invalidateQueries({
        queryKey: ['workitem', workitemId, 'clarification-conversation', conversationId],
      });
    },
  });
}
