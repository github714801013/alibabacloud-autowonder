import { useLocalizedValidation } from '@/shared/i18n/useLocalizedValidation';
import { formatDateTime, formatNumber } from '@/shared/i18n/format';
import { i18n } from '@/shared/i18n';
import { useTranslation } from 'react-i18next';
import { PageBackButton } from '@/shared/ui/PageBackButton';
import { SectionCard } from '@/shared/ui/SectionCard';
import { StatusTag } from '@/shared/ui/StatusTag';
import type { StatusColorKey } from '@/shared/ui/StatusTag';
import { useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import {
  Spin, Button, Result, Space, Modal, Form, Input, Select,
  Popconfirm, message, Tooltip, Drawer, Alert, Switch, InputNumber, Empty, Popover, Typography } from 'antd';
import { Table } from '@/shared/theme/ThemedTable';
import { StopOutlined } from '@ant-design/icons';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSdlcTemplate, updateSdlcTemplate, enableSdlcTemplate, disableSdlcTemplate,
  addStep, updateStep, deleteStep, reorderSteps,
} from './api';
import { AiSessionPanel } from '@/shared/ui/AiSessionPanel';
import { SDLC_AI_ENABLED } from './featureFlags';
import type { SdlcId, SdlcStep, CreateStepParams, UpdateStepParams } from './api';
import type { ColumnsType } from 'antd/es/table';
import { useAccessCommand } from '@/shared/auth/useAccessCommand';
import { listMembers } from '@/features/settings/api';

const checklistExample = '[{"id": "tests-pass", "text": "运行相关测试全部通过"}]';
const policyExample = '{ "evidenceRequired": true, "requiredArtifacts": ["evidence/"] }';

const kindOptions = [
  { value: 'analysis', key: 'kind.analysis' as const },
  { value: 'implementation', key: 'kind.implementation' as const },
  { value: 'test', key: 'kind.test' as const },
  { value: 'review', key: 'kind.review' as const },
  { value: 'artifact', key: 'kind.artifact' as const },
  { value: 'handoff', key: 'kind.handoff' as const },
  { value: 'cleanup', key: 'kind.cleanup' as const },
];

const statusMeta: Record<string, { colorKey: StatusColorKey; key: 'status.draft' | 'status.enabled' | 'status.disabled' }> = {
  DRAFT: { colorKey: 'gray', key: 'status.draft' as const },
  ENABLED: { colorKey: 'green', key: 'status.enabled' as const },
  DISABLED: { colorKey: 'amber', key: 'status.disabled' as const },
};

// 与步骤总览流程条 getStepKindTone 的着色语义一致：分析=蓝 · 实现=绿 · 测试=琥珀 · 评审=紫 · 其余中性
export const SDLC_KIND_TAG_COLOR: Record<string, StatusColorKey> = {
  analysis: 'blue',
  implementation: 'green',
  test: 'amber',
  review: 'violet',
  artifact: 'gray',
  handoff: 'gray',
  cleanup: 'gray',
};

const MISSING = '-';

export function SdlcDetailPage() {
  const { t } = useTranslation('sdlc');
  const { id } = useParams<{ id: string }>();
  const workTypes = new Map<string, string>([['REQUIREMENT', t('workType.requirement')], ['REQ', t('workType.requirement')], ['TASK', t('workType.task')], ['BUG', t('workType.bug')]]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rawAccessCommand = useAccessCommand();
  const accessCommand: typeof rawAccessCommand = (required, action, command) =>
    rawAccessCommand(required, action, command, 'SDLC');
  const rawId = id ?? '';
  const isValidSdlcId = /^\d+$/.test(rawId);
  const sdlcId = isValidSdlcId ? rawId : '';

  const [editingInfo, setEditingInfo] = useState(false);
  const [stepModalOpen, setStepModalOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<SdlcStep | null>(null);
  const [infoForm] = Form.useForm();
  const [stepForm] = Form.useForm();
  const humanApprovalRequired = Form.useWatch('humanApprovalRequired', stepForm);
  const { data: members = [] } = useQuery({
    queryKey: ['workspace-members'], queryFn: listMembers, enabled: stepModalOpen,
  });
  const approverOptions = [
    { value: 'creator', label: t('approval.creator') },
    ...members.filter(m => m.accessLevel !== 'READ_ONLY').map(m => ({ value: `user:${m.userId}`, label: m.nickname || m.username })),
    ...[...new Set(members.flatMap(m => m.identityTags || []))].map(tag => ({ value: `tag:${tag}`, label: t('approval.identityTag', { tag }) })),
  ];

  const { data: sdlc, isLoading, isError, error } = useQuery({
    queryKey: ['sdlc', sdlcId],
    queryFn: () => getSdlcTemplate(sdlcId),
    enabled: isValidSdlcId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sdlc', sdlcId] });

  const updateInfoMutation = useMutation({
    mutationFn: (data: Parameters<typeof updateSdlcTemplate>[1]) => updateSdlcTemplate(sdlcId, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(['sdlc', sdlcId], updated);
      invalidate(); setEditingInfo(false); message.success(i18n.t('sdlc:messages.saved'));
    },
    onError: (error) => message.error(error instanceof Error ? error.message : i18n.t('sdlc:messages.saveFailed')),
  });

  const enableMutation = useMutation({
    mutationFn: () => enableSdlcTemplate(sdlcId),
    onSuccess: () => { invalidate(); message.success(i18n.t('sdlc:status.enabled')); },
  });

  const disableMutation = useMutation({
    mutationFn: () => disableSdlcTemplate(sdlcId),
    onSuccess: () => { invalidate(); message.success(i18n.t('sdlc:status.disabled')); },
  });

  const addStepMutation = useMutation({
    mutationFn: (data: CreateStepParams) => addStep(sdlcId, data),
    onSuccess: () => { invalidate(); setStepModalOpen(false); stepForm.resetFields(); message.success(i18n.t('sdlc:messages.stepAdded')); },
    onError: (e) => { message.error(e instanceof Error ? e.message : i18n.t('sdlc:messages.addStepFailed')); },
  });

  const updateStepMutation = useMutation({
    mutationFn: ({ stepId, data }: { stepId: SdlcId; data: UpdateStepParams }) =>
      updateStep(sdlcId, stepId, data),
    onSuccess: () => { invalidate(); setStepModalOpen(false); setEditingStep(null); stepForm.resetFields(); message.success(i18n.t('sdlc:messages.stepUpdated')); },
    onError: (e) => { message.error(e instanceof Error ? e.message : i18n.t('sdlc:messages.updateStepFailed')); },
  });

  const deleteStepMutation = useMutation({
    mutationFn: (stepId: SdlcId) => deleteStep(sdlcId, stepId),
    onSuccess: () => { invalidate(); message.success(i18n.t('sdlc:messages.stepDeleted')); },
  });

  const reorderMutation = useMutation({
    mutationFn: (stepIds: SdlcId[]) => reorderSteps(sdlcId, stepIds),
    onSuccess: () => { invalidate(); },
  });

  const formReady = isValidSdlcId && !isLoading && !isError && Boolean(sdlc);
  useLocalizedValidation(infoForm, formReady && editingInfo);
  useLocalizedValidation(stepForm, formReady && stepModalOpen);

  if (!isValidSdlcId) return (
    <Result status="404" title={t('messages.invalidId')} extra={<Button onClick={() => navigate(-1)}>{t('actions.back')}</Button>} />
  );
  if (isLoading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  // 后台刷新失败时保留已加载数据，只有从未加载成功才整页报错（502 不抹数据）。
  if (isError && !sdlc) return (
    <Result status="error" title={t('messages.loadFailed')} subTitle={error?.message || t('messages.retry')}
      extra={<Button onClick={() => navigate(-1)}>{t('actions.back')}</Button>} />
  );
  if (!sdlc) return null;

  const steps = [...(sdlc.steps || [])].sort((a, b) => a.stepOrder - b.stepOrder);
  const isEnabled = sdlc.status === 'ENABLED';

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    accessCommand('READ_WRITE', t('commands.reorder'), () => {
      const newSteps = [...steps];
      const swapIdx = direction === 'up' ? index - 1 : index + 1;
      [newSteps[index], newSteps[swapIdx]] = [newSteps[swapIdx], newSteps[index]];
      reorderMutation.mutate(newSteps.map(s => s.id));
    });
  };

  const openAddStep = () => {
    accessCommand('READ_WRITE', t('commands.addStep'), () => {
      setEditingStep(null);
      stepForm.resetFields();
      stepForm.setFieldsValue({ stepOrder: steps.length + 1, kind: 'analysis', required: true, humanApprovalRequired: false, approvers: ['creator'], askWhenUnclear: false });
      setStepModalOpen(true);
    });
  };

  const openEditStep = (step: SdlcStep) => {
    accessCommand('READ_WRITE', t('commands.editStep'), () => {
      setEditingStep(step);
      let policy;
      try { policy = JSON.parse(step.gatePolicyJson || '{}'); }
      catch { policy = {}; } // Keep malformed legacy JSON in the editor so it can be corrected.
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) policy = {};
      stepForm.setFieldsValue({
        name: step.name,
        kind: step.kind || undefined,
        instructionMd: step.instructionMd || undefined,
        checklistJson: step.checklistJson || undefined,
        gatePolicyJson: step.gatePolicyJson || undefined,
        humanApprovalRequired: policy.humanApprovalRequired === true,
        approvers: policy.humanApprovers ? [
          ...(policy.humanApprovers.includeCreator ? ['creator'] : []),
          ...(policy.humanApprovers.userIds || []).map((id: number) => `user:${id}`),
          ...(policy.humanApprovers.identityTags || []).map((tag: string) => `tag:${tag}`),
        ] : ['creator'],
        askWhenUnclear: policy.askWhenUnclear === true,
        required: step.required ?? true,
        timeoutSeconds: step.timeoutSeconds ?? undefined,
        retryBudget: step.retryBudget ?? undefined,
      });
      setStepModalOpen(true);
    });
  };

  const handleStepSubmit = async () => {
    const values = await stepForm.validateFields().catch(() => null);
    if (!values) return;
    const { humanApprovalRequired, approvers = ['creator'], askWhenUnclear, ...stepValues } = values;
    const policy = JSON.parse(stepValues.gatePolicyJson || '{}');
    if (humanApprovalRequired) policy.humanApprovalRequired = true;
    else delete policy.humanApprovalRequired;
    if (humanApprovalRequired && !(approvers.length === 1 && approvers[0] === 'creator')) {
      policy.humanApprovers = {
        includeCreator: approvers.includes('creator'),
        userIds: approvers.filter((s: string) => s.startsWith('user:')).map((s: string) => Number(s.slice(5))),
        identityTags: approvers.filter((s: string) => s.startsWith('tag:')).map((s: string) => s.slice(4)),
      };
    } else delete policy.humanApprovers;
    if (askWhenUnclear) policy.askWhenUnclear = true;
    else delete policy.askWhenUnclear;
    delete policy.askWhenUnclearGuidance;
    stepValues.gatePolicyJson = JSON.stringify(policy);
    accessCommand('READ_WRITE', editingStep ? t('commands.editStep') : t('commands.addStep'), () => {
      if (editingStep) {
        // 清空输入框时显式传 null，让后端将超时/重试恢复为未配置
        updateStepMutation.mutate({
          stepId: editingStep.id,
          data: { ...stepValues, timeoutSeconds: values.timeoutSeconds ?? null, retryBudget: values.retryBudget ?? null },
        });
      } else {
        addStepMutation.mutate({ ...stepValues, stepOrder: steps.length + 1 });
      }
    });
  };

  const handleInfoSave = async () => {
    const values = await infoForm.validateFields();
    accessCommand('READ_WRITE', t('commands.editInfo'), () => updateInfoMutation.mutate(values));
  };

  const stepColumns: ColumnsType<SdlcStep> = [
    { title: '#', width: 44, render: (_, __, idx) => idx + 1 },
    { title: t('fields.stepName'), dataIndex: 'name', align: 'left', width: 150, render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: t('fields.kind'), dataIndex: 'kind', width: 110, render: (v: string | null) => {
      const option = kindOptions.find(option => option.value === v);
      return v ? <StatusTag size="sm" label={option ? t(option.key) : v} colorKey={SDLC_KIND_TAG_COLOR[v] ?? 'gray'} /> : MISSING;
    } },
    { title: t('fields.required'), dataIndex: 'required', width: 64, render: (v: boolean) => v === false ? t('messages.no') : t('messages.yes') },
    {
      title: t('fields.instruction'), dataIndex: 'instructionMd',
      render: (v: string | null) => v ? (
        <Popover
          title={t('fields.instruction')}
          trigger={['hover', 'click']}
          overlayStyle={{ maxWidth: 384 }}
          content={<div style={instructionPopoverStyle}>{v}</div>}
        >
          <span style={instructionClampStyle}>{v}</span>
        </Popover>
      ) : MISSING,
    },
    {
      title: t('fields.checklist'), dataIndex: 'checklistJson', width: 92,
      render: (v: string | null) => v ? (
        <Popover title={t('fields.checklist')} trigger={['hover', 'click']} content={<ChecklistPreview raw={v} />}>
          <StatusTag size="sm" label={t('messages.configured')} colorKey="blue" style={{ cursor: 'pointer' }} />
        </Popover>
      ) : MISSING,
    },
    {
      title: t('fields.policy'), dataIndex: 'gatePolicyJson', width: 92,
      render: (v: string | null) => v ? (
        <Popover title={t('fields.policy')} trigger={['hover', 'click']} content={<GatePolicyPreview raw={v} />}>
          <StatusTag size="sm" label={t('messages.configured')} colorKey="blue" style={{ cursor: 'pointer' }} />
        </Popover>
      ) : MISSING,
    },
    {
      title: t('fields.actions'), width: 120,
      render: (_, record, idx) => (
        <Space size={4}>
          <Tooltip title={t('actions.moveUp')}>
            <Button type="text" size="small" className="aw-op-btn" aria-label={t('actions.moveUp')} icon={<AwStrokeIcon name="up" />} disabled={idx === 0 || isEnabled}
              onClick={() => handleMoveStep(idx, 'up')} />
          </Tooltip>
          <Tooltip title={t('actions.moveDown')}>
            <Button type="text" size="small" className="aw-op-btn" aria-label={t('actions.moveDown')} icon={<AwStrokeIcon name="down" />} disabled={idx === steps.length - 1 || isEnabled}
              onClick={() => handleMoveStep(idx, 'down')} />
          </Tooltip>
          <Tooltip title={t('actions.edit')}>
            <Button type="text" size="small" className="aw-op-btn" aria-label={t('actions.editStep')} icon={<AwStrokeIcon name="edit" />} disabled={isEnabled}
              onClick={() => openEditStep(record)} />
          </Tooltip>
          <Popconfirm title={t('confirm.deleteStep')} onConfirm={() => accessCommand(
            'READ_WRITE',
            t('commands.deleteStep'),
            () => deleteStepMutation.mutate(record.id),
          )}
            disabled={isEnabled}>
            <Tooltip title={t('actions.delete')}>
              <Button type="text" size="small" className="aw-op-btn aw-op-btn--del" aria-label={t('actions.delete')} icon={<AwStrokeIcon name="trash" />} disabled={isEnabled} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="aw-detail-canvas">

      {/* 原型 14 页头块：画布上的白卡（同工单详情头部卡），back + 名称 + 状态 + 右置操作 */}
      <section className="aw-detail-head-card">
        <div className="aw-detail-title" style={{ gap: 10 }}>
          <PageBackButton to="/sdlcs" label={t('actions.backList')} />
          <Typography.Title level={5} style={{ margin: 0, fontSize: 16, lineHeight: '24px', minWidth: 0, overflowWrap: 'anywhere' }}>{sdlc.name}</Typography.Title>
          <StatusTag
            dot
            size="sm"
            label={Object.prototype.hasOwnProperty.call(statusMeta, sdlc.status) ? t(statusMeta[sdlc.status].key) : sdlc.status}
            colorKey={Object.prototype.hasOwnProperty.call(statusMeta, sdlc.status) ? statusMeta[sdlc.status].colorKey : 'gray'}
          />
          <Space style={{ marginLeft: 'auto' }}>
            {sdlc.status === 'DRAFT' || sdlc.status === 'DISABLED' ? (
              <Popconfirm title={t('confirm.enableLock')} onConfirm={() => accessCommand(
                'READ_WRITE',
                t('commands.enable'),
                () => enableMutation.mutate(),
              )}>
                <Button type="primary" icon={<AwStrokeIcon name="check" />}
                  loading={enableMutation.isPending}>{t('actions.enable')}</Button>
              </Popconfirm>
            ) : (
              <Popconfirm title={t('confirm.disableDetail')} onConfirm={() => accessCommand(
                'READ_WRITE',
                t('commands.disable'),
                () => disableMutation.mutate(),
              )}>
                <Button danger icon={<StopOutlined aria-hidden="true" />}
                  loading={disableMutation.isPending}>{t('actions.disable')}</Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        <div style={{ marginLeft: 42, marginTop: 4, fontSize: 12, color: 'var(--aw-text-3)' }}>
          {t('overview.subtitle', { date: formatDateTime(sdlc.gmtCreate) })}
        </div>
      </section>

      <SectionCard
        title={t('overview.info')}
        extra={!editingInfo && !isEnabled ? (
          <Button size="small" style={{ fontSize: 12 }} icon={<AwStrokeIcon name="edit" />}
            onClick={() => accessCommand('READ_WRITE', t('commands.editInfo'), () => {
              infoForm.setFieldsValue({ name: sdlc.name, description: sdlc.description, workType: sdlc.workType });
              setEditingInfo(true);
            })}>{t('actions.editInfo')}</Button>
        ) : undefined}
      >
        {editingInfo ? (
          <Form name="sdlc-info" form={infoForm} layout="vertical" onFinish={handleInfoSave}>
            <Form.Item name="name" label={t('fields.name')} rules={[{ required: true, message: t('validation.name') }]}>
              <Input />
            </Form.Item>
            <Form.Item name="description" label={t('fields.description')}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="workType" label={t('fields.workType')} style={{ maxWidth: 240 }}>
              <Select allowClear placeholder={t('placeholder.workType')}
                options={[
                  { value: 'REQUIREMENT', label: t('workType.requirement') },
                  { value: 'TASK', label: t('workType.task') },
                  { value: 'BUG', label: t('workType.bug') },
                ]} />
            </Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={updateInfoMutation.isPending}>{t('actions.save')}</Button>
              <Button onClick={() => setEditingInfo(false)}>{t('actions.cancel')}</Button>
            </Space>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--aw-text-3)' }}>{t('help.infoEditingNote')}</div>
          </Form>
        ) : (
          <div className="aw-desc-grid aw-desc-grid--c4">
            <div className="aw-desc-item">
              <div className="aw-dk">{t('fields.status')}</div>
              <div className="aw-dv">
                <StatusTag
                  dot
                  size="sm"
                  label={Object.prototype.hasOwnProperty.call(statusMeta, sdlc.status) ? t(statusMeta[sdlc.status].key) : sdlc.status}
                  colorKey={Object.prototype.hasOwnProperty.call(statusMeta, sdlc.status) ? statusMeta[sdlc.status].colorKey : 'gray'}
                />
              </div>
            </div>
            <div className="aw-desc-item">
              <div className="aw-dk">{t('fields.workType')}</div>
              <div className="aw-dv">{sdlc.workType ? workTypes.get(sdlc.workType) ?? sdlc.workType : t('workType.general')}</div>
            </div>
            <div className="aw-desc-item">
              <div className="aw-dk">{t('fields.version')}</div>
              <div className="aw-dv aw-desc-mono">{t('fields.versionValue', { version: sdlc.version })}</div>
            </div>
            <div className="aw-desc-item">
              <div className="aw-dk">{t('fields.stepCount')}</div>
              <div className="aw-dv">{formatNumber(steps.length)}</div>
            </div>
            <div className="aw-desc-item">
              <div className="aw-dk">{t('fields.stageTiming')}</div>
              <div className="aw-dv">
                <Switch aria-label={t('fields.stageTiming')} checked={sdlc.stageTimingEnabled === true}
                  loading={updateInfoMutation.isPending}
                  onChange={checked => accessCommand('READ_WRITE', t('fields.stageTiming'), () => updateInfoMutation.mutate({ stageTimingEnabled: checked }))} />
              </div>
            </div>
            <div className="aw-desc-item aw-desc-item--full">
              <div className="aw-dk">{t('fields.description')}</div>
              <div className="aw-dv">{sdlc.description || MISSING}</div>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('overview.title')}
        data-testid="sdlc-step-overview-card"
        extra={(
          <span style={{ color: 'var(--aw-text-3)', fontSize: 11 }}>
            <span>{t('overview.count', { count: steps.length })}</span>
            <span style={{ marginLeft: 8 }}>{t('overview.hoverHint')}</span>
          </span>
        )}
      >
        {steps.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('overview.empty')}
            style={{ margin: 0 }}
          />
        ) : (
          <div
            data-testid="sdlc-step-overview-flow"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              overflowX: 'visible',
              rowGap: 12,
            }}
          >
            {steps.map((step, index) => {
              const tone = getStepKindTone(step.kind);
              return (
                <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                  <Tooltip overlayInnerStyle={{ fontSize: 11 }} title={<StepOverviewTooltip step={step} />}>
                    <div
                      aria-label={t('overview.step', { index: index + 1, name: step.name })}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                        maxWidth: 180,
                      }}
                    >
                      <span style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: `1px solid ${tone.border}`,
                        background: tone.background,
                        color: tone.textColor,
                        display: 'inline-grid',
                        placeItems: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        flex: '0 0 auto',
                      }}>
                        {index + 1}
                      </span>
                      <span style={{
                        color: 'var(--aw-text)',
                        fontSize: 13,
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 150,
                      }}>
                        {step.name}
                      </span>
                    </div>
                  </Tooltip>
                  {index < steps.length - 1 && (
                    <span
                      aria-label={t('overview.next')}
                      style={{
                        color: step.kind === 'analysis' ? 'var(--aw-primary)' : 'var(--aw-text-3)',
                        opacity: step.kind === 'analysis' ? 0.55 : undefined,
                        fontSize: 15,
                        fontWeight: 800,
                        lineHeight: 1,
                        flex: '0 0 auto',
                      }}
                    >
                      →
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t('overview.editor')}
        extra={
          <Space>
            {SDLC_AI_ENABLED && (
              <Button size="small" icon={<AwStrokeIcon name="bulb" />} style={{ fontSize: 12 }}
                onClick={() => accessCommand('READ_WRITE', t('commands.aiAssist'), () => setAiDrawerOpen(true))}>
                {t('actions.aiAssist')}
              </Button>
            )}
            <Button type="primary" size="small" icon={<AwStrokeIcon name="plus" />} style={{ fontSize: 12 }} onClick={openAddStep} disabled={isEnabled}>
              {t('actions.addStep')}
            </Button>
          </Space>
        }
      >
        {isEnabled && (
          <Alert className="aw-lock-note" type="warning" showIcon message={t('overview.locked')} />
        )}
        <Table
          rowKey="id"
          columns={stepColumns}
          dataSource={steps}
          pagination={false}
        />
      </SectionCard>

      <Modal
        title={editingStep ? t('actions.editStep') : t('actions.addStep')}
        width={720}
        open={stepModalOpen}
        closable={{ 'aria-label': t('gallery.close') }}
        onOk={handleStepSubmit}
        onCancel={() => { setStepModalOpen(false); setEditingStep(null); }}
        confirmLoading={addStepMutation.isPending || updateStepMutation.isPending}
        destroyOnClose
      >
        <Form name="sdlc-step" form={stepForm} layout="vertical">
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="name" label={t('fields.stepName')} rules={[{ required: true, message: t('validation.stepName') }]}
              style={{ flex: 1, minWidth: 0 }}>
              <Input placeholder={t('placeholder.stepName')} />
            </Form.Item>
            <Form.Item name="kind" label={t('fields.stepKind')} style={{ width: 220 }}>
              <Select allowClear options={kindOptions.map(option => ({ ...option, label: t(option.key) }))} placeholder={t('placeholder.kind')} />
            </Form.Item>
          </div>
          <Form.Item name="required" label={t('fields.isRequired')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="humanApprovalRequired" label={t('approval.required')} valuePropName="checked"
            extra={t('approval.description')}>
            <Switch checkedChildren={t('approval.needed')} unCheckedChildren={t('approval.notNeeded')} />
          </Form.Item>
          <Form.Item label={t('humanInput.label')} extra={t('humanInput.description')}>
            <Space>
              <Form.Item name="askWhenUnclear" valuePropName="checked" noStyle>
                <Switch aria-label={t('humanInput.label')} />
              </Form.Item>
              <Tooltip title={t('humanInput.description')}>
                <span role="img" tabIndex={0} aria-label={t('humanInput.help')}
                  style={{ display: 'inline-flex', alignItems: 'center', height: 22, color: 'var(--aw-text-3)', cursor: 'help' }}>
                  <AwStrokeIcon name="help" size={14} />
                </span>
              </Tooltip>
            </Space>
          </Form.Item>
          {humanApprovalRequired && <Form.Item name="approvers" label={t('approval.approvers')} rules={[{ required: true, message: t('approval.validation') }]}
            extra={t('approval.approversDescription')}>
            <Select mode="multiple" options={approverOptions} optionFilterProp="label" placeholder={t('approval.placeholder')} />
          </Form.Item>}
          <Form.Item name="instructionMd" label={t('fields.instruction')} rules={[{ required: true, message: t('validation.instruction') }]}>
            <Input.TextArea rows={8} placeholder={t('placeholder.instruction')} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="checklistJson" label={<StepFieldHelp text={t('fields.checklistJson')} help={<ChecklistFieldHelp />} popover />}
              style={{ flex: 1, minWidth: 0 }}>
              <Input.TextArea rows={3} placeholder={t('help.examplePlaceholder', { example: checklistExample })} />
            </Form.Item>
            <Form.Item name="gatePolicyJson" label={<StepFieldHelp text={t('fields.policyJson')} help={<GatePolicyFieldHelp />} popover />}
              style={{ flex: 1, minWidth: 0 }}
              rules={[{ validator: (_, value) => {
                try {
                  const policy = JSON.parse(value || '{}');
                  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error();
                  return Promise.resolve();
                } catch { return Promise.reject(new Error(t('validation.policyObject'))); }
              } }]}>
              <Input.TextArea rows={3} placeholder={t('help.examplePlaceholder', { example: policyExample })} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 32 }}>
            <Form.Item name="timeoutSeconds" label={t('fields.timeout')}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item
              name="retryBudget"
              label={<StepFieldHelp text={t('fields.retry')} help={<RetryBudgetTooltipContent />} popover />}
            >
              <InputNumber min={0} precision={0} />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <Drawer
        title={t('commands.aiAssist')}
        open={aiDrawerOpen}
        closable={{ 'aria-label': t('gallery.close') }}
        onClose={() => setAiDrawerOpen(false)}
        width="min(1080px, 92vw)"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('ai.assistWarning')}
        />
        <div style={{ height: 'calc(100vh - 170px)', minHeight: 520 }}>
          <AiSessionPanel
            scene="SDLC_GEN"
            bizRefType='ORG'
            bizRefId={0}
            onConfirm={() => {
              queryClient.invalidateQueries({ queryKey: ['sdlcs'] });
              setAiDrawerOpen(false);
            }}
          />
        </div>
      </Drawer>
    </div>
  );
}

// 与原型 14 流程条着色一致：分析=主蓝 · 实现=成功绿 · 测试=警示琥珀 · 评审=紫 · 其余中性。
// 全部用 crystal.css 真实存在的令牌（早前引用了不存在的 --aw-info，color-mix 整体失效导致步骤圈无色）。
function getStepKindTone(kind?: string | null) {
  switch (kind) {
    case 'analysis':
      return { border: 'color-mix(in srgb, var(--aw-primary) 45%, transparent)', background: 'var(--aw-primary-weak)', textColor: 'var(--aw-accent-text)' };
    case 'implementation':
      return { border: 'var(--aw-success)', background: 'var(--aw-success-bg)', textColor: 'var(--aw-success-deep)' };
    case 'test':
      return { border: 'var(--aw-warning)', background: 'var(--aw-warning-bg)', textColor: 'var(--aw-warning-deep)' };
    case 'review':
      return { border: 'var(--aw-ai)', background: 'var(--aw-ai-bg)', textColor: 'var(--aw-ai)' };
    default:
      return { border: 'var(--aw-border)', background: 'var(--aw-gray-bg)', textColor: 'var(--aw-text-2)' };
  }
}

function StepOverviewTooltip({ step }: { step: SdlcStep }) {
  const { t } = useTranslation('sdlc');
  const kind = kindOptions.find(option => option.value === step.kind);
  let policy: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(step.gatePolicyJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) policy = parsed as Record<string, unknown>;
  } catch { policy = {}; }
  const needsApproval = policy.humanApprovalRequired === true;
  const approvers = needsApproval ? policy.humanApprovers as Record<string, unknown> | undefined : undefined;
  const approverNames = approvers ? [
    ...(approvers.includeCreator === true ? [t('approval.creator')] : []),
    ...((approvers.userIds as number[] | undefined) ?? []).map((id) => `user:${id}`),
    ...((approvers.identityTags as string[] | undefined) ?? []).map((tag) => `tag:${tag}`),
  ] : [];
  const approval = !needsApproval
    ? t('overview.approvalNotNeeded')
    : approverNames.length > 0 ? t('overview.approvalNeededWith', { names: approverNames.join(' + ') }) : t('overview.approvalNeeded');
  return (
    <div style={{ display: 'grid', gap: 4, maxWidth: 260 }}>
      <div style={{ fontWeight: 700 }}>{step.name}</div>
      <div>{t('overview.kind', { kind: kind ? t(kind.key) : step.kind || t('messages.unconfigured') })}</div>
      <div>{t('overview.required', { required: step.required === false ? t('messages.no') : t('messages.yes') })}</div>
      <div>{t('overview.approval', { approval })}</div>
      <div>{t('overview.timeout', { timeout: step.timeoutSeconds ? t('overview.seconds', { count: step.timeoutSeconds }) : t('messages.unconfigured') })}</div>
      <div>{t('overview.retry', { retry: step.retryBudget == null ? t('messages.unconfigured') : formatNumber(step.retryBudget) })}</div>
    </div>
  );
}

const previewStyle: CSSProperties = { maxWidth: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 };

// 说明列十六轮定稿：20 行截断（约 360px = 20×18px），hover Popover 全文滚动查看
const instructionClampStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 20,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  whiteSpace: 'pre-wrap',
  fontSize: 12,
  color: 'var(--aw-text-2)',
  cursor: 'pointer',
};

const instructionPopoverStyle: CSSProperties = {
  maxWidth: 360,
  maxHeight: 240,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  lineHeight: 1.7,
  color: 'var(--aw-text-2)',
};

function ChecklistPreview({ raw }: { raw: string }) {
  const { t } = useTranslation('sdlc');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (Array.isArray(parsed) && parsed.length > 0) {
    return (
      <div style={{ display: 'grid', gap: 4, maxWidth: 360 }}>
        {parsed.map((item, idx) => (
          <div key={idx}>
            • {typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : JSON.stringify(item)}
            {item && typeof item === 'object' && item.allowNotApplicable === true && (
              <div style={{ color: 'var(--aw-muted)' }}>{t('help.allowedNotApplicable', { condition: typeof item.notApplicableWhen === 'string' ? item.notApplicableWhen : t('help.invalidCondition') })}</div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <pre style={previewStyle}>{raw}</pre>;
}

function GatePolicyPreview({ raw }: { raw: string }) {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
    return (
      <div style={{ display: 'grid', gap: 4, maxWidth: 360 }}>
        {Object.entries(parsed as Record<string, unknown>).map(([key, value]) => (
          <div key={key}>{key}: {typeof value === 'string' ? value : JSON.stringify(value)}</div>
        ))}
      </div>
    );
  }
  return <pre style={previewStyle}>{raw}</pre>;
}

export function RetryBudgetTooltipContent() {
  const { t } = useTranslation('sdlc');
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 340 }}>
      <div style={{ fontWeight: 700 }}>{t('fields.retry')}</div>
      <div>
        <span style={{ fontWeight: 600 }}>{t('help.meaning')}</span>
        {t('help.retryMeaning')}
      </div>
      <div>
        <span style={{ fontWeight: 600 }}>{t('help.behavior')}</span>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          <li>{t('help.retryZero')}</li>
          <li>
            {t('help.retryAttempts')}
          </li>
        </ul>
      </div>
      <div>
        <span style={{ fontWeight: 600 }}>{t('help.example')}</span>
        {t('help.retryExample')}
      </div>
      <div>
        <span style={{ fontWeight: 600 }}>{t('help.recommendation')}</span>
        {t('help.retryRecommendation')}
      </div>
    </div>
  );
}

function StepFieldHelp({ text, help, popover }: { text: string; help: ReactNode; popover?: boolean }) {
  const { t } = useTranslation('sdlc');
  const icon = (
    <span role="button" tabIndex={0} aria-label={t('help.field', { field: text })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--aw-text-3)', cursor: 'help' }}>
      <AwStrokeIcon name="help" size={14} />
    </span>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {text}
      {popover ? (
        <Popover trigger={['hover', 'focus', 'click']} content={help} overlayInnerStyle={{ maxWidth: 460 }} placement="topLeft">
          {icon}
        </Popover>
      ) : (
        <Tooltip trigger={['hover', 'focus']} title={help}>
          {icon}
        </Tooltip>
      )}
    </span>
  );
}

function ChecklistFieldHelp() {
  const { t } = useTranslation('sdlc');
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
      <div><b>{t('help.meaning')}</b>{t('help.checklistMeaning')}</div>
      <div><b>{t('help.behavior')}</b>{t('help.checklistBehavior')}</div>
      <div>
        <b>{t('help.format')}</b>{t('help.checklistFormat')}
        <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{checklistExample}</pre>
      </div>
      <div><b>{t('help.conditional')}</b>{t('help.checklistConditional')}</div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{'[{"id":"code-tests","text":"代码测试通过","allowNotApplicable":true,"notApplicableWhen":"本轮仅澄清需求，未进入代码实施分支"}]'}</pre>
    </div>
  );
}

function GatePolicyFieldHelp() {
  const { t } = useTranslation('sdlc');
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
      <div><b>{t('help.meaning')}</b>{t('help.policyMeaning')}</div>
      <div><b>{t('help.evidenceRequiredLabel')}</b>{t('help.evidenceRequired')}</div>
      <div><b>{t('help.requiredArtifactsLabel')}</b>{t('help.requiredArtifacts')}</div>
      <div><b>{t('help.checklistRequiredLabel')}</b>{t('help.checklistRequired')}</div>
      <div>
        <b>{t('help.example')}</b>
        <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{policyExample}</pre>
      </div>
    </div>
  );
}
