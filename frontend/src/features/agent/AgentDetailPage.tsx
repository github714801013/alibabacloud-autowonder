import { useTranslation } from 'react-i18next';
import { i18n } from '@/shared/i18n';
import { formatDateTime } from '@/shared/i18n/format';
import { getAgentRoleLabel, getEvolutionModeLabel, getAgentStatusLabel } from './constants';
import { PageBackButton } from '@/shared/ui/PageBackButton';
import { Alert, Tag, Button, Space, Popconfirm, message, Spin, Result, Tabs, Typography } from 'antd';
import { Table } from '@/shared/theme/ThemedTable';
import { StatusTag, type StatusColorKey } from '@/shared/ui/StatusTag';
import { AiIdentity } from '@/shared/ui/AiIdentity';
import { TableCard, TableFooter } from '@/shared/ui/TableCard';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { PoweroffOutlined } from '@ant-design/icons';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAgent, useAgentVersions, useAgentVersion, useRollback, useOfflineAgent, useOnlineAgent, useDeleteAgent, useAgentWorkitems, useAgentMemories } from './hooks';
import { getVersion, type AgentVersionSummary, type RepoPermItem, type SkillItem, type AgentEnvironmentVariableRef } from './api';
import { getSdlcTemplate } from '@/features/sdlc/api';
import type { ColumnsType } from 'antd/es/table';
import { AgentStatCards } from './components/AgentStatCards';
import { AgentWorkitemList } from './components/AgentWorkitemList';
import { AgentVersionDiff } from './components/AgentVersionDiff';
import { AgentTagList } from './components/AgentTagList';
import { MarkdownView } from '@/shared/ui/MarkdownView';
import { EllipsisText } from '@/shared/ui/EllipsisText';
import { useAccessCommand } from '@/shared/auth/useAccessCommand';

import { usePageSizePreference } from '@/shared/lib/usePageSizePreference';
import './AgentForm.css';
import './AgentDetailPage.css';

const { Text } = Typography;
const EMPTY_CELL = '-';

const versionStatusColorKeys: Record<string, StatusColorKey> = {
  DRAFT: 'gray', PENDING_REVIEW: 'amber', APPROVED: 'green',
  REJECTED: 'red', ONLINE: 'green', ROLLED_BACK: 'gray',
};
const agentStatusColorKeys: Record<string, StatusColorKey> = {
  DRAFT: 'gray', ONLINE: 'green', OFFLINE: 'gray', PENDING_REVIEW: 'amber',
};
const permLevelColorKeys: Record<string, StatusColorKey> = {
  READ: 'gray', WRITE: 'blue', ADMIN: 'violet',
};

/** 优先显示模板名称（当前生效值可复用已查到的 name）；未知/未加载时退回 #id。 */
function sdlcLabel(sdlcId?: number | null, name?: string) {
  if (sdlcId == null) return i18n.t('display.notBound', { ns: 'agent' });
  return name || `#${sdlcId}`;
}

function AgentIdentitySection({ title, content }: { title: string; content?: string | null }) {
  const { t } = useTranslation('agent');
  const value = content?.trim();
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div className="aw-agent-sub-title">{title}</div>
      {value ? <MarkdownView content={value} /> : <Text type="secondary">{t('display.notConfigured')}</Text>}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <Text type="secondary">{text}</Text>;
}

/** 原型 13 id-item：标签 11px text-3 在上，值 12px 在下。 */
function NamedAttribute({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="aw-desc-item">
      <div className="aw-dk">{label}</div>
      <div className="aw-dv">{children}</div>
    </div>
  );
}

/** 仅绑定了 SDLC 时才发起单查，解析不出名称时退回 #id。 */
function useSdlcName(sdlcId?: number | null) {
  const { data } = useQuery({
    queryKey: ['sdlc', sdlcId],
    queryFn: () => getSdlcTemplate(sdlcId as number),
    enabled: sdlcId != null,
    staleTime: 5 * 60 * 1000,
  });
  return data?.name;
}

export function AgentDetailPage() {
  const { t } = useTranslation('agent');
  const permissionLabels = new Map<string, string>([['READ', t('permissions.READ')], ['WRITE', t('permissions.WRITE')], ['ADMIN', t('permissions.ADMIN')]]);

  const repoPermColumns: ColumnsType<RepoPermItem> = [
    { title: t('fields.repository'), dataIndex: 'repoName', render: (v: string, r) => v || `#${r.repoId}` },
    { title: t('fields.permission'), dataIndex: 'permLevel', width: 100, render: (v: string) => <StatusTag label={permissionLabels.get(v) || v} colorKey={permLevelColorKeys[v] ?? 'gray'} /> },
    {
      title: t('fields.commitBranches'), dataIndex: 'allowedBranchPatterns',
      render: (patterns?: string[]) => !patterns || patterns.length === 0
        ? <Text type="secondary">{t('repository.unrestricted')}</Text>
        : (
          <span className="aw-agent-branches">
            {patterns.map(pattern => <StatusTag key={pattern} size="sm" label={pattern} colorKey="gray" className="aw-agent-mono" />)}
          </span>
        ),
    },
  ];

  const skillColumns: ColumnsType<SkillItem> = [
    { title: t('fields.capability'), dataIndex: 'skillName', render: (v: string, r) => v || `#${r.skillId}` },
  ];

  const environmentVariableColumns: ColumnsType<AgentEnvironmentVariableRef> = [
    { title: t('fields.variableName'), dataIndex: 'name', width: '36%' },
    {
      title: t('fields.description'), dataIndex: 'description',
      render: (description: string | null) => description || <Text type="secondary">{t('environment.noDescription')}</Text>,
    },
  ];

  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accessCommand = useAccessCommand();
  const agentId = Number(id);
  const { data: agent, isLoading, isError, error } = useAgent(agentId);
  const {
    data: versions = [],
    isLoading: versionsLoading,
    isError: versionsError,
  } = useAgentVersions(agentId);
  const { data: workitems = [] } = useAgentWorkitems(agentId);
  const { data: memories = [] } = useAgentMemories(agentId);
  const sdlcName = useSdlcName(agent?.sdlcId);
  const [versionPageNo, setVersionPageNo] = useState(1);
  const [versionPageSize, setVersionPageSize] = usePageSizePreference(
    'autowonder.agentDetail.versions.pageSize', [10, 20, 50], 10);
  // 当前生效版本的完整绑定（仓库/能力/环境变量）：编辑页同一数据源，详情页只读展示。
  const { data: onlineVersion, isLoading: versionDetailLoading } = useAgentVersion(
    agentId, agent?.latestVersionNo ?? 0,
  );
  const rollback = useRollback();
  const offline = useOfflineAgent();
  const online = useOnlineAgent();
  const remove = useDeleteAgent();
  const [actionFeedback, setActionFeedback] = useState<number | null>(null);
  const [rollbackConfirmVersion, setRollbackConfirmVersion] = useState<number | null>(null);
  const [offlineConfirmOpen, setOfflineConfirmOpen] = useState(false);
  const [onlineConfirmOpen, setOnlineConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [draftDiffOpen, setDraftDiffOpen] = useState(false);

  const draftVersionNo = agent?.hasDraft ? (agent.draftVersionNo ?? null) : null;
  // Fetched only when the comparison is opened, so the detail page stays on two requests otherwise.
  const { data: draftVersion } = useQuery({
    queryKey: ['agent', agentId, 'version', draftVersionNo ?? 0],
    queryFn: () => getVersion(agentId, draftVersionNo as number),
    enabled: draftDiffOpen && draftVersionNo != null && draftVersionNo > 0,
  });
  const onlineVersionNo = agent?.onlineVersionId == null
    ? null
    : versions.find((version) => version.id === agent.onlineVersionId)?.versionNo ?? null;
  // Baseline snapshot is only loaded while the comparison is expanded (versionNo 0 disables the query).
  const {
    data: draftBaseVersion,
    isLoading: draftBaseLoading,
    isError: draftBaseError,
  } = useAgentVersion(agentId, draftDiffOpen && onlineVersionNo != null ? onlineVersionNo : 0);
  // While the version list is still loading we cannot know whether the baseline exists, so the
  // degraded notice must wait; a failed list also means the baseline cannot be resolved.
  const draftBaselineUnavailable = agent?.onlineVersionId != null
    && !versionsLoading
    && (versionsError || onlineVersionNo == null || draftBaseError);
  if (!agentId || isNaN(agentId)) return (
    <Result status="404" title={t('errors.invalidId')} extra={<Button onClick={() => navigate(-1)}>{t('actions.back')}</Button>} />
  );
  if (isLoading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  // 后台刷新失败时保留已加载数据，只有从未加载成功才整页报错（502 不抹数据）。
  if (isError && !agent) return (
    <Result status="error" title={t('errors.load')} subTitle={(error as Error)?.message || t('display.retryLater')}
      extra={<Button onClick={() => navigate(-1)}>{t('actions.back')}</Button>} />
  );
  if (!agent) return null;

  const handleRollback = (versionNo: number) => {
    accessCommand('READ_WRITE', t('display.rollbackAction'), () => {
      rollback.mutate({ agentId, versionNo }, {
        onError: (error) => message.error(error instanceof Error && error.message || i18n.t('display.rollbackError', { ns: 'agent' })),
        onSuccess: () => {
          message.success(i18n.t('display.rolledBack', { ns: 'agent' }));
          setActionFeedback(versionNo);
        },
      });
    });
  };
  const handleOffline = () => {
    accessCommand('READ_WRITE', t('display.offlineAction'), () => {
      offline.mutate(agentId, { onError: (error) => message.error(error instanceof Error && error.message || i18n.t('display.offlineError', { ns: 'agent' })), onSuccess: () => message.success(i18n.t('display.offlineSuccess', { ns: 'agent' })) });
    });
  };
  const handleOnline = () => {
    accessCommand('READ_WRITE', t('display.onlineAction'), () => {
      online.mutate(agentId, { onError: (error) => message.error(error instanceof Error && error.message || i18n.t('display.onlineError', { ns: 'agent' })), onSuccess: () => message.success(i18n.t('display.onlineSuccess', { ns: 'agent' })) });
    });
  };
  const handleDelete = () => {
    accessCommand('READ_WRITE', t('display.deleteAction'), () => {
      remove.mutate(agentId, {
        onError: (error) => message.error(error instanceof Error && error.message || i18n.t('display.deleteError', { ns: 'agent' })),
        onSuccess: () => {
          message.success(i18n.t('display.deleted', { ns: 'agent' }));
          navigate('/agents');
        },
      });
    });
  };
  const handleConfirmOpen = (
    open: boolean,
    action: string,
    setOpen: (next: boolean) => void,
  ) => {
    if (!open) {
      setOpen(false);
      return;
    }
    accessCommand('READ_WRITE', action, () => setOpen(true));
  };

  const versionColumns: ColumnsType<AgentVersionSummary> = [
    { title: t('display.versionNo'), dataIndex: 'versionNo', width: 80, render: (v: number) => `v${v}` },
    {
      title: t('fields.roleName'), dataIndex: 'roleName', ellipsis: { showTitle: false },
      render: (_: string, row) => {
        const label = getAgentRoleLabel(row.roleCode, row.roleName) || '—';
        return <EllipsisText tooltip={label}>{label}</EllipsisText>;
      },
    },
    { title: t('display.statusTitle'), dataIndex: 'status', width: 100, render: (s: string) => <StatusTag dot label={getAgentStatusLabel(s)} colorKey={versionStatusColorKeys[s] ?? 'gray'} /> },
    { title: t('display.createdAt'), dataIndex: 'gmtCreate', width: 160, render: (t: string) => formatDateTime(t) },
    {
      title: t('display.submitNoteColumn'), dataIndex: 'submitNote', ellipsis: { showTitle: false },
      render: (note?: string | null) => (note
        ? <EllipsisText tooltip={note}>{note}</EllipsisText>
        : <Text type="secondary">{EMPTY_CELL}</Text>),
    },
    {
      title: t('fields.actions'), width: 100,
      render: (_: unknown, record: AgentVersionSummary) =>
        record.status === 'ONLINE' || record.status === 'APPROVED' ? (
          <Popconfirm
            title={t('display.confirmRollback')}
            okText={t('display.rollbackButton')}
            cancelText={t('actions.cancel')}
            open={rollbackConfirmVersion === record.versionNo}
            onOpenChange={(open) => handleConfirmOpen(
              open,
              t('display.rollbackAction'),
              (next) => setRollbackConfirmVersion(next ? record.versionNo : null),
            )}
            onConfirm={() => {
              setRollbackConfirmVersion(null);
              handleRollback(record.versionNo);
            }}
          >
            <Button type="link" size="small" icon={<AwStrokeIcon name="back" />}>{t('display.rollback')}</Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const statusInfo = { colorKey: agentStatusColorKeys[agent.status] ?? 'gray', label: getAgentStatusLabel(agent.status) };
  const isPlatform = agent.kind === 'PLATFORM';

  const sdlcNameOf = (sdlcId: number) => (sdlcId === agent.sdlcId ? sdlcName : undefined);

  return (
    <div>
      {/* 原型 13 agent-head：返回 + AI 头像 + 名称/tags + 版本 sub，操作按钮右置 */}
      <div style={{ marginBottom: 16 }}>
        <div className="aw-detail-title" style={{ gap: 10 }}>
          <PageBackButton to="/agents" label={t('actions.backList')} />
          <Typography.Title level={5} className="aw-agent-head-name" style={{ margin: 0, fontSize: 16, lineHeight: '24px', minWidth: 0, overflowWrap: 'anywhere' }}>
            <AiIdentity name={agent.name} avatar icon />
          </Typography.Title>
          <StatusTag dot label={statusInfo.label} colorKey={statusInfo.colorKey} />
          {!isPlatform && <StatusTag label={t('display.standard')} colorKey="outline" />}
          {isPlatform && <StatusTag label={t('display.platform')} colorKey="violet" />}
          <Space style={{ marginLeft: 'auto' }}>
            {agent.status === 'ONLINE' && !isPlatform && (
              <Popconfirm
                title={t('display.confirmOffline')}
                okText={t('display.offline')}
                cancelText={t('actions.cancel')}
                open={offlineConfirmOpen}
                onOpenChange={(open) => handleConfirmOpen(open, t('display.offlineAction'), setOfflineConfirmOpen)}
                onConfirm={() => {
                  setOfflineConfirmOpen(false);
                  handleOffline();
                }}
              >
                <Button icon={<PoweroffOutlined aria-hidden />}>{t('display.offline')}</Button>
              </Popconfirm>
            )}
            {agent.status === 'OFFLINE' && (
              <Popconfirm
                title={t('display.confirmOnline')}
                okText={t('display.onlineButton')}
                cancelText={t('actions.cancel')}
                open={onlineConfirmOpen}
                onOpenChange={(open) => handleConfirmOpen(open, t('display.onlineAction'), setOnlineConfirmOpen)}
                onConfirm={() => {
                  setOnlineConfirmOpen(false);
                  handleOnline();
                }}
              >
                <Button icon={<AwStrokeIcon name="play" />}>{t('display.online')}</Button>
              </Popconfirm>
            )}
            {agent.status !== 'ONLINE' && !isPlatform && (
              <Popconfirm
                title={t('display.confirmDelete')}
                okText={t('display.deleteButton')}
                cancelText={t('actions.cancel')}
                open={deleteConfirmOpen}
                onOpenChange={(open) => handleConfirmOpen(open, t('display.deleteAction'), setDeleteConfirmOpen)}
                onConfirm={() => {
                  setDeleteConfirmOpen(false);
                  handleDelete();
                }}
              >
                <Button danger icon={<AwStrokeIcon name="trash" />}>{t('display.delete')}</Button>
              </Popconfirm>
            )}
            <Button type="primary" icon={<AwStrokeIcon name="edit" />}
              onClick={() => accessCommand('READ_WRITE', t('display.editAction'), () => navigate(`/agents/${agentId}/edit`))}>
              {t('display.editConfig')}
            </Button>
          </Space>
        </div>
        <div style={{ fontSize: 12, color: 'var(--aw-text-3)', marginTop: 4 }}>
          {t('display.versionDescription', { version: agent.latestVersionNo ? `v${agent.latestVersionNo}` : '-', date: formatDateTime(agent.gmtCreate) })}
        </div>
      </div>


      {actionFeedback != null && (
        <Alert
          showIcon
          type="success"
          message={t('display.rolledBackVersion', { version: actionFeedback })}
          description={t('display.rollbackHint')}
          style={{ marginBottom: 16 }}
        />
      )}

      {isPlatform && (
        <Alert
          showIcon
          type="info"
          message={t('display.platformAgent')}
          description={t('display.platformHint')}
          style={{ marginBottom: 16 }}
        />
      )}

      {agent.status === 'DRAFT' && (
        <Alert
          showIcon
          type="info"
          message={t('display.draftAgent')}
          description={t('display.draftAgentHint')}
          style={{ marginBottom: 16 }}
        />
      )}

      {draftVersionNo != null && agent.status !== 'DRAFT' && (
        <Alert
          showIcon
          type="warning"
          message={t('display.unpublishedDraft', { version: draftVersionNo })}
          description={t('display.unpublishedHint')}
          style={{ marginBottom: 16 }}
          action={
            <Space direction="vertical" size={4}>
              <Button size="small" onClick={() => setDraftDiffOpen((open) => !open)}>
                {draftDiffOpen ? t('display.hideDiff') : t('display.showDiff')}
              </Button>
              <Button size="small" type="link"
                onClick={() => accessCommand('READ_WRITE', t('display.editAction'), () => navigate(`/agents/${agentId}/edit`))}>
                {t('display.editDraft')}
              </Button>
            </Space>
          }
        />
      )}

      {draftDiffOpen && draftVersionNo != null && (
        <div className="aw-agent-sec aw-agent-detail-diff" data-sec="diff">
          <div className="aw-agent-sec-title">{t('display.diffTitle', { version: draftVersionNo })}</div>
          {!draftVersion || draftBaseLoading ? (
            <Spin style={{ display: 'block', margin: '24px auto' }} />
          ) : (
            <AgentVersionDiff
              base={draftBaseVersion ?? null}
              target={draftVersion}
              variant="inline"
              baselineUnavailable={draftBaselineUnavailable}
              sdlcNameOf={sdlcNameOf}
            />
          )}
        </div>
      )}

      <AgentStatCards workitems={workitems} memoryCount={memories.length} />

      <div className="aw-agent-sec" data-sec="identity">
        <div className="aw-agent-sec-title">{t('display.identity')}</div>
        <div className="aw-id-grid" data-testid="agent-attributes">
          <NamedAttribute label={t('fields.roleName')}>
            {getAgentRoleLabel(agent.roleCode, agent.roleName) || <Text type="secondary">{t('display.notConfigured')}</Text>}
          </NamedAttribute>
          <NamedAttribute label={t('fields.roleCode')}>
            {agent.roleCode ? <span style={{ fontFamily: 'var(--aw-mono)' }}>{agent.roleCode}</span> : <Text type="secondary">{t('display.notConfigured')}</Text>}
          </NamedAttribute>
          <NamedAttribute label={t('fields.evolution')}>
            {getEvolutionModeLabel(agent.evolutionMode)}
          </NamedAttribute>
          <NamedAttribute label={t('fields.sdlc')}>
            {agent.sdlcId == null ? (
              <Text type="secondary">{t('display.notBound')}</Text>
            ) : (
              <Link to={`/sdlcs/${agent.sdlcId}`}>{sdlcLabel(agent.sdlcId, sdlcName)}</Link>
            )}
          </NamedAttribute>
          <NamedAttribute label={t('display.executor')}>
            {agent.executorTotalCount == null ? (
              <Text type="secondary">{t('display.executorUnknown')}</Text>
            ) : agent.executorTotalCount === 0 ? (
              <Text type="secondary">{t('display.executorNone')}</Text>
            ) : (
              <Link to={`/executors?agentId=${agentId}&view=agent`}>
                {t('display.onlineRatio', { online: agent.executorOnlineCount ?? 0, total: agent.executorTotalCount })}
              </Link>
            )}
          </NamedAttribute>
        </div>
        {/* Tags are maintained inline in the list; the detail page only mirrors the current value. */}
        <div className="aw-agent-tags-row" data-testid="agent-detail-tags-row">
          <div className="aw-dk">{t('tags.title')}</div>
          <div className="aw-dv">
            <AgentTagList
              systemTags={agent.systemTags}
              customTags={agent.customTags}
              emptyText={t('tags.emptyDetail')}
              testId="agent-detail-tags"
            />
          </div>
        </div>
        {!!agent.squadNames?.length && (
          <Space size={6} wrap style={{ display: 'flex', marginTop: 10 }}>
            {agent.squadNames.map((name, i) => <StatusTag key={name + i} size="sm" label={name} colorKey="gray" />)}
          </Space>
        )}
        {agent.officialConfiguration && (
          <Space wrap style={{ display: 'flex', marginTop: 10 }}>
            <Typography.Text>{t('display.officialCapabilities')}</Typography.Text>
            {agent.officialConfiguration.capabilities.map(capability => (
              <Tag key={capability.id}>{capability.name}</Tag>
            ))}
          </Space>
        )}
        <AgentIdentitySection title={t('diff.group.soul')} content={agent.officialConfiguration?.businessBackground ?? agent.businessBackground} />
        <AgentIdentitySection title={t('diff.group.agentMd')} content={agent.officialConfiguration?.responsibilities ?? agent.responsibilities} />
      </div>

      <Tabs
        className="aw-agent-detail-tabs"
        items={[
          {
            key: 'workitems',
            label: t('display.workitems'),
            children: <AgentWorkitemList agentId={agentId} />,
          },
          {
            key: 'config',
            label: t('display.configTab'),
            children: (
              <>
                <div className="aw-agent-sec" data-sec="repo">
                  <div className="aw-agent-sec-title">
                    {t('repository.title')}
                    {!isPlatform && onlineVersion && <span className="aw-agent-sec-count">{onlineVersion.repoPerms?.length ?? 0}</span>}
                  </div>
                  {isPlatform ? (
                    <div className="aw-agent-sec-desc"><b>{t('repository.platformTitle')}</b>{t('repository.platformHint')}</div>
                  ) : (
                    <Table rowKey="repoId" size="small" columns={repoPermColumns}
                      dataSource={onlineVersion?.repoPerms ?? []} pagination={false}
                      loading={versionDetailLoading}
                      locale={{ emptyText: <EmptyHint text={t('display.emptyRepos')} /> }} />
                  )}
                </div>
                <div className="aw-agent-sec" data-sec="capability">
                  <div className="aw-agent-sec-title">
                    {t('capability.title')}
                    {onlineVersion && <span className="aw-agent-sec-count">{onlineVersion.skills?.length ?? 0}</span>}
                  </div>
                  <Table rowKey="skillId" size="small" columns={skillColumns}
                    dataSource={onlineVersion?.skills ?? []} pagination={false}
                    loading={versionDetailLoading}
                    locale={{ emptyText: <EmptyHint text={t('display.emptySkills')} /> }} />
                </div>
                <div className="aw-agent-sec" data-sec="env">
                  <div className="aw-agent-sec-title">
                    {t('environment.title')}
                    <span className="aw-agent-sec-count">{agent.environmentVariables?.length ?? 0}</span>
                  </div>
                  <Table rowKey="id" size="small" columns={environmentVariableColumns}
                    dataSource={agent.environmentVariables ?? []} pagination={false}
                    locale={{ emptyText: <EmptyHint text={t('environment.empty')} /> }} />
                </div>
              </>
            ),
          },
          {
            key: 'versions',
            label: t('display.versions'),
            children: (
              <TableCard
                flush
                footer={
                  <TableFooter
                    total={versions.length}
                    page={versionPageNo}
                    pageSize={versionPageSize}
                    totalText={t('display.total', { count: versions.length })}
                    onPageChange={(nextPage, nextSize) => {
                      setVersionPageNo(nextPage);
                      if (nextSize !== versionPageSize) setVersionPageSize(nextSize);
                    }}
                    onPageSizeChange={setVersionPageSize}
                  />
                }
              >
                <Table rowKey="id" columns={versionColumns} dataSource={versions} pagination={false} />
              </TableCard>
            ),
          },
        ]}
      />
    </div>
  );
}
