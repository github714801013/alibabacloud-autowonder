import { formatDuration } from '../duration';
import { formatDateTime, formatNumber } from '@/shared/i18n/format';
import { i18n } from '@/shared/i18n';
import { runtimeStatusLabel, dispatchExecutionLabel, runtimeEdgeLabel, artifactTypeLabel, subStepName, graphAgentName } from '../runtimeLabels';
import { Trans, useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Card, Typography, Space, Spin, Collapse, Tag, Tooltip, Button, Popover, ConfigProvider, Modal, Tabs, Alert, Empty } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, CompressOutlined, LoadingOutlined } from '@ant-design/icons';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import type { AgentDeliveryProgress, Artifact, DeliveryProgress as DeliveryProgressModel, DeliveryStep, DispatchAttempt, ProcessGraph, ProcessGraphEdge, ProcessGraphNode, StepTiming, SubStep, WorkflowPlan } from '@/shared/types/workitem';
import { artifactCategories, artifactsForReadingCategory, artifactsInDisplayOrder, groupArtifactsByExecution } from '../artifactGrouping';
import { basename } from '@/shared/lib/artifactLinking';
import { formatCredits } from '@/shared/lib/tokenFormat';
import { getArtifactDownloadUrl, getRuntimeTrace } from '../api';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import { DispatchActivityFeed } from './DispatchActivityFeed';
import { ExecutionActionBar } from './ExecutionActionBar';
import type { ExecutionActionKind } from '../hooks';
import { LiveActivityPanel } from './LiveActivityPanel';
import { RuntimeTracePanel } from './RuntimeTraceDrawer';
import { RuntimeLogPanel } from './RuntimeLogDrawer';
import './DeliveryWorkbench.css';
import { TokenUsageBadge, StepTokenBadge } from './TokenUsageBadge';
import { StepDurationChart } from './StepDurationChart';
import { creditRunLabel, creditRuns } from './creditsBreakdown';
import { NoticeTip } from '@/shared/ui/NoticeTip';
import { DeliveryStartRecords, useRecoveryState } from './RecoveryControls';
import type { RestartRound } from './RecoveryControls';
import { useIsMobile } from '@/shared/ui/useIsMobile';

const { Text } = Typography;

type DisplayAttempt = DispatchAttempt & {
  displayIndex: number;
  isActivityFeedHost: boolean;
};

type GraphSelection = { node: ProcessGraphNode } | { edge: ProcessGraphEdge; index: number; source: ProcessGraphNode; target: ProcessGraphNode };

interface DeliveryProgressProps {
  showWorkflowPlan?: boolean;
  renderControlTimeline?: (dispatchId: number, compact?: boolean) => ReactNode;
  renderRecovery?: (dispatchId: number) => ReactNode;
  steps?: DeliveryStep[];
  progress?: DeliveryProgressModel | null;
  artifacts?: Artifact[];
  artifactsLoading?: boolean;
  loading?: boolean;
  terminalStatus?: string | null;
  onContinue?: (dispatchId: number) => void;
  continuingDispatchId?: number | null;
  onPause?: (dispatchId: number) => void;
  pausingDispatchId?: number | null;
  onExecutionAction?: (attempt: DispatchAttempt, action: ExecutionActionKind) => void;
  pendingExecutionAction?: { dispatchId: number; action: ExecutionActionKind } | null;
  workitemId?: string;
}

export { formatDuration } from '../duration';

export type StepDisplayStatus = DeliveryStep['status'] | 'cancelled' | 'interrupted';

export type ConvergedDeliveryStep = Omit<DeliveryStep, 'status' | 'subSteps'> & {
  status: StepDisplayStatus;
  subSteps: (Omit<SubStep, 'status'> & { status: SubStep['status'] | 'cancelled' })[] | null;
};

type TerminalKind = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

function normalizeTerminalStatus(terminalStatus?: string | null): TerminalKind | null {
  if (!terminalStatus) return null;
  const value = terminalStatus.trim().toUpperCase();
  if (value === 'SUCCEEDED' || value === 'FAILED' || value === 'CANCELLED') return value;
  if (value === 'CANCELED') return 'CANCELLED';
  if (value === 'DONE') return 'SUCCEEDED';
  if (value === 'CLOSED' || terminalStatus.trim() === '已关闭') return 'SUCCEEDED';
  return null;
}

function convergedSubStepStatus(status: SubStep['status'], terminal: TerminalKind, isFailurePoint: boolean): SubStep['status'] | 'cancelled' {
  if (status !== 'active') return status;
  if (terminal === 'SUCCEEDED') return 'done';
  if (terminal === 'CANCELLED') return 'cancelled';
  return isFailurePoint ? 'failed' : 'done';
}

// 终态收敛：run/工单已终态但步骤事件流不完整（缺 completed 事件）时，把仍为 active 的步骤映射到与终态一致的展示状态。
export function convergeStepsForTerminalStatus(steps: DeliveryStep[], terminalStatus?: string | null): ConvergedDeliveryStep[] {
  const terminal = normalizeTerminalStatus(terminalStatus);
  if (!terminal) return steps.map((step) => ({ ...step }));

  let lastActiveIndex = -1;
  if (terminal === 'FAILED') {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].status === 'active') {
        lastActiveIndex = i;
        break;
      }
    }
  }

  return steps.map((step, index) => {
    if (step.status !== 'active') return { ...step };
    const isFailurePoint = index === lastActiveIndex;
    const status: StepDisplayStatus = terminal === 'SUCCEEDED'
      ? 'done'
      : terminal === 'CANCELLED'
        ? 'cancelled'
        : isFailurePoint ? 'failed' : 'done';
    return {
      ...step,
      status,
      subSteps: step.subSteps?.map((sub) => ({ ...sub, status: convergedSubStepStatus(sub.status, terminal, isFailurePoint) })) ?? null,
    };
  });
}

function StepIcon({ step, index, pausing = false }: { step: ConvergedDeliveryStep; index: number; pausing?: boolean }) {
  if (step.status === 'done' || step.status === 'reused' || step.planStatus === 'REUSED') {
    return <CheckCircleFilled aria-hidden="true" style={{ color: 'var(--aw-success-deep)', fontSize: 16 }} />;
  }
  if (pausing) {
    return <span style={{ color: 'var(--aw-warning-deep)', display: 'inline-flex' }}><AwStrokeIcon name="pause" size={16} /></span>;
  }
  if (step.status === 'active' && step.executionStatus && step.executionStatus !== 'RUNNING') {
    return <span style={{ color: 'var(--aw-muted)', display: 'inline-flex' }}><AwStrokeIcon name="clock" size={16} /></span>;
  }
  if (step.status === 'active') {
    return <LoadingOutlined aria-hidden="true" style={{ color: 'var(--aw-accent-text)', fontSize: 16 }} />;
  }
  if (step.status === 'cancelled') {
    return <span style={{ color: 'var(--aw-muted)', display: 'inline-flex' }}><AwStrokeIcon name="pause" size={16} /></span>;
  }
  if (step.status === 'failed') {
    return <CloseCircleFilled aria-hidden="true" style={{ color: 'var(--aw-error-deep)', fontSize: 16 }} />;
  }
  if (step.status === 'paused') {
    return <span style={{ color: 'var(--aw-warning-deep)', display: 'inline-flex' }}><AwStrokeIcon name="pause" size={16} /></span>;
  }
  if (step.status === 'skipped' || step.status === 'stale' || step.status === 'interrupted' || step.planStatus === 'SKIPPED') {
    return <span style={{ color: step.status === 'stale' || step.status === 'interrupted' ? 'var(--aw-warning)' : 'var(--aw-muted)', fontSize: 11 }}>—</span>;
  }
  // pending
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: '1.5px solid var(--aw-border)',
        fontSize: 10,
        color: 'var(--aw-muted)',
        lineHeight: 1,
      }}
    >
      {index + 1}
    </span>
  );
}

function SubStepDot({ status }: { status: SubStep['status'] | 'cancelled' }) {
  const colorMap: Record<SubStep['status'] | 'cancelled', string> = {
    done: 'var(--aw-success)',
    active: 'var(--aw-accent-text)',
    pending: 'var(--aw-border)',
    failed: 'var(--aw-error)',
    cancelled: 'var(--aw-muted)',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        backgroundColor: colorMap[status],
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

function findActionTargetStep(steps: ConvergedDeliveryStep[], ownerStep: ConvergedDeliveryStep, attempt: DispatchAttempt): ConvergedDeliveryStep | null {
  if (attempt.resumeMode === 'COMMENT_INTERACTION'
    || attempt.resumeMode === 'SIDE_INTERACTION'
    || attempt.resumeMode === 'CANONICAL_INTERACTION') {
    return null;
  }
  if (attempt.canPause) {
    if (ownerStep.status === 'active') {
      return ownerStep;
    }
    return steps.find((step) => step.status === 'active') ?? null;
  }
  if (attempt.canContinue) {
    if (ownerStep.status === 'paused' || ownerStep.status === 'failed') {
      return ownerStep;
    }
    return steps.find((step) => step.status === 'paused' || step.status === 'failed') ?? null;
  }
  return null;
}

function buildAttemptViews(steps: ConvergedDeliveryStep[]): Map<number, DisplayAttempt[]> {
  const byStep = new Map<number, DisplayAttempt[]>();
  const relocatedActions = new Map<number, Set<number>>();

  steps.forEach((step) => {
    step.attempts?.forEach((attempt, i) => {
      const target = findActionTargetStep(steps, step, attempt);
      if (target && target.stepId !== step.stepId && !target.attempts?.some(value => value.dispatchId === attempt.dispatchId)) {
        relocatedActions.set(step.stepId, (relocatedActions.get(step.stepId) ?? new Set()).add(attempt.dispatchId));
        byStep.set(target.stepId, [
          ...(byStep.get(target.stepId) ?? []),
          { ...attempt, displayIndex: i, isActivityFeedHost: true },
        ]);
      }
    });
  });

  steps.forEach((step) => {
    const strippedActionIds = relocatedActions.get(step.stepId);
    const attempts = step.attempts?.map((attempt, i) => {
      const isRelocatedAction = strippedActionIds?.has(attempt.dispatchId) ?? false;
      return {
        ...attempt,
        ...(isRelocatedAction ? { canContinue: false, canPause: false } : {}),
        displayIndex: i,
        isActivityFeedHost: !isRelocatedAction,
      };
    }) ?? [];
    byStep.set(step.stepId, [...attempts, ...(byStep.get(step.stepId) ?? [])]);
  });

  return byStep;
}

function stepIsPausing(step: ConvergedDeliveryStep): boolean {
  return step.attempts?.some((attempt) => attempt.status === 'PAUSING') ?? false;
}

function StepCard({ step, index, attempts, renderControlTimeline, collapsible = false, defaultOpen = false, feedAttempt }: {
  step: ConvergedDeliveryStep;
  index: number;
  attempts: DisplayAttempt[];
  renderControlTimeline?: (dispatchId: number, compact?: boolean) => ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  feedAttempt?: DisplayAttempt;
}) {
  const { t } = useTranslation('workitem');
  const isCancelling = attempts.some((attempt) => attempt.cancelRequested && attempt.status === 'PAUSING');
  const isPausing = !isCancelling && attempts.some((attempt) => attempt.status === 'PAUSING');
  const isActive = step.status === 'active';
  const isPaused = step.status === 'paused';
  const isCancelled = step.status === 'cancelled';
  const isDone = step.status === 'done' || step.status === 'reused' || step.status === 'skipped'
    || step.planStatus === 'REUSED' || step.planStatus === 'SKIPPED';
  const isFailed = step.status === 'failed';
  const isInterrupted = step.status === 'interrupted';
  const executionLabel = step.planStatus === 'SKIPPED' ? t('delivery.noExecution') : isDone ? t('delivery.completed') : isCancelling ? t('delivery.ending') : isPausing ? t('delivery.pausing') : isActive ? step.executionStatus ? dispatchExecutionLabel(step.executionStatus, step.waitingReason) : t('delivery.running') : isPaused ? t('delivery.paused') : isCancelled ? t('delivery.cancelled') : isFailed ? t('delivery.failed') : isInterrupted ? t('stepTiming.status.interrupted') : t('delivery.pending');
  const planLabel = step.planStatus === 'RUN'
    ? t('delivery.rerun')
    : step.planStatus === 'REUSED'
      ? step.sourceAttempt ? t('delivery.reusedResult', { number: step.sourceAttempt }) : t('delivery.reusedPrevious')
      : step.planStatus === 'SKIPPED'
        ? t('delivery.skipped')
        : null;
  const hasAttemptDetails = attempts.length > 0 || Boolean(step.agentName) || Boolean(step.executorName) || Boolean(step.subSteps?.length);
  const attentionStatus = isActive || isPaused || isFailed;
  const [recordsOpen, setRecordsOpen] = useState(collapsible ? defaultOpen || attentionStatus : attentionStatus);
  const previousAttentionStatus = useRef(attentionStatus);
  const attemptRecords = attempts.length > 0 ? attempts : [];
  const bodyId = `delivery-stage-body-${step.stepId}`;

  useEffect(() => {
    if (attentionStatus && !previousAttentionStatus.current) {
      setRecordsOpen(true);
    }
    previousAttentionStatus.current = attentionStatus;
  }, [attentionStatus]);

  const attemptLine = (attempt: DisplayAttempt) => <>
    {attempt.executorName
      ? t('delivery.attemptOnRunner', { number: attempt.displayIndex + 1, name: attempt.agentName ?? '—', runner: attempt.executorName, status: dispatchExecutionLabel(attempt.status, attempt.waitingReason) })
      : t('delivery.attempt', { number: attempt.displayIndex + 1, name: attempt.agentName ?? '—', status: dispatchExecutionLabel(attempt.status, attempt.waitingReason) })}
    {attempt.durationMs != null && ` · ${formatDuration(attempt.durationMs)}`}
    {attempt.error && !collapsible && ` · ${attempt.error}`}
  </>;
  const headerContent = <>
    {collapsible && <AwStrokeIcon name={recordsOpen ? 'chev-d' : 'chev-r'} size={12} className="delivery-stage-chev" />}
    <span className="delivery-step-icon"><StepIcon step={step} index={index} pausing={isPausing} /></span>
    <Text style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--aw-text)' }}>
      {step.name}
    </Text>
    {step.error && (
      <Tooltip title={step.error}>
        <Tag color="error" style={{ marginInlineEnd: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t('delivery.failureDetail', { error: step.error })}
        </Tag>
      </Tooltip>
    )}
    <Text
      type="secondary"
      style={{ fontSize: 11, color: isPausing || isPaused ? 'var(--aw-warning-deep)' : isActive ? 'var(--aw-primary)' : isFailed ? 'var(--aw-error)' : isInterrupted ? 'var(--aw-warning-deep)' : isDone ? 'var(--aw-success)' : 'var(--aw-text-3)' }}
    >
      {planLabel ? t('delivery.stepStatus', { plan: planLabel, status: executionLabel }) : step.status === 'reused' ? t('delivery.reusedPrevious') : step.status === 'skipped' ? t('delivery.skipped') : step.status === 'stale' ? t('delivery.stale') : executionLabel}
      {step.durationMs != null && `  ${formatDuration(step.durationMs)}`}
    </Text>
    {step.usage && <StepTokenBadge usage={step.usage} />}
  </>;
  const agentName = step.agentName ?? attempts[0]?.agentName;

  return (
    <div
      data-testid={`delivery-step-${step.stepId}`}
      className={`delivery-step-card${collapsible ? ' is-collapsible' : ''}`}
      style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--aw-border)', backgroundColor: 'var(--aw-panel)' }}
    >
      {collapsible
        ? <button type="button" className="delivery-stage-head" aria-expanded={recordsOpen} aria-controls={recordsOpen ? bodyId : undefined} onClick={() => setRecordsOpen(open => !open)}>{headerContent}</button>
        : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{headerContent}</div>}

      {collapsible && recordsOpen && (
        <div id={bodyId} className="delivery-stage-body">
          {(agentName || step.executorName || feedAttempt) && <div className="delivery-stage-meta">
            {agentName && <span>{t('delivery.executor', { name: agentName })}</span>}
            {step.executorName && <span>{t('delivery.runner', { name: step.executorName })}</span>}
            {feedAttempt && <span data-testid="delivery-stage-attempt">{attemptLine(feedAttempt)}</span>}
          </div>}
          {feedAttempt && <>
            {renderControlTimeline?.(feedAttempt.dispatchId)}
            <DispatchActivityFeed dispatchId={feedAttempt.dispatchId} status={feedAttempt.status} />
          </>}
          {step.subSteps && step.subSteps.length > 0 && (
            <div className="delivery-step-substeps" data-testid="delivery-stage-events">
              {step.subSteps.map((sub, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
                  <SubStepDot status={sub.status} />
                  <Text style={{ fontSize: 12, color: 'var(--aw-muted)' }}>{subStepName(sub)}</Text>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!collapsible && hasAttemptDetails && (
        <div style={{ marginTop: 4, paddingLeft: 22 }}>
          <Collapse
            ghost
            size="small"
            activeKey={recordsOpen ? ['records'] : []}
            onChange={(keys) => setRecordsOpen((Array.isArray(keys) ? keys : [keys]).includes('records'))}
            items={[
              {
                key: 'records',
                label: <Text type="secondary" style={{ fontSize: 12 }}>{t('artifacts.runtime')}</Text>,
                children: (
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {step.agentName && (
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                        {t('delivery.executor', { name: step.agentName })}
                      </Text>
                    )}
                    {step.executorName && (
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                        {t('delivery.runner', { name: step.executorName })}
                      </Text>
                    )}
                    {recordsOpen && attemptRecords.map((attempt) => (
                      <div key={String(attempt.dispatchId)}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Text type="secondary" style={{ fontSize: 11, flex: 1 }}>
                            {attemptLine(attempt)}
                          </Text>
                        </div>
                        {recordsOpen && attempt.isActivityFeedHost && (
                          <>
                            {renderControlTimeline?.(attempt.dispatchId)}
                            <DispatchActivityFeed dispatchId={attempt.dispatchId} status={attempt.status} />
                          </>
                        )}
                      </div>
                    ))}
                    {step.subSteps && step.subSteps.length > 0 && (
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        {step.subSteps.map((sub, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
                            <SubStepDot status={sub.status} />
                            <Text style={{ fontSize: 12, color: sub.status === 'pending' ? 'var(--aw-muted)' : 'var(--aw-muted)' }}>
                              {subStepName(sub)}
                            </Text>
                          </div>
                        ))}
                      </Space>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function StepList({ steps, renderControlTimeline, collapsible, feedAttempt }: { steps: ConvergedDeliveryStep[]; collapsible?: boolean; feedAttempt?: DispatchAttempt } & Pick<DeliveryProgressProps, 'renderControlTimeline'>) {
  const attemptsByStep = buildAttemptViews(steps);
  // 同一 dispatch 的活动流只挂一处：最后一个有执行记录的阶段（默认展开），避免逐阶段重复。
  const lastWithAttempts = steps.map(step => (attemptsByStep.get(step.stepId)?.length ?? 0) > 0).lastIndexOf(true);
  const feedHostIndex = !collapsible ? -1 : lastWithAttempts >= 0 ? lastWithAttempts : steps.length - 1;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {steps.map((step, i) => {
        const attempts = attemptsByStep.get(step.stepId) ?? [];
        return <StepCard
          key={String(step.stepId)}
          step={step}
          index={i}
          attempts={attempts}
          renderControlTimeline={renderControlTimeline}
          collapsible={collapsible}
          defaultOpen={steps.length === 1 || i === feedHostIndex}
          feedAttempt={i !== feedHostIndex ? undefined : attempts.find(attempt => attempt.isActivityFeedHost) ?? (feedAttempt && { ...feedAttempt, displayIndex: 0, isActivityFeedHost: true })}
        />;
      })}
    </Space>
  );
}

export function WorkflowPlanSummary({ plan }: { plan: WorkflowPlan }) {
  const { t } = useTranslation('workitem');
  const grouped = (status: WorkflowPlan['steps'][number]['planStatus']) => plan.steps
    .filter((step) => step.planStatus === status)
    .map((step) => step.name || step.stepKey)
    .filter((name): name is string => Boolean(name));
  const reused = grouped('REUSED');
  const run = grouped('RUN');
  const skipped = grouped('SKIPPED');

  return (
    <Card
      size="small"
      title={t('delivery.plan')}
      data-testid="workflow-plan-card"
      styles={{ body: { padding: '8px 10px' } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('delivery.round', { number: plan.revision })}</Tag>
      </div>
      <Space size={[6, 6]} wrap>
        {reused.length > 0 && <Tag color="green">{t('delivery.reuseNames', { names: reused.join(i18n.language === 'en-US' ? ', ' : '、') })}</Tag>}
        {run.length > 0 && <Tag color="volcano">{t('delivery.rerunNames', { names: run.join(i18n.language === 'en-US' ? ', ' : '、') })}</Tag>}
        <Tag>{t('delivery.skipNames', { names: skipped.length > 0 ? skipped.join(i18n.language === 'en-US' ? ', ' : '、') : t('delivery.none') })}</Tag>
      </Space>
      {plan.reason && (
        <Text type="secondary" style={{ display: 'block', marginTop: 7, fontSize: 11 }}>
          {t('delivery.reason', { reason: plan.reason })}
        </Text>
      )}
      {plan.agentName && (
        <Text type="secondary" style={{ display: 'block', marginTop: 3, fontSize: 11 }}>
          {t('delivery.executor', { name: plan.agentName })}
        </Text>
      )}
    </Card>
  );
}

function statusLabel(status: AgentDeliveryProgress['status'], executionStatus?: string | null, waitingReason?: string | null) {
  // 超时是独立的终态，不能沿用「失败」；等待/暂停中的状态也要用对应的提示色。
  if (executionStatus === 'TIMEOUT') return { text: i18n.t('workitem:recovery.timeout'), color: 'error' };
  if (status === 'active' && executionStatus) {
    // 暂停失败是执行器未确认的失败结果，按错误色提示，不能混进「暂停中」的等待态。
    if (executionStatus === 'PAUSE_FAILED') return { text: dispatchExecutionLabel(executionStatus, waitingReason), color: 'error' };
    const waiting = ['PENDING', 'PACKAGING', 'PAUSED', 'PAUSING', 'WAITING_FOR_PAUSE'].includes(executionStatus);
    return { text: dispatchExecutionLabel(executionStatus, waitingReason), color: executionStatus === 'PENDING' ? 'default' : waiting ? 'warning' : 'processing' };
  }
  if (status === 'cancelled') return { text: i18n.t('workitem:delivery.cancelled'), color: 'default' };
  if (status === 'active') return { text: i18n.t('workitem:delivery.running'), color: 'processing' };
  if (status === 'paused') return { text: i18n.t('workitem:delivery.paused'), color: 'warning' };
  if (status === 'finished') return { text: i18n.t('workitem:delivery.completed'), color: 'success' };
  if (status === 'failed') return { text: i18n.t('workitem:delivery.failed'), color: 'error' };
  return { text: i18n.t('workitem:delivery.notRun'), color: 'default' };
}

export type ConvergedAgentProgress = Omit<AgentDeliveryProgress, 'steps'> & {
  steps: ConvergedDeliveryStep[];
};

function artifactDispatchIds(agent: ConvergedAgentProgress): Set<number> {
  const ids = new Set<number>();
  agent.steps.forEach((step) => {
    step.attempts?.forEach((attempt) => {
      if (attempt.dispatchId != null) {
        ids.add(Number(attempt.dispatchId));
      }
    });
  });
  return ids;
}

// Distinct dispatch ids for an agent in step/attempt order (oldest first), so retries and
// multi-dispatch history stay selectable instead of only exposing the latest one.
function orderedDispatchIds(agent: ConvergedAgentProgress): number[] {
  return Array.from(artifactDispatchIds(agent));
}

function artifactsForAgent(agent: ConvergedAgentProgress, artifacts: Artifact[], executions?: DispatchAttempt[] | null): Artifact[] {
  const dispatchIds = artifactDispatchIds(agent);
  executions?.filter(execution => execution.agentId === agent.agentId).forEach(execution => dispatchIds.add(execution.dispatchId));
  return artifacts.filter((artifact) => artifact.dispatchId != null && dispatchIds.has(Number(artifact.dispatchId)));
}

function clampZoom(value: number): number {
  return Math.min(2.4, Math.max(0.01, value));
}

function GraphText({ value, x, y, width, size = 10, strong = false, align = 'center' }: { value: string; x: number; y: number; width: number; size?: number; strong?: boolean; align?: 'left' | 'center' }) {
  return <foreignObject x={x - width / 2} y={y} width={width} height={size + 5}>
    <div className="execution-graph-text" style={{ fontSize: size, fontWeight: strong ? 600 : 400, textAlign: align }}>{value}</div>
  </foreignObject>;
}

const outlinedStage = (status: string) => status === 'reused' || status === 'skipped';

function stageCellColor(status: string) {
  if (status === 'done') return 'var(--aw-success)';
  if (status === 'active') return 'var(--aw-primary)';
  if (status === 'failed') return 'var(--aw-error)';
  if (status === 'paused') return 'var(--aw-warning)';
  return 'var(--aw-text-3)';
}

const isRunningNode = (status?: string | null) => ['RUNNING', 'ACKED', 'DISPATCHED'].includes(status?.toUpperCase() ?? '');

function graphStatusTone(status?: string | null) {
  const value = status?.toUpperCase();
  if (isRunningNode(status)) return 'running';
  if (value === 'SUCCEEDED') return 'success';
  if (value === 'FAILED' || value === 'TIMEOUT') return 'error';
  if (value?.includes('PAUS')) return 'warning';
  return 'muted';
}

function authoritativeNodeTone(status?: string | null) {
  const value = status?.toUpperCase();
  if (isRunningNode(status)) return { border: 'var(--aw-primary)', bar: 'var(--aw-primary)', background: 'var(--aw-primary-faint)' };
  if (value === 'FAILED' || value === 'TIMEOUT' || value === 'CANCELED') return { border: 'var(--aw-error)', bar: 'var(--aw-error)', background: 'var(--aw-panel)' };
  if (value?.includes('PAUS')) return { border: 'var(--aw-border)', bar: 'var(--aw-warning)', background: 'var(--aw-panel)' };
  if (value === 'HUMAN') return { border: 'var(--aw-border)', bar: 'var(--aw-primary)', background: 'var(--aw-primary-weak)' };
  return { border: 'var(--aw-border)', bar: value === 'SUCCEEDED' ? 'var(--aw-success)' : 'var(--aw-text-3)', background: 'var(--aw-panel)' };
}

function authoritativeEdgeTone(type: ProcessGraphEdge['type']) {
  if (type === 'COMMENT_REWORK') return { color: 'var(--aw-error)', background: 'var(--aw-error-bg)' };
  if (type === 'CONTINUE') return { color: 'var(--aw-warning-deep)', background: 'var(--aw-warning-bg)' };
  return { color: 'color-mix(in srgb, var(--aw-primary) 60%, var(--aw-panel))', background: 'var(--aw-primary-weak)' };
}

function graphConnectionPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  return from.x === to.x
    ? `M ${from.x + 52} ${from.y} C ${from.x + 95} ${from.y}, ${to.x + 95} ${to.y}, ${to.x + 52} ${to.y}`
    : `M ${from.x} ${from.y + 26} C ${from.x} ${from.y + 39}, ${to.x} ${to.y - 39}, ${to.x} ${to.y - 26}`;
}

function AuthoritativeExecutionProcessGraph({ processGraph, entries, onOpenTrace }: { processGraph?: ProcessGraph | null; entries: ExecutionEntry[]; onOpenTrace: (dispatchId: number) => void }) {
  const { t } = useTranslation('workitem');
  const viewport = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const content = useRef<SVGGElement>(null);
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [size, setSize] = useState({ width: 680, height: 420 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelection] = useState<GraphSelection | null>(null);
  const nodes = processGraph?.nodes ?? [];
  const edges = processGraph?.edges ?? [];
  const laneKey = (node: ProcessGraphNode) => node.agentId != null ? `agent:${node.agentId}` : node.key;
  const lanes = Array.from(new Set(nodes.map(laneKey)));
  const laneSpacing = 116;
  const rowSpacing = 76;
  const width = 180 + Math.max(0, lanes.length - 1) * laneSpacing;
  const height = 100 + Math.max(0, nodes.length - 1) * rowSpacing;
  const positions = new Map(nodes.map((node, index) => [node.key, { x: 64 + lanes.indexOf(laneKey(node)) * laneSpacing, y: 48 + index * rowSpacing }]));
  const nodesByKey = new Map(nodes.map(node => [node.key, node]));
  const fit = (widthOnly = false) => {
    // 按内容实际边界适配：固定宽度公式右侧多留了同泳道回环线的余量，会让左右留白不对称
    const box = content.current?.getBBox?.();
    const bounds = box && box.width > 0 ? { x: box.x, width: box.width } : { x: 0, width };
    const inner = size.width - 48;
    const next = widthOnly
      ? clampZoom(inner / bounds.width)
      : clampZoom(Math.min(1, inner / bounds.width, (size.height - 16) / height));
    setZoom(next);
    setPan({ x: (size.width - bounds.width * next) / 2 - bounds.x * next, y: 8 });
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nodes.length > 0, fullscreen]);
  useEffect(() => { fit(); }, [width, height, size.width, size.height]);
  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [fullscreen]);

  if (nodes.length === 0) return null;
  const stageSequence = (node: ProcessGraphNode) => entries.find(entry => entry.dispatchId === node.dispatchId)?.steps.filter(step => step.status !== 'pending') ?? [];
  const nodeTitle = (node: ProcessGraphNode) => node.stepName || t('delivery.humanHandoff');
  const nodeDetails = (node: ProcessGraphNode) => {
    const sequence = stageSequence(node);
    const name = node.dispatchId != null ? `#${node.dispatchId}` : graphAgentName(node);
    return <Space direction="vertical" size={2} className="execution-graph-node-info">
      <Text strong>{graphAgentName(node)}</Text>
      <span>{sequence.length > 0
        ? <Trans t={t} i18nKey="delivery.nodeStatus" values={{ name, status: runtimeStatusLabel(node.status) }} components={{ status: <span className={`execution-graph-node-status is-${graphStatusTone(node.status)}`} /> }} />
        : t('delivery.nodeSummary', { name, step: nodeTitle(node), status: runtimeStatusLabel(node.status) })}</span>
      <span className="is-dim">{t('workbench.startedAt', { time: node.startedAt ? formatDateTime(node.startedAt) : t('workbench.unknownTime') })}</span>
      {sequence.length > 0 ? <>
        <div data-testid="execution-graph-stage-list" className="execution-graph-stage-list">
          {sequence.map((step, index) => <div key={`${step.stepId}-${index}`} className="execution-graph-stage-row">
            <i className={outlinedStage(step.status) ? 'execution-graph-stage-dot is-outlined' : 'execution-graph-stage-dot'} style={outlinedStage(step.status) ? undefined : { background: stageCellColor(step.status) }} />
            <span className="execution-graph-stage-name">{step.name}</span>
            <span className="execution-graph-stage-meta">{step.durationMs == null ? t(`stepTiming.status.${step.status}`) : t('delivery.stageMeta', { status: t(`stepTiming.status.${step.status}`), duration: formatDuration(step.durationMs) })}</span>
          </div>)}
        </div>
        <span className="is-mono">{t('delivery.stageTotal', { duration: formatDuration(node.durationMs) || t('workbench.unknownTime') })}</span>
      </> : <span>{t('delivery.selection', { status: runtimeStatusLabel(node.status), duration: formatDuration(node.durationMs) })}</span>}
      {node.dispatchId != null && <DispatchUsage dispatchId={node.dispatchId} visible />}
      {node.error && <span className="is-error">{node.error}</span>}
      {node.triggerCommentId != null && <span>{t('delivery.reworkComment', { id: node.triggerCommentId })}</span>}
      {node.dispatchId != null && <span className="is-dim">{t('delivery.openTrace')}</span>}
    </Space>;
  };
  const zoomBy = (delta: number) => setZoom(value => clampZoom(value + delta));
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const point = (x: number, y: number) => {
    const matrix = svg.current?.getScreenCTM?.();
    if (!matrix) return { x, y };
    const position = svg.current!.createSVGPoint();
    position.x = x; position.y = y;
    return position.matrixTransform(matrix.inverse());
  };
  const activateNode = (node: ProcessGraphNode) => { setSelection({ node }); if (node.dispatchId != null) onOpenTrace(node.dispatchId); };
  const activateKey = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); action(); }
  };
  const selectedDetails = selected && ('node' in selected ? nodeDetails(selected.node) : <Space direction="vertical" size={2}>
    <Text strong>{t('delivery.transition', { number: selected.index + 1 })}</Text>
    <span>{runtimeEdgeLabel(selected.edge, selected.source.status)}</span>
    <span>{t('delivery.lineage', { sourceName: graphAgentName(selected.source), targetName: graphAgentName(selected.target), source: selected.edge.sourceDispatchId ?? '-', target: selected.edge.targetDispatchId ?? '-' })}</span>
  </Space>);
  const beginDrag = (event: { button: number; clientX: number; clientY: number }) => {
    if (event.button !== 0) return;
    const start = point(event.clientX, event.clientY);
    dragState.current = { startX: start.x, startY: start.y, panX: pan.x, panY: pan.y };
  };
  const moveDrag = (event: { clientX: number; clientY: number }) => {
    const drag = dragState.current;
    if (!drag) return;
    const next = point(event.clientX, event.clientY);
    setPan({ x: drag.panX + next.x - drag.startX, y: drag.panY + next.y - drag.startY });
  };
  const endDrag = () => { dragState.current = null; };
  return <div data-testid={fullscreen ? 'execution-graph-fullscreen' : undefined} className={fullscreen ? 'execution-graph-fullscreen' : undefined}>
    <section data-testid="delivery-graph-card" className="execution-graph-section">
      <div className="execution-graph-heading"><Text strong>{t('delivery.graph')}</Text><span className="execution-graph-sub">{t('delivery.graphTransitions', { count: edges.length })}</span></div>
      <div data-testid="execution-process-graph" className="execution-graph-body">
        <div className="execution-graph-tools">
          <Tooltip title={t('delivery.zoomOut')}><Button size="small" aria-label={t('delivery.zoomOut')} icon={<AwStrokeIcon name="zoom-out" />} onClick={() => zoomBy(-0.12)} /></Tooltip>
          <Tooltip title={t('delivery.zoomIn')}><Button size="small" aria-label={t('delivery.zoomIn')} icon={<AwStrokeIcon name="zoom-in" />} onClick={() => zoomBy(0.12)} /></Tooltip>
          <Tooltip title={t('delivery.resetView')}><Button size="small" aria-label={t('delivery.resetView')} icon={<AwStrokeIcon name="refresh" />} onClick={resetView} /></Tooltip>
          <Tooltip title={fullscreen ? t('delivery.exitFullscreen') : t('delivery.fullscreen')}><Button size="small" aria-label={fullscreen ? t('delivery.exitFullscreen') : t('delivery.fullscreen')} icon={fullscreen ? <CompressOutlined aria-hidden="true" /> : <AwStrokeIcon name="fullscreen" />} onClick={() => setFullscreen(value => !value)} /></Tooltip>
          <Tooltip title={t('delivery.fitWidth')}><Button size="small" className="execution-graph-fit" aria-label={t('delivery.fitWidth')} onClick={() => fit(true)}>{t('delivery.fitWidth')}</Button></Tooltip>
        </div>
        <div ref={viewport} data-testid="execution-graph-viewport" data-zoom={zoom.toFixed(2)} data-pan={`${Math.round(pan.x)},${Math.round(pan.y)}`} className="execution-graph-viewport" style={{ touchAction: 'none' }}
          onWheel={event => { event.preventDefault(); zoomBy(event.deltaY > 0 ? -0.08 : 0.08); }}
          onPointerDown={beginDrag} onMouseDown={beginDrag}
          onPointerMove={moveDrag} onMouseMove={moveDrag}
          onPointerUp={endDrag} onMouseUp={endDrag} onPointerCancel={endDrag}
          onPointerLeave={endDrag} onMouseLeave={endDrag}>
          <svg ref={svg} width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={t('delivery.graphAria')}>
            <g ref={content} transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {lanes.map((lane, index) => <g key={lane} data-testid="execution-graph-lane">
                <line x1={64 + index * laneSpacing} y1={12} x2={64 + index * laneSpacing} y2={height - 8} stroke="var(--aw-border)" strokeWidth={1} strokeDasharray="2 5" />
              </g>)}
              {edges.map((edge, index) => {
                const source = nodesByKey.get(edge.sourceKey), target = nodesByKey.get(edge.targetKey);
                const from = positions.get(edge.sourceKey), to = positions.get(edge.targetKey);
                if (!source || !target || !from || !to) return null;
                const tone = authoritativeEdgeTone(edge.type);
                const sameLane = from.x === to.x;
                const path = graphConnectionPath(from, to);
                const labelX = sameLane ? from.x + 76 : (from.x + to.x) / 2;
                const labelY = (from.y + to.y) / 2;
                const fullLabel = t('delivery.edgeSummary', { label: runtimeEdgeLabel(edge, source.status), source: edge.sourceDispatchId ?? '-', target: edge.targetDispatchId ?? '-' });
                const label = t('delivery.shortEdge', { number: index + 1, label: runtimeEdgeLabel(edge, source.status) });
                const activate = () => setSelection({ edge, index, source, target });
                return <Tooltip key={`${edge.sourceKey}-${edge.targetKey}-${index}`} rootClassName="execution-graph-tip" arrow={false} title={fullLabel} trigger={['hover', 'focus']}><g data-testid="execution-graph-edge" role="button" tabIndex={0} aria-label={t('delivery.edgeAria', { number: index + 1, source: graphAgentName(source), target: graphAgentName(target), label: runtimeEdgeLabel(edge, source.status) })} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); activate(); }} onKeyDown={event => activateKey(event, activate)} style={{ cursor: 'pointer' }}>
                  <path d={path} fill="none" stroke={tone.color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                  <rect x={labelX - 30} y={labelY - 7} width={60} height={14} rx={4} fill={tone.background} />
                  <GraphText value={label} x={labelX} y={labelY - 6} width={54} size={8} />
                  <rect className="execution-graph-focus-ring" x={labelX - 33} y={labelY - 10} width={66} height={20} rx={6} vectorEffect="non-scaling-stroke" />
                </g></Tooltip>;
              })}
              {nodes.map(node => {
                const position = positions.get(node.key)!, tone = authoritativeNodeTone(node.status), sequence = stageSequence(node);
                const shortDuration = node.durationMs == null ? t('workbench.unknownTime') : t('delivery.graphMinutes', { count: Math.floor(node.durationMs / 60000) });
                const left = position.x - 52, top = position.y - 26;
                const cellWidth = (64 - 2 * (sequence.length - 1)) / Math.max(1, sequence.length);
                const running = isRunningNode(node.status);
                return <Tooltip key={node.key} rootClassName="execution-graph-tip" arrow={false} title={nodeDetails(node)} trigger={['hover', 'focus']}><g data-testid="execution-graph-worker" data-status={node.status || ''} role="button" tabIndex={0} aria-label={t('delivery.nodeAria', { name: graphAgentName(node), status: runtimeStatusLabel(node.status) })} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); activateNode(node); }} onKeyDown={event => activateKey(event, () => activateNode(node))} style={{ cursor: 'pointer' }}>
                  <rect x={left} y={top} width={104} height={52} rx={7} fill={tone.background} stroke={tone.border} />
                  <rect x={left} y={position.y - 16} width={3.5} height={32} rx={1.75} fill={tone.bar} />
                  <GraphText value={graphAgentName(node)} x={position.x} y={top + 5} width={88} size={10} strong align="left" />
                  {sequence.length > 0 ? <g data-testid="execution-graph-stage-bar">
                    {sequence.map((step, index) => {
                      const x = left + 8 + index * (cellWidth + 2);
                      return outlinedStage(step.status)
                        ? <rect key={`${step.stepId}-${index}`} data-stage-status={step.status} x={x + 0.5} y={top + 24.5} width={Math.max(0.5, cellWidth - 1)} height={5} rx={1.5} fill="none" stroke="var(--aw-text-3)" strokeWidth={1} strokeDasharray="2 1.5" />
                        : <rect key={`${step.stepId}-${index}`} data-stage-status={step.status} x={x} y={top + 24} width={cellWidth} height={6} rx={1.5} fill={stageCellColor(step.status)} />;
                    })}
                    <text data-testid="execution-graph-stage-count" className={running ? 'execution-graph-stage-count is-running' : 'execution-graph-stage-count'} x={left + 76} y={top + 29.5}>{t('delivery.stageCount', { count: sequence.length })}</text>
                  </g> : <GraphText value={nodeTitle(node)} x={position.x} y={top + 22} width={88} size={9.5} strong align="left" />}
                  <GraphText value={`${node.dispatchId != null ? `#${node.dispatchId} · ` : ''}${shortDuration}`} x={position.x} y={top + 36} width={88} size={9} align="left" />
                  <rect className="execution-graph-focus-ring" x={left - 4} y={top - 4} width={112} height={60} rx={9} vectorEffect="non-scaling-stroke" />
                </g></Tooltip>;
              })}
            </g>
          </svg>
        </div>
        <div data-testid="execution-graph-detail-panel" className="execution-graph-detail">
          {selectedDetails || <Text type="secondary">{t('delivery.graphHint')}</Text>}
        </div>
      </div>
    </section>
  </div>;
}

async function downloadArtifact(artifact: Artifact) {
  const url = await getArtifactDownloadUrl(artifact.id);
  const link = document.createElement('a');
  link.href = url;
  link.download = basename(artifact.name);
  link.rel = 'noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${formatNumber(size)} B`;
  if (size < 1024 * 1024) return `${formatNumber(size / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(size / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function ArtifactRows({
  artifacts,
  loading,
  onPreview,
}: {
  artifacts: Artifact[];
  loading?: boolean;
  onPreview: (artifact: Artifact) => void;
}) {
  const { t } = useTranslation('workitem');
  if (loading) {
    return <Spin size="small" />;
  }
  if (artifacts.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>{t('artifacts.none')}</Text>;
  }
  return (
    <div className="delivery-artifact-list">
      {artifacts.map((artifact) => (
        <Tooltip key={String(artifact.id)} title={artifact.name}>
          <div className="delivery-artifact-row">
            <AwStrokeIcon name="file" size={14} className="delivery-artifact-icon" />
            <button
              type="button"
              className="delivery-artifact-name"
              aria-label={t('artifacts.openName', { name: artifact.name })}
              onClick={() => onPreview(artifact)}
            >
              {basename(artifact.name)}
            </button>
            <span className="delivery-artifact-meta">
              {artifact.size != null
                ? t('artifacts.meta', { size: formatFileSize(artifact.size), type: artifactTypeLabel(artifact.type) })
                : artifactTypeLabel(artifact.type)}
            </span>
            <Button
              type="text"
              size="small"
              aria-label={t('artifacts.previewName', { name: artifact.name })}
              icon={<AwStrokeIcon name="eye" />}
              onClick={() => onPreview(artifact)}
            />
            <Button
              type="text"
              size="small"
              aria-label={t('artifacts.downloadName', { name: artifact.name })}
              icon={<AwStrokeIcon name="dl" />}
              onClick={() => void downloadArtifact(artifact)}
            />
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

function ArtifactGroup({ artifacts, steps, executions: attempts, loading, onPreview }: {
  artifacts: Artifact[];
  steps: ConvergedDeliveryStep[];
  executions?: DispatchAttempt[];
  loading?: boolean;
  onPreview: (artifact: Artifact) => void;
}) {
  const { t } = useTranslation('workitem');
  if (loading) return <Spin size="small" />;
  const executions = groupArtifactsByExecution(steps, artifacts, attempts);
  if (!artifacts.length) return <Text type="secondary">{t('artifacts.none')}</Text>;
  const categories = (files: Artifact[]) => files.length === 0 ? <Text type="secondary">{t('artifacts.executionEmpty')}</Text> : <Collapse
    ghost
    size="small"
    defaultActiveKey={['handoff', 'evidence']}
    items={artifactCategories.flatMap(category => {
      const grouped = artifactsForReadingCategory(files, category.key);
      return grouped.length ? [{
        key: category.key,
        label: <Tooltip title={category.hint}><Text className="delivery-artifact-gname">{t('artifacts.categoryCount', { label: category.label, count: grouped.length })}</Text></Tooltip>,
        children: <ArtifactRows artifacts={grouped} onPreview={onPreview} />,
      }] : [];
    })}
  />;
  return <ConfigProvider theme={{
    token: { fontSize: 12, lineHeight: 1.5 },
    components: { Collapse: { headerPadding: '4px 0', contentPadding: '0 0 8px 0' } },
  }}>{executions.length === 1 ? categories(executions[0].artifacts) : <Collapse
    ghost
    size="small"
    defaultActiveKey={executions[0] ? [String(executions[0].dispatchId)] : []}
    items={executions.map((execution, index) => ({
      key: String(execution.dispatchId),
      label: <span title={`Dispatch ${execution.dispatchId}`} style={{ fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere' }}>{t('artifacts.executionSummary', { latest: index === 0 ? t('artifacts.latest') : '', label: execution.label, count: execution.artifacts.length })}</span>,
      children: categories(execution.artifacts),
    }))}
  />}</ConfigProvider>;
}

type ExecutionEntry = { agent: ConvergedAgentProgress; dispatchId: number; attempt: DispatchAttempt; steps: ConvergedDeliveryStep[] };

function stageFromTiming(timing: StepTiming): ConvergedDeliveryStep {
  return {
    stepId: timing.stepId,
    stepKey: null,
    name: timing.name,
    status: timing.status,
    planStatus: null,
    sourceAttempt: null,
    agentName: null,
    executorId: null,
    executorName: null,
    error: null,
    subSteps: null,
    durationMs: timing.durationMs,
    attempts: null,
    usage: null,
  };
}

function withExecutionStages(entry: ExecutionEntry): ExecutionEntry {
  const known = new Map(entry.steps.map(step => [step.stepId, step]));
  // Stages without an entry dispatch are driven by the agent's current dispatch runtime events.
  const driven = new Set<number>();
  if (entry.agent.currentDispatchId === entry.dispatchId) entry.agent.steps.forEach(step => {
    if (step.currentDispatchId != null || step.attempts?.length || known.has(step.stepId)) return;
    known.set(step.stepId, step);
    driven.add(step.stepId);
  });
  const timings = entry.attempt.stepTimings ?? entry.steps
    .filter(step => (step.currentDispatchId ?? step.attempts?.at(-1)?.dispatchId) === entry.dispatchId)
    .map(step => ({ stepId: step.stepId, name: step.name, status: step.status, durationMs: step.durationMs }));
  return { ...entry, steps: timings.map(timing => {
    const step = known.get(timing.stepId);
    const latest = step && (driven.has(step.stepId) || (step.currentDispatchId ?? step.attempts?.at(-1)?.dispatchId) === entry.dispatchId);
    return {
      ...stageFromTiming(timing),
      planStatus: latest ? step.planStatus : null,
      sourceAttempt: latest ? step.sourceAttempt : null,
      subSteps: latest ? step.subSteps : null,
      error: latest ? step.error : null,
      executorName: entry.attempt.executorName,
      attempts: timing.status === 'pending' ? null : [entry.attempt],
    };
  }) };
}

// Dispatch IDs are creation-ordered; traversing agent/step arrays is not a handoff timeline.
function executionEntries(agents: ConvergedAgentProgress[], executions?: DispatchAttempt[] | null): ExecutionEntry[] {
  const entries = new Map<number, ExecutionEntry>();
  agents.forEach(agent => agent.steps.forEach(step => step.attempts?.forEach(attempt => {
    const existing = entries.get(attempt.dispatchId);
    if (existing) {
      if (!existing.steps.some(value => value.stepId === step.stepId)) existing.steps.push(step);
      // A later step may carry more recent status/action metadata for the same dispatch.
      if (attempt.control || attempt.canPause || attempt.canContinue) existing.attempt = { ...existing.attempt, ...attempt };
    } else entries.set(attempt.dispatchId, { agent, dispatchId: attempt.dispatchId, attempt, steps: [step] });
  })));
  executions?.forEach(attempt => {
    const existing = entries.get(attempt.dispatchId);
    if (existing) {
      existing.attempt = {
        ...existing.attempt,
        ...attempt,
        control: attempt.control ?? existing.attempt.control,
        canPause: attempt.control?.pause?.allowed ?? existing.attempt.canPause,
        canContinue: attempt.control?.resume?.allowed ?? existing.attempt.canContinue,
        cancelRequested: attempt.cancelRequested ?? existing.attempt.cancelRequested,
        stopPending: attempt.stopPending ?? existing.attempt.stopPending,
        forced: attempt.forced ?? existing.attempt.forced,
      };
    } else {
      const agent = agents.find(value => value.agentId === attempt.agentId) ?? {
        agentId: attempt.agentId ?? -attempt.dispatchId, agentName: attempt.agentName ?? '—',
        status: 'pending' as const, durationMs: null, steps: [],
      };
      entries.set(attempt.dispatchId, { agent, dispatchId: attempt.dispatchId, attempt, steps: [] });
    }
  });
  return [...entries.values()].sort((a, b) => a.dispatchId - b.dispatchId).map(withExecutionStages);
}

function DispatchFailureDetails({ dispatchId, error, status }: { dispatchId: number; error: string; status: string | null }) {
  const { t } = useTranslation('workitem');
  const heading = t(status === 'FAILED' || status === 'TIMEOUT' ? 'delivery.dispatchFailure' : 'delivery.dispatchDiagnostic', { id: dispatchId });
  const checklist = /checklist not fully checked: "([^"]+)" remains pending/.exec(error);
  const artifact = /code=ARTIFACT_REFERENCE_INVALID path="([^"]+)"/.exec(error);
  return <div role="note" aria-label={heading}>
    <Text strong>{heading}</Text>
    {checklist && <div>{t('delivery.checklistPending', { id: checklist[1] })}</div>}
    {artifact && <div>{t('delivery.invalidArtifactReference', { path: artifact[1] })}</div>}
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--aw-error-deep)' }}>{error}</pre>
  </div>;
}

/** 关注行的底色与左轨沿用卡头 Tag 的状态语义：完成=成功、失败=错误、等待=警告、执行中=主色、未运行=中性。 */
function agentToneClass(color: string): string {
  return color === 'success' ? 'is-done'
    : color === 'error' ? 'is-error'
    : color === 'warning' ? 'is-warn'
    : color === 'processing' ? 'is-live' : 'is-idle';
}

function executionStatusColor(status: string | null): string {
  return status === 'SUCCEEDED' ? 'success'
    : status === 'FAILED' || status === 'TIMEOUT' ? 'error'
    : status === 'PAUSED' || status === 'PAUSING' || status === 'PAUSE_FAILED' ? 'warning'
    : status === 'CANCELED' || !status ? 'default' : 'processing';
}

/** 折叠轨道发起的工作台打开请求：token 每次递增，DeliveryWorkbench 据 token 变化应用并打开模态。 */
export interface WorkbenchEntryRequest {
  token: number;
  tab: string;
  pinnedAgent?: number | null;
  pinnedDispatch?: number | null;
}

function activeAgent(agents: ConvergedAgentProgress[]): ConvergedAgentProgress | null {
  return [...agents].filter(agent => agent.status === 'active')
    .sort((a, b) => Math.max(0, ...orderedDispatchIds(b)) - Math.max(0, ...orderedDispatchIds(a)))[0] ?? null;
}

function attentionAgentOf(agents: ConvergedAgentProgress[]): ConvergedAgentProgress | null {
  return activeAgent(agents) ?? [...agents].reverse().find(agent => agent.status === 'paused' || agent.status === 'failed') ?? null;
}

function currentExecutionEntry(entries: ExecutionEntry[], agent: ConvergedAgentProgress | null): ExecutionEntry | null {
  if (!agent) return null;
  return [...entries].reverse().find(entry => entry.agent.agentId === agent.agentId && ['PENDING', 'PACKAGING', 'DISPATCHED', 'ACKED', 'RUNNING', 'PAUSING', 'PAUSE_FAILED', 'WAITING_FOR_PAUSE'].includes(entry.attempt.status ?? ''))
    ?? [...entries].reverse().find(entry => entry.agent.agentId === agent.agentId && entry.attempt.canPause)
    ?? [...entries].reverse().find(entry => entry.agent.agentId === agent.agentId) ?? null;
}

// 原型 05 右栏交付轨道：side-kpis（当前阶段/累计 Credits）+ agent-rows（数字人行 + 当前执行原位展开）
// + 查看交付详情按钮 + rail-note。详情模态由 entry request 打开。
// 轨道元信息分隔符：模块级常量避免 JSX 内裸标点被 AST 文案检查器误拦。
const META_SEPARATOR = ' · ';
const EMDASH = '—';
const DOT_MARK = '·';

function entryStageName(entry: ExecutionEntry | null): string | null {
  if (!entry) return null;
  const active = entry.steps.find(step => step.status === 'active');
  if (active) return active.name;
  return [...entry.steps].reverse().find(step => step.status !== 'pending')?.name ?? null;
}

type RailNotice = { text: string; error?: boolean };

function railNotice(t: (key: string, options?: Record<string, unknown>) => string, attempt: DispatchAttempt, activity?: string | null): RailNotice | null {
  const status = attempt.status ?? '';
  if (status === 'SUCCEEDED') return { text: t('delivery.railNoticeSucceeded') };
  if (status === 'CANCELED' || status === 'CANCELLED') return { text: t('delivery.railNoticeCanceled') };
  if (status === 'PENDING') return { text: attempt.waitingReason ? t('delivery.railWaitingReason', { reason: attempt.waitingReason }) : t('delivery.railNoticeQueued') };
  if (status === 'PACKAGING') return { text: t('delivery.railNoticePackaging') };
  if (status === 'DISPATCHED' || status === 'ACKED') return { text: t('delivery.railNoticeAccepted') };
  if (status === 'PAUSED') return { text: activity ?? t('delivery.railNoticePaused') };
  if (status === 'PAUSING') return { text: t('delivery.railNoticePausing') };
  if (status === 'WAITING_FOR_PAUSE') return { text: t('delivery.railNoticeWaitingPause') };
  if (status === 'PAUSE_FAILED') return attempt.error ? { text: attempt.error, error: true } : { text: t('delivery.railNoticePauseFailed') };
  if (status === 'FAILED') return attempt.error ? { text: attempt.error, error: true } : { text: t('delivery.railNoticeFailed') };
  if (status === 'TIMEOUT') return attempt.error ? { text: attempt.error, error: true } : { text: t('delivery.railNoticeTimeout') };
  return null;
}

/** 关注块的卡身：执行详情（只看当前/最近一次）+ 动作，数字人身份只在卡头出现一次。 */
function AgentExecutionBody({ agent, entry, isLive, stageName, artifacts, onOpen, onAction, pendingAction }: {
  agent: ConvergedAgentProgress;
  entry: ExecutionEntry | null;
  isLive: boolean;
  stageName: string | null;
  artifacts: Artifact[];
  onOpen: (tab: string, pinnedAgent?: number | null, pinnedDispatch?: number | null) => void;
  onAction?: (attempt: DispatchAttempt, action: ExecutionActionKind) => void;
  pendingAction?: { dispatchId: number; action: ExecutionActionKind } | null;
}) {
  const { t } = useTranslation('workitem');
  if (!entry) {
    return <p className="aw-agent-block-empty">{t('delivery.railEmptyExecution')}</p>;
  }
  const entryArtifacts = artifacts.filter(artifact => artifact.dispatchId === entry.dispatchId).length;
  const execParts = [entryStageName(entry) ?? stageName, t('delivery.railDispatch', { id: entry.dispatchId })].filter(Boolean);
  const dimParts = [
    entry.attempt.executorName ? t('delivery.runner', { name: entry.attempt.executorName }) : '',
    t('delivery.railArtifacts', { count: entryArtifacts }),
  ].filter(Boolean);
  const notice = railNotice(t, entry.attempt, agent.currentActivity);
  const showActivity = isLive && entry.attempt.status === 'RUNNING';
  return <>
    <div className="aw-agent-block-exec-line" data-testid="agent-current-activity">
      <span className={`aw-agent-block-exec-k${isLive ? ' is-live' : ''}`}>{t(isLive ? 'delivery.railCurrentExecution' : 'delivery.railRecentExecution')}</span>
      <span className="aw-agent-block-exec-main" title={execParts.join(META_SEPARATOR)}>{execParts.join(META_SEPARATOR)}</span>
    </div>
    {dimParts.length > 0 && <div className="aw-agent-block-exec-sub" title={dimParts.join(META_SEPARATOR)}>{dimParts.join(META_SEPARATOR)}</div>}
    {notice && <p className={`aw-agent-block-notice${notice.error ? ' is-error' : ''}`}>
      {notice.error && <AwStrokeIcon name="alert-t" size={12} />}
      <span>{notice.text}</span>
    </p>}
    {showActivity && (
      <div className="aw-agent-block-live" data-testid="rail-live-activity">
        <AwStrokeIcon name="eye" className="aw-agent-block-live-icon" />
        <div className="aw-agent-block-live-body"><LiveActivityPanel key={entry.dispatchId} dispatchId={entry.dispatchId} enabled summaryOnly /></div>
      </div>
    )}
    <div className="aw-agent-block-actions">
      <Button size="small" icon={<AwStrokeIcon name="term" />} onClick={() => onOpen('terminal', null, entry.dispatchId)}>
        {t('delivery.railOpenExecution')}
      </Button>
      {onAction && <ExecutionActionBar attempt={entry.attempt} pending={pendingAction} emphasis onAction={action => onAction(entry.attempt, action)} />}
    </div>
  </>;
}

function DeliveryRail({ agents, progress, artifacts, restartsByAgent, onOpenWorkbench, onExecutionAction, pendingExecutionAction }: {
  agents: ConvergedAgentProgress[];
  progress?: DeliveryProgressModel | null;
  artifacts: Artifact[];
  restartsByAgent: Map<number, RestartRound[]>;
  onOpenWorkbench: (tab: string, pinnedAgent?: number | null, pinnedDispatch?: number | null) => void;
  onExecutionAction?: (attempt: DispatchAttempt, action: ExecutionActionKind) => void;
  pendingExecutionAction?: { dispatchId: number; action: ExecutionActionKind } | null;
}) {
  const { t } = useTranslation('workitem');
  const entries = useMemo(() => executionEntries(agents, progress?.executions), [agents, progress?.executions]);
  const currentAgent = activeAgent(agents);
  const attentionCandidate = attentionAgentOf(agents);
  const currentEntry = currentExecutionEntry(entries, currentAgent);
  // 与 DeliveryWorkbench.defaultEntry 同规则：当前执行 → 关注数字人最近一次 → 全局最后一次。
  const defaultEntry = currentEntry
    ?? (attentionCandidate ? [...entries].reverse().find(entry => entry.agent.agentId === attentionCandidate.agentId) ?? null : null)
    ?? entries[entries.length - 1]
    ?? null;
  const attention = attentionCandidate ?? defaultEntry?.agent ?? null;
  const focusAgent = currentAgent ?? attention;
  const focusEntry = focusAgent ? currentExecutionEntry(entries, focusAgent) : null;
  const isLive = currentAgent != null;
  // 旧折叠卡 attentionLabel 的取消/暂停意图判定下沉到每个数字人行，保证「正在结束」等状态在轨道上不丢。
  const agentLabel = (agent: ConvergedAgentProgress) => {
    if (agent.steps.some(step => step.attempts?.some(attempt => attempt.cancelRequested && attempt.status === 'PAUSING'))) return { text: t('delivery.ending'), color: 'warning' };
    if (agent.steps.some(stepIsPausing)) return { text: t('delivery.pausing'), color: 'warning' };
    if (agent.steps.some(step => step.attempts?.some(attempt => attempt.error?.startsWith('CANCEL_REQUESTED:')))) return { text: t('delivery.ending'), color: 'warning' };
    return statusLabel(agent.status, agent.executionStatus, agent.waitingReason);
  };
  const stageStep = currentAgent?.steps.find(step => step.status === 'active')
    ?? (attention ? [...attention.steps].reverse().find(step => step.status !== 'pending') ?? null : null);
  const stageName = stageStep?.name ?? entryStageName(currentEntry);
  const stageLabel = attention ? agentLabel(attention) : null;
  // PENDING/PACKAGING 的「当前阶段」写的是目标阶段，副标必须是等待态而不是「进行中」。
  const stageNote = stageName && stageLabel ? (currentEntry?.attempt.status === 'RUNNING' ? t('delivery.railInProgress') : stageLabel.text) : null;
  const squadIdle = agents.length > 0 && entries.length === 0 && attentionCandidate == null;
  const dispatchCountByAgent = useMemo(() => {
    const map = new Map<number, number>();
    entries.forEach(entry => map.set(entry.agent.agentId, (map.get(entry.agent.agentId) ?? 0) + 1));
    return map;
  }, [entries]);
  const totalUsage = progress?.totalUsage ?? null;
  // 轨道只列参与者；有重启轮次但从未派发的目标数字人也补一行，承载启动失败的轮次。
  const visibleAgents = agents.filter(agent => (dispatchCountByAgent.get(agent.agentId) ?? 0) > 0
    || agent.status === 'active' || agent.status === 'paused' || agent.status === 'failed'
    || (restartsByAgent.get(agent.agentId)?.length ?? 0) > 0);
  const usageRuns = totalUsage ? creditRuns(totalUsage) : [];
  const runsDetail = usageRuns.length ? (
    <div className="aw-credit-pop" data-testid="rail-credits-breakdown">
      {usageRuns.map(({ run, sourceIndex }, index) => (
        <div className="aw-credit-row" key={`${run.agentId ?? 'unknown'}-${run.runIndex ?? index + 1}-${sourceIndex}`}>
          <span className="aw-credit-run">{creditRunLabel(run, index)}</span>
          <span className="aw-credit-amount">{formatCredits(run.credits)}</span>
        </div>
      ))}
      <div className="aw-credit-row is-total">
        <span className="aw-credit-run">{t('delivery.railCreditsTotal')}</span>
        <span className="aw-credit-amount">{formatCredits(totalUsage?.credits)}</span>
      </div>
    </div>
  ) : null;

  return <div data-testid="delivery-rail">
    <div className="aw-side-kpis">
      <div className="aw-side-kpi">
        <div className="aw-side-kpi-k">{t('delivery.railCurrentStage')}</div>
        <div className="aw-side-kpi-v" style={{ fontSize: 13 }}>
          {stageName ?? EMDASH}
          {stageNote && <small>{stageNote}</small>}
        </div>
      </div>
      <div className="aw-side-kpi">
        <div className="aw-side-kpi-k">{t('delivery.railTotalCredits')}</div>
        <div className="aw-side-kpi-v">
          {totalUsage?.credits != null && totalUsage.credits > 0 ? (
            runsDetail ? (
              <Popover content={runsDetail} trigger="hover" placement="left">
                <span className="aw-credit-trigger" tabIndex={0} data-testid="rail-credits-trigger">
                  <span className="aw-credit-hover">{formatCredits(totalUsage.credits)}</span>
                  <small>{t('delivery.railCreditsHint')}</small>
                </span>
              </Popover>
            ) : <span>{formatCredits(totalUsage.credits)}</span>
          ) : <span>{EMDASH}</span>}
        </div>
      </div>
    </div>
    {visibleAgents.length > 0 && (
      <div className="aw-agent-group-head">
        <span className="aw-agent-group-title">{t('delivery.railAgentsGroup', { count: visibleAgents.length })}</span>
        <span className="aw-agent-group-sort">{t('delivery.railAgentOrder')}</span>
      </div>
    )}
    <div className="aw-agent-blocks">
      {visibleAgents.map(agent => {
        const dispatchCount = dispatchCountByAgent.get(agent.agentId) ?? 0;
        const label = agentLabel(agent);
        const isFocus = focusAgent != null && agent.agentId === focusAgent.agentId;
        const credits = agent.usage?.credits;
        const dispatchMeta = dispatchCount > 0 ? t('delivery.railDispatchCount', { count: dispatchCount }) : '';
        const agentRounds = restartsByAgent.get(agent.agentId) ?? [];
        // 轮次是否属于「当前这轮」以当前执行派发为准，历史失败轮次不默认展开。
        const agentDispatchId = currentExecutionEntry(entries, agent)?.dispatchId ?? null;
        const tone = agentToneClass(label.color);
        return <section key={agent.agentId}
          className={`aw-agent-block${isFocus ? ` is-open ${tone}` : ''}`}
          data-testid={isFocus ? 'delivery-current-execution' : undefined}>
          <div className="aw-agent-block-head">
            <button type="button" className="aw-agent-block-main" title={t('delivery.railEnterWorkbench')}
              data-testid="delivery-agent-row" onClick={() => onOpenWorkbench('details', agent.agentId)}>
              <span className="aw-fn-mark" aria-hidden="true">{Array.from(agent.agentName.trim())[0] ?? DOT_MARK}</span>
              <span className="aw-agent-name" data-testid={attention != null && agent.agentId === attention.agentId ? 'current-agent-name' : undefined}>{agent.agentName}</span>
              {dispatchMeta && <span className="aw-agent-meta">{dispatchMeta}</span>}
              {credits != null && credits > 0 && (
                <span className="aw-agent-meta is-credits"><AwStrokeIcon name="zap" />{formatCredits(credits)}</span>
              )}
              <Tag color={label.color}>{label.text}</Tag>
              <AwStrokeIcon name="chev-r" className="aw-agent-block-chev" aria-hidden="true" />
            </button>
          </div>
          {isFocus && <div className="aw-agent-block-body">
            <AgentExecutionBody agent={agent} entry={focusEntry} isLive={isLive} stageName={stageName}
              artifacts={artifacts}
              onOpen={onOpenWorkbench} onAction={onExecutionAction} pendingAction={pendingExecutionAction} />
            <DeliveryStartRecords rounds={agentRounds} variant="section" currentDispatchId={agentDispatchId} />
            {dispatchCount > 0 && (
              <button type="button" className="aw-history-link" onClick={() => onOpenWorkbench('terminal', agent.agentId)}>
                <span>{t('delivery.railHistory', { count: dispatchCount })}</span>
                <AwStrokeIcon name="chev-r" />
              </button>
            )}
          </div>}
          {!isFocus && <DeliveryStartRecords rounds={agentRounds} variant="summary" currentDispatchId={agentDispatchId} />}
        </section>;
      })}
    </div>
    {focusAgent == null && (
      <div className="aw-agent-block is-empty" data-testid="delivery-current-execution">
        <div className="aw-agent-block-head">
          <span className="aw-agent-block-main is-static">
            <span className="aw-agent-name">{t('delivery.railNoExecution')}</span>
            <Tag>{t('delivery.notRun')}</Tag>
          </span>
        </div>
        <p className="aw-agent-block-empty">{squadIdle ? t('delivery.railSquadIdle', { count: agents.length }) : t('delivery.railNoDispatchHint')}</p>
      </div>
    )}
  </div>;
}

function DispatchUsage({ dispatchId, visible }: { dispatchId: number; visible: boolean }) {
  const { t } = useTranslation('workitem');
  const [usage, setUsage] = useState<import('@/shared/types/workitem').RuntimeTraceTokenUsage | null>(null);
  useEffect(() => {
    setUsage(null);
    if (!visible) return;
    let cancelled = false;
    getRuntimeTrace(dispatchId).then(trace => { if (!cancelled) setUsage(trace.tokenUsage); }).catch(() => {});
    return () => { cancelled = true; };
  }, [dispatchId, visible]);
  if (!usage?.available || usage.credits == null) return <Text type="secondary">{t('workbench.dispatchCreditsMissing')}</Text>;
  return usage.credits > 0 ? <TokenUsageBadge usage={usage} /> : <Text type="secondary">{t('usage.creditAmount', { amount: formatCredits(usage.credits) })}</Text>;
}

const RAIL_DEFAULT_WIDTH = 228;
const RAIL_MIN_WIDTH = 200;
const RAIL_MAX_WIDTH = 400;
const RECENT_ENTRY_LIMIT = 1;
const TIME_RECENT_LIMIT = 10;
const clampRailWidth = (width: number) => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));

function DeliveryWorkbench({ agents, progress, artifacts, artifactsLoading, onExecutionAction, pendingExecutionAction, renderRecovery, renderControlTimeline, entry }: {
  agents: ConvergedAgentProgress[];
  progress: DeliveryProgressModel | null | undefined;
  artifacts: Artifact[];
  artifactsLoading?: boolean;
  /** 折叠轨道（DeliveryRail）发起的工作台打开请求：token 递增触发，附带初始 tab 与固定选择。 */
  entry?: WorkbenchEntryRequest | null;
} & Pick<DeliveryProgressProps, 'onExecutionAction' | 'pendingExecutionAction' | 'renderRecovery' | 'renderControlTimeline'>) {
  const { t } = useTranslation('workitem');
  const entries = useMemo(() => executionEntries(agents, progress?.executions), [agents, progress?.executions]);
  const currentAgent = [...agents].filter(agent => agent.status === 'active').sort((a, b) =>
    Math.max(0, ...orderedDispatchIds(b)) - Math.max(0, ...orderedDispatchIds(a)))[0] ?? null;
  const attentionAgent = currentAgent ?? [...agents].reverse().find(agent => agent.status === 'paused' || agent.status === 'failed') ?? null;
  const currentEntry = currentAgent ? [...entries].reverse().find(entry => entry.agent.agentId === currentAgent.agentId && ['PENDING', 'PACKAGING', 'DISPATCHED', 'ACKED', 'RUNNING', 'PAUSING', 'PAUSE_FAILED', 'WAITING_FOR_PAUSE'].includes(entry.attempt.status ?? ''))
    ?? [...entries].reverse().find(entry => entry.agent.agentId === currentAgent.agentId && entry.attempt.canPause)
    ?? [...entries].reverse().find(entry => entry.agent.agentId === currentAgent.agentId) : null;
  const defaultEntry = currentEntry ?? [...entries].reverse().find(entry => entry.agent.agentId === attentionAgent?.agentId) ?? entries[entries.length - 1];
  const [expanded, setExpanded] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [tab, setTab] = useState('terminal');
  const [pinnedDispatch, setPinnedDispatch] = useState<number | null>(null);
  const [pinnedAgent, setPinnedAgent] = useState<number | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const isMobile = useIsMobile();
  const [railVisible, setRailVisible] = useState(() => !isMobile);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const railDrag = useRef<{ x: number; width: number } | null>(null);
  const [groupBy, setGroupBy] = useState<'agent' | 'time'>('agent');
  const [showAllExecutions, setShowAllExecutions] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<number[]>([]);
  const [collapsedAgents, setCollapsedAgents] = useState<number[]>([]);
  // 数字人行只固定员工、不固定会话，仍跟随该员工最近一次执行；只有选中历史 Dispatch 才退出跟随。
  const followCurrent = pinnedDispatch === null;
  const selectedEntry = pinnedDispatch !== null ? entries.find(entry => entry.dispatchId === pinnedDispatch) : pinnedAgent !== null ? [...entries].reverse().find(entry => entry.agent.agentId === pinnedAgent) : defaultEntry;
  const selectedAgent = pinnedAgent !== null ? agents.find(agent => agent.agentId === pinnedAgent) : selectedEntry?.agent ?? attentionAgent ?? agents[agents.length - 1];
  const selectedStep = selectedEntry?.steps.find(step => step.stepId === selectedStepId);
  const selectedTraceNode = progress?.processGraph?.nodes.find(node => node.dispatchId === selectedEntry?.dispatchId);
  const selectedArtifacts = useMemo(() => selectedAgent ? artifactsForAgent(selectedAgent, artifacts, progress?.executions) : artifacts, [selectedAgent, artifacts, progress?.executions]);
  const selectedExecutions = useMemo(() => progress?.executions?.filter(attempt => !selectedAgent || attempt.agentId === selectedAgent.agentId), [progress?.executions, selectedAgent]);
  const previewSequence = useMemo(() => artifactsInDisplayOrder(selectedAgent?.steps ?? [], selectedArtifacts, selectedExecutions), [selectedAgent, selectedArtifacts, selectedExecutions]);
  const selectedIsTimeout = selectedEntry?.attempt.status === 'TIMEOUT';
  const selectedLive = selectedEntry?.dispatchId === currentEntry?.dispatchId && currentAgent !== null;
  const [handoffId, setHandoffId] = useState<number | null>(null);
  const previousCurrent = useRef(currentEntry?.dispatchId ?? null);
  useEffect(() => {
    setSelectedStepId(null);
    setPreviewArtifact(null);
  }, [selectedEntry?.dispatchId]);
  useEffect(() => {
    const next = currentEntry?.dispatchId ?? null;
    if (previousCurrent.current !== null && next !== null && next !== previousCurrent.current) setHandoffId(next);
    previousCurrent.current = next;
  }, [currentEntry?.dispatchId]);
  useEffect(() => {
    if (!entry) return;
    setTab(entry.tab);
    // 仅显式传入的固定选择才覆盖：工作台入口按钮沿用当前会话，轨道行/当前执行卡按需固定。
    if (entry.pinnedAgent !== undefined) setPinnedAgent(entry.pinnedAgent);
    if (entry.pinnedDispatch !== undefined) setPinnedDispatch(entry.pinnedDispatch);
    if (entry.pinnedAgent !== undefined || entry.pinnedDispatch !== undefined) setSelectedStepId(null);
    setExpanded(true);
  }, [entry]);
  const open = (nextTab: string) => { setTab(nextTab); setExpanded(true); };
  const selectEntry = (entry: ExecutionEntry) => { setPinnedDispatch(entry.dispatchId); setPinnedAgent(null); setSelectedStepId(null); };
  const returnToCurrent = () => { setPinnedDispatch(null); setPinnedAgent(null); setSelectedStepId(null); setHandoffId(null); };
  const keepWithin = (limit: number) => (entry: ExecutionEntry, index: number) => index < limit || entry.dispatchId === defaultEntry?.dispatchId || entry.dispatchId === selectedEntry?.dispatchId;
  const keepVisible = keepWithin(RECENT_ENTRY_LIMIT);
  const timeRecentEntries = [...entries].reverse().filter(keepWithin(TIME_RECENT_LIMIT));
  const sidebarEntries = showAllExecutions ? [...entries].reverse() : timeRecentEntries;
  const timeHiddenCount = entries.length - timeRecentEntries.length;
  const executionTimes = (attempt: DispatchAttempt, timesOnly = false) => <div className="delivery-workbench-entry-meta">
    {!timesOnly && attempt.agentName && <div>{t('delivery.executor', { name: attempt.agentName })}</div>}
    {!timesOnly && attempt.executorName && <div>{t('delivery.runner', { name: attempt.executorName })}</div>}
    <div>{t('workbench.startedAt', { time: attempt.startedAt ? formatDateTime(attempt.startedAt) : t('workbench.unknownTime') })}</div>
    <div>{t('workbench.endedAt', { time: attempt.endedAt ? formatDateTime(attempt.endedAt) : attempt.status && ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELED'].includes(attempt.status) ? t('workbench.unknownTime') : t('workbench.notEnded') })}</div>
  </div>;
  const timeline = (visibleEntries: ExecutionEntry[], byTime = false) => <div className="delivery-workbench-timeline" aria-label={t('workbench.handoffs')}>
    {visibleEntries.map(entry => <div key={entry.dispatchId} className="delivery-workbench-entry-card">
      <button type="button" className={`delivery-workbench-entry ${selectedEntry?.dispatchId === entry.dispatchId ? 'is-selected' : ''}`}
        aria-pressed={selectedEntry?.dispatchId === entry.dispatchId} onClick={() => selectEntry(entry)}>
        <span className="delivery-workbench-entry-r1">
          <span className="delivery-workbench-entry-meta">{t('workbench.sessionDuration', { id: entry.dispatchId, duration: formatDuration(entry.attempt.durationMs) })}</span>
          <Tag color={executionStatusColor(entry.attempt.status)}>{dispatchExecutionLabel(entry.attempt.status, entry.attempt.waitingReason)}</Tag>
        </span>
        <span className="delivery-workbench-entry-r2">
          <span className="delivery-workbench-entry-name" data-testid="agent-progress-name">{entry.agent.agentName}</span>
          {entry.attempt.executorName && <span>{META_SEPARATOR}{t('delivery.runner', { name: entry.attempt.executorName })}</span>}
        </span>
      </button>
    </div>)}
    {byTime && agents.filter(agent => !entries.some(entry => entry.agent.agentId === agent.agentId)).slice(0, 3).map(agent => <button key={agent.agentId} type="button" className="delivery-workbench-entry" onClick={() => { setPinnedAgent(agent.agentId); setPinnedDispatch(null); setSelectedStepId(null); if (!expanded) open('details'); }}>
      <span className="delivery-workbench-entry-r1"><span className="delivery-workbench-entry-name" data-testid="agent-progress-name">{agent.agentName}</span><Tag>{statusLabel(agent.status, agent.executionStatus, agent.waitingReason).text}</Tag></span>
      <span className="delivery-workbench-entry-r2"><span className="delivery-workbench-entry-meta">{formatDuration(agent.durationMs)}</span></span>
    </button>)}
  </div>;
  const stagePlanLabel = (step: ConvergedDeliveryStep) => step.planStatus === 'REUSED' || step.status === 'reused' ? t('delivery.reusedPrevious') : step.planStatus === 'RUN' ? t('delivery.rerun') : null;
  const stageDotClass = (step: ConvergedDeliveryStep) => step.status === 'pending' ? 'is-pending'
    : stepIsPausing(step) || step.status === 'paused' || step.status === 'stale' || step.status === 'interrupted' ? 'is-warning'
      : step.status === 'failed' ? 'is-error'
        : step.status === 'active' ? step.executionStatus && step.executionStatus !== 'RUNNING' ? 'is-waiting' : 'is-running'
          : step.status === 'cancelled' || step.status === 'skipped' ? 'is-muted' : 'is-done';
  const stageList = selectedEntry && <div className="delivery-workbench-stages" aria-label={t('workbench.stages')}>
    {selectedEntry.steps.length > 1 && <button type="button" className={`delivery-workbench-stage is-all ${selectedStepId == null ? 'is-selected' : ''}`} aria-pressed={selectedStepId == null}
      onClick={() => setSelectedStepId(null)}>{t('workbench.allStages')}</button>}
    {selectedEntry.steps.map(step => <button key={step.stepId} type="button" className={`delivery-workbench-stage ${stageDotClass(step)} ${step.stepId === selectedStepId ? 'is-selected' : ''}`} aria-pressed={step.stepId === selectedStepId}
      onClick={() => { setPinnedDispatch(selectedEntry.dispatchId); setPinnedAgent(null); setSelectedStepId(current => current === step.stepId ? null : step.stepId); }}>
      <span className="delivery-workbench-stage-dot" aria-hidden="true" /><span>{step.name}</span>{stagePlanLabel(step) && <span className="delivery-workbench-stage-plan">{stagePlanLabel(step)}</span>}
    </button>)}
  </div>;
  const executedSteps = selectedEntry?.steps.filter(step => step.status !== 'pending') ?? [];
  const selectedStepPending = selectedStep?.status === 'pending';
  const groupedByTime = groupBy === 'time';
  const railAgents = [...agents, ...entries.map(entry => entry.agent).filter((agent, index, all) =>
    !agents.some(value => value.agentId === agent.agentId) && all.findIndex(value => value.agentId === agent.agentId) === index)];
  const details = selectedEntry ? <>
    {stageList}
    <div className="delivery-workbench-detail-heading"><Text strong>{selectedStep?.name ?? selectedAgent?.agentName}</Text><Space wrap>
      {selectedEntry.attempt.durationMs != null && <Text type="secondary">{formatDuration(selectedEntry.attempt.durationMs)}</Text>}
      <DispatchUsage key={selectedEntry.dispatchId} dispatchId={selectedEntry.dispatchId} visible={expanded && tab === 'details'} />
    </Space></div>
    {executionTimes(selectedEntry.attempt, !selectedStepPending && executedSteps.length > 0)}
    {selectedEntry.attempt.error && <DispatchFailureDetails dispatchId={selectedEntry.dispatchId} error={selectedEntry.attempt.error} status={selectedEntry.attempt.status} />}
    {selectedStepPending ? <Empty description={t('workbench.noExecution')} /> : executedSteps.length === 0
      ? <DispatchActivityFeed dispatchId={selectedEntry.dispatchId} status={selectedEntry.attempt.status} />
      : <StepList key={`${selectedEntry.dispatchId}:${selectedStepId ?? 'all'}`} collapsible feedAttempt={selectedEntry.attempt} steps={selectedStep ? [selectedStep] : executedSteps} />}
  </> : <Empty description={t('workbench.noSession')} />;
  return <>
    <Modal open={expanded} destroyOnClose onCancel={() => setExpanded(false)} footer={null} width="calc(100vw - 32px)" style={{ top: 16 }} className="delivery-workbench-modal"
      title={<div className="delivery-workbench-heading">
        <AwStrokeIcon name="term" size={14} className="delivery-workbench-heading-icon" />
        <span className="delivery-workbench-title">{t('delivery.title')}</span>
        {selectedEntry && <span className={`delivery-workbench-run-chip is-${executionStatusColor(selectedEntry.attempt.status)}`}><span className="delivery-workbench-run-dot" aria-hidden="true" />{selectedAgent?.agentName}{META_SEPARATOR}{dispatchExecutionLabel(selectedEntry.attempt.status, selectedEntry.attempt.waitingReason)}</span>}
      </div>}>
      <div className="delivery-workbench-expanded" data-testid="delivery-workbench">
        {handoffId !== null && <Alert showIcon type="info" message={t(followCurrent ? 'workbench.handoffFollowing' : 'workbench.handoffPinned', { name: currentAgent?.agentName ?? '' })} closable onClose={() => setHandoffId(null)} />}
        <div className={`delivery-workbench-layout ${railVisible ? '' : 'without-rail'}`} style={{ '--delivery-rail-width': `${railWidth}px` } as React.CSSProperties}>
          <aside className="delivery-workbench-rail" hidden={!railVisible}>
            <div className="delivery-workbench-section-heading">
              <AwStrokeIcon name="history" size={13} className="delivery-workbench-heading-icon" />
              <span>{t('workbench.handoffs')}</span>
              <span className="delivery-workbench-count">{t('workbench.executionCount', { count: entries.length })}</span>
              <button type="button" className="delivery-workbench-icon-btn" aria-label={t('workbench.hideSidebar')} onClick={() => setRailVisible(false)}><AwStrokeIcon name="chev-l" size={12} /></button>
            </div>
            <div className="delivery-workbench-group-switch" role="group" aria-label={t('workbench.grouping')}>
              <button type="button" className={groupBy === 'agent' ? 'is-on' : ''} aria-pressed={groupBy === 'agent'} onClick={() => setGroupBy('agent')}>{t('workbench.byAgent')}</button>
              <button type="button" className={groupBy === 'time' ? 'is-on' : ''} aria-pressed={groupBy === 'time'} onClick={() => setGroupBy('time')}>{t('workbench.byTime')}</button>
            </div>
            <div className="delivery-workbench-side-list">
              {groupedByTime ? timeline(sidebarEntries, true) : railAgents.map(agent => {
                const agentEntries = [...entries].reverse().filter(entry => entry.agent.agentId === agent.agentId);
                const groupExpanded = expandedAgents.includes(agent.agentId);
                const groupCollapsed = collapsedAgents.includes(agent.agentId);
                const shownEntries = groupExpanded ? agentEntries : agentEntries.filter(keepVisible);
                const hiddenCount = agentEntries.length - shownEntries.length;
                return <div key={agent.agentId} className="delivery-workbench-agent-group">
                <button type="button" className="delivery-workbench-ghead" aria-expanded={!groupCollapsed}
                  onClick={() => setCollapsedAgents(value => groupCollapsed ? value.filter(id => id !== agent.agentId) : [...value, agent.agentId])}>
                  <AwStrokeIcon name={groupCollapsed ? 'chev-r' : 'chev-d'} size={12} className="delivery-workbench-ghead-chev" />
                  <span className="delivery-workbench-ai-tag" aria-hidden="true" />
                  <span className="delivery-workbench-group-heading">{agent.agentName}</span>
                  <span className="delivery-workbench-count is-times">{agentEntries.length}</span>
                </button>
                {!groupCollapsed && <>
                {timeline(shownEntries)}
                {(groupExpanded ? agentEntries.length > RECENT_ENTRY_LIMIT : hiddenCount > 0) && <button type="button" className="delivery-workbench-group-more" aria-expanded={groupExpanded}
                  onClick={() => setExpandedAgents(value => groupExpanded ? value.filter(id => id !== agent.agentId) : [...value, agent.agentId])}>
                  {groupExpanded ? t('workbench.recentOnly') : t('workbench.earlierCount', { count: hiddenCount })}
                </button>}
                {!entries.some(entry => entry.agent.agentId === agent.agentId) && <button type="button" className={`delivery-workbench-entry is-idle ${!selectedEntry && selectedAgent?.agentId === agent.agentId ? 'is-selected' : ''}`} onClick={() => { setPinnedAgent(agent.agentId); setPinnedDispatch(null); setSelectedStepId(null); }}>
                  <span className="delivery-workbench-idle-dash" aria-hidden="true" />
                  <span>{t('workbench.noExecution')}</span>
                </button>}
                </>}
              </div>;
              })}
            </div>
            <div className="delivery-workbench-side-foot">
              {groupedByTime && (showAllExecutions || timeHiddenCount > 0) && <Button type="text" size="small" onClick={() => setShowAllExecutions(value => !value)}>{showAllExecutions ? t('workbench.recentOnly') : t('workbench.historyCount', { count: entries.length })}</Button>}
            </div>
            <div className="delivery-workbench-resizer" role="separator" aria-orientation="vertical" aria-label={t('workbench.sidebarWidth')}
              aria-valuemin={RAIL_MIN_WIDTH} aria-valuemax={RAIL_MAX_WIDTH} aria-valuenow={railWidth} tabIndex={0}
              onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); railDrag.current = { x: event.clientX, width: railWidth }; }}
              onPointerMove={event => { if (railDrag.current) setRailWidth(clampRailWidth(railDrag.current.width + event.clientX - railDrag.current.x)); }}
              onPointerUp={() => { railDrag.current = null; }}
              onPointerCancel={() => { railDrag.current = null; }}
              onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                setRailWidth(width => clampRailWidth(width + (event.key === 'ArrowRight' ? 8 : -8)));
              }} />
          </aside>
          <main className="delivery-workbench-main">
            <div className="delivery-workbench-session">
              {!railVisible && <button type="button" className="delivery-workbench-icon-btn" aria-label={t('workbench.showSidebar')} onClick={() => setRailVisible(true)}><AwStrokeIcon name="chev-r" size={12} /></button>}
              {selectedEntry && <span className="delivery-workbench-session-dispatch" data-testid="live-activity-dispatch-select">{t('delivery.dispatchOption', { id: selectedEntry.dispatchId, latest: selectedEntry.dispatchId === defaultEntry?.dispatchId ? t('delivery.latest') : '' })}</span>}
              <span className="delivery-workbench-session-agent" data-testid="selected-agent-name">{selectedAgent?.agentName}</span>
              {selectedEntry?.attempt.executorName && <span>{t('delivery.runner', { name: selectedEntry.attempt.executorName })}</span>}
              <span>{t(followCurrent ? currentEntry ? 'workbench.following' : 'workbench.latestSession' : 'workbench.history')}</span>
              {!followCurrent && <Button size="small" onClick={returnToCurrent}>{t('workbench.returnCurrent')}</Button>}
              {selectedEntry && onExecutionAction && (
                <ExecutionActionBar
                  attempt={selectedEntry.attempt}
                  pending={pendingExecutionAction}
                  onAction={(action) => onExecutionAction(selectedEntry.attempt, action)}
                />
              )}
              {selectedEntry && <span className="delivery-workbench-session-dur">{formatDuration(selectedEntry.attempt.durationMs)}</span>}
            </div>
            {selectedEntry?.attempt.stopPending && (
              <Text className="delivery-workbench-notice">
                {selectedIsTimeout
                  ? t('delivery.timeoutStopUnconfirmed', { id: selectedEntry.dispatchId })
                  : t('delivery.stopUnconfirmed', { id: selectedEntry.dispatchId })}
              </Text>
            )}
            <div key={`execution-${selectedEntry?.dispatchId ?? 'none'}`} className="delivery-workbench-recovery">{selectedEntry && renderRecovery?.(selectedEntry.dispatchId)}</div>
            <Tabs activeKey={tab} onChange={setTab} items={[
              { key: 'terminal', label: t('runtimeLog.terminal'), children: selectedEntry ? <RuntimeLogPanel key={selectedEntry.dispatchId} dispatchId={selectedEntry.dispatchId} terminal embedded enabled={expanded && tab === 'terminal'} /> : <Empty description={t('workbench.noSession')} /> },
              { key: 'activity', label: t('workbench.activity'), children: selectedEntry ? <LiveActivityPanel key={selectedEntry.dispatchId} dispatchId={selectedEntry.dispatchId} enabled={selectedLive && expanded && tab === 'activity'} feed /> : <Empty description={t('workbench.noSession')} /> },
              { key: 'controls', label: t('executionControl.timeline'), children: selectedEntry ? <><div className="delivery-workbench-controls">{renderControlTimeline?.(selectedEntry.dispatchId)}</div><Empty className="delivery-workbench-controls-empty" description={t('workbench.noControls')} /></> : <Empty description={t('workbench.noSession')} /> },
              { key: 'details', label: t('workbench.details'), children: details },
              { key: 'trace', label: t('trace.timeline'), children: selectedEntry ? <RuntimeTracePanel dispatchId={selectedEntry.dispatchId} status={selectedEntry.attempt.status ?? undefined} node={selectedTraceNode} processGraph={progress?.processGraph ?? undefined} visible={expanded && tab === 'trace'} /> : <Empty description={t('workbench.noSession')} /> },
              { key: 'timing', label: t('stepTiming.title'), children: selectedEntry ? <StepDurationChart key={selectedEntry.dispatchId} dispatchId={selectedEntry.dispatchId} steps={selectedEntry.attempt.stepTimings} /> : <Empty description={t('workbench.noSession')} /> },
              { key: 'artifacts', label: t('artifacts.agentCount', { count: selectedArtifacts.length }), children: <ArtifactGroup key={selectedAgent?.agentId ?? 'all'} executions={selectedExecutions} steps={selectedAgent?.steps ?? []} artifacts={selectedArtifacts} loading={artifactsLoading} onPreview={setPreviewArtifact} /> },
            ]} />
          </main>
        </div>
      </div>
      <ArtifactPreviewModal
        open={expanded && previewArtifact != null}
        artifact={previewArtifact}
        artifacts={previewSequence}
        onClose={() => setPreviewArtifact(null)}
      />
    </Modal>
  </>;
}

/** Loads restart rounds only when the caller can identify a workitem, so pages that
 *  render delivery progress without one never touch the recovery API. */
function RestartRoundScope({ workitemId, children }: { workitemId: string; children: (rounds: RestartRound[]) => ReactNode }) {
  const { data } = useRecoveryState(workitemId);
  return <>{children(data?.restarts ?? [])}</>;
}

export function DeliveryProgress(props: DeliveryProgressProps) {
  if (!props.workitemId) return <DeliveryProgressView {...props} />;
  return <RestartRoundScope workitemId={props.workitemId}>
    {(rounds) => <DeliveryProgressView {...props} restarts={rounds} />}
  </RestartRoundScope>;
}

function DeliveryProgressView({ showWorkflowPlan = true, steps = [], progress, artifacts = [], artifactsLoading, loading, terminalStatus, onContinue, onPause, onExecutionAction, pendingExecutionAction, renderRecovery, renderControlTimeline, restarts = [] }: DeliveryProgressProps & { restarts?: RestartRound[] }) {
  const { t } = useTranslation('workitem');
  const [workbenchEntry, setWorkbenchEntry] = useState<WorkbenchEntryRequest | null>(null);
  const openWorkbench = (tab: string, pinnedAgent?: number | null, pinnedDispatch?: number | null) => {
    setWorkbenchEntry(prev => ({
      token: (prev?.token ?? 0) + 1,
      tab,
      ...(pinnedAgent !== undefined ? { pinnedAgent } : {}),
      ...(pinnedDispatch !== undefined ? { pinnedDispatch } : {}),
    }));
  };
  const handleExecutionAction = onExecutionAction ?? ((attempt: DispatchAttempt, action: ExecutionActionKind) => {
    if (action === 'pause') onPause?.(attempt.dispatchId);
    if (action === 'resume') onContinue?.(attempt.dispatchId);
  });
  // 只用持久化的数字人归属展示各自轮次；缺少归属的旧记录在工单层级显示。
  const restartsByAgent = useMemo(() => {
    const grouped = new Map<number, RestartRound[]>();
    restarts.forEach(round => {
      if (round.agent_id == null) return;
      const rounds = grouped.get(round.agent_id);
      if (rounds) rounds.push(round); else grouped.set(round.agent_id, [round]);
    });
    grouped.forEach(rounds => rounds.sort((a, b) => b.restart_round - a.restart_round));
    return grouped;
  }, [restarts]);
  const unattributedRounds = restarts.filter((round) => round.agent_id == null);

  const agents = useMemo(() => {
    const terminal = normalizeTerminalStatus(terminalStatus);
    const agents: ConvergedAgentProgress[] = (progress?.agents ?? []).map((agent) => ({
      ...agent,
      status: terminal && (agent.status === 'active' || agent.status === 'paused')
        ? terminal === 'SUCCEEDED' ? 'finished' : terminal === 'FAILED' ? 'failed' : 'cancelled'
        : agent.status,
      steps: convergeStepsForTerminalStatus(agent.steps, terminalStatus),
    }));
    const seenAgentIds = new Set<number>();
    [...(progress?.executions ?? [])].sort((a, b) => b.dispatchId - a.dispatchId).forEach(execution => {
      const agentId = execution.agentId ?? -execution.dispatchId;
      if (seenAgentIds.has(agentId)) return;
      seenAgentIds.add(agentId);
      const status: AgentDeliveryProgress['status'] = execution.status === 'SUCCEEDED' ? 'finished'
        : execution.status === 'FAILED' || execution.status === 'TIMEOUT' ? 'failed'
        : execution.status === 'CANCELED' ? 'cancelled' : execution.status === 'PAUSED' ? 'paused' : 'active';
      const existing = agents.find(agent => agent.agentId === agentId);
      if (existing) {
        if (!terminal) {
          existing.status = status;
          existing.currentDispatchId = execution.dispatchId;
          existing.executionStatus = execution.status;
          existing.waitingReason = execution.waitingReason;
        }
        return;
      }
      agents.push({ agentId, agentName: execution.agentName ?? '—', currentDispatchId: execution.dispatchId, executionStatus: execution.status, waitingReason: execution.waitingReason,
        status: terminal ? terminal === 'SUCCEEDED' ? 'finished' : terminal === 'FAILED' ? 'failed' : 'cancelled' : status,
        durationMs: execution.durationMs, steps: [] });
    });
    // 0 派发但被再次交付的目标数字人也要有一行，否则启动失败的轮次无处归属。
    restartsByAgent.forEach((rounds, agentId) => {
      if (agents.some(agent => agent.agentId === agentId)) return;
      agents.push({ agentId, agentName: rounds.find(round => round.agent_name)?.agent_name ?? EMDASH,
        currentDispatchId: null, executionStatus: null, waitingReason: null, status: 'pending',
        durationMs: null, steps: [] });
    });
    return agents;
  }, [progress?.agents, progress?.executions, terminalStatus, restartsByAgent]);

  if (loading) {
    return (
      <Card size="small" title={t('delivery.title')}>
        <div style={{ textAlign: 'center', padding: 16 }}>
          <Spin size="small" />
        </div>
      </Card>
    );
  }

  const displaySteps = agents.length > 0 ? [] : convergeStepsForTerminalStatus(progress?.steps ?? steps, terminalStatus);
  const stepActionAttempt = agents.length === 0
    ? displaySteps.flatMap(step => step.attempts ?? []).find(attempt => attempt.canContinue || attempt.canPause) ?? null
    : null;
  const cardTitle = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1 }}>{t('delivery.title')}</span>
      {progress?.totalDurationMs != null && (
        <Tooltip title={t('delivery.durationHint')}>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {t('delivery.totalDuration', { duration: formatDuration(progress.totalDurationMs) })}
          </Text>
        </Tooltip>
      )}
    </div>
  );

  if (agents.length > 0) {
    return (
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {showWorkflowPlan && progress?.workflowPlan && <WorkflowPlanSummary plan={progress.workflowPlan} />}
        {progress?.closed && <NoticeTip kind="warning" title={t('recovery.deliveryClosed')} detail={t('recovery.closeHint')} />}
        <Card size="small" title={cardTitle} data-testid="delivery-progress-card" styles={{ body: { padding: '14px 16px' } }}>
          <DeliveryRail agents={agents} progress={progress} artifacts={artifacts}
            restartsByAgent={restartsByAgent}
            onOpenWorkbench={openWorkbench}
            onExecutionAction={handleExecutionAction} pendingExecutionAction={pendingExecutionAction} />
          <DeliveryStartRecords rounds={unattributedRounds} variant="unattributed" />
        </Card>
        <AuthoritativeExecutionProcessGraph processGraph={progress?.processGraph} entries={executionEntries(agents, progress?.executions)} onOpenTrace={dispatchId => openWorkbench('trace', null, dispatchId)} />
        <DeliveryWorkbench entry={workbenchEntry} renderControlTimeline={renderControlTimeline} renderRecovery={renderRecovery} agents={agents} progress={progress} artifacts={artifacts} artifactsLoading={artifactsLoading}
          onExecutionAction={handleExecutionAction} pendingExecutionAction={pendingExecutionAction} />
      </Space>
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      {showWorkflowPlan && progress?.workflowPlan && <WorkflowPlanSummary plan={progress.workflowPlan} />}
      {progress?.closed && <NoticeTip kind="warning" title={t('recovery.deliveryClosed')} detail={t('recovery.closeHint')} />}
      <Card size="small" title={cardTitle} data-testid="delivery-progress-card" styles={{ body: { padding: '6px 8px' } }}>
        {stepActionAttempt && (
          <div style={{ marginBottom: 6 }}>
            <ExecutionActionBar
              attempt={stepActionAttempt}
              pending={pendingExecutionAction}
              onAction={(action) => handleExecutionAction(stepActionAttempt, action)}
            />
          </div>
        )}
        {displaySteps.length === 0 ? <EmptyState description={t('delivery.empty')} /> : <StepList steps={displaySteps} renderControlTimeline={renderControlTimeline} />}
        <DeliveryStartRecords rounds={unattributedRounds} variant="unattributed" />
      </Card>
    </Space>
  );
}
