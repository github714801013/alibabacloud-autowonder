import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { workitemDeleteReason } from './runtimeLabels';
import './workitemDetail.css';
import './transitionModal.css';
import { transitionDotColor } from './transition';
import { useTranslation } from 'react-i18next';
import { RecoveryControls } from './components/RecoveryControls';
import { DispatchRequests } from './components/DispatchRequests';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Empty, Input, Modal, Spin, Result, Button, Tabs } from 'antd';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTemplateDetail } from '@/features/statemachine/hooks';
import {
  useWorkitem, useTimelineHistory, useParticipants,
  useDeliveryProgress, useClarification, useArtifacts, useRequirementDocuments, useTransitionWorkitem, useSyncExternalWorkitem,
  useUpdateWorkitemContent, useDeleteWorkitem, useToggleWatch, useUpdateWorkitemTags, useWorkitemTagOptions,
  useExecutionControl,
} from './hooks';
import { WorkitemHeader } from './components/WorkitemHeader';
import { WorkitemMeta } from './components/WorkitemMeta';
import { ScheduledStartControl } from './components/ScheduledStartControl';
import { HumanInterventionAlert } from './components/HumanInterventionBadge';
import { WorkitemActionBar } from './components/WorkitemActionBar';
import { StartDeliveryModal } from './components/StartDeliveryModal';
import { ClarifyReminderModal } from './components/ClarifyReminderModal';
import { AssignHumanModal } from './components/AssignHumanModal';
import { OtherWorkspacePrompt } from './components/OtherWorkspacePrompt';
import { readWorkitemOwningWorkspace } from './otherWorkspace';
import { WorkitemContent } from './components/WorkitemContent';
import { WorkitemTagsEditor } from './components/WorkitemTagsEditor';
import { RequirementDocumentsCard } from './components/RequirementDocumentsCard';
import { ClarificationResult } from './components/ClarificationResult';
import { usePrdSummary } from '@/features/prd/hooks';
import { PrdContextPreview } from '@/features/prd/components/PrdContextPreview';
import { UnifiedTimeline } from './components/UnifiedTimeline';
import { InteractionStopControl } from './components/InteractionStopControl';
import type { InteractionStopAction } from './components/InteractionStopControl';
import { CommentInput } from './components/CommentInput';
import { ScrollToEdgeButton } from './components/ScrollToEdgeButton';
import { RightPanel } from './components/RightPanel';
import { ResizeHandle } from '@/shared/ui/ResizeHandle';
import { AI_CLARIFICATION_ENABLED } from './featureFlags';
import { isSameClarifyView, readClarifyView, writeClarifyView } from './clarifyView';
import type { ClarifyContext, ClarifyView } from './clarifyView';
import { isClarifyReminderSuppressed, suppressClarifyReminder } from './clarifyReminderPreference';
import { useAccessCommand } from '@/shared/auth/useAccessCommand';
import { allows } from '@/shared/auth/access';
import { useAuthStore } from '@/shared/auth/store';
import { CLARIFICATION_THEME } from './clarification/theme';
import { TRANSITION_REASON_MAX_LENGTH } from './transitionLimits';
import type { Artifact, CommentInteraction, Participant } from '@/shared/types/workitem';
import { useIsMobile } from '@/shared/ui/useIsMobile';

const CLARIFY_MIN_WIDTH = 320;

// 模块级空数组：查询数据未就绪时不生成新引用，避免时间线 memo 被空数组默认值击穿。
const EMPTY_PARTICIPANTS: Participant[] = [];
const EMPTY_ARTIFACTS: Artifact[] = [];
const MOBILE_VIEW_COMMENTS = 'comments';
const MOBILE_VIEW_PROGRESS = 'progress';

export function WorkitemDetailPage() {
  const { t } = useTranslation('workitem');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accessCommand = useAccessCommand();
  const accessLevel = useAuthStore((state) => state.accessLevel);
  const readOnlyDomains = useAuthStore((state) => state.readOnlyDomains);
  // 与后端一致：读写级即可编辑，角色勾选「工单」只读后收回入口。
  const tagsEditable = accessLevel !== null && allows(accessLevel, 'READ_WRITE')
    && (accessLevel === 'ADMIN' || !readOnlyDomains.includes('WORKITEM'));
  const canControlInteraction = accessLevel !== null && allows(accessLevel, 'READ_WRITE')
    && (accessLevel === 'ADMIN' || !readOnlyDomains.includes('WORKITEM'));
  const executionControl = useExecutionControl(id || '');
  const [interactionPending, setInteractionPending] = useState<Record<number, InteractionStopAction>>({});
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [clarifyReminderOpen, setClarifyReminderOpen] = useState(false);
  // localStorage 不是响应式的：挂载时读一次进 state，本次会话内勾选后立刻生效，不必刷新页面
  const [clarifyReminderSuppressed, setClarifyReminderSuppressed] = useState(isClarifyReminderSuppressed);
  const [assignHumanOpen, setAssignHumanOpen] = useState(false);
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<number | null>(null);
  const [transitionReason, setTransitionReason] = useState('');
  const [transitionExpected, setTransitionExpected] = useState<{ fromNodeId?: number | string; expectedVersion?: number }>({});
  const transitionSubmitting = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<'comments' | 'progress'>(
    () => readClarifyView(searchParams).mode === 'clarify' ? 'progress' : 'comments',
  );
  // Router 导航可以延后提交。同帧的全屏/会话上报必须累积到尚未提交的 URL，
  // 否则后一次上报会用旧 searchParams 覆盖前一次变更。
  const clarifySearchRef = useRef({ committed: searchParams, pending: searchParams });
  if (clarifySearchRef.current.committed !== searchParams) {
    clarifySearchRef.current = { committed: searchParams, pending: searchParams };
  }
  // 澄清视图状态挂在 URL 上：刷新后仍停在原工单的原澄清会话并恢复全屏态（工单 53035）
  const clarifyView = readClarifyView(searchParams);
  const panelMode = clarifyView.mode;
  useEffect(() => {
    if (isMobile && panelMode === 'clarify') setMobileView('progress');
  }, [isMobile, panelMode]);
  const handleMobileViewChange = (next: 'comments' | 'progress') => {
    setMobileView(next);
    // 切回评论页签时退出澄清态，否则 URL 里的 clarify 会立刻把页签拽回进度。
    if (next === 'comments' && panelMode === 'clarify') updateClarifyView({ mode: 'progress' });
  };
  const [clarifyWidth, setClarifyWidth] = useState<number | null>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setClarifyWidth(null);
    setTransitionOpen(false);
    setTransitionTarget(null);
    setTransitionReason('');
  }, [id]);

  // 依赖 react-router 按 location.search 记忆化的 searchParams：交付进度在轮询，
  // 但轮询不改 search，回调标识因此稳定，澄清面板的上下文上报 effect 不会被无谓地反复触发。
  const updateClarifyView = useCallback((patch: Partial<ClarifyView>) => {
    const current = clarifySearchRef.current.pending;
    const next = writeClarifyView(current, patch);
    if (isSameClarifyView(readClarifyView(next), readClarifyView(current))) return;
    clarifySearchRef.current.pending = next;
    // replace：刷新能恢复即可，不该让每次进出澄清都往浏览历史里塞一条
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);
  const handleClarifyContextChange = useCallback(
    (context: Partial<ClarifyContext>) => updateClarifyView(context),
    [updateClarifyView],
  );

  const { data: workitem, isLoading, isError, error } = useWorkitem(id || '');
  // 当前项目查不到不等于工单不存在：服务端确认用户对归属项目有权限时才下发 13023（单 55699）
  const owningWorkspace = readWorkitemOwningWorkspace(error);
  const templateId = workitem?.templateId != null ? Number(workitem.templateId) : null;
  const validTemplateId = templateId != null && Number.isFinite(templateId) ? templateId : null;
  const currentStatusNodeId = workitem?.statusNodeId != null ? Number(workitem.statusNodeId) : null;
  const { data: templateDetail, isLoading: templateLoading } = useTemplateDetail(validTemplateId);
  const updateContentMutation = useUpdateWorkitemContent();
  const transitionMutation = useTransitionWorkitem();
  const externalSyncMutation = useSyncExternalWorkitem();
  const deleteMutation = useDeleteWorkitem();
  const watchMutation = useToggleWatch();
  const tagsMutation = useUpdateWorkitemTags(id || '');
  const { data: tagOptions } = useWorkitemTagOptions();
  const { data: timeline, hasNextPage: timelineHasMore, isLoading: timelineLoading, isFetching: timelineFetching, loadedPageCount, fetchNextPage, refetch: refetchTimeline } = useTimelineHistory(id || '');
  const { data: participantsData, isLoading: participantsLoading } = useParticipants(id || '');
  const participants = participantsData ?? EMPTY_PARTICIPANTS;
  const { data: progress, isLoading: progressLoading, isError: progressError, refetch: retryProgress } = useDeliveryProgress(id || '', workitem?.statusCategory);
  const { data: clarification } = useClarification(id || '');
  const { data: prdSummary } = usePrdSummary(id || '');
  const { data: artifactsData, isLoading: artifactsLoading } = useArtifacts(id || '');
  const artifacts = artifactsData ?? EMPTY_ARTIFACTS;
  const { data: requirementDocumentsData, isLoading: requirementDocumentsLoading } = useRequirementDocuments(id || '');
  const requirementDocuments = requirementDocumentsData ?? EMPTY_ARTIFACTS;
  const timelineArtifacts = useMemo(
    () => [...artifacts, ...requirementDocuments],
    [artifacts, requirementDocuments],
  );

  // 每条交互只携带自己的 dispatchId：确认框、loading 和失败都按 dispatch 隔离。
  const runInteractionAction = useCallback(async (dispatchId: number, action: InteractionStopAction) => {
    await accessCommand('READ_WRITE', t('delivery.endExecution'), async () => {
      setInteractionPending((current) => ({ ...current, [dispatchId]: action }));
      try {
        await executionControl.mutateAsync({ dispatchId, action });
      } finally {
        setInteractionPending((current) => {
          const next = { ...current };
          delete next[dispatchId];
          return next;
        });
      }
    });
  }, [accessCommand, executionControl, t]);

  const renderInteractionActions = useCallback((interaction: CommentInteraction) => {
    const dispatchId = interaction.dispatchId;
    if (!canControlInteraction || !dispatchId) return null;
    return (
      <InteractionStopControl
        interaction={interaction}
        pending={interactionPending[dispatchId] ?? null}
        onAction={(action) => runInteractionAction(dispatchId, action)}
        onRefresh={() => { void refetchTimeline(); }}
      />
    );
  }, [canControlInteraction, interactionPending, refetchTimeline, runInteractionAction]);

  if (!id) return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}><Result status="404" title={t('detail.invalidId')} extra={<Button onClick={() => navigate(-1)}>{t('detail.back')}</Button>} /></div>;
  if (isLoading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  // 轮询后台刷新失败时 react-query 会保留已加载数据（isError=true 但 data 还在）。
  // 只有一次都没加载成功才整页替换成错误页，否则页面会从有数据被抹成 502（需求：502 保留数据）。
  if (isError && !workitem) return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      {owningWorkspace ? (
        <OtherWorkspacePrompt owning={owningWorkspace} />
      ) : (
        <Result status="error" title={t('detail.loadFailed')} subTitle={error?.message || t('detail.retryLater')}
          extra={<Button onClick={() => navigate(-1)}>{t('detail.back')}</Button>} />
      )}
    </div>
  );
  if (!workitem) return null;

  const handleClarifyConfirm = () => {
    queryClient.invalidateQueries({ queryKey: ['workitem', id, 'clarification'] });
  };
  const hasSdlc = workitem.sdlcId != null;
  // 澄清材料就是左栏「澄清材料 (AI 生成)」卡片的数据源：有内容即视为已完成澄清
  const clarificationDone = Boolean(clarification?.contentMd?.trim());
  // 需求文档已经就位，说明需求信息不缺，没必要再引导去澄清（工单 54819）
  const hasRequirementDocuments = requirementDocuments.length > 0;
  // 只在「首次启动交付 + 尚未完成澄清 + 没有需求文档 + 用户没说过别再提醒」时引导（工单 53315 / 54819）；
  // 按钮已变成「重新指派」说明不是首次
  const shouldRemindClarify = AI_CLARIFICATION_ENABLED
    && !hasSdlc && !clarificationDone && !hasRequirementDocuments && !clarifyReminderSuppressed;
  const handleStartDeliveryClick = () => accessCommand(
    'READ_WRITE',
    hasSdlc ? t('detail.reassignCommand') : t('detail.startDeliveryCommand'),
    // 引导弹窗只是插在原流程前面：跳过就照旧打开启动交付弹窗
    () => (shouldRemindClarify ? setClarifyReminderOpen(true) : setDeliveryOpen(true)),
  );
  // 只有跳过和去澄清算用户做了决定，关闭图标不算，所以落偏好收在这一个入口（工单 54819）
  const rememberClarifyReminderChoice = (rememberChoice: boolean) => {
    if (!rememberChoice) return;
    suppressClarifyReminder();
    setClarifyReminderSuppressed(true);
  };
  const handleGoClarify = (rememberChoice: boolean) => {
    rememberClarifyReminderChoice(rememberChoice);
    setClarifyReminderOpen(false);
    accessCommand('READ_WRITE', t('detail.clarifyCommand'), () => updateClarifyView({ mode: 'clarify' }));
  };
  const handleSkipClarifyReminder = (rememberChoice: boolean) => {
    rememberClarifyReminderChoice(rememberChoice);
    setClarifyReminderOpen(false);
    setDeliveryOpen(true);
  };
  // 宽度上限保证左栏工单正文区至少保留 480px 可用宽度
  const clarifyMaxWidth = Math.max(
    CLARIFY_MIN_WIDTH,
    Math.min(720, window.innerWidth * 0.65, window.innerWidth - 480),
  );
  // 流转候选（规格 3.3）：当前模板内除当前节点外的全部节点；推荐边只决定排序与推荐标记，不拦截。
  const recommendedNodeIds = new Set((templateDetail?.transitions ?? [])
    .filter((transition) => Number(transition.fromNodeId) === currentStatusNodeId)
    .map((transition) => Number(transition.toNodeId)));
  const transitionCandidates = (templateDetail?.nodes ?? [])
    .filter((node) => Number(node.id) !== currentStatusNodeId)
    .sort((a, b) => Number(recommendedNodeIds.has(Number(b.id))) - Number(recommendedNodeIds.has(Number(a.id))));
  const openTransition = () => accessCommand('READ_WRITE', t('actions.transition'), () => {
    setTransitionTarget(null);
    setTransitionReason('');
    setTransitionExpected({ fromNodeId: workitem.statusNodeId ?? undefined, expectedVersion: workitem.version });
    setTransitionOpen(true);
  });
  const handleTransition = () => {
    if (transitionTarget == null || transitionSubmitting.current) return;
    accessCommand('READ_WRITE', t('actions.transition'), () => {
      transitionSubmitting.current = true;
      transitionMutation.mutate(
        {
          id,
          toNodeId: transitionTarget,
          expected: {
            ...transitionExpected,
            reason: transitionReason.trim() ? transitionReason : undefined,
          },
        },
        {
          onSuccess: () => setTransitionOpen(false),
          onSettled: () => { transitionSubmitting.current = false; },
        },
      );
    });
  };
  const handleSaveContent = async (values: { title: string; contentMd: string }) => {
    await accessCommand(
      'READ_WRITE',
      t('detail.editCommand'),
      () => updateContentMutation.mutateAsync({ id, ...values }),
    );
  };
  const handleDelete = () => {
    accessCommand('READ_WRITE', t('actions.delete'), () => {
      deleteMutation.mutate(
        { id },
        { onSuccess: () => navigate('/workitems') },
      );
    });
  };

  return (
    <div className="aw-detail-page" style={{ height: '100%', flexDirection: isMobile ? 'column' : undefined }}>
      {isMobile && (
        <Tabs
          data-testid="workitem-mobile-tabs"
          activeKey={mobileView}
          onChange={(key) => handleMobileViewChange(key as 'comments' | 'progress')}
          items={[
            { key: MOBILE_VIEW_COMMENTS, label: t('detail.commentsTab') },
            { key: MOBILE_VIEW_PROGRESS, label: t('detail.progressTab') },
          ]}
          style={{ flexShrink: 0, padding: '0 12px', marginBottom: 0 }}
        />
      )}
      {/* Left Panel：原型 05c 主栏为画布上的并列白卡（头部 / 需求与设计 / 评论&时间线）；移动端按页签条件渲染 */}
      {(!isMobile || mobileView === MOBILE_VIEW_COMMENTS) && <section className="aw-detail-main aw-wi-main">
        <div
          data-testid="workitem-scroll-region"
          style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'visible', display: 'flex' }}
        >
          <div ref={leftScrollRef} data-testid="workitem-left-scroll" className="aw-detail-canvas" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
          <section className="aw-detail-head-card" data-testid="workitem-head-card">
          <WorkitemHeader
            title={workitem.title}
            workitemId={workitem.id}
            origin={workitem.origin}
            scheduledStartAt={workitem.scheduledStartAt}
            scheduledStartTriggeredAt={workitem.scheduledStartTriggeredAt}
            gmtCreate={workitem.gmtCreate}
          />
          <WorkitemMeta
            workitemId={workitem.id}
            assigneeName={workitem.assigneeName ?? null}
            assigneeDisplayName={workitem.assigneeDisplayName ?? null}
            assigneeNameFallback={workitem.assigneeNameFallback}
            assigneeType={workitem.assigneeType}
            creatorDisplayName={workitem.creatorDisplayName ?? null}
            sdlcName={workitem.sdlcName ?? null}
            tags={workitem.tags}
            tagsEditable={tagsEditable}
            onEditTags={() => accessCommand(
              'READ_WRITE',
              t('tags.editCommand'),
              () => setTagsOpen(true),
              'WORKITEM',
            )}
          />
          <ScheduledStartControl
            workitemId={workitem.id}
            assigneeType={workitem.assigneeType}
            scheduledStartAt={workitem.scheduledStartAt}
          />
          <RecoveryControls workitemId={id} renderActions={(deliveryControl) => <WorkitemActionBar
            deliveryControl={deliveryControl}
            workType={workitem.workType}
            statusName={workitem.statusName ?? null}
            statusLabelKey={workitem.statusLabelKey ?? null}
            statusCategory={workitem.statusCategory}
            priority={workitem.priority}
            hasSdlc={hasSdlc}
            watched={!!workitem.watched}
            onToggleWatch={() => watchMutation.mutate({ id, watched: !!workitem.watched })}
            watchLoading={watchMutation.isPending}
            onStartDelivery={handleStartDeliveryClick}
            onAssignHuman={() => accessCommand(
              'READ_WRITE',
              t('detail.assignHumanCommand'),
              () => setAssignHumanOpen(true),
            )}
            onTransition={openTransition}
            onAddComment={() => commentRef.current?.querySelector('textarea')?.focus()}
            onSyncExternal={() => accessCommand(
              'READ_WRITE',
              t('detail.syncCommand'),
              () => externalSyncMutation.mutate({ id }),
            )}
            onDelete={() => accessCommand('READ_WRITE', t('actions.delete'), () => setDeleteOpen(true))}
            syncExternalLoading={externalSyncMutation.isPending}
            deleteLoading={deleteMutation.isPending}
            deleteDisabled={workitem.deletable === false}
            deleteDisabledReason={workitemDeleteReason(workitem)}
          />} />
          </section>
          <HumanInterventionAlert item={workitem} />
          <DispatchRequests workitemId={id} artifacts={artifacts} />
          <WorkitemContent
            title={workitem.title}
            contentMd={workitem.contentMd}
            workitemId={id}
            saving={updateContentMutation.isPending}
            readOnly={Boolean(workitem.externalCollaboration)}
            onSave={handleSaveContent}
          >
            <RequirementDocumentsCard
              workitemId={id}
              documents={requirementDocuments}
              loading={requirementDocumentsLoading}
              hasGeneratedContext={Boolean(clarification?.contentMd || prdSummary?.latestVersionNo)}
            >
              {AI_CLARIFICATION_ENABLED ? <ClarificationResult clarification={clarification} /> : null}
              {Boolean(prdSummary?.latestVersionNo) && <PrdContextPreview workitemId={id} />}
            </RequirementDocumentsCard>
          </WorkitemContent>
            <UnifiedTimeline
              key={id}
              items={timeline}
              participants={participants}
              artifacts={timelineArtifacts}
              loading={timelineLoading}
              hasMore={timelineHasMore}
              loadingMore={timelineFetching}
              onLoadMore={() => { if (!timelineFetching) void fetchNextPage({ cancelRefetch: false }); }}
              scrollContainerRef={leftScrollRef}
              loadedPageCount={loadedPageCount}
              renderInteractionActions={renderInteractionActions}
              composer={(
                <div ref={commentRef} data-testid="workitem-sticky-comment">
                  <CommentInput
                    key={id}
                    workitemId={id}
                    documents={requirementDocuments}
                    participants={participants}
                  />
                </div>
              )}
            />
          </div>
          <ScrollToEdgeButton containerRef={leftScrollRef} />
        </div>
      </section>}

      {/* Right Panel：原型 05 右栏 380 轨道，透明底直接挂画布；澄清模式接管时恢复面板底色；移动端按页签条件渲染 */}
      {(!isMobile || mobileView === MOBILE_VIEW_PROGRESS) && <div
        ref={rightPanelRef}
        data-testid="workitem-right-panel"
        className="aw-detail-aside"
        style={{
          width: isMobile ? '100%' : clarifyWidth != null ? `${clarifyWidth}px` : '380px',
          flex: isMobile ? 1 : undefined,
          flexShrink: 0,
          minHeight: isMobile ? 0 : undefined,
          padding: isMobile ? 10 : undefined,
          overflowY: 'auto',
          position: 'relative',
          display: panelMode === 'clarify' ? 'flex' : 'block',
          flexDirection: panelMode === 'clarify' ? 'column' : undefined,
          background: panelMode === 'clarify' ? CLARIFICATION_THEME.surface : undefined,
          borderLeft: panelMode === 'clarify' ? `1px solid ${CLARIFICATION_THEME.hairline}` : undefined,
        }}
      >
        {panelMode === 'clarify' ? (
          <ResizeHandle
            direction="horizontal"
            value={clarifyWidth ?? 0}
            measureValue={() => rightPanelRef.current?.getBoundingClientRect().width ?? 0}
            min={CLARIFY_MIN_WIDTH}
            max={clarifyMaxWidth}
            onChange={setClarifyWidth}
            aria-label={t('detail.resizeClarification')}
          />
        ) : null}
        <RightPanel
          key={id}
          workitemId={id}
          workitemTitle={workitem.title}
          timeline={timeline}
          participants={participants}
          participantsLoading={participantsLoading}
          externalCollaboration={workitem.externalCollaboration}
          steps={progress?.steps || []}
          progress={progress}
          stepsLoading={progressLoading}
          progressError={progressError}
          onRetryProgress={() => { void retryProgress(); }}
          terminalStatus={workitem.statusCategory ?? workitem.statusName}
          artifacts={artifacts}
          clarificationArtifacts={timelineArtifacts}
          artifactsLoading={artifactsLoading}
          onClarifyConfirm={handleClarifyConfirm}
          initialMode={panelMode}
          initialFullscreen={clarifyView.fullscreen}
          clarifyContext={clarifyView}
          onModeChange={(next) => {
            if (next === 'progress') setClarifyWidth(null);
            updateClarifyView({ mode: next });
          }}
          onFullscreenChange={(fullscreen) => updateClarifyView({ fullscreen })}
          onClarifyContextChange={handleClarifyContextChange}
        />
      </div>}

      <ClarifyReminderModal
        open={clarifyReminderOpen}
        onConfirm={handleGoClarify}
        onSkip={handleSkipClarifyReminder}
        onClose={() => setClarifyReminderOpen(false)}
      />
      <StartDeliveryModal
        open={deliveryOpen}
        workitemId={id}
        hasSdlc={hasSdlc}
        currentAgentId={workitem.assigneeType === 'AGENT' ? workitem.assigneeRef : null}
        currentSdlcId={workitem.sdlcId}
        onClose={() => setDeliveryOpen(false)}
      />
      <AssignHumanModal
        open={assignHumanOpen}
        workitemId={id}
        onClose={() => setAssignHumanOpen(false)}
      />
      <Modal
        className="aw-transition-modal"
        width={420}
        closeIcon={<AwStrokeIcon name="x" size={14} />}
        closable={{ 'aria-label': t('projection.close') }}
        title={<span className="aw-transition-title"><AwStrokeIcon name="branch" size={14} />{t('detail.transitionTitle')}</span>}
        open={transitionOpen}
        okText={t('transition.confirm')}
        cancelText={t('detail.cancel')}
        confirmLoading={transitionMutation.isPending}
        okButtonProps={{ size: 'small', disabled: transitionTarget == null || templateLoading || transitionMutation.isPending }}
        cancelButtonProps={{ size: 'small', disabled: transitionMutation.isPending }}
        maskClosable={!transitionMutation.isPending}
        keyboard={!transitionMutation.isPending}
        onOk={handleTransition}
        onCancel={() => { if (!transitionSubmitting.current) setTransitionOpen(false); }}
      >
        {!validTemplateId ? (
          <Empty description={t('detail.noTemplate')} />
        ) : templateLoading ? (
          <Spin style={{ display: 'block', margin: '32px auto' }} />
        ) : transitionCandidates.length === 0 ? (
          <Empty description={t('detail.noTransitions')} />
        ) : (
          <>
            <div className="aw-state-opts" role="radiogroup" aria-label={t('transition.choose')} aria-disabled={transitionMutation.isPending}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
                if (!step || transitionMutation.isPending) return;
                event.preventDefault();
                const current = transitionCandidates.findIndex((node) => Number(node.id) === transitionTarget);
                const next = (current + step + transitionCandidates.length) % transitionCandidates.length;
                setTransitionTarget(Number(transitionCandidates[next].id));
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
              }}>
              {transitionCandidates.map((node, index) => {
                const checked = transitionTarget === Number(node.id);
                const focusable = transitionTarget == null ? index === 0 : checked;
                return (
                  <button key={node.id} type="button" role="radio" aria-checked={checked} aria-label={node.name}
                    className={`aw-state-opt ${checked ? 'is-on' : ''}`} tabIndex={focusable ? 0 : -1}
                    disabled={transitionMutation.isPending} onClick={() => setTransitionTarget(Number(node.id))}>
                    <span className={`aw-state-dot is-${transitionDotColor(node)}`} aria-hidden="true" />
                    <span className="aw-state-opt-name">{node.name}</span>
                    <span className="aw-state-desc">
                      {recommendedNodeIds.has(Number(node.id)) ? t('detail.recommended') : t('detail.notRecommended')}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="aw-transition-reason">
              <Input.TextArea
                id="workitem-transition-reason"
                variant="borderless"
                aria-label={t('transition.reason')}
                placeholder={t('transition.reasonPlaceholder')}
                value={transitionReason}
                disabled={transitionMutation.isPending}
                onChange={(event) => setTransitionReason(event.target.value)}
                maxLength={TRANSITION_REASON_MAX_LENGTH}
                showCount
                rows={3}
              />
            </div>
          </>
        )}
      </Modal>
      <Modal
        closeIcon={<AwStrokeIcon name="x" />}
        closable={{ 'aria-label': t('projection.close') }}
        title={t('actions.delete')}
        open={deleteOpen}
        okText={t('detail.delete')}
        okButtonProps={{ danger: true, loading: deleteMutation.isPending }}
        cancelText={t('detail.cancel')}
        onOk={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      >
        {t('detail.deleteDescription')}
      </Modal>
      <Modal
        closeIcon={<AwStrokeIcon name="x" />}
        closable={{ 'aria-label': t('projection.close') }}
        title={t('tags.edit')}
        open={tagsOpen}
        footer={null}
        destroyOnHidden
        onCancel={() => setTagsOpen(false)}
      >
        <WorkitemTagsEditor
          initialTags={workitem.tags ?? []}
          options={tagOptions ?? []}
          saving={tagsMutation.isPending}
          onSave={async (tags) => {
            await tagsMutation.mutateAsync({ tags });
            setTagsOpen(false);
          }}
          onCancel={() => setTagsOpen(false)}
          autoFocus
        />
      </Modal>
    </div>
  );
}
