import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Form, Input, Switch, Tag, Tooltip, Typography, message } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { NoticeTip } from '@/shared/ui/NoticeTip';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { i18n } from '@/shared/i18n';
import { useLocalizedValidation } from '@/shared/i18n/useLocalizedValidation';
import { ImIdentityConflictAlert } from '@/shared/ui/ImIdentityConflictAlert';
import {
  IM_SELECTION_QUERY_KEY,
  PLATFORM_IM_CHANNELS_QUERY_KEY,
  getGroupChatConfig,
  groupChatQueryKey,
  updateGroupChatConfig,
  type GroupChatConfig,
  type UpdateGroupChatConfigParams,
} from './brandingApi';
import './messageChannel.css';

interface GroupChatFormValues {
  appKey?: string;
  robotCode?: string;
  baseUrl?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  clearEncryptKey?: boolean;
  enabled: boolean;
}

const FEISHU_PROVIDER = 'FEISHU';
const DINGTALK_PROVIDER = 'DINGTALK';
const FEISHU_DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis';

const WECOM_PROVIDER = 'WECOM';
const WECOM_CONNECTED = 'CONNECTED';

const WECOM_CONNECTION_LABEL_KEYS = {
  CONNECTING: 'wecomConnectionConnecting',
  CONNECTED: 'wecomConnectionConnected',
  DISCONNECTED: 'wecomConnectionDisconnected',
  ERROR: 'wecomConnectionError',
  UNKNOWN: 'wecomConnectionUnknown',
} as const;

const WECOM_CONNECTION_COLORS: Readonly<Record<string, string>> = {
  CONNECTING: 'processing',
  CONNECTED: 'green',
  DISCONNECTED: 'default',
  ERROR: 'red',
  UNKNOWN: 'default',
};

type GroupChatStatusLabelKey =
  | 'groupChatStatusActive'
  | 'groupChatStatusDraining'
  | 'groupChatStatusPaused'
  | 'groupChatStatusDisabled'
  | 'groupChatStatusError'
  | 'groupChatStatusUnknown';

const STATUS_COLORS = new Map<string, string>([
  ['ACTIVE', 'green'],
  ['ERROR', 'red'],
]);

const STATUS_LABEL_KEYS: ReadonlyMap<string, GroupChatStatusLabelKey> = new Map([
  ['ACTIVE', 'groupChatStatusActive'],
  ['DRAINING', 'groupChatStatusDraining'],
  ['PAUSED', 'groupChatStatusPaused'],
  ['DISABLED', 'groupChatStatusDisabled'],
  ['ERROR', 'groupChatStatusError'],
]);

interface Props {
  provider: string;
  disabled?: boolean;
  onBeforeSubmit?: () => boolean;
  onPendingChange?: (pending: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function GroupChatConfigPanel({ provider, disabled = false, onBeforeSubmit, onPendingChange, onDirtyChange }: Props) {
  const { t } = useTranslation('platform');
  const [form] = Form.useForm<GroupChatFormValues>();
  const [conflictError, setConflictError] = useState<unknown>(null);
  const [identityChanged, setIdentityChanged] = useState(false);
  const [applicationChanged, setApplicationChanged] = useState(false);
  const [draftDirtyState, setDraftDirtyState] = useState(false);
  const submitLock = useRef(false);
  const draftDirty = useRef(false);
  const draftConfig = useRef<GroupChatConfig>();
  const seededProvider = useRef<string>();
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = groupChatQueryKey(provider);
  const { data: config, error, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => getGroupChatConfig(provider),
    retry: false,
    // 企业微信连接状态由长连接实时上报，未连接时不能显示为已连接。
    refetchInterval: provider === WECOM_PROVIDER ? 5000 : false,
  });
  useLocalizedValidation(form, !error);
  const providerLabel = provider === FEISHU_PROVIDER ? t('feishu') : provider === WECOM_PROVIDER ? t('wecom') : t('dingtalk');
  const isWecom = provider === WECOM_PROVIDER;
  const connection = config?.connectionStatus ?? 'UNKNOWN';
  const connectionLabelKey = WECOM_CONNECTION_LABEL_KEYS[
    connection as keyof typeof WECOM_CONNECTION_LABEL_KEYS
  ];
  const connectionLabel = connectionLabelKey ? t(connectionLabelKey) : t('wecomConnectionUnknown');

  useEffect(() => {
    if (draftDirty.current && seededProvider.current === provider) return;
    form.resetFields();
    draftDirty.current = false;
    setDraftDirtyState(false);
    draftConfig.current = config;
    seededProvider.current = provider;
    onDirtyChange?.(false);
    setIdentityChanged(false);
    setApplicationChanged(false);
    if (config) {
      form.setFieldsValue({
        appKey: config.appKey ?? '',
        robotCode: config.robotCode ?? '',
        baseUrl: config.baseUrl ?? '',
        appSecret: '',
        verificationToken: '',
        encryptKey: '',
        clearEncryptKey: false,
        enabled: config.desiredEnabled,
      });
    }
  }, [config, form, provider]);

  /** A new application always needs its own credentials; a robotCode-only change keeps the secret. */
  const appKeyDiffers = (values: { appKey?: string }): boolean => {
    if (!draftConfig.current?.configured) {
      return false;
    }
    return (values.appKey ?? '') !== (draftConfig.current.appKey ?? '');
  };

  /** Any change of the stored identity (application or robot code) restarts the route. */
  const identityDiffers = (values: { appKey?: string; robotCode?: string }): boolean => {
    if (appKeyDiffers(values)) {
      return true;
    }
    if (!draftConfig.current?.configured || provider !== DINGTALK_PROVIDER) {
      return false;
    }
    return (values.robotCode ?? '') !== (draftConfig.current.robotCode ?? '');
  };

  const mutation = useMutation({
    mutationFn: ({ targetProvider, params }: { targetProvider: string; params: UpdateGroupChatConfigParams }) => updateGroupChatConfig(targetProvider, params),
    onSuccess: async (saved, { targetProvider }) => {
      if (providerRef.current === targetProvider) {
        draftDirty.current = false;
        draftConfig.current = saved;
      }
      queryClient.setQueryData(groupChatQueryKey(targetProvider), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PLATFORM_IM_CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: IM_SELECTION_QUERY_KEY }),
      ]);
      if (providerRef.current === targetProvider) {
        form.setFieldsValue({ appSecret: '', verificationToken: '', encryptKey: '' });
        onDirtyChange?.(false);
        setDraftDirtyState(false);
        setIdentityChanged(false);
        setApplicationChanged(false);
      }
      message.success(i18n.t('platform:groupChatSaved'));
    },
    onError: (error: Error) => {
      setConflictError(error);
      message.error(error.message || i18n.t('platform:groupChatSaveFailed'));
    },
  });

  const handleSubmit = async () => {
    const base = draftConfig.current;
    if (disabled || !base || error || submitLock.current) return;
    if (onBeforeSubmit && !onBeforeSubmit()) return;
    submitLock.current = true;
    setSubmitting(true);
    onPendingChange?.(true);
    const targetProvider = provider;
    const version = base.version;
    try {
      const values = await form.validateFields();
      if (disabledRef.current || providerRef.current !== targetProvider) return;
      const params: UpdateGroupChatConfigParams = { enabled: values.enabled, version: version ?? undefined };
      if (values.appKey) {
        if (targetProvider === FEISHU_PROVIDER) params.appId = values.appKey;
        else params.appKey = values.appKey;
      }
      if (targetProvider === DINGTALK_PROVIDER && values.robotCode) params.robotCode = values.robotCode;
      if (targetProvider === FEISHU_PROVIDER) params.baseUrl = values.baseUrl ?? '';
      if (values.appSecret) params.appSecret = values.appSecret;
      if (targetProvider === FEISHU_PROVIDER) {
        if (values.verificationToken) params.verificationToken = values.verificationToken;
        if (values.encryptKey) params.encryptKey = values.encryptKey;
        if (values.clearEncryptKey) params.clearEncryptKey = true;
      }
      await mutation.mutateAsync({ targetProvider, params });
    } catch {
      // Field and mutation errors remain visible without clearing the draft.
    } finally {
      submitLock.current = false;
      setSubmitting(false);
      onPendingChange?.(false);
    }
  };

  const formDisabled = disabled || !config || Boolean(error) || submitting;
  const status = config?.status ?? 'UNKNOWN';
  const statusColor = STATUS_COLORS.get(status);
  const statusLabelKey = STATUS_LABEL_KEYS.get(status);
  const accessLabel = `${t('platformAccess')}: ${statusLabelKey ? t(statusLabelKey) : t('groupChatStatusUnknown')}`;

  return (
    <Card
      className="aw-platform-message-card"
      title={
        <div className="aw-config-card-title">
          <span>{t('groupChatSection')}</span>
          <div className="aw-config-tags" aria-live="polite">
            <Tooltip title={t('groupChatStatusHint')} trigger={['hover', 'focus']}>
              <Tag color={statusColor} className={statusColor ? undefined : 'aw-tag-gray'} tabIndex={0} style={{ marginInlineEnd: 0 }}>
                {accessLabel}
              </Tag>
            </Tooltip>
            {config && <Tag color={config.desiredEnabled ? 'blue' : undefined} className={config.desiredEnabled ? undefined : 'aw-tag-gray'}>
              {config.desiredEnabled ? t('savedEnabled') : t('savedDisabled')}
            </Tag>}
            {isWecom && (
              <Tag color={WECOM_CONNECTION_COLORS[connection] ?? 'default'}>
                {t('wecomConnectionLabel', { status: connectionLabel })}
              </Tag>
            )}
            {config && !config.configured && <Tag color="orange">{t('groupChatNotConfigured')}</Tag>}
            {config && config.drainingCount > 0 && (
              <Tag color="orange">{t('groupChatDrainingCount', { items: config.drainingCount })}</Tag>
            )}
            {config && config.failedCount > 0 && (
              <Tag color="red">{t('groupChatFailedCount', { items: config.failedCount })}</Tag>
            )}
            {config && config.unknownCount > 0 && (
              <Tag color="orange">{t('groupChatUnknownCount', { items: config.unknownCount })}</Tag>
            )}
          </div>
        </div>
      }
      extra={
        <Button
          type="primary"
          aria-label={t('saveGroupChat')}
          loading={submitting}
          disabled={formDisabled}
          onClick={handleSubmit}
        >
          {t('saveGroupChat')}
        </Button>
      }
    >
      {error ? (
        <NoticeTip kind="error" title={t('groupChatLoadFailed')} detail={error.message}
          action={<Button onClick={() => { void refetch(); }}>{t('ssoRetry')}</Button>} />
      ) : (
        <div className="aw-platform-group-content" aria-busy={isLoading || submitting}>
          <Typography.Text type="secondary">{t('groupChatSectionHint')}</Typography.Text>

          <NoticeTip kind="warning" title={t('groupChatWarningAlert')} />

          {isWecom && (
            <Alert
              type={connection === WECOM_CONNECTED && config?.ready ? 'success' : 'warning'}
              showIcon
              message={t('wecomConnectionSeparate')}
              description={connection === WECOM_CONNECTED
                ? config?.ready ? t('wecomReadyHint') : t('wecomNotReadyConfig')
                : t('wecomNotReadyConnection', { status: connectionLabel })}
            />
          )}

          <Form
            form={form}
            name="groupChatConfig"
            layout="vertical"
            className="aw-im-form"
            disabled={formDisabled}
            initialValues={{ enabled: false }}
            onValuesChange={(_, all) => {
              draftDirty.current = true;
              setDraftDirtyState(true);
              setConflictError(null);
              onDirtyChange?.(true);
              setIdentityChanged(identityDiffers(all));
              setApplicationChanged(appKeyDiffers(all));
            }}
          >
            <input className="aw-autofill-decoy" type="text" aria-hidden="true" tabIndex={-1} autoComplete="off" />
            <input className="aw-autofill-decoy" type="password" aria-hidden="true" tabIndex={-1} autoComplete="current-password" />
            <div className="aw-config-check-row">
              <label className="aw-config-check">
                <Form.Item name="enabled" valuePropName="checked" noStyle>
                  <Switch size="small" aria-label={t('enableGroupChatAria', { provider: providerLabel })} />
                </Form.Item>
                <span>{t('enableGroupChatDraft')}</span>
              </label>
              <p className="aw-config-help">{draftDirtyState ? t('groupChatDirtyHint') : t('groupChatDraftHint')}</p>
            </div>
            <div className="aw-platform-message-fields">
              <Form.Item
                label={provider === FEISHU_PROVIDER
                  ? t('groupChatAppIdLabel')
                  : isWecom ? t('groupChatWecomBotIdLabel') : t('groupChatAppKeyLabel')}
                name="appKey"
                validateTrigger={[]}
                extra={config?.configured ? t('groupChatIdentityEditable') : undefined}
                rules={[({ getFieldValue }) => ({
                  validator: (_, value) => !getFieldValue('enabled') || value
                    ? Promise.resolve()
                    : Promise.reject(new Error(isWecom ? t('wecomBotIdRequired') : t('appKeyRequired'))),
                })]}
              >
                <Input
                  placeholder={provider === FEISHU_PROVIDER
                    ? t('appIdPlaceholder')
                    : isWecom ? t('wecomBotIdPlaceholder') : t('appKeyPlaceholder')}
                />
              </Form.Item>
              {provider === DINGTALK_PROVIDER && (
                <Form.Item
                  label={t('groupChatRobotCodeLabel')}
                  name="robotCode"
                  validateTrigger={[]}
                  extra={config?.configured ? t('groupChatIdentityEditable') : undefined}
                  rules={[({ getFieldValue }) => ({
                    validator: (_, value) => !getFieldValue('enabled') || value
                      ? Promise.resolve()
                      : Promise.reject(new Error(t('robotCodeRequired'))),
                  })]}
                >
                  <Input placeholder={t('robotCodePlaceholder')} />
                </Form.Item>
              )}
              <Form.Item
                label={isWecom ? t('groupChatWecomSecretLabel') : t('groupChatAppSecretLabel')}
                name="appSecret"
                validateTrigger={[]}
                extra={applicationChanged
                  ? t('groupChatNewIdentitySecretHint')
                  : config?.secretConfigured ? t('groupChatSecretConfiguredHint') : t('groupChatSecretMissingHint')}
                rules={[({ getFieldValue }) => ({
                  validator: (_, value) => {
                    if (!getFieldValue('enabled')) {
                      return Promise.resolve();
                    }
                    const changed = appKeyDiffers({ appKey: getFieldValue('appKey') });
                    return value || (!changed && draftConfig.current?.secretConfigured)
                      ? Promise.resolve()
                      : Promise.reject(new Error(isWecom ? t('wecomSecretRequired') : t('appSecretRequired')));
                  },
                })]}
              >
                <Input.Password
                  autoComplete="new-password"
                  iconRender={(visible) => (
                    <Button
                      type="text"
                      htmlType="button"
                      aria-label={t(visible ? 'groupChatHideSecret' : 'groupChatShowSecret')}
                      disabled={formDisabled}
                      icon={visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />}
                    />
                  )}
                  placeholder={config?.secretConfigured ? t('keepSecret') : t('secretPlaceholder')}
                />
              </Form.Item>
              {provider === FEISHU_PROVIDER && (
                <>
                  <Form.Item
                    label={t('feishuBaseUrlLabel')}
                    name="baseUrl"
                    extra={t('feishuBaseUrlHint')}
                  >
                    <Input placeholder={FEISHU_DEFAULT_BASE_URL} />
                  </Form.Item>
                  <Form.Item
                    label={t('groupChatVerificationTokenLabel')}
                    name="verificationToken"
                    validateTrigger={[]}
                    extra={applicationChanged
                      ? t('groupChatNewIdentityTokenHint')
                      : config?.verificationTokenConfigured ? t('groupChatTokenConfiguredHint') : t('groupChatTokenMissingHint')}
                    rules={[({ getFieldValue }) => ({
                      validator: (_, value) => {
                        if (!getFieldValue('enabled')) {
                          return Promise.resolve();
                        }
                        const changed = appKeyDiffers({ appKey: getFieldValue('appKey') });
                        return value || (!changed && draftConfig.current?.verificationTokenConfigured)
                          ? Promise.resolve()
                          : Promise.reject(new Error(t('requiredToken')));
                      },
                    })]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      iconRender={(visible) => (
                        <Button
                          type="text"
                          htmlType="button"
                          aria-label={t(visible ? 'groupChatHideSecret' : 'groupChatShowSecret')}
                          disabled={formDisabled}
                          icon={visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />}
                        />
                      )}
                    />
                  </Form.Item>
                  <Form.Item
                    label={t('groupChatEncryptKeyLabel')}
                    name="encryptKey"
                    extra={config?.encryptKeyConfigured ? t('groupChatEncryptConfiguredHint') : t('groupChatEncryptMissingHint')}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      iconRender={(visible) => (
                        <Button
                          type="text"
                          htmlType="button"
                          aria-label={t(visible ? 'groupChatHideSecret' : 'groupChatShowSecret')}
                          disabled={formDisabled}
                          icon={visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />}
                        />
                      )}
                    />
                  </Form.Item>
                  {config?.encryptKeyConfigured && (
                    <div className="aw-config-check-row">
                      <label className="aw-config-check">
                        <Form.Item name="clearEncryptKey" valuePropName="checked" noStyle>
                          <Switch size="small" aria-label={t('clearEncryption')} />
                        </Form.Item>
                        <span>{t('clearEncryptKeyLabel')}</span>
                      </label>
                      <p className="aw-config-help">{t('clearEncryptKeyHint')}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Form>

          {identityChanged && (
            <NoticeTip
              kind="warning"
              title={t('groupChatIdentityChangeTitle')}
              detail={t('groupChatIdentityChangeImpact')}
            />
          )}

          {conflictError != null && <ImIdentityConflictAlert error={conflictError} />}
        </div>
      )}
    </Card>
  );
}
