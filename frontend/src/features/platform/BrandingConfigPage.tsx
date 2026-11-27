import { useTranslation } from 'react-i18next';
import { i18n } from '@/shared/i18n';
import { useLocalizedValidation } from '@/shared/i18n/useLocalizedValidation';
import { PageBackButton } from '@/shared/ui/PageBackButton';
import { PageHead } from '@/shared/ui/PageHead';
import { PlatformShell } from '@/shared/ui/PlatformShell';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Radio, Switch, Tabs, Tag, Typography, Upload, message, type InputProps } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { UploadRequestOption } from 'rc-upload/lib/interface';
import {
  BRANDING_ADMIN_QUERY_KEY,
  BRANDING_QUERY_KEY,
  DEFAULT_BRANDING,
  IM_SELECTION_QUERY_KEY,
  PLATFORM_IM_CHANNELS_QUERY_KEY,
  THEME_PRESETS,
  getImSelection,
  getPlatformImChannels,
  getAdminBranding,
  selectImProvider,
  selectedImProvider,
  updateDingTalkImChannel,
  updateFeishuImChannel,
  updateWecomImChannel,
  updateBranding,
  uploadBrandingLogo,
  type PlatformImChannel,
  type PlatformBranding,
  type UpdateDingTalkImChannelParams,
  type UpdatePlatformBrandingParams,
} from './brandingApi';
import { GroupChatConfigPanel } from './GroupChatConfigPanel';
import { ImIdentityConflictAlert } from '@/shared/ui/ImIdentityConflictAlert';
import { NoticeTip } from '@/shared/ui/NoticeTip';
import './messageChannel.css';
import { PlatformAdminPanel } from './PlatformAdminPanel';
import { SsoConfigPanel } from './SsoConfigPanel';
import { UserManagementPanel } from './UserManagementPanel';
import { FeatureSwitchesPanel } from './FeatureSwitchesPanel';
import { MailSettingsPanel } from './MailSettingsPanel';
import { PageError } from '@/shared/ui/PageError';
import { WorkspacePageHeader } from '@/app/WorkspacePageHeader';
import { ApiError } from '@/shared/types/common';
import './brandingConfig.css';

const { Text } = Typography;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type BrandingColorInputProps = Omit<InputProps, 'value' | 'onChange'> & {
  value?: string;
  onChange?: (value: string) => void;
};

/** Both controls edit the same Form field; the native picker never receives an invalid draft. */
function BrandingColorInput({ value = '', onChange, disabled, id, ...inputProps }: BrandingColorInputProps) {
  const { t } = useTranslation('platform');
  const [lastValidColor, setLastValidColor] = useState(DEFAULT_BRANDING.primaryColor);
  const isValid = HEX_COLOR_PATTERN.test(value);
  useEffect(() => {
    if (isValid) setLastValidColor(value);
  }, [isValid, value]);

  return (
    <div className="aw-branding-color-row">
      <Input
        type="color"
        aria-label={t('chooseColor')}
        disabled={disabled}
        value={(isValid ? value : lastValidColor).toLowerCase()}
        onChange={(event) => onChange?.(event.target.value)}
      />
      <Input
        {...inputProps}
        id={id}
        className="aw-branding-color-hex"
        aria-label={t('primaryColorHex')}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  );
}

type ImRobotFormValues = UpdateDingTalkImChannelParams;

const BRANDING_TAB_KEY = 'branding';
const NOTIFICATION_TAB_KEY = 'notification';
const EMAIL_VERIFICATION_TAB_KEY = 'email-verification';
const FEATURE_SWITCH_TAB_KEY = 'feature-switches';
const PLATFORM_ADMIN_TAB_KEY = 'platform-admin';
const ENTERPRISE_SSO_TAB_KEY = 'enterprise-sso';
const USER_MANAGEMENT_TAB_KEY = 'user-management';
const PLATFORM_CONFIG_TAB_STORAGE_KEY = 'autowonder.platform-config.tab';
const ADMIN_ONLY_TAB_KEYS = new Set([NOTIFICATION_TAB_KEY, EMAIL_VERIFICATION_TAB_KEY,
  ENTERPRISE_SSO_TAB_KEY, USER_MANAGEMENT_TAB_KEY]);
const PLATFORM_CONFIG_TAB_KEYS = new Set([
  BRANDING_TAB_KEY,
  NOTIFICATION_TAB_KEY,
  EMAIL_VERIFICATION_TAB_KEY,
  FEATURE_SWITCH_TAB_KEY,
  PLATFORM_ADMIN_TAB_KEY,
  ENTERPRISE_SSO_TAB_KEY,
  USER_MANAGEMENT_TAB_KEY,
]);

function readPlatformConfigTab(): string {
  try {
    const savedTab = localStorage.getItem(PLATFORM_CONFIG_TAB_STORAGE_KEY);
    return savedTab && PLATFORM_CONFIG_TAB_KEYS.has(savedTab) ? savedTab : BRANDING_TAB_KEY;
  } catch {
    return BRANDING_TAB_KEY;
  }
}

const EMPTY_IM_CHANNEL: PlatformImChannel = {
  provider: 'DINGTALK',
  enabled: false,
  appKey: '',
  robotCode: '',
  secretConfigured: false,
  ready: false,
};

const FEISHU_DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis';
const FEISHU_PROVIDER = 'FEISHU';

const PROVIDER_ORDER = ['DINGTALK', 'FEISHU', 'WECOM'] as const;
const PROVIDER_LABEL_KEYS = {
  DINGTALK: 'dingtalk',
  FEISHU: 'feishu',
  WECOM: 'wecom',
} as const;

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

export function BrandingConfigPage() {
  const { t } = useTranslation('platform');
  const [form] = Form.useForm<UpdatePlatformBrandingParams>();
  const [imForm] = Form.useForm<ImRobotFormValues>();
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: BRANDING_ADMIN_QUERY_KEY,
    queryFn: getAdminBranding,
    retry: false,
  });
  const isPlatformAdmin = data?.canManage === true;
  const { data: imSelection, error: selectionError, refetch: refetchSelection } = useQuery({
    queryKey: IM_SELECTION_QUERY_KEY,
    queryFn: getImSelection,
    enabled: isPlatformAdmin,
    retry: false,
  });
  const {
    data: imChannels,
    error: imChannelsError,
    isLoading: isImChannelsLoading,
    refetch: refetchImChannels,
  } = useQuery({
    queryKey: PLATFORM_IM_CHANNELS_QUERY_KEY,
    queryFn: getPlatformImChannels,
    enabled: isPlatformAdmin,
    retry: false,
    // 企业微信连接状态由长连接实时上报，仅在选中该渠道时轮询。
    refetchInterval: imSelection?.provider === 'WECOM' ? 5000 : false,
  });

  const [activeTab, setActiveTab] = useState(readPlatformConfigTab);
  // 通知深链携带的合法查询参数优先于标签页记忆（例如 status=PENDING_REVIEW / userId）。
  const [searchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  useEffect(() => {
    if (urlTab && PLATFORM_CONFIG_TAB_KEYS.has(urlTab)) {
      setActiveTab(urlTab);
    }
  }, [urlTab]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [notificationDirty, setNotificationDirty] = useState(false);
  const [groupChatDirty, setGroupChatDirty] = useState(false);
  const channelWriteLock = useRef(false);
  const seededNotificationProvider = useRef<string>();
  const [notificationSubmitting, setNotificationSubmitting] = useState(false);
  const [groupChatSubmitting, setGroupChatSubmitting] = useState(false);
  const [switchSubmitting, setSwitchSubmitting] = useState(false);
  const [switchTarget, setSwitchTarget] = useState('');
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [imConflictError, setImConflictError] = useState<unknown>(null);
  // 管理员专属页签（消息渠道、邮箱验证、企业 SSO、用户管理）不会对非管理员渲染；历史存储值落回品牌配置，避免空白页。
  const resolvedActiveTab = !isPlatformAdmin && ADMIN_ONLY_TAB_KEYS.has(activeTab)
    ? BRANDING_TAB_KEY
    : activeTab;
  useLocalizedValidation(form, !error && resolvedActiveTab === BRANDING_TAB_KEY);
  useLocalizedValidation(imForm, isPlatformAdmin && !error && !imChannelsError && !selectionError);
  const provider = imSelection?.provider ?? (imChannels ? selectedImProvider(imChannels) : 'DINGTALK');
  const providerLabelOf = (value: string) => {
    const key = PROVIDER_LABEL_KEYS[value as keyof typeof PROVIDER_LABEL_KEYS];
    return key ? t(key) : value;
  };
  const selectionKnown = !selectionError && (provider === FEISHU_PROVIDER || provider === 'DINGTALK' || provider === 'WECOM');
  const providerLabel = selectionKnown ? providerLabelOf(provider) : t('groupChatStatusUnknown');
  const messageWritesAvailable = isPlatformAdmin && selectionKnown && imChannels != null && !imChannelsError;
  const messageWritesAvailableRef = useRef(messageWritesAvailable);
  messageWritesAvailableRef.current = messageWritesAvailable;
  const channelBusy = notificationSubmitting || groupChatSubmitting || switchSubmitting;
  const notificationDisabled = !messageWritesAvailable || channelBusy;
  const current = data || DEFAULT_BRANDING;
  const imChannel = imChannels?.find((item) => item.provider === provider) || EMPTY_IM_CHANNEL;
  // Keep the saved secret/ready indicators visible without duplicating the draft switch state.
  const imAppSecret = Form.useWatch('appSecret', imForm) || '';
  const hasImSecret = imChannel.secretConfigured || Boolean(imAppSecret);
  const imReady = Boolean(imChannel.ready);
  const themeKey = Form.useWatch('themeKey', form) ?? current.themeKey;
  const primaryColor = Form.useWatch('primaryColor', form) ?? current.primaryColor;
  // Keep a supported themeKey in the payload, but never highlight a preset for a different color.
  const selectedTheme = THEME_PRESETS.find((theme) =>
    theme.key === themeKey && theme.primaryColor.toLowerCase() === primaryColor.toLowerCase())?.key;
  const isWecom = provider === 'WECOM';
  const wecomConnection = imChannel.connectionStatus ?? 'UNKNOWN';
  const wecomConnectionLabelKey = WECOM_CONNECTION_LABEL_KEYS[
    wecomConnection as keyof typeof WECOM_CONNECTION_LABEL_KEYS
  ];
  const wecomConnectionLabel = wecomConnectionLabelKey ? t(wecomConnectionLabelKey) : t('wecomConnectionUnknown');
  const wecomReadinessReasons: string[] = [];
  if (isWecom) {
    if (!imChannel.enabled) wecomReadinessReasons.push(t('wecomNotReadyDisabled'));
    if (!imChannel.secretConfigured) wecomReadinessReasons.push(t('wecomNotReadySecret'));
    if (!imReady && imChannel.enabled && imChannel.secretConfigured) {
      wecomReadinessReasons.push(t('wecomNotReadyConfig'));
    }
    if (wecomConnection !== WECOM_CONNECTED) {
      wecomReadinessReasons.push(t('wecomNotReadyConnection', { status: wecomConnectionLabel }));
    }
  }
  const appKeyLabel = provider === 'FEISHU' ? t('notificationAppIdLabel') : isWecom ? t('wecomBotId') : t('notificationAppKeyLabel');
  const appKeyPlaceholder = provider === 'FEISHU' ? 'cli_xxxxxx' : isWecom ? t('wecomBotIdPlaceholder') : 'dingxxxxxx';
  const appKeyRequiredMessage = isWecom ? t('wecomBotIdRequired') : t('appKeyRequired');
  const appSecretLabel = isWecom ? t('wecomSecret') : t('notificationAppSecretLabel');
  const appSecretRequiredMessage = isWecom ? t('wecomSecretRequired') : t('appSecretRequired');

  useEffect(() => {
    if (data) {
      form.setFieldsValue({
        platformName: data.platformName,
        themeKey: data.themeKey,
        primaryColor: data.primaryColor,
        domain: data.domain || '',
      });
    }
  }, [data, form]);

  useEffect(() => {
    if (!imChannels || !provider || !selectionKnown) return;
    if (notificationDirty && seededNotificationProvider.current === provider) return;
    const channel = imChannels.find((item) => item.provider === provider) || EMPTY_IM_CHANNEL;
    imForm.setFieldsValue({
      enabled: channel.enabled,
      appKey: channel.appKey || '',
      robotCode: channel.robotCode || '',
      baseUrl: channel.baseUrl || '',
      appSecret: '',
    });
    seededNotificationProvider.current = provider;
    setNotificationDirty(false);
  }, [imForm, imChannels, provider, notificationDirty, selectionKnown]);

  const saveMutation = useMutation({
    mutationFn: updateBranding,
    onSuccess: async (branding) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: BRANDING_ADMIN_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: BRANDING_QUERY_KEY }),
      ]);
      queryClient.setQueryData(BRANDING_ADMIN_QUERY_KEY, branding);
      queryClient.setQueryData(BRANDING_QUERY_KEY, { ...branding, canManage: false });
      message.success(i18n.t('platform:brandingSaved'));
    },
    onError: (error: Error) => message.error(error.message || i18n.t('platform:brandingSaveFailed')),
  });

  const imMutation = useMutation({
    mutationFn: ({ targetProvider, params }: { targetProvider: string; params: UpdateDingTalkImChannelParams }) => targetProvider === 'FEISHU' ? updateFeishuImChannel(params) : targetProvider === 'WECOM' ? updateWecomImChannel(params) : updateDingTalkImChannel(params),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PLATFORM_IM_CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['user-im-identities'] }),
        queryClient.invalidateQueries({ queryKey: ['notify-prefs'] }),
        queryClient.invalidateQueries({ queryKey: ['settings', 'NOTIFY'] }),
      ]);
      imForm.setFieldValue('appSecret', '');
      setNotificationDirty(false);
      message.success(i18n.t('platform:imSaved'));
    },
    onError: (error: Error) => {
      setImConflictError(error);
      message.error(error.message || i18n.t('platform:imSaveFailed'));
    },
  });

  const selectionMutation = useMutation({
    mutationFn: ({ next, generation }: { next: string; generation: number }) => selectImProvider(next, generation),
    onSuccess: async (saved) => {
      queryClient.setQueryData(IM_SELECTION_QUERY_KEY, saved);
      setNotificationDirty(false);
      setGroupChatDirty(false);
      setSwitchOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PLATFORM_IM_CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['user-im-identities'] }),
        queryClient.invalidateQueries({ queryKey: ['notify-prefs'] }),
        queryClient.invalidateQueries({ queryKey: ['settings', 'NOTIFY'] }),
      ]);
      message.success(i18n.t('platform:imSelectionSaved'));
    },
    onError: (error: Error) => {
      message.error(error.message || i18n.t('platform:imSelectionSaveFailed'));
    },
  });

  const logoMutation = useMutation({
    mutationFn: uploadBrandingLogo,
    onSuccess: async ({ logoUrl }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: BRANDING_ADMIN_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: BRANDING_QUERY_KEY }),
      ]);
      queryClient.setQueryData<PlatformBranding>(BRANDING_ADMIN_QUERY_KEY, (previous) => ({
        ...(previous || current), logoUrl,
      }));
      queryClient.setQueryData<PlatformBranding>(BRANDING_QUERY_KEY, (previous) => ({
        ...(previous || current), logoUrl, canManage: false,
      }));
      message.success(i18n.t('platform:logoUploaded'));
    },
    onError: (error: Error) => message.error(error.message || i18n.t('platform:logoUploadFailed')),
  });

  const handleUpload = async (options: UploadRequestOption) => {
    try {
      await logoMutation.mutateAsync(options.file as File);
      options.onSuccess?.({}, new XMLHttpRequest());
    } catch (error) {
      options.onError?.(error as Error);
    }
  };

  const handleImSubmit = async () => {
    if (!messageWritesAvailable || !provider || channelWriteLock.current) return;
    channelWriteLock.current = true;
    setNotificationSubmitting(true);
    setImConflictError(null);
    const targetProvider = provider;
    try {
      const values = await imForm.validateFields();
      if (!messageWritesAvailableRef.current) return;
      await imMutation.mutateAsync({
        targetProvider,
        params: {
          enabled: values.enabled,
          appKey: values.appKey || '',
          appSecret: values.appSecret || '',
          robotCode: values.robotCode || '',
          ...(targetProvider === FEISHU_PROVIDER ? { baseUrl: values.baseUrl || '' } : {}),
        },
      });
    } catch {
      // Validation retains field errors; mutation callbacks retain server diagnostics.
    } finally {
      channelWriteLock.current = false;
      setNotificationSubmitting(false);
    }
  };

  const handleSwitch = async () => {
    if (!messageWritesAvailable || !imSelection || channelWriteLock.current) return;
    if (!switchTarget || switchTarget === imSelection.provider) {
      setSwitchError(t('switchChannelSameTarget'));
      return;
    }
    channelWriteLock.current = true;
    setSwitchSubmitting(true);
    try {
      await selectionMutation.mutateAsync({
        next: switchTarget,
        generation: imSelection.generation,
      });
    } catch {
      // A failed switch keeps the dialog and both drafts available for correction.
    } finally {
      channelWriteLock.current = false;
      setSwitchSubmitting(false);
    }
  };

  const beginGroupChatSubmit = () => {
    if (!messageWritesAvailableRef.current || channelWriteLock.current) return false;
    channelWriteLock.current = true;
    return true;
  };

  const handleGroupChatPending = (pending: boolean) => {
    setGroupChatSubmitting(pending);
    if (!pending) channelWriteLock.current = false;
  };

  const brandingDisabled = !isPlatformAdmin || isLoading || saveMutation.isPending;

  if (error) {
    const apiError = error instanceof ApiError ? error : null;
    return (
      <PlatformShell topbar={<WorkspacePageHeader />}>
        <PageError
          status="500"
          title={t('systemError')}
          subTitle={apiError?.message}
          traceId={apiError?.traceId}
        />
      </PlatformShell>
    );
  }

  const brandingPane = (
    <>
      <NoticeTip kind="info" className="aw-branding-hint" title={t('brandingHint')} />

      <Form
        form={form}
        layout="vertical"
        disabled={brandingDisabled}
        onFinish={(values) => { if (isPlatformAdmin) saveMutation.mutate(values); }}
        initialValues={DEFAULT_BRANDING}
      >
        <Form.Item name="themeKey" hidden><Input /></Form.Item>
        <div className="aw-branding-grid">
          <Card title={t('basicInfo')}>
            <div className="aw-branding-basic-fields">
              <Form.Item
                label={t('platformName')}
                name="platformName"
                rules={[{ required: true, message: t('platformNameRequired') }]}
              >
                <Input maxLength={128} placeholder="AutoWonder" />
              </Form.Item>
              <Form.Item
                label={t('domain')}
                name="domain"
                extra={t('domainHint')}
              >
                <Input placeholder="https://wonder.example.com" />
              </Form.Item>
            </div>
          </Card>

          <Card title={t('logo')}>
            <div className="aw-branding-logo-row">
              <div className="aw-branding-logo-box">
                <img src={current.logoUrl || '/logo.svg'} alt={current.platformName} onError={(e) => { const image = e.currentTarget; if (!image.dataset.fb) { image.dataset.fb = '1'; image.src = '/logo.svg'; } }} />
              </div>
              <div className="aw-branding-logo-actions">
                <Upload
                  showUploadList={false}
                  disabled={brandingDisabled || logoMutation.isPending}
                  accept=".png,.jpg,.jpeg,.webp,.svg,.gif,.ico,.avif,image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/x-icon,image/vnd.microsoft.icon,image/avif"
                  beforeUpload={(file) => {
                    if (file.size > 512 * 1024) {
                      message.error(t('logoTooLarge'));
                      return Upload.LIST_IGNORE;
                    }
                    return true;
                  }}
                  customRequest={handleUpload}
                >
                  <Button
                    icon={<AwStrokeIcon name="upload" />}
                    aria-label={t('uploadLogo')}
                    disabled={brandingDisabled}
                    loading={logoMutation.isPending}
                  >
                    {t('uploadLogo')}
                  </Button>
                </Upload>
                <Text type="secondary" className="aw-branding-logo-hint">{t('logoHint')}</Text>
              </div>
            </div>
          </Card>

          <Card title={t('themeColors')}>
            <Typography.Paragraph type="secondary" className="aw-branding-accent-hint">{t('accentHint')}</Typography.Paragraph>
            <div className="aw-branding-theme-fields">
              <Form.Item label={t('presetColors')}>
                <Radio.Group
                  value={selectedTheme ?? null}
                  className="aw-branding-presets"
                  onChange={(event) => {
                    const preset = THEME_PRESETS.find((item) => item.key === event.target.value);
                    if (preset) {
                      form.setFieldsValue({ themeKey: preset.key, primaryColor: preset.primaryColor });
                    }
                  }}
                >
                  {THEME_PRESETS.map((theme) => (
                    <Radio.Button
                      key={theme.key}
                      value={theme.key}
                      style={{ borderColor: selectedTheme === theme.key ? primaryColor : 'var(--aw-border)' }}
                    >
                      <span className="aw-branding-preset-label">
                        <span aria-hidden="true" className="aw-branding-preset-dot" style={{ background: theme.primaryColor }} />
                        <span>{t(`themes.${theme.key}`)}</span>
                      </span>
                    </Radio.Button>
                  ))}
                </Radio.Group>
              </Form.Item>
              <Form.Item
                label={t('primaryColor')}
                name="primaryColor"
                extra={t('primaryColorHint')}
                rules={[{ required: true, pattern: HEX_COLOR_PATTERN, message: t('colorRequired') }]}
              >
                <BrandingColorInput disabled={brandingDisabled} />
              </Form.Item>
            </div>
          </Card>
        </div>

        <div className="aw-branding-save-bar">
          <Button
            type="primary"
            htmlType="submit"
            icon={<AwStrokeIcon name="check" />}
            aria-label={t('saveBranding')}
            loading={saveMutation.isPending}
          >
            {t('saveBranding')}
          </Button>
        </div>
      </Form>
    </>
  );

  const otherProviders = PROVIDER_ORDER.filter((item) => item !== provider);
  const imDirty = notificationDirty || groupChatDirty;
  const notificationPane = (
    <div className="aw-platform-message-panels">
      {!isPlatformAdmin && <NoticeTip kind="info" title={t('imReadOnly')} />}
      <Card className="aw-platform-message-card">
        {selectionError && <NoticeTip
          kind="error" title={t('imSelectionLoadFailed')}
          detail={selectionError instanceof Error ? selectionError.message : t('retryLater')}
          action={<Button onClick={() => { void refetchSelection(); }}>{t('ssoRetry')}</Button>}
        />}
        <div className="aw-channel-header">
          <div>
            <Text strong>{t('currentChannel', { provider: providerLabel })}</Text>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('currentChannelHint')}</Text>
            </div>
          </div>
          <Button
            onClick={() => {
              if (channelWriteLock.current || !messageWritesAvailable) return;
              setSwitchTarget(otherProviders[0]);
              setSwitchError(null);
              setSwitchOpen(true);
            }}
            disabled={notificationDisabled}
          >
            {selectionKnown
              ? t('switchChannel', { provider: providerLabelOf(otherProviders[0]) })
              : t('switchChannelPending')}
          </Button>
        </div>
      </Card>

      {imChannelsError ? (
        <Card className="aw-platform-message-card">
          <NoticeTip
            kind="error"
            title={t('imLoadFailed')}
            detail={imChannelsError instanceof Error ? imChannelsError.message : t('retryLater')}
            action={<Button onClick={() => { void refetchImChannels(); }}>{t('ssoRetry')}</Button>}
          />
        </Card>
      ) : (
        <Card
          title={
            <div className="aw-config-card-title">
              <span>{t('notificationSection')}</span>
              <div className="aw-config-tags" aria-live="polite">
                {selectionKnown && imChannels ? (
                  <>
                    <Tag color={imChannel.enabled ? 'green' : undefined} className={imChannel.enabled ? undefined : 'aw-tag-gray'}>{imChannel.enabled ? t('savedEnabled') : t('savedDisabled')}</Tag>
                    <Tag color={hasImSecret ? 'green' : undefined} className={hasImSecret ? undefined : 'aw-tag-gray'}>{hasImSecret ? t('secretConfigured') : t('secretMissing')}</Tag>
                    <Tag color={imReady ? 'green' : 'orange'}>{imReady ? t('ready') : t('notReady')}</Tag>
                    {isWecom && (
                      <Tag color={WECOM_CONNECTION_COLORS[wecomConnection] ?? 'default'}>
                        {t('wecomConnectionLabel', { status: wecomConnectionLabel })}
                      </Tag>
                    )}
                  </>
                ) : <Tag className="aw-tag-gray">{t('groupChatStatusUnknown')}</Tag>}
              </div>
            </div>
          }
          extra={
            <Button
              type="primary"
              aria-label={t('saveIm')}
              loading={notificationSubmitting}
              disabled={notificationDisabled}
              onClick={handleImSubmit}
            >
              {t('saveIm')}
            </Button>
          }
          className="aw-platform-message-card"
        >
          <Form
            form={imForm}
            name="imNotification"
            layout="vertical"
            className="aw-im-form"
            aria-busy={isImChannelsLoading || notificationSubmitting}
            disabled={notificationDisabled}
            initialValues={{
              enabled: false,
              appKey: '',
              appSecret: '',
              robotCode: '',
              baseUrl: '',
            }}
            onValuesChange={() => {
              setImConflictError(null);
              setNotificationDirty(true);
            }}
          >
            <input className="aw-autofill-decoy" type="text" aria-hidden="true" tabIndex={-1} autoComplete="off" />
            <input className="aw-autofill-decoy" type="password" aria-hidden="true" tabIndex={-1} autoComplete="current-password" />
            <div className="aw-channel-section">
              <Typography.Text type="secondary">{t('notificationSectionHint')}</Typography.Text>

              {isWecom && (
                <Alert
                  type={wecomConnection === WECOM_CONNECTED && imReady ? 'success' : 'warning'}
                  showIcon
                  message={t('wecomConnectionSeparate')}
                  description={wecomReadinessReasons.length > 0
                    ? <>{wecomReadinessReasons.map((reason) => <div key={reason}>{reason}</div>)}</>
                    : t('wecomReadyHint')}
                />
              )}

              <div className="aw-config-check-row">
                <label className="aw-config-check">
                  <Form.Item name="enabled" valuePropName="checked" noStyle>
                    <Switch size="small" aria-label={t('enableRobot', { provider: providerLabel })} />
                  </Form.Item>
                  <span>{t('notificationEnableDraft')}</span>
                </label>
                <p className="aw-config-help">{notificationDirty ? t('notificationDirtyHint') : t('notificationDraftHint')}</p>
              </div>

              <div className="aw-platform-message-fields">
                <Form.Item label={appKeyLabel} name="appKey" validateTrigger={[]} rules={[({ getFieldValue }) => ({ validator: (_, value) => !getFieldValue('enabled') || value ? Promise.resolve() : Promise.reject(new Error(appKeyRequiredMessage)) })]}>
                  <Input placeholder={appKeyPlaceholder} />
                </Form.Item>
                {provider === 'DINGTALK' && <Form.Item label={t('notificationRobotCodeLabel')} name="robotCode" validateTrigger={[]} rules={[({ getFieldValue }) => ({ validator: (_, value) => !getFieldValue('enabled') || value ? Promise.resolve() : Promise.reject(new Error(t('robotCodeRequired'))) })]}>
                  <Input placeholder="robot_xxxxxx" />
                </Form.Item>}
                {provider === FEISHU_PROVIDER && <Form.Item label={t('feishuBaseUrlLabel')} name="baseUrl" extra={t('feishuBaseUrlHint')}>
                  <Input placeholder={FEISHU_DEFAULT_BASE_URL} />
                </Form.Item>}
                <Form.Item
                  label={appSecretLabel}
                  name="appSecret"
                  validateTrigger={[]}
                  rules={[({ getFieldValue }) => ({ validator: (_, value) => !getFieldValue('enabled') || value || imChannel.secretConfigured ? Promise.resolve() : Promise.reject(new Error(appSecretRequiredMessage)) })]}
                  extra={imChannel.secretConfigured ? t('notificationSecretConfiguredHint') : t('notificationSecretMissingHint')}
                >
                  <Input.Password autoComplete="new-password" iconRender={visible => <Button type="text" htmlType="button" aria-label={t(visible ? 'hideSecret' : 'showSecret')} disabled={notificationDisabled} icon={visible ? <EyeOutlined aria-hidden="true" /> : <EyeInvisibleOutlined aria-hidden="true" />} />} placeholder={imChannel.secretConfigured ? t('keepSecret') : t('secretPlaceholder')} />
                </Form.Item>
              </div>

              {imConflictError != null && <ImIdentityConflictAlert error={imConflictError} />}
            </div>
          </Form>
        </Card>
      )}
      {isPlatformAdmin && selectionKnown && provider && <GroupChatConfigPanel
        key={provider}
        provider={provider}
        disabled={!messageWritesAvailable || notificationSubmitting || switchSubmitting}
        onBeforeSubmit={beginGroupChatSubmit}
        onPendingChange={handleGroupChatPending}
        onDirtyChange={setGroupChatDirty}
      />}

      <Modal
        open={switchOpen}
        className="aw-platform-channel-modal"
        width={520}
        title={t('switchChannelTitle')}
        okText={t('confirmSwitchChannel', { provider: providerLabelOf(switchTarget) })}
        cancelText={t('cancel')}
        confirmLoading={switchSubmitting}
        okButtonProps={{ disabled: notificationDisabled }}
        cancelButtonProps={{ disabled: switchSubmitting }}
        closable={!switchSubmitting}
        keyboard={!switchSubmitting}
        maskClosable={!switchSubmitting}
        onOk={handleSwitch}
        onCancel={() => { if (!channelWriteLock.current) setSwitchOpen(false); }}
        destroyOnClose
      >
        <p>{t('switchChannelBody')}</p>
        <Radio.Group
          value={switchTarget}
          onChange={(event) => setSwitchTarget(event.target.value)}
          options={otherProviders.map((item) => ({ label: providerLabelOf(item), value: item }))}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}
        />
        {imDirty && <NoticeTip kind="warning" title={t('switchChannelDirty')} />}
        {switchError != null && <p className="aw-channel-switch-error" role="alert">{switchError}</p>}
      </Modal>
    </div>
  );

  return (
    <PlatformShell topbar={<WorkspacePageHeader />}>
      <div className="aw-branding-config">
        <PageHead
          title={t('configuration')}
          description={t('configurationDescription')}
          actions={<PageBackButton to="/workspaces" label={t('backWorkspaces')} compact={false} />}
        />

        <Tabs
          activeKey={resolvedActiveTab}
          onChange={(key) => {
            setActiveTab(key);
            try {
              localStorage.setItem(PLATFORM_CONFIG_TAB_STORAGE_KEY, key);
            } catch {
              // Browser policy may deny persistence; current-page switching still works.
            }
          }}
          items={[
            { key: BRANDING_TAB_KEY, label: t('brandingTab'), children: brandingPane },
            ...(isPlatformAdmin ? [{
              key: NOTIFICATION_TAB_KEY,
              label: t('notificationTab'),
              // imForm is seeded by an effect in this component and read through useWatch here,
              // so the pane must stay mounted; a lazily mounted pane would leave the form instance
              // disconnected from any rendered Form element.
              forceRender: true,
              children: notificationPane,
            }] : []),
            ...(isPlatformAdmin ? [{
              key: EMAIL_VERIFICATION_TAB_KEY,
              label: t('emailVerificationTab'),
              children: <MailSettingsPanel />,
            }] : []),
            {
              key: FEATURE_SWITCH_TAB_KEY,
              label: t('featureSwitchTab'),
              children: <FeatureSwitchesPanel canManage={isPlatformAdmin} />,
            },
            { key: PLATFORM_ADMIN_TAB_KEY, label: t('adminTab'), children: <PlatformAdminPanel /> },
            ...(isPlatformAdmin
              ? [{ key: ENTERPRISE_SSO_TAB_KEY, label: t('ssoTab'), children: <SsoConfigPanel branding={data} /> }]
              : []),
            ...(isPlatformAdmin
              ? [{ key: USER_MANAGEMENT_TAB_KEY, label: t('userTab'), children: <UserManagementPanel /> }]
              : []),
          ]}
        />
      </div>
    </PlatformShell>
  );
}
