import { workitemDeleteReason } from './runtimeLabels';
import { useSystemLabel } from '@/shared/i18n/systemLabels';
import { PageHead } from '@/shared/ui/PageHead';
import { Toolbar } from '@/shared/ui/Toolbar';
import { TableCard, TableFooter } from '@/shared/ui/TableCard';
import { Trans, useTranslation } from 'react-i18next';
import { i18n } from '@/shared/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tag, Space, Segmented, Popconfirm, Tooltip, Input, AutoComplete, Typography, Popover, Empty, Modal, Spin, message } from 'antd';
import { Table } from '@/shared/theme/ThemedTable';
import { StatusTag, type StatusColorKey } from '@/shared/ui/StatusTag';
import { TimeCell } from '@/shared/ui/TimeCell';
import { AiIdentity } from '@/shared/ui/AiIdentity';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ExclamationCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDeleteWorkitem, useWorkitemList, useWorkitemKanbanColumns, useToggleWatch, useWorkitemTagOptions, useTransitionWorkitem } from './hooks';
import { WorkitemTagsCell } from './components/WorkitemTagsCell';
import { EllipsisText } from '@/shared/ui/EllipsisText';
import { WorkitemKanban } from './components/WorkitemKanban';
import {
  EMPTY_ADVANCED_FILTER,
  WorkitemAdvancedFilter,
  type WorkitemAdvancedFilterDraft,
} from './components/WorkitemAdvancedFilter';
import { WorkitemHealthBadge } from './components/WorkitemHealthBadge';
import { HumanInterventionBadge } from './components/HumanInterventionBadge';
import { ScheduledExecutionBadge } from './components/ScheduledExecutionBadge';
import { workTypeMap, STATUS_COLUMNS, STATUS_CATEGORY_TAG_COLOR, getPriorityMeta, statusCategoryOf } from './constants';
import { displayNameWithoutId } from './nameDisplay';
import { readWorkitemViewPreference, writeWorkitemViewPreference, type WorkitemViewMode } from './viewPreference';
import { toCreatedTimeQuery } from './createdTimeFilter';
import { serializeTagConditions } from './tagConditionFilter';
import {
  mergeWorkitemListFilters,
  parseWorkitemListSearchParams,
  toWorkitemListSearchParams,
  type WorkitemListFilterPatch,
  type WorkitemListScope,
} from './listUrlState';
import { usePageSizePreference } from '@/shared/lib/usePageSizePreference';
import { useQueryClient } from '@tanstack/react-query';
import { useTemplateDetail } from '@/features/statemachine/hooks';
import type { StatusNode } from '@/features/statemachine/types';
import { ApiError, ErrorCodes } from '@/shared/types/common';
import type { Workitem } from '@/shared/types/workitem';
import type { WorkitemStatusCategory } from './api';
import type { ColumnsType } from 'antd/es/table';
import { useAuthStore } from '@/shared/auth/store';
import { useAccessCommand } from '@/shared/auth/useAccessCommand';

import { useKanbanTransition } from './useKanbanTransition';
import { NewWorkitemModal } from '@/features/workbench/components/NewWorkitemModal';

type ViewMode = WorkitemViewMode;
type Scope = WorkitemListScope;
type StatusCategory = WorkitemStatusCategory;

/** 看板每列首屏加载条数，点「加载更多」按此步长递增 */
const KANBAN_COLUMN_PAGE_SIZE = 10;
const ALL_STATUS_KEYS = STATUS_COLUMNS.map(col => col.key as StatusCategory);

const SCOPE_STORAGE_KEY = 'autowonder.workitems.scope';
const LEGACY_PENDING_KEY = 'autowonder.workitems.onlyMyPendingDecision';

/** priorityMap 的 antd 色名 → StatusTag 色板键。 */
const PRIORITY_TAG_COLOR: Record<string, StatusColorKey> = {
  red: 'red', orange: 'amber', blue: 'blue', default: 'gray',
};

/** 缺失值的占位符，语言无关。 */
const MISSING = '-';

function readScopePreference(): Scope {
  try {
    const stored = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    if (stored === 'ALL' || stored === 'PENDING' || stored === 'CREATED' || stored === 'ASSIGNED' || stored === 'WATCHED' || stored === 'COMMENTED') {
      return stored;
    }
    if (window.localStorage.getItem(LEGACY_PENDING_KEY) === 'true') {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, 'PENDING');
      window.localStorage.removeItem(LEGACY_PENDING_KEY);
      return 'PENDING';
    }
  } catch {
    // ignore
  }
  return 'ALL';
}

function writeScopePreference(value: Scope) {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, value);
    window.localStorage.removeItem(LEGACY_PENDING_KEY);
  } catch {
    // ignore
  }
}

function scopeToQuery(scope: Scope): { pendingDecisionOnly?: boolean; mineScope?: 'CREATED' | 'ASSIGNED' | 'WATCHED' | 'COMMENTED' } {
  switch (scope) {
    case 'PENDING': return { pendingDecisionOnly: true };
    case 'CREATED': return { mineScope: 'CREATED' };
    case 'ASSIGNED': return { mineScope: 'ASSIGNED' };
    case 'WATCHED': return { mineScope: 'WATCHED' };
    case 'COMMENTED': return { mineScope: 'COMMENTED' };
    default: return {};
  }
}


function creatorCellText(record: Workitem): string {
  if (record.sourceType === 'EXTERNAL') {
    const sourceCreator = record.sourceCreator;
    if (!sourceCreator) return i18n.t('workitem:list.missingSourceCreator');
    return displayNameWithoutId(sourceCreator.displayName) || sourceCreator.subjectId || i18n.t('workitem:list.missingSourceCreator');
  }
  return displayNameWithoutId(record.creatorDisplayName, record.creatorName) || '-';
}

/** 表头单行显示，禁止逐字换行；对齐遵循原型默认左对齐。 */
function withNowrapHeader(columns: ColumnsType<Workitem>): ColumnsType<Workitem> {
  return columns.map(column => ({ ...column, onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }) }));
}

function WatchWorkitemButton({
  record,
  loading,
  onToggle,
}: {
  record: Workitem;
  loading: boolean;
  onToggle: (record: Workitem) => void;
}) {
  const { t } = useTranslation('workitem');
  const watched = !!record.watched;
  return (
    <Tooltip title={watched ? t('actions.unwatch') : t('actions.watch')}>
      <Button
        size="small"
        type="text"
        className="aw-op-btn"
        data-testid="workitem-watch-toggle"
        aria-label={watched ? t('actions.unwatchAria') : t('actions.watchAria')}
        icon={<AwStrokeIcon name="star" className={watched ? 'aw-watch-active' : undefined} />}
        loading={loading}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(record);
        }}
      />
    </Tooltip>
  );
}

function DeleteWorkitemButton({
  record,
  loading,
  onDelete,
}: {
  record: Workitem;
  loading: boolean;
  onDelete: (id: number) => void;
}) {
  const { t } = useTranslation('workitem');
  if (record.deletable === false) {
    return (
      <Tooltip title={workitemDeleteReason(record)}>
        <span>
          <Button
            type="text"
            size="small"
            className="aw-op-btn aw-op-btn--del"
            aria-label={t('actions.delete')}
            icon={<AwStrokeIcon name="trash" />}
            disabled
            onClick={(event) => event.stopPropagation()}
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <Popconfirm
      icon={<ExclamationCircleFilled aria-hidden="true" />}
      title={t('actions.delete')}
      description={t('list.deleteDescription')}
      okText={t('list.deleteConfirm')}
      okButtonProps={{ danger: true }}
      cancelText={t('list.cancel')}
      onConfirm={() => onDelete(record.id)}
    >
      <Button
        type="text"
        size="small"
        className="aw-op-btn aw-op-btn--del"
        aria-label={t('actions.delete')}
        icon={<AwStrokeIcon name="trash" />}
        loading={loading}
        onClick={(event) => event.stopPropagation()}
      />
    </Popconfirm>
  );
}

export function WorkitemListPage() {
  const { t } = useTranslation('workitem');
  const systemLabel = useSystemLabel();
  const scopeOptions: { value: Scope; label: string }[] = [
    { value: 'ALL', label: t('scope.all') },
    { value: 'PENDING', label: t('scope.pending') },
    { value: 'CREATED', label: t('scope.created') },
    { value: 'ASSIGNED', label: t('scope.assigned') },
    { value: 'WATCHED', label: t('scope.watched') },
    { value: 'COMMENTED', label: t('scope.commented') },
  ];
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const accessCommand = useAccessCommand();
  const kanbanTransition = useKanbanTransition();
  const [searchParams, setSearchParams] = useSearchParams();
  // 地址栏是筛选条件的唯一数据源：分享链接与页面结果始终一致
  const filters = useMemo(
    () => parseWorkitemListSearchParams(searchParams, readScopePreference()),
    [searchParams],
  );
  const { scope, workType, statusCategory, keyword, tag, advancedFilter } = filters;
  const filtersRef = useRef(filters);
  const [page, setPage] = useState(1);
  const [size, setSize] = usePageSizePreference('autowonder.workitems.pageSize', [10, 20, 50, 100, 200], 10);
  const [viewMode, setViewMode] = useState<ViewMode>(readWorkitemViewPreference);
  const [keywordInput, setKeywordInput] = useState(keyword ?? '');
  const [tagInput, setTagInput] = useState(tag ?? '');
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const { data: tagOptions, isError: tagOptionsError } = useWorkitemTagOptions();

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  // 筛选变更在 handler 内同步写回地址，避免依赖 Router transition 的提交时序
  const applyFilters = useCallback((patch: WorkitemListFilterPatch) => {
    const next = mergeWorkitemListFilters(filtersRef.current, patch);
    filtersRef.current = next;
    setSearchParams(toWorkitemListSearchParams(next), { replace: true });
    setPage(1);
    setColumnSizes({});
  }, [setSearchParams]);

  // 地址真正变化（前进/后退、手工改址或自身写回）时重置分页与列宽
  const appliedSearchRef = useRef(searchParams.toString());
  useEffect(() => {
    const current = searchParams.toString();
    if (current === appliedSearchRef.current) {
      return;
    }
    appliedSearchRef.current = current;
    setPage(1);
    setColumnSizes({});
  }, [searchParams]);

  // 只在 URL 中对应值变化时回填输入框，避免覆盖用户尚未提交的输入；
  // 标签按去空白后比较，保留用户输入框里的原始文本（提交时才 trim）。
  useEffect(() => {
    const next = keyword ?? '';
    setKeywordInput((prev) => (prev === next ? prev : next));
  }, [keyword]);
  useEffect(() => {
    const next = tag ?? '';
    setTagInput((prev) => (prev.trim() === next ? prev : next));
  }, [tag]);

  // 首屏把地址规范化为解析后的条件：补齐缺省 scope、丢弃非法值与未知参数，
  // 保证复制出的地址与当前结果一致且可确定还原。
  const normalizedSearchRef = useRef(false);
  useEffect(() => {
    if (normalizedSearchRef.current) {
      return;
    }
    normalizedSearchRef.current = true;
    const canonical = toWorkitemListSearchParams(filtersRef.current).toString();
    if (canonical === searchParams.toString()) {
      return;
    }
    setSearchParams(new URLSearchParams(canonical), { replace: true });
  }, [searchParams, setSearchParams]);

  const isKanban = viewMode === 'kanban';
  const createdQuery = useMemo(() => toCreatedTimeQuery(advancedFilter.created), [advancedFilter.created]);
  const creatorQuery = advancedFilter.creatorIds.length
    ? { creatorIds: advancedFilter.creatorIds.join(',') }
    : {};
  const squadQuery = advancedFilter.unassignedSquad
    ? { unassignedSquad: true }
    : advancedFilter.squadIds.length
      ? { squadIds: advancedFilter.squadIds.join(',') }
      : {};
  const tagConditionsQuery = useMemo(
    () => serializeTagConditions(advancedFilter.tagConditions),
    [advancedFilter.tagConditions],
  );
  // 高级筛选与其他筛选条件以 AND 组合，表格与看板共用同一份查询条件
  const baseQuery = {
    workType,
    ...scopeToQuery(scope),
    keyword,
    tag,
    ...(tagConditionsQuery ? { tagConditions: tagConditionsQuery } : {}),
    ...createdQuery,
    ...creatorQuery,
    ...squadQuery,
  };

  // 表格视图用全量分页查询；看板视图下只取 total 给页面标题用
  const { data, isLoading } = useWorkitemList(
    { ...baseQuery, statusCategory, page: isKanban ? 1 : page, size: isKanban ? 1 : size },
  );
  const items = data?.list ?? [];
  const total = data?.total ?? 0;

  // 看板每列各自带 statusCategory 去服务端查，列内容不再取决于全量列表的页码
  const visibleColumnKeys = statusCategory ? [statusCategory] : ALL_STATUS_KEYS;
  const kanbanColumns = useWorkitemKanbanColumns(
    baseQuery, visibleColumnKeys, columnSizes, KANBAN_COLUMN_PAGE_SIZE, isKanban,
  );
  const showDecisionSummary = isKanban && scope === 'ALL' && !!user && visibleColumnKeys.includes('PENDING_DECISION');
  const [myPendingColumn] = useWorkitemKanbanColumns(
    {
      workType,
      keyword,
      tag,
      ...(tagConditionsQuery ? { tagConditions: tagConditionsQuery } : {}),
      ...createdQuery,
      ...creatorQuery,
      ...squadQuery,
      pendingDecisionOnly: true,
    },
    showDecisionSummary ? ['PENDING_DECISION'] : [], {}, 1, showDecisionSummary,
  );
  const kanbanItems = useMemo(() => {
    const byId = new Map<number | string, Workitem>();
    kanbanColumns.forEach(col => col.items.forEach(item => byId.set(item.id, item)));
    return Array.from(byId.values());
  }, [kanbanColumns]);
  const columnTotals = Object.fromEntries(kanbanColumns.map(col => [col.key, col.total]));
  const columnHasMore = Object.fromEntries(kanbanColumns.map(col => [col.key, col.hasMore]));
  const kanbanLoading = kanbanColumns.some(col => col.isLoading);

  const deleteMutation = useDeleteWorkitem();
  const watchMutation = useToggleWatch();
  const queryClient = useQueryClient();
  const transitionMutation = useTransitionWorkitem();
  // 只有在打开某一行的候选列表时才按需加载该行的模板，同一模板的工单共用 react-query 缓存
  const [transitionTarget, setTransitionTarget] = useState<Workitem | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{ record: Workitem; node: StatusNode } | null>(null);
  const transitionTemplateId = transitionTarget?.templateId != null ? Number(transitionTarget.templateId) : null;
  const validTransitionTemplateId = transitionTemplateId != null && Number.isFinite(transitionTemplateId)
    ? transitionTemplateId
    : null;
  const { data: transitionTemplate, isLoading: transitionTemplateLoading } = useTemplateDetail(validTransitionTemplateId);
  const recommendedTransitionIds = useMemo(() => new Set(
    (transitionTemplate?.transitions ?? [])
      .filter((edge) => String(edge.fromNodeId) === String(transitionTarget?.statusNodeId))
      .map((edge) => String(edge.toNodeId)),
  ), [transitionTarget, transitionTemplate]);
  // 候选口径与详情页一致：当前模板内除当前节点外的全部节点，推荐流转置顶
  const transitionCandidates = useMemo(() => (transitionTemplate?.nodes ?? [])
    .filter((node) => String(node.id) !== String(transitionTarget?.statusNodeId))
    .sort((a, b) => Number(recommendedTransitionIds.has(String(b.id))) - Number(recommendedTransitionIds.has(String(a.id)))),
  [transitionTarget, transitionTemplate, recommendedTransitionIds]);

  const openTransition = (record: Workitem) => {
    if (transitionTarget?.id === record.id) {
      setTransitionTarget(null);
      return;
    }
    accessCommand('READ_WRITE', t('actions.transition'), () => setTransitionTarget(record));
  };

  const chooseTransitionTarget = (node: StatusNode) => {
    if (!transitionTarget) return;
    setPendingTransition({ record: transitionTarget, node });
    setTransitionTarget(null);
  };

  const renderTransitionCandidates = () => {
    if (transitionTemplateLoading) {
      return <Spin data-testid="workitem-transition-loading" />;
    }
    if (transitionCandidates.length === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('list.transitionNoCandidates')} />;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }} data-testid="workitem-transition-candidates">
        {transitionCandidates.map((node) => (
          <Button
            key={String(node.id)}
            block
            disabled={transitionMutation.isPending}
            data-testid={`workitem-transition-target-${node.id}`}
            onClick={() => chooseTransitionTarget(node)}
          >
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <span>{systemLabel(node.systemLabelKey, node.name)}</span>
              {recommendedTransitionIds.has(String(node.id))
                ? <Tag color="gold" style={{ margin: 0 }}>{t('list.transitionRecommended')}</Tag>
                : null}
            </Space>
          </Button>
        ))}
      </div>
    );
  };

  const confirmTransition = () => {
    if (!pendingTransition) return;
    const { record, node } = pendingTransition;
    accessCommand('READ_WRITE', t('actions.transition'), () => {
      transitionMutation.mutate(
        {
          id: record.id,
          toNodeId: Number(node.id),
          expected: { fromNodeId: record.statusNodeId!, expectedVersion: record.version },
        },
        {
          onSuccess: () => setPendingTransition(null),
          onError: (error) => {
            if ((error as ApiError).code === ErrorCodes.WORKITEM_VERSION_CONFLICT) {
              // 版本冲突不写入，列表与行数据刷新后由用户重新选择目标状态
              message.error(t('list.transitionVersionConflict'));
              void queryClient.invalidateQueries({ queryKey: ['workitems'] });
            } else {
              message.error((error as Error).message || t('transition.updateFailed'));
            }
            setPendingTransition(null);
          },
        },
      );
    });
  };

  const renderStatusTag = (statusName: string | null, record: Workitem) => {
    const label = statusName ? systemLabel(record.statusLabelKey, statusName) : MISSING;
    const configured = record.templateId != null && record.statusNodeId != null;
    const tag = (
      <StatusTag
        label={label}
        colorKey={STATUS_CATEGORY_TAG_COLOR[statusCategoryOf(record)] ?? 'gray'}
        dot
        data-testid={`workitem-status-${record.id}`}
        role={configured ? 'button' : undefined}
        tabIndex={configured ? 0 : undefined}
        aria-label={configured ? t('list.transitionStatusAria', { name: label }) : undefined}
        style={configured ? { cursor: 'pointer' } : undefined}
        onClick={configured ? (event) => {
          event.stopPropagation();
          openTransition(record);
        } : undefined}
        onKeyDown={configured ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openTransition(record);
          }
        } : undefined}
      />
    );
    if (!configured) {
      return <Tooltip title={t('list.transitionNoWorkflow')}>{tag}</Tooltip>;
    }
    return (
      <Popover
        trigger="click"
        open={transitionTarget?.id === record.id}
        onOpenChange={(next) => {
          if (!next) setTransitionTarget(null);
        }}
        placement="bottom"
        content={renderTransitionCandidates()}
      >
        {tag}
      </Popover>
    );
  };

  const columns: ColumnsType<Workitem> = withNowrapHeader([
    {
      title: 'ID', dataIndex: 'id', className: 'aw-column-numeric', width: 80,
      render: (id: number) => <span style={{ fontFamily: 'var(--aw-font-mono)', fontSize: 11, color: 'var(--aw-text-3)' }}>{id}</span>,
    },
    {
      title: t('fields.title'), dataIndex: 'title', className: 'aw-column-title',
      render: (text: string, record: Workitem) => (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
          <EllipsisText lines={2} tooltip={text} placement="topLeft" style={{ flex: '1 1 auto', wordBreak: 'break-all' }}>
            <a onClick={() => navigate(`/workitems/${record.id}`)}>{text}</a>
          </EllipsisText>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: 18, flex: '0 0 auto' }}>
            <ScheduledExecutionBadge
              scheduledStartAt={record.scheduledStartAt}
              scheduledStartTriggeredAt={record.scheduledStartTriggeredAt}
              origin={record.origin}
              gmtCreate={record.gmtCreate}
            />
          </span>
        </div>
      ),
    },
    {
      title: t('fields.type'), dataIndex: 'workType', width: 80,
      render: (type: string) => {
        const meta = workTypeMap[type];
        return <StatusTag label={meta?.label ?? type} colorKey={(meta?.color ?? 'gray') as StatusColorKey} />;
      },
    },
    {
      title: t('fields.status'), dataIndex: 'statusName', width: 150,
      render: (s: string | null, record: Workitem) => (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          {renderStatusTag(s, record)}
          <HumanInterventionBadge item={record} />
          <WorkitemHealthBadge item={record} />
        </div>
      ),
    },
    {
      title: t('fields.priority'), dataIndex: 'priority', width: 96,
      render: (p: number) => {
        const meta = getPriorityMeta(p);
        const colorKey = PRIORITY_TAG_COLOR[meta.color] ?? 'gray';
        return <StatusTag label={meta.label} colorKey={colorKey} />;
      },
    },
    {
      title: t('fields.tags'), dataIndex: 'tags', width: 160,
      render: (_: unknown, record: Workitem) => <WorkitemTagsCell workitem={record} maxVisible={3} />,
    },
    {
      title: t('fields.assignee'), dataIndex: 'assigneeName', width: 120,
      render: (_: string | null, record: Workitem) => {
        const text = displayNameWithoutId(record.assigneeDisplayName, record.assigneeName);
        if (!text) return <EllipsisText>{t('assignee.unassigned')}</EllipsisText>;
        if (record.assigneeType === 'AGENT') return (
          <Tooltip title={text} trigger={['hover', 'focus']}>
            <span tabIndex={0} style={{ display: 'block', minWidth: 0 }}><AiIdentity name={text} aiBadge /></span>
          </Tooltip>
        );
        return <EllipsisText tooltip={text}>{text}</EllipsisText>;
      },
    },
    {
      title: t('fields.creator'), dataIndex: 'creatorDisplayName', width: 120,
      render: (_: string | null, record: Workitem) => {
        const text = creatorCellText(record);
        const hasCreator = record.sourceType === 'EXTERNAL'
          ? record.sourceCreator?.displayName || record.sourceCreator?.subjectId
          : record.creatorDisplayName || record.creatorName;
        return <EllipsisText tooltip={hasCreator ? text : undefined}>{text}</EllipsisText>;
      },
    },
    {
      title: t('fields.created'), dataIndex: 'gmtCreate', className: 'aw-column-numeric', width: 108,
      render: (value: string) => <TimeCell value={value} />,
    },
    ...(scope === 'COMMENTED'
      ? [{
        title: t('fields.myLastCommentAt'), dataIndex: 'myLastCommentAt', className: 'aw-column-numeric', width: 132,
        render: (value: string | null | undefined) => <TimeCell value={value} />,
      } as ColumnsType<Workitem>[number]]
      : []),
    {
      title: t('fields.actions'),
      dataIndex: 'operation',
      width: 112,
      render: (_: unknown, record: Workitem) => (
        <Space size={4}>
          <WatchWorkitemButton
            record={record}
            loading={watchMutation.isPending}
            onToggle={(target) => watchMutation.mutate({ id: target.id, watched: !!target.watched })}
          />
          <DeleteWorkitemButton
            record={record}
            loading={deleteMutation.isPending}
            onDelete={(workitemId) => accessCommand(
              'READ_WRITE',
              t('actions.delete'),
              () => deleteMutation.mutate({ id: workitemId }),
            )}
          />
        </Space>
      ),
    },
  ]);

  const handleScopeChange = (value: string | number) => {
    const next = value as Scope;
    writeScopePreference(next);
    applyFilters({ scope: next });
  };

  const handlePageChange = (nextPage: number, nextSize: number) => {
    setPage(nextPage);
    setSize(nextSize);
  };

  // 类型、状态与其它高级条件在同一弹窗内应用：一次写回全部条件，
  // 应用创建者条件后顶部范围的「我的」类筛选不再有意义，统一回到「全部」。
  const handleAdvancedFilterApply = (next: WorkitemAdvancedFilterDraft) => {
    const { workType: nextWorkType, statusCategory: nextStatusCategory, ...advancedFilterPatch } = next;
    const patch: WorkitemListFilterPatch = {
      advancedFilter: advancedFilterPatch,
      workType: nextWorkType,
      statusCategory: nextStatusCategory,
    };
    if (advancedFilterPatch.creatorIds.length > 0 && scope !== 'ALL') {
      writeScopePreference('ALL');
      applyFilters({ ...patch, scope: 'ALL' });
      return;
    }
    applyFilters(patch);
  };

  const hasActiveFilters = !!workType || !!statusCategory || !!keyword || !!tag
    || !!tagConditionsQuery || Object.keys(createdQuery).length > 0
    || advancedFilter.creatorIds.length > 0 || advancedFilter.squadIds.length > 0
    || advancedFilter.unassignedSquad;

  const handleClearFilters = () => {
    setKeywordInput('');
    setTagInput('');
    applyFilters({
      workType: undefined,
      statusCategory: undefined,
      keyword: undefined,
      tag: undefined,
      advancedFilter: EMPTY_ADVANCED_FILTER,
    });
  };

  const tableEmpty = (
    <EmptyState
      icon={hasActiveFilters ? <AwStrokeIcon name="filter" size={32} /> : <AwStrokeIcon name="file" size={32} />}
      title={hasActiveFilters ? t('list.emptyFilteredTitle') : t('list.emptyTitle')}
      subtext={hasActiveFilters ? t('list.emptyFilteredSubtext') : t('list.emptySubtext')}
      action={hasActiveFilters ? (
        <Button icon={<AwStrokeIcon name="refresh" />} onClick={handleClearFilters}>
          {t('list.emptyFilteredAction')}
        </Button>
      ) : (
        <Button type="primary" icon={<AwStrokeIcon name="plus" />}
          onClick={() => accessCommand('READ_WRITE', t('actions.new'), () => setCreateOpen(true))}>
          {t('list.emptyAction')}
        </Button>
      )}
    />
  );

  return (
    // 页面纵向填满 aw-content-frame：看板精确占据剩余高度，外层 frame 不再出现纵向滚动条（验收返修 14）
    <section className="aw-workitems-page">
      <PageHead
        title={t('list.title')}
        description={<Trans t={t} i18nKey="list.total" count={total} components={{ total: <span className="aw-heading-number">{total}</span> }} />}
        actions={
          <Space>
            <Segmented
              value={viewMode}
              onChange={(v) => {
                const next = v as ViewMode;
                setViewMode(next);
                writeWorkitemViewPreference(next);
                setPage(1);
              }}
              options={[
                { value: 'kanban', icon: <span role="img" aria-label={t('list.kanbanView')}><AwStrokeIcon name="kanban" /></span> },
                { value: 'table', icon: <span role="img" aria-label={t('list.tableView')}><AwStrokeIcon name="table" /></span> },
              ]}
            />
            <Button type="primary" icon={<AwStrokeIcon name="plus" />}
              onClick={() => accessCommand('READ_WRITE', t('actions.new'), () => setCreateOpen(true))}>
              {t('actions.new')}
            </Button>
          </Space>
        }
      />

      {/* 工具行（验收返修 2/3）：快速范围 Segmented 左对齐；搜索与筛选控件右对齐，搜索框在筛选下拉之前 */}
      <Toolbar
        left={
          <Segmented
            value={scope}
            onChange={handleScopeChange}
            options={scopeOptions}
            aria-label={t('scope.label')}
            style={{ maxWidth: '100%', overflowX: 'auto', flexShrink: 0 }}
          />
        }
        right={<>
          <Input
            value={keywordInput}
            aria-label={t('list.searchWithExternalId')}
            allowClear={{ clearIcon: <CloseCircleFilled aria-label={t('list.clearSearch')} /> }}
            prefix={<AwStrokeIcon name="search" />}
            placeholder={t('list.searchWithExternalId')}
            onChange={(event) => {
              const next = event.target.value;
              setKeywordInput(next);
              // 清空输入框即撤销关键词条件，与回车提交保持同一语义
              if (!next) {
                applyFilters({ keyword: undefined });
              }
            }}
            onPressEnter={(event) => {
              const next = (event.target as HTMLInputElement).value;
              setKeywordInput(next);
              applyFilters({ keyword: next || undefined });
            }}
            style={{ width: 240, maxWidth: '100%', flex: '0 1 240px', minWidth: 160 }}
          />
          <AutoComplete
            className="aw-tag-filter"
            value={tagInput}
            options={(tagOptions ?? []).map((value) => ({ value }))}
            onChange={(value) => {
              setTagInput(value);
              if (!value) {
                applyFilters({ tag: undefined });
              }
            }}
            onSelect={(value) => {
              setTagInput(value);
              applyFilters({ tag: value });
            }}
            style={{ width: 160, maxWidth: '100%', flex: '0 1 160px', minWidth: 120 }}
          >
            <Input
              aria-label={t('list.tagFilter')}
              allowClear={{ clearIcon: <CloseCircleFilled aria-label={t('list.clearTag')} /> }}
              prefix={<AwStrokeIcon name="tag" />}
              placeholder={t('list.tagFilter')}
              onPressEnter={(event) => {
                const value = (event.target as HTMLInputElement).value;
                setTagInput(value ?? '');
                applyFilters({ tag: value?.trim() || undefined });
              }}
            />
          </AutoComplete>
          {tagOptionsError ? (
            <Typography.Text type="warning" data-testid="workitem-tag-options-error">
              {t('tags.loadFailed')}
            </Typography.Text>
          ) : null}
          <WorkitemAdvancedFilter
            applied={advancedFilter}
            workType={workType}
            statusCategory={statusCategory}
            onApply={handleAdvancedFilterApply}
          />
        </>}
      />

      {kanbanTransition.dialog}
      <NewWorkitemModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <Modal
        open={!!pendingTransition}
        title={t('list.transitionConfirmTitle')}
        okText={t('list.transitionConfirmOk')}
        cancelText={t('list.cancel')}
        confirmLoading={transitionMutation.isPending}
        onOk={confirmTransition}
        onCancel={() => {
          if (!transitionMutation.isPending) setPendingTransition(null);
        }}
        closeIcon={<AwStrokeIcon name="x" />}
        maskClosable={!transitionMutation.isPending}
        keyboard={!transitionMutation.isPending}
      >
        <Typography.Paragraph data-testid="workitem-transition-confirm">
          {t('list.transitionConfirmText', {
            from: pendingTransition?.record.statusName
              ? systemLabel(pendingTransition.record.statusLabelKey, pendingTransition.record.statusName)
              : '-',
            to: pendingTransition?.node
              ? systemLabel(pendingTransition.node.systemLabelKey, pendingTransition.node.name)
              : '',
          })}
        </Typography.Paragraph>
      </Modal>
      {viewMode === 'kanban' ? (
        <WorkitemKanban
          onMove={kanbanTransition.move}
          transitionBusy={kanbanTransition.busy}
          onToggleWatch={(item) => accessCommand(
            'READ_WRITE',
            item.watched ? t('actions.unwatch') : t('actions.watch'),
            () => watchMutation.mutate({ id: item.id, watched: !!item.watched }),
          )}
          watchBusyId={watchMutation.isPending && watchMutation.variables ? watchMutation.variables.id : null}
          items={kanbanItems}
          loading={kanbanLoading}
          pendingDecisionSummary={showDecisionSummary && user && myPendingColumn && !myPendingColumn.isLoading ? {
            name: displayNameWithoutId(user.nickname, user.username) ?? user.username,
            count: myPendingColumn.total,
          } : undefined}
          columnKeys={visibleColumnKeys}
          columnTotals={columnTotals}
          columnHasMore={columnHasMore}
          onLoadMore={(key) => setColumnSizes(prev => ({
            ...prev,
            [key]: (prev[key] ?? KANBAN_COLUMN_PAGE_SIZE) + KANBAN_COLUMN_PAGE_SIZE,
          }))}
        />
      ) : (
        <TableCard
          flush
          className="aw-workitems"
          footer={<TableFooter
            total={total}
            page={page}
            pageSize={size}
            onPageChange={handlePageChange}
            onPageSizeChange={setSize}
          />}
        >
          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={isLoading}
            tableLayout="fixed"
            scroll={{ x: 1200 }}
            locale={{ emptyText: tableEmpty }}
            pagination={false}
          />
        </TableCard>
      )}
    </section>
  );
}
