import { i18n } from '@/shared/i18n';
import { formatDateTime } from '@/shared/i18n/format';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal, Tooltip, Typography, message } from 'antd';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/shared/api/client';
import { useAccessCommand } from '@/shared/auth/useAccessCommand';
import { continueDispatch } from '../api';

interface Execution {
  dispatchId: number; agentId: number; status: string; error?: string; attempt: number;
  recovery: { cancel_requested?: number; stop_pending?: number; forced?: number; retry_count?: number; max_retries?: number;
    next_retry_at?: string; reason?: string; phase?: string };
  control?: { action?: string; phase?: string; origin?: string; requestedById?: number; requestedByName?: string;
    stopPending?: boolean; forced?: boolean } | null;
}
/** 一次用户发起的交付重启轮次（统一重新指派语义）。agent_id 是该轮重新指派的目标数字人。 */
export interface RestartRound {
  restart_round: number; restart_token?: string | null; status: string; stop_reason?: string | null;
  dispatch_id?: number | null; scheduled_start_at?: string | null; requested_by?: number;
  operator_type?: string; gmt_create?: string; gmt_modified?: string;
  source_dispatch_id?: number | null; sdlc_id?: number | null;
  agent_id?: number | null; agent_name?: string | null;
}
export interface RecoveryState {
  closed: boolean;
  executions: Execution[];
  restarts?: RestartRound[];
  canReopen?: boolean;
  reopenReasonKey?: string | null;
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED']);
// 最新一轮处于进行中的正常态时不透出轮次，避免与数字人执行状态争抢。
const normalRoundStatuses = new Set(['STARTED', 'STARTING']);
const restartLabels: Record<string, string> = { get STARTING() { return i18n.t('workitem:recovery.starting'); }, get STOPPING_OLD() { return i18n.t('workitem:recovery.stoppingOld'); }, get STARTED() { return i18n.t('workitem:recovery.started'); }, get FAILED() { return i18n.t('workitem:recovery.startFailed'); }, get SUPERSEDED() { return i18n.t('workitem:recovery.superseded'); } };
const reasons: Record<string, string> = { get AGENT_NOT_PUBLISHED() { return i18n.t('workitem:recovery.agentNotPublished'); }, get AGENT_VERSION_NOT_FOUND() { return i18n.t('workitem:recovery.versionNotFound'); }, get NO_EXECUTOR_ONLINE() { return i18n.t('workitem:recovery.noExecutor'); }, get NO_EXECUTOR_CAPACITY() { return i18n.t('workitem:recovery.noCapacity'); }, get CAPACITY_LOCK_BUSY() { return i18n.t('workitem:recovery.lockBusy'); }, get EXECUTOR_AT_CAPACITY() { return i18n.t('workitem:recovery.atCapacity'); }, get EXECUTOR_RECOVERING() { return i18n.t('workitem:recovery.executorRecovering'); }, get DISPATCH_BINDING_WAIT() { return i18n.t('workitem:recovery.bindingWait'); }, get DISPATCH_BINDING_TIMEOUT() { return i18n.t('workitem:recovery.bindingTimeout'); }, get RUNTIME_INCOMPATIBLE() { return i18n.t('workitem:recovery.incompatible'); }, get SELECTION_INTERNAL_ERROR() { return i18n.t('workitem:recovery.selectionError'); } };
const ROUND_META_SEPARATOR = ' · ';
const ROUND_TIME_OPTIONS: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };

export function useRecoveryState(workitemId?: string) {
  return useQuery<RecoveryState>({
    queryKey: ['workitem-recovery', workitemId],
    queryFn: async () => (await apiClient.get<RecoveryState>(`/api/workitems/${workitemId}/recovery`)).data,
    refetchInterval: 5000,
    enabled: Boolean(workitemId),
  });
}

/**
 * 交付启动记录。按持久化的 agent_id 归属到数字人：`section` 在关注块卡身内展示全部轮次，
 * `summary` 在非关注块卡头下只透出最新异常或一个弱化折叠入口。
 */
export function DeliveryStartRecords({ rounds, variant = 'section', currentDispatchId = null }: {
  rounds: RestartRound[];
  variant?: 'section' | 'summary' | 'unattributed';
  /** 数字人当前执行对应的派发；有值时只有挂在该派发上的轮次才算「当前这轮」，其余视为历史。 */
  currentDispatchId?: number | null;
}) {
  const { t } = useTranslation('workitem');
  const [open, setOpen] = useState<boolean | null>(null);
  if (rounds.length === 0) return null;
  const ordered = [...rounds].sort((a, b) => b.restart_round - a.restart_round);
  const unattributed = variant === 'unattributed';
  // 当前这轮：已产出当前派发时按派发归属匹配；从未派发时最新一轮就是当前尝试。
  const currentRound = currentDispatchId != null
    ? ordered.find(round => round.dispatch_id === currentDispatchId) ?? null
    : ordered[0];
  const currentNormal = currentRound == null || normalRoundStatuses.has(currentRound.status);
  const multipleRounds = ordered.length > 1;
  const hasHistoricalFailure = currentRound == null && ordered.some(round => round.status === 'FAILED');
  const canFold = multipleRounds || hasHistoricalFailure;
  // 历史轮次异常不默认展开，也不占用摘要行。
  if (!unattributed && !canFold && currentNormal) return null;
  const expanded = open ?? (unattributed || (variant === 'section' && !currentNormal));
  const roundLabel = (round: RestartRound) => round.restart_round === 1
    ? t('recovery.deliveryStart')
    : t('delivery.round', { number: round.restart_round });
  const summaryLabel = (round: RestartRound) => round.restart_round === 1
    ? t('recovery.deliveryStart')
    : t('recovery.roundStart', { number: round.restart_round });
  const dispatchNote = (round: RestartRound) => round.dispatch_id
    ? [t('recovery.roundDispatch', { id: round.dispatch_id }),
      round.source_dispatch_id ? t('recovery.roundReplaces', { id: round.source_dispatch_id }) : null].filter(Boolean).join(ROUND_META_SEPARATOR)
    : t('recovery.roundNoDispatch');
  const note = (round: RestartRound) => round.status === 'SUPERSEDED'
    ? dispatchNote(round)
    : round.stop_reason || dispatchNote(round);
  const roundRows = (list: RestartRound[]) => list.map(round => <div className="aw-restart-row" key={round.restart_round}>
    <div className="aw-restart-line">
      <span className="aw-restart-no">{roundLabel(round)}</span>
      <span className={`aw-restart-status${round.status === 'FAILED' ? ' is-failed' : ''}`}>{restartLabels[round.status] || round.status}</span>
      {round.gmt_create && <time dateTime={round.gmt_create}
        title={formatDateTime(round.gmt_create)}>{formatDateTime(round.gmt_create, ROUND_TIME_OPTIONS)}</time>}
    </div>
    <div className="aw-restart-note">{note(round)}</div>
  </div>);
  const foldLabel = (value: boolean) => value ? t('recovery.collapseRounds') : t('recovery.allRounds', { count: ordered.length });

  if (variant === 'summary' && !expanded) {
    if (currentRound == null || currentRound.status !== 'FAILED') {
      return <button type="button" className="aw-agent-block-sub is-quiet" aria-expanded={false}
        onClick={() => setOpen(true)}>
        <span className="aw-agent-block-sub-text">{t('recovery.recordsQuiet', { count: ordered.length })}</span>
      </button>;
    }
    const reason = currentRound.stop_reason || null;
    const time = currentRound.gmt_create
      ? <time dateTime={currentRound.gmt_create} title={formatDateTime(currentRound.gmt_create)}>{formatDateTime(currentRound.gmt_create, ROUND_TIME_OPTIONS)}</time>
      : null;
    return <div className="aw-agent-block-sub" role="alert" data-testid="recovery-controls">
      <span className="aw-agent-block-sub-k">{summaryLabel(currentRound)}</span>
      <span className="aw-restart-status is-failed">{restartLabels[currentRound.status] || currentRound.status}</span>
      {reason && <span className="aw-agent-block-sub-text" title={reason}>{reason}</span>}
      {time}
      {multipleRounds && <button type="button" className="aw-restart-fold" aria-expanded={false} title={foldLabel(false)}
        onClick={() => setOpen(true)}>
        {foldLabel(false)}
      </button>}
    </div>;
  }

  return <div className="aw-restart-sec" data-testid="delivery-restart-rounds">
    <div className="aw-restart-head">
      <span>{t(unattributed ? 'recovery.unattributedStartRecords' : 'recovery.deliveryStartRecords')}</span>
      {canFold && <button type="button" className="aw-restart-fold" aria-expanded={expanded} title={foldLabel(expanded)}
        onClick={() => setOpen(!expanded)}>
        {foldLabel(expanded)}
      </button>}
    </div>
    {expanded && roundRows(ordered)}
  </div>;
}

export interface DeliveryControlAction {
  label: string;
  danger: boolean;
  disabled: boolean;
  disabledReason: string | null;
  pending: boolean;
  invoke: () => void;
}

export function RecoveryControls({ workitemId, renderActions, variant = 'header', dispatchId }: { workitemId: string; renderActions?: (deliveryControl: DeliveryControlAction | null) => ReactNode; variant?: 'header' | 'execution'; dispatchId?: number }) {
  const { t } = useTranslation('workitem');
  const client = useQueryClient();
  const accessCommand = useAccessCommand();
  const { data, error } = useRecoveryState(workitemId);
  const mutation = useMutation({
    mutationFn: async ({ action, dispatchId, force }: { action: string; dispatchId?: number; force?: boolean }) => {
      if (action === 'retry') return continueDispatch(workitemId, dispatchId!);
      return apiClient.post(`/api/workitems/${workitemId}/recovery`, { action, dispatchId, force });
    },
    onSuccess: async () => { await client.invalidateQueries(); message.success(i18n.t('workitem:recovery.accepted')); },
    onError: (e: Error) => message.error(e.message || i18n.t('workitem:recovery.operationFailed')),
  });
  const submitting = useRef(false);
  const act = (action: string, dispatchId?: number, force = false) => {
    if (submitting.current) return undefined;
    return accessCommand('READ_WRITE', t('recovery.command'), () => {
      submitting.current = true;
      return mutation.mutateAsync({ action, dispatchId, force }).finally(() => { submitting.current = false; });
    });
  };
  if (error) return <>{renderActions?.(null)}<Alert type="warning" message={t('recovery.loadFailed')} /></>;
  if (!data) return <>{renderActions?.(null)}</>;
  const executions = variant === 'execution' ? data.executions.filter(e => e.dispatchId === dispatchId) : [];
  const executionRows = executions.map(e => {
    const reason = e.error || e.recovery.reason;
    const userForceUnconfirmed = e.control?.origin === 'USER'
      && !!e.recovery.forced && !!e.recovery.stop_pending;
    const retrying = !!e.recovery.retry_count && !terminal.has(e.status);
    if (!reason && !userForceUnconfirmed && !retrying) return null;
    return <div key={e.dispatchId} style={{ margin: '12px 0' }}>
      {userForceUnconfirmed ? <Alert type="warning" message={t('recovery.forceWarning')} /> : null}
      {reason && <div style={{ overflowWrap: 'anywhere' }}><Typography.Text type="secondary">{reasons[reason] || reason}</Typography.Text></div>}
      {retrying && <div>{e.recovery.next_retry_at ? t('recovery.retryScheduled', { number: e.recovery.retry_count, maximum: e.recovery.max_retries ?? 3, time: formatDateTime(e.recovery.next_retry_at) }) : t('recovery.retryCount', { number: e.recovery.retry_count, maximum: e.recovery.max_retries ?? 3 })}</div>}
    </div>;
  });
  const reopenAction = 'reopen';
  const closeAction = 'close';
  const confirmDeliveryAction = (action: string) => () => act(action)?.catch(() => undefined);
  const requestDeliveryControl = () => {
    if (data.closed) {
      Modal.confirm({
        title: t('recovery.reopenDelivery'),
        content: t('recovery.reopenConfirmBody'),
        okText: t('recovery.reopenDelivery'),
        cancelText: t('delivery.cancelAction'),
        onOk: confirmDeliveryAction(reopenAction),
      });
      return;
    }
    Modal.confirm({
      title: t('recovery.closeDelivery'),
      content: t('recovery.closeConfirmBody'),
      okText: t('recovery.closeDelivery'),
      okButtonProps: { danger: true },
      cancelText: t('delivery.cancelAction'),
      onOk: confirmDeliveryAction(closeAction),
    });
  };
  const reopenDisabled = data.closed && !data.canReopen;
  const deliveryHint = data.closed
    ? reopenDisabled ? t('recovery.cancelPending') : t('recovery.reopenHint')
    : t('recovery.closeHint');
  const deliveryButton = <Button aria-label={data.closed ? t('recovery.reopenDelivery') : t('recovery.closeDelivery')}
    danger={!data.closed} loading={mutation.isPending} disabled={reopenDisabled}
    onClick={requestDeliveryControl}>
    {data.closed ? t('recovery.reopenDelivery') : t('recovery.closeDelivery')}
  </Button>;
  const deliveryControl = <span className="aw-delivery-toggle" data-testid="delivery-toggle">
    <span className="aw-delivery-toggle-state">{data.closed ? t('recovery.deliveryClosed') : t('recovery.deliveryOpen')}</span>
    {reopenDisabled
      ? <Tooltip title={deliveryHint} trigger={['hover', 'focus']}>
        <span className="aw-delivery-toggle-action" tabIndex={0} aria-label={deliveryHint}>{deliveryButton}</span>
      </Tooltip>
      : <Tooltip title={deliveryHint} trigger={['hover', 'focus']}>{deliveryButton}</Tooltip>}
  </span>;
  const deliveryAction: DeliveryControlAction = {
    label: data.closed ? t('recovery.reopenDelivery') : t('recovery.closeDelivery'),
    danger: !data.closed,
    disabled: reopenDisabled,
    disabledReason: reopenDisabled ? deliveryHint : null,
    pending: mutation.isPending,
    invoke: requestDeliveryControl,
  };
  if (variant === 'execution') return <>{executionRows}</>;
  return renderActions ? renderActions(deliveryAction) : deliveryControl;
}
