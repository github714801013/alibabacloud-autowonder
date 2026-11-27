import { i18n } from '@/shared/i18n';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { BrandingConfigPage } from './BrandingConfigPage';
import type { UpdateDingTalkImChannelParams } from './brandingApi';
import * as brandingApi from './brandingApi';
import { AppearanceProvider } from '@/shared/theme/AppearanceProvider';
import { useAuthStore } from '@/shared/auth/store';

function brandingPayload() {
  return {
    success: true,
    code: '0',
    message: '',
    traceId: null,
    data: {
      platformName: 'AutoWonder',
      logoUrl: '/logo.png',
      themeKey: 'aliyun-orange',
      primaryColor: '#f97316',
      domain: 'https://community.example',
      mcpBaseUrl: 'https://community.example/api/mcp',
      canManage: true,
    },
  };
}

function imChannelsPayload() {
  return {
    success: true,
    code: '0',
    message: '',
    traceId: null,
    data: [
      {
        provider: 'DINGTALK',
        enabled: true,
        appKey: 'ding-app',
        robotCode: 'ding-robot',
        secretConfigured: true,
        ready: true,
      },
    ],
  };
}

function imSelectionPayload(provider = 'DINGTALK', generation = 1) {
  return {
    success: true,
    code: '0',
    message: '',
    traceId: null,
    data: { provider, generation, activatedAt: null },
  };
}

function groupChatPayload(provider: string) {
  return {
    success: true,
    code: '0',
    message: '',
    traceId: null,
    data: {
      provider,
      configured: false,
      ready: false,
      desiredEnabled: false,
      selected: provider === 'DINGTALK',
      appKey: null,
      robotCode: null,
      secretConfigured: false,
      verificationTokenConfigured: false,
      encryptKeyConfigured: false,
      version: null,
      routeVersion: 1,
      selectionGeneration: 1,
      status: 'DISABLED',
      drainingCount: 0,
      failedCount: 0,
      unknownCount: 0,
    },
  };
}

const clients: QueryClient[] = [];
const pendingResponses = new Set<() => void>();

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspaces/branding']}>
        <BrandingConfigPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-path">{location.pathname}</span>;
}

function renderPageWithLocation() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspaces/branding']}>
        <BrandingConfigPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** antd Tabs mounts a pane only once its tab has been activated. */
async function openNotificationTab() {
  await userEvent.click(await screen.findByRole('tab', { name: '消息渠道' }));
}

async function openPlatformAdminTab() {
  await userEvent.click(await screen.findByRole('tab', { name: '平台管理员' }));
}

async function openEnterpriseSsoTab() {
  await userEvent.click(await screen.findByRole('tab', { name: '企业 SSO' }));
}

async function openUserManagementTab() {
  await userEvent.click(await screen.findByRole('tab', { name: '用户管理' }));
}

describe('BrandingConfigPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    vi.restoreAllMocks();
    vi.spyOn(message, 'success').mockImplementation(
      () => undefined as unknown as ReturnType<typeof message.success>,
    );
    vi.spyOn(message, 'error').mockImplementation(
      () => undefined as unknown as ReturnType<typeof message.error>,
    );
    useAuthStore.getState().clear();
    window.localStorage.clear();
    useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'ADMIN');
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
      http.get('/api/platform/im-channels', () => HttpResponse.json(imChannelsPayload())),
      http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload())),
      http.get('/api/platform/im-channels/DINGTALK/group-chat', () => HttpResponse.json(groupChatPayload('DINGTALK'))),
      http.get('/api/platform/im-channels/FEISHU/group-chat', () => HttpResponse.json(groupChatPayload('FEISHU'))),
    );
  });

  afterEach(async () => {
    pendingResponses.forEach((release) => release());
    pendingResponses.clear();
    try {
      await waitFor(() => clients.forEach((client) => expect(client.isMutating()).toBe(0)));
    } finally {
      cleanup();
      clients.splice(0).forEach((client) => client.clear());
      vi.restoreAllMocks();
      message.destroy();
      await i18n.changeLanguage('zh-CN');
    }
  });

  it('opens user management for a ?tab= deep link', async () => {
    server.use(http.get('/api/platform/users', () => HttpResponse.json({
      success: true,
      code: '0',
      message: '',
      data: { totalAll: 0, total: 0, pageNum: 1, pageSize: 20, list: [] },
      traceId: null,
    })));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(queryClient);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/workspaces/branding?tab=user-management']}>
          <BrandingConfigPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('全部用户 0 人')).toBeInTheDocument();
  });

  it('uses the existing standalone shell, page head and three ordered branding cards', async () => {
    const { container } = renderPage();
    const heading = await screen.findByRole('heading', { name: '平台配置', level: 1 });
    expect(heading).toHaveClass('aw-page-title');
    expect(container.querySelectorAll('.aw-platform-shell')).toHaveLength(1);
    const main = container.querySelector('.aw-platform-shell > main.ws-wrap');
    expect(main).toContainElement(heading);
    expect(main).toContainElement(screen.getByRole('button', { name: /返回工作空间列表/ }));
    expect(screen.getByText('管理平台品牌与主题、消息渠道、功能开关、平台管理员、企业 SSO 和用户。')).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll('.aw-branding-grid > .ant-card .ant-card-head-title'))
      .map((element) => element.textContent)).toEqual(['基础信息', 'Logo', '主题配色']);
    await screen.findByRole('tab', { name: '用户管理' });
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    expect(screen.getAllByRole('radio')).toHaveLength(11);
    expect(container.querySelectorAll('.aw-page-header')).toHaveLength(1);
    expect(screen.queryByText('主题实时预览')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置' })).not.toBeInTheDocument();
  });

  it('synchronizes hex text, native color and preset selection while preserving a supported theme key', async () => {
    const update = vi.spyOn(brandingApi, 'updateBranding').mockImplementation(async (values) => ({
      ...brandingApi.DEFAULT_BRANDING, ...values, canManage: true,
    }));
    renderPage();
    const hex = screen.getByRole('textbox', { name: '主色十六进制值' });
    const picker = screen.getByLabelText('选择主色');
    await waitFor(() => expect(hex).toHaveValue('#f97316'));
    expect(screen.getByRole('radio', { name: '阿里橙' })).toBeChecked();
    expect(hex).toHaveClass('aw-branding-color-hex');

    await userEvent.click(screen.getByRole('radio', { name: '海洋蓝' }).closest('label')!);
    expect(hex).toHaveValue('#2563eb');
    expect(picker).toHaveValue('#2563eb');
    expect(screen.getByRole('radio', { name: '海洋蓝' })).toBeChecked();

    fireEvent.change(hex, { target: { value: '#AbCdEf' } });
    expect(hex).toHaveValue('#AbCdEf');
    expect(picker).toHaveValue('#abcdef');
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /保存配置/ }));
    await waitFor(() => expect(update.mock.calls[0]?.[0]).toEqual({
      platformName: 'AutoWonder', domain: 'https://community.example',
      themeKey: 'ocean-blue', primaryColor: '#AbCdEf',
    }));
    await waitFor(() => expect(hex).toBeEnabled());

    fireEvent.change(picker, { target: { value: '#123456' } });
    expect(hex).toHaveValue('#123456');
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: '默认' }).closest('label')!);
    expect(hex).toHaveValue('#0064C8');
    expect(picker).toHaveValue('#0064c8');
    expect(screen.getByRole('radio', { name: '默认' })).toBeChecked();
  });

  it.each(['', 'orange', '#123', '#gggggg', '#1234567'])('blocks saving invalid hex draft %j without passing it to the native picker', async (draft) => {
    const update = vi.spyOn(brandingApi, 'updateBranding');
    renderPage();
    const hex = screen.getByRole('textbox', { name: '主色十六进制值' });
    await waitFor(() => {
      expect(hex).toBeEnabled();
      expect(hex).toHaveValue('#f97316');
    });
    fireEvent.change(hex, { target: { value: draft } });
    expect(hex).toHaveValue(draft);
    expect(screen.getByLabelText('选择主色')).toHaveValue('#f97316');
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /保存配置/ }));
    expect(await screen.findByText('请输入 #RRGGBB 格式颜色')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves invalid draft and translates color validation, help and the page description in both languages', async () => {
    const update = vi.spyOn(brandingApi, 'updateBranding');
    renderPage();
    const hex = screen.getByRole('textbox', { name: '主色十六进制值' });
    await waitFor(() => {
      expect(hex).toBeEnabled();
      expect(hex).toHaveValue('#f97316');
    });
    fireEvent.change(hex, { target: { value: 'raw draft' } });
    await userEvent.click(screen.getByRole('button', { name: /保存配置/ }));
    await screen.findByText('请输入 #RRGGBB 格式颜色');
    try {
      await act(async () => { await i18n.changeLanguage('en-US'); });
      expect(await screen.findByText('Enter a color in #RRGGBB format')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Primary color hex value' })).toBe(hex);
      expect(hex).toHaveValue('raw draft');
      expect(hex).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Choose primary color')).toHaveValue('#f97316');
      expect(screen.getByText('Manage the platform brand and theme, message channels, feature switches, platform administrators, enterprise SSO and users.')).toBeInTheDocument();
      expect(screen.getByText(/Use the color control on the left or enter a #RRGGBB value/)).toBeInTheDocument();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
    }
    expect(await screen.findByText('请输入 #RRGGBB 格式颜色')).toBeInTheDocument();
    expect(hex).toHaveValue('raw draft');
  });

  it('keeps non-platform-admin branding readable but prevents editing, saving and uploading', async () => {
    const update = vi.spyOn(brandingApi, 'updateBranding');
    const upload = vi.spyOn(brandingApi, 'uploadBrandingLogo');
    server.use(http.get('/api/platform/branding', () => HttpResponse.json({
      ...brandingPayload(), data: { ...brandingPayload().data, canManage: false },
    })));
    const { container } = renderPage();
    const name = screen.getByLabelText('平台名称');
    await waitFor(() => expect(screen.getByRole('textbox', { name: '主色十六进制值' })).toHaveValue('#f97316'));
    expect(name).toHaveValue('AutoWonder');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('部署域名')).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '主色十六进制值' })).toHaveValue('#f97316');
    expect(screen.getByRole('textbox', { name: '主色十六进制值' })).toBeDisabled();
    expect(screen.getByLabelText('选择主色')).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('radio', { name: '阿里橙' })).toBeChecked();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
    const save = screen.getByRole('button', { name: /保存配置/ });
    const uploadButton = screen.getByRole('button', { name: '上传 Logo' });
    expect(save).toBeDisabled();
    expect(uploadButton).toBeDisabled();
    await userEvent.click(save);
    await userEvent.click(uploadButton);
    expect(update).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /返回工作空间列表/ })).toBeEnabled();
  });

  it('does not highlight a saved theme key whose custom primary color differs', async () => {
    server.use(http.get('/api/platform/branding', () => HttpResponse.json({
      ...brandingPayload(), data: { ...brandingPayload().data, primaryColor: '#112233' },
    })));
    renderPage();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '主色十六进制值' })).toHaveValue('#112233'));
    expect(screen.getByLabelText('选择主色')).toHaveValue('#112233');
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
  });

  it('rejects logos above 512 KB and accepts the exact limit', async () => {
    const upload = vi.spyOn(brandingApi, 'uploadBrandingLogo').mockResolvedValue({ logoUrl: '/api/platform/branding/logo?v=2' });
    const { container } = renderPage();
    await screen.findByText('上传 Logo');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    await userEvent.upload(input, new File([new Uint8Array(512 * 1024 + 1)], 'large.png', { type: 'image/png' }));
    await waitFor(() => expect(message.error).toHaveBeenCalledWith('Logo 文件不能超过 512 KB'));
    expect(upload).not.toHaveBeenCalled();
    const nextInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(nextInput, new File([new Uint8Array(512 * 1024)], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it('uploads each supported logo format through the file picker', async () => {
    const upload = vi.spyOn(brandingApi, 'uploadBrandingLogo').mockResolvedValue({ logoUrl: '/api/platform/branding/logo?v=2' });
    const { container } = renderPage();
    await screen.findByText('上传 Logo');
    const files = [
      ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'], ['svg', 'image/svg+xml'], ['gif', 'image/gif'],
      ['ico', 'image/x-icon'], ['ico', 'image/vnd.microsoft.icon'], ['avif', 'image/avif'],
    ];
    for (const [ext, type] of files) {
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      const count = upload.mock.calls.length;
      await userEvent.upload(input, new File(['logo'], `logo.${ext}`, { type }));
      await waitFor(() => expect(upload).toHaveBeenCalledTimes(count + 1));
      expect(upload.mock.calls[count][0]).toMatchObject({ name: `logo.${ext}`, type });
      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'AutoWonder' })).toHaveAttribute('src', '/api/platform/branding/logo?v=2');
        expect(screen.getByRole('link', { name: /AutoWonder，返回工作空间列表/ }).querySelector('img'))
          .toHaveAttribute('src', '/api/platform/branding/logo?v=2');
      });
    }
  });

  it('applies saved preset and custom colors to the current theme without rereading stale config', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    clients.push(queryClient);
    const initial = { ...brandingApi.DEFAULT_BRANDING, ...brandingPayload().data };
    queryClient.setQueryData(brandingApi.BRANDING_QUERY_KEY, { ...initial, canManage: false });
    server.use(
      // A subsequent GET may still read the old configuration.
      http.get('/api/platform/branding/public', () => HttpResponse.json(brandingPayload())),
      http.put('/api/platform/branding', async ({ request }) => HttpResponse.json({
        ...brandingPayload(),
        data: { ...initial, ...await request.json() as object },
      })),
    );
    function ThemedPage() {
      const { data = initial } = useQuery({
        queryKey: brandingApi.BRANDING_QUERY_KEY,
        queryFn: brandingApi.getPublicBranding,
      });
      return <AppearanceProvider accent={data.primaryColor}><BrandingConfigPage /></AppearanceProvider>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><ThemedPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    const save = await screen.findByRole('button', { name: /保存配置/ });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(screen.getByText('海洋蓝'));
    expect(document.documentElement.style.getPropertyValue('--aw-accent')).toBe('#f97316');
    await userEvent.click(save);
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--aw-accent')).toBe('#2563eb');
      expect(save).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText('选择主色'), { target: { value: '#123456' } });
    await userEvent.click(save);
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--aw-accent')).toBe('#123456');
      expect(queryClient.getQueryData(brandingApi.BRANDING_ADMIN_QUERY_KEY)).toMatchObject({ primaryColor: '#123456' });
      expect(queryClient.getQueryData(brandingApi.BRANDING_QUERY_KEY)).toMatchObject({ primaryColor: '#123456', canManage: false });
    });
  });

  it('loads existing branding and saves updates', async () => {
    let savedBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
      http.put('/api/platform/branding', async ({ request }) => {
        savedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          success: true,
          code: '0',
          message: '',
          traceId: null,
          data: {
            ...(savedBody as Record<string, unknown>),
            logoUrl: '/logo.png',
            canManage: true,
          },
        });
      }),
    );

    renderPage();

    const nameInput = await screen.findByPlaceholderText('AutoWonder');
    await waitFor(() => expect(nameInput).not.toBeDisabled());
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'WonderHub');
    const domainInput = screen.getByPlaceholderText('https://wonder.example.com');
    await userEvent.clear(domainInput);
    await userEvent.type(domainInput, 'https://wonder.example.com');
    await userEvent.click(screen.getByText('海洋蓝'));
    await userEvent.click(screen.getByRole('button', { name: /保存配置/ }));

    await waitFor(() => {
      expect(savedBody).toMatchObject({
        platformName: 'WonderHub',
        themeKey: 'ocean-blue',
        primaryColor: '#2563eb',
        domain: 'https://wonder.example.com',
      });
    });
  });

  it('explains that the saved domain drives the outbound platform addresses', async () => {
    renderPage();

    expect(await screen.findByText(
      '仅平台管理员可以修改平台配置。保存「部署域名」后，MCP 服务地址、执行器启动命令等对外地址会立即使用该域名；未配置时使用部署环境变量地址。',
    )).toBeInTheDocument();
    expect(screen.getByText(
      '填写私有化部署后用户访问平台的域名，例如 https://wonder.example.com；保存后 MCP 服务地址、执行器启动命令等对外地址立即使用该域名',
    )).toBeInTheDocument();
  });

  it('loads dingtalk collaboration robot status', async () => {
    renderPage();

    expect(await screen.findByRole('tab', { name: '消息渠道' })).toBeInTheDocument();
    await openNotificationTab();

    expect(await screen.findByText('通知机器人')).toBeInTheDocument();
    expect(await screen.findByText('已保存：启用')).toBeInTheDocument();
    expect(await screen.findByText('AppSecret 已配置')).toBeInTheDocument();
    expect(screen.getByText('配置完整')).toBeInTheDocument();
    // The notification form is namespaced so its AppKey cannot collide with the group-chat form.
    expect(await screen.findByLabelText('通知 AppKey')).toHaveAttribute('id', 'imNotification_appKey');
  });

  it('shows the saved disabled state from backend im-channels', async () => {
    server.use(
      http.get('/api/platform/im-channels', () => HttpResponse.json({
        ...imChannelsPayload(),
        data: [
          {
            provider: 'DINGTALK',
            enabled: false,
            appKey: 'ding-app',
            robotCode: 'ding-robot',
            secretConfigured: true,
            ready: false,
          },
        ],
      })),
    );

    renderPage();
    await openNotificationTab();

    // Both the notification card and the group-chat card carry the saved-disabled tag.
    expect(await screen.findAllByText('已保存：未启用')).toHaveLength(2);
    expect(screen.queryByText('已保存：启用')).not.toBeInTheDocument();
  });

  it('preserves configured app secret when saving dingtalk robot without a new secret', async () => {
    let savedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/platform/im-channels/dingtalk', async ({ request }) => {
        savedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...imChannelsPayload(), data: imChannelsPayload().data[0] });
      }),
    );

    renderPage();
    await openNotificationTab();

    const appKeyInput = await screen.findByLabelText('通知 AppKey');
    await waitFor(() => expect(appKeyInput).not.toBeDisabled());
    const appSecretInput = screen.getByLabelText('通知 AppSecret');
    expect(appSecretInput).toHaveValue('');

    await userEvent.clear(appKeyInput);
    await userEvent.type(appKeyInput, 'ding-app-updated');
    await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));

    await waitFor(() => {
      expect(savedBody).toEqual({
        enabled: true,
        appKey: 'ding-app-updated',
        appSecret: '',
        robotCode: 'ding-robot',
      });
    });
  });

  it('can save disabled dingtalk robot with empty app secret', async () => {
    let savedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/platform/im-channels/dingtalk', async ({ request }) => {
        savedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...imChannelsPayload(), data: { ...imChannelsPayload().data[0], enabled: false } });
      }),
    );

    renderPage();
    await openNotificationTab();

    const enabledSwitch = await screen.findByRole('switch', { name: '启用钉钉机器人' });
    await userEvent.click(enabledSwitch);
    await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));

    await waitFor(() => {
      expect(savedBody).toMatchObject({
        enabled: false,
        appKey: 'ding-app',
        appSecret: '',
        robotCode: 'ding-robot',
      });
    });
  });

  it('does not send app secret when saving main branding config', async () => {
    let savedBrandingBody: Record<string, unknown> | null = null;
    let savedDingTalkBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
      http.put('/api/platform/branding', async ({ request }) => {
        savedBrandingBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          ...brandingPayload(),
          data: {
            ...brandingPayload().data,
            ...(savedBrandingBody as Record<string, unknown>),
          },
        });
      }),
      http.put('/api/platform/im-channels/dingtalk', async ({ request }) => {
        savedDingTalkBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...imChannelsPayload(), data: imChannelsPayload().data[0] });
      }),
    );

    renderPage();

    await screen.findByText('已保存：启用');
    await userEvent.click(screen.getByRole('button', { name: /保存配置/ }));

    await waitFor(() => {
      expect(savedBrandingBody).not.toBeNull();
    });
    expect(savedBrandingBody).not.toHaveProperty('appSecret');
    expect(savedDingTalkBody).toBeNull();
  });

  it('keeps branding controls visible and shows backend permission errors', async () => {
    let updateCalls = 0;
    const error = vi.spyOn(message, 'error').mockImplementation(
      () => undefined as unknown as ReturnType<typeof message.error>,
    );
    useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'READ_WRITE');
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
      http.put('/api/platform/branding', () => {
        updateCalls += 1;
        return HttpResponse.json({
          success: false,
          code: '10403',
          message: '仅平台管理员可以修改平台配置',
          traceId: null,
          data: null,
        });
      }),
    );

    renderPage();

    const saveButton = await screen.findByRole('button', { name: /保存配置/ });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(updateCalls).toBe(1);
      expect(error).toHaveBeenCalledWith('仅平台管理员可以修改平台配置');
    });
    await waitFor(() => expect(saveButton).toBeEnabled());
  });

  it('falls back to default logo when custom logo fails to load', async () => {
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json({
        ...brandingPayload(),
        data: {
          ...brandingPayload().data,
          logoUrl: '/api/platform/branding/logo?v=5',
        },
      })),
    );

    renderPage();

    const nameInput = await screen.findByPlaceholderText('AutoWonder');
    await waitFor(() => expect(nameInput).not.toBeDisabled());

    const logoImg = screen.getByRole('img', { name: 'AutoWonder' });
    expect(logoImg.getAttribute('src')).toBe('/api/platform/branding/logo?v=5');

    fireEvent.error(logoImg);

    expect(logoImg.getAttribute('src')).toBe('/logo.svg');
  });

  it('shows an enabled back-to-workspaces entry beside the page title', async () => {
    renderPage();

    const backButton = await screen.findByRole('button', { name: /返回工作空间列表/ });
    await waitFor(() => expect(backButton).toBeEnabled());
    expect(screen.getByText('平台配置')).toBeInTheDocument();
  });

  it('navigates back to the workspace list when the back entry is clicked', async () => {
    renderPageWithLocation();

    expect(await screen.findByTestId('location-path')).toHaveTextContent('/workspaces/branding');

    await userEvent.click(screen.getByRole('button', { name: /返回工作空间列表/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-path')).toHaveTextContent(/^\/workspaces$/);
    });
  });

  it('keeps the back entry above the collaboration notice section', async () => {
    renderPage();

    const backButton = await screen.findByRole('button', { name: /返回工作空间列表/ });
    const noticeSection = await screen.findByText('通知机器人');

    expect(
      backButton.compareDocumentPosition(noticeSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('leaves directly with unsaved branding edits instead of prompting', async () => {
    renderPageWithLocation();

    const nameInput = await screen.findByPlaceholderText('AutoWonder');
    await waitFor(() => expect(nameInput).not.toBeDisabled());
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'WonderHub');

    await userEvent.click(screen.getByRole('button', { name: /返回工作空间列表/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-path')).toHaveTextContent(/^\/workspaces$/);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('groups branding, collaboration notice, enterprise SSO and platform admins into tabs', async () => {
    renderPage();

    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: '消息渠道' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: '企业 SSO' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '平台管理员' })).toBeInTheDocument();

    // Branding stays the landing pane so an operator who only came to rename the platform does not
    // have to hunt for the form.
    const saveButton = await screen.findByRole('button', { name: /保存配置/ });
    await waitFor(() => expect(saveButton).toBeEnabled());
  });

  it('hides the enterprise SSO tab from non-admins and falls back to branding', async () => {
    let ssoRequests = 0;
    window.localStorage.setItem('autowonder.platform-config.tab', 'enterprise-sso');
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json({
        ...brandingPayload(),
        data: { ...brandingPayload().data, canManage: false },
      })),
      http.get('/api/platform/federation/overview', () => {
        ssoRequests += 1;
        return HttpResponse.json({
          success: true,
          code: '0',
          message: '',
          traceId: null,
          data: { idps: [], connections: [] },
        });
      }),
      http.get('/api/platform/federation/idps', () => {
        ssoRequests += 1;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: [] });
      }),
      http.get('/api/platform/federation/connections', () => {
        ssoRequests += 1;
        return HttpResponse.json({ success: true, code: '0', message: '', traceId: null, data: [] });
      }),
    );

    renderPage();

    // 企业 SSO 与用户管理同为管理员专属页签；历史存储的 SSO 页签落回品牌配置，且不触发任何 SSO 请求。
    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: '企业 SSO' })).not.toBeInTheDocument();
    expect(ssoRequests).toBe(0);
  });

  it('hides the enterprise SSO tab when platform admin rights are revoked', async () => {
    let canManage = true;
    const empty = { success: true, code: '0', message: '', traceId: null, data: [] };
    window.localStorage.setItem('autowonder.platform-config.tab', 'enterprise-sso');
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json({
        ...brandingPayload(),
        data: { ...brandingPayload().data, canManage },
      })),
      http.get('/api/platform/federation/idps', () => HttpResponse.json(empty)),
      http.get('/api/platform/federation/connections', () => HttpResponse.json(empty)),
    );

    const adminRender = renderPage();
    expect(await screen.findByRole('button', { name: '添加身份提供方' })).toBeInTheDocument();
    adminRender.unmount();

    canManage = false;
    renderPage();

    // 权限收回后企业 SSO 页签不再渲染，历史存储值落回品牌配置，避免空白页。
    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: '企业 SSO' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加身份提供方' })).toBeNull();
  });

  it('loads enterprise SSO configuration only after its tab is opened', async () => {
    let federationRequests = 0;
    const empty = { success: true, code: '0', message: '', traceId: null, data: [] };
    server.use(
      http.get('/api/platform/federation/idps', () => {
        federationRequests += 1;
        return HttpResponse.json(empty);
      }),
      http.get('/api/platform/federation/connections', () => {
        federationRequests += 1;
        return HttpResponse.json(empty);
      }),
    );

    renderPage();

    await screen.findByRole('tab', { name: '企业 SSO' });
    expect(federationRequests).toBe(0);

    await openEnterpriseSsoTab();

    await waitFor(() => expect(federationRequests).toBe(2));
    expect(await screen.findByText('还没有身份提供方')).toBeInTheDocument();
  });

  it('restores the last selected platform configuration tab after remounting', async () => {
    const firstRender = renderPage();

    await openNotificationTab();
    expect(window.localStorage.getItem('autowonder.platform-config.tab')).toBe('notification');

    firstRender.unmount();
    renderPage();

    expect(await screen.findByRole('tab', { name: '消息渠道' })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to branding when the saved platform configuration tab is invalid', async () => {
    window.localStorage.setItem('autowonder.platform-config.tab', 'unknown');

    renderPage();

    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to branding when browser storage is unavailable', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    renderPage();

    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps tab switching available when browser storage rejects writes', async () => {
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'autowonder.platform-config.tab') throw new Error('storage unavailable');
      setItem(key, value);
    });

    renderPage();
    await openNotificationTab();

    expect(screen.getByRole('tab', { name: /消息渠道/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not fetch the platform admin roster until its tab is opened', async () => {
    let adminRequests = 0;
    server.use(http.get('/api/platform/admins', () => {
      adminRequests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { admins: [], canManage: false },
      });
    }));

    renderPage();

    await screen.findByRole('tab', { name: '平台管理员' });
    expect(adminRequests).toBe(0);

    await openPlatformAdminTab();

    await waitFor(() => expect(adminRequests).toBe(1));
  });

  it('manages platform admins from its own public tab', async () => {
    server.use(http.get('/api/platform/admins', () => HttpResponse.json({
      success: true,
      code: '0',
      message: '',
      traceId: null,
      data: {
        admins: [
          {
            userId: 10000,
            username: 'alice',
            nickname: '爱丽丝',
            email: 'alice@example.com',
            active: true,
            self: true,
            removable: false,
            removeDisabledReason: '平台管理员不可移除自己',
          },
          {
            userId: 10001,
            username: 'bob',
            nickname: '鲍勃',
            email: 'bob@example.com',
            active: true,
            self: false,
            removable: true,
            removeDisabledReason: null,
          },
        ],
        canManage: true,
      },
    })));

    renderPage();
    await openPlatformAdminTab();

    const selfRow = (await screen.findByText('爱丽丝')).closest('tr');
    const otherRow = (await screen.findByText('鲍勃')).closest('tr');
    expect(selfRow).not.toBeNull();
    expect(otherRow).not.toBeNull();
    expect(within(selfRow!).getByRole('button', { name: '移除' })).toBeDisabled();
    expect(within(otherRow!).getByRole('button', { name: '移除' })).toBeEnabled();
    expect(screen.getAllByRole('tab').slice(0, 5).map((tab) => tab.textContent)).toEqual([
      '品牌与主题', '消息渠道', '邮箱验证', '开关配置', '平台管理员',
    ]);
    const add = screen.getByRole('button', { name: '添加管理员' });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: '搜索可添加的用户' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '添加 0 人' })).toBeDisabled();
  });

  it('switches platform configuration language from the shared header', async () => {
    renderPage();
    await screen.findByText('上传 Logo');
    try {
      await userEvent.click(screen.getByRole('button', { name: '切换语言' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'English' }));
      expect(await screen.findByRole('heading', { name: 'Platform configuration' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Switch language' })).toHaveLength(1);
    } finally {
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
    }
  });

  it('exposes the user management tab to platform admins and loads its roster lazily', async () => {
    let requests = 0;
    server.use(http.get('/api/platform/users', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { totalAll: 0, total: 0, pageNum: 1, pageSize: 20, list: [] },
      });
    }));

    renderPage();

    await screen.findByRole('tab', { name: '用户管理' });
    expect(requests).toBe(0);

    await openUserManagementTab();

    await waitFor(() => expect(requests).toBe(1));
    expect(await screen.findByText('全部用户 0 人')).toBeInTheDocument();
    expect(window.localStorage.getItem('autowonder.platform-config.tab')).toBe('user-management');
  });

  it('hides the user management tab from non-admin operators and never fetches the roster', async () => {
    let requests = 0;
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json({
        ...brandingPayload(),
        data: { ...brandingPayload().data, canManage: false },
      })),
      http.get('/api/platform/users', () => {
        requests += 1;
        return HttpResponse.json({
          success: true,
          code: '0',
          message: '',
          traceId: null,
          data: { totalAll: 0, total: 0, pageNum: 1, pageSize: 20, list: [] },
        });
      }),
    );

    renderPage();

    await screen.findByRole('tab', { name: '品牌与主题' });
    expect(screen.queryByRole('tab', { name: '用户管理' })).not.toBeInTheDocument();
    expect(requests).toBe(0);
  });

  it('restores a persisted user management tab for platform admins', async () => {
    let requests = 0;
    window.localStorage.setItem('autowonder.platform-config.tab', 'user-management');
    server.use(http.get('/api/platform/users', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { totalAll: 0, total: 0, pageNum: 1, pageSize: 20, list: [] },
      });
    }));

    renderPage();

    expect(await screen.findByRole('tab', { name: '用户管理' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(requests).toBe(1));
  });

  it('falls back to branding when a persisted user management tab is opened by a non-admin', async () => {
    window.localStorage.setItem('autowonder.platform-config.tab', 'user-management');
    server.use(
      http.get('/api/platform/branding', () => HttpResponse.json({
        ...brandingPayload(),
        data: { ...brandingPayload().data, canManage: false },
      })),
    );

    renderPage();

    expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: '用户管理' })).not.toBeInTheDocument();
  });

it('switches to Feishu through the persisted selection without reusing DingTalk credentials or requiring RobotCode', async () => {
  let saved: UpdateDingTalkImChannelParams | undefined;
  let selection: { provider: string } | undefined;
  server.use(
    http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
    http.get('/api/platform/im-channels', () => HttpResponse.json(imChannelsPayload())),
    http.put('/api/platform/im-channels/selection', async ({ request }) => {
      selection = await request.json() as { provider: string };
      return HttpResponse.json(imSelectionPayload('FEISHU', 2));
    }),
    http.put('/api/platform/im-channels/feishu', async ({ request }) => {
      saved = await request.json() as UpdateDingTalkImChannelParams;
      return HttpResponse.json({ ...imChannelsPayload(), data: { provider: 'FEISHU', ...saved } });
    }),
  );
  const { container } = renderPage();
  const page = within(container);
  await userEvent.click(await page.findByRole('tab', { name: '消息渠道' }));
  const switchChannel = await page.findByRole('button', { name: '切换为飞书' });
  await waitFor(() => expect(switchChannel).toBeEnabled());
  await userEvent.click(switchChannel);
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: '确定切换为飞书' }));
  await waitFor(() => expect(selection).toEqual({ provider: 'FEISHU', expectedGeneration: 1 }));
  expect(await page.findByText('平台当前渠道：飞书')).toBeInTheDocument();
  const appId = page.getByLabelText('通知 App ID');
  const secret = page.getByLabelText('通知 AppSecret');
  const save = page.getByRole('button', { name: /保存通知机器人/ });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(switchChannel).toBeEnabled();
    expect(save).toBeEnabled();
    expect(appId).toBeEnabled();
  });
  expect(page.queryByLabelText('通知 RobotCode')).not.toBeInTheDocument();
  expect(appId).toHaveValue('');
  expect(secret).toHaveValue('');
  expect(await page.findByLabelText('群聊 App ID')).toBeInTheDocument();
  await userEvent.click(page.getByRole('switch', { name: '启用飞书机器人' }));
  await userEvent.type(appId, 'cli_test');
  await userEvent.type(secret, 'feishu-secret');
  await userEvent.click(save);
  await waitFor(() => expect(saved).toEqual({ enabled: true, appKey: 'cli_test', appSecret: 'feishu-secret', robotCode: '', baseUrl: '' }));
  await waitFor(() => {
    expect(save).toBeEnabled();
    expect(switchChannel).toBeEnabled();
  });
});

it('shows and saves the Feishu API base url for a non-official domain', async () => {
  let saved: UpdateDingTalkImChannelParams | undefined;
  server.use(
    http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
    http.get('/api/platform/im-channels', () => HttpResponse.json({
      ...imChannelsPayload(),
      data: [{
        provider: 'FEISHU',
        enabled: true,
        appKey: 'cli_custom',
        robotCode: '',
        baseUrl: 'https://feishu.sanyi.example.com/open-apis',
        secretConfigured: true,
        ready: true,
      }],
    })),
    http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload('FEISHU', 1))),
    http.put('/api/platform/im-channels/feishu', async ({ request }) => {
      saved = await request.json() as UpdateDingTalkImChannelParams;
      return HttpResponse.json({ ...imChannelsPayload(), data: { provider: 'FEISHU', ...saved } });
    }),
  );
  renderPage(); await openNotificationTab();

  const baseUrlInput = await screen.findByLabelText('飞书 API 地址', { selector: '#imNotification_baseUrl' });
  await waitFor(() => expect(baseUrlInput).toHaveValue('https://feishu.sanyi.example.com/open-apis'));
  expect(baseUrlInput).not.toBeDisabled();
  await userEvent.clear(baseUrlInput);
  await userEvent.type(baseUrlInput, 'https://gw.sanyi.example.com/feishu/open-apis');
  await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));

  await waitFor(() => expect(saved).toEqual({
    enabled: true,
    appKey: 'cli_custom',
    appSecret: '',
    robotCode: '',
    baseUrl: 'https://gw.sanyi.example.com/feishu/open-apis',
  }));
});

it('prefers the persisted provider selection over the channel list', async () => {
  server.use(http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload('FEISHU', 3))));
  renderPage(); await openNotificationTab();

  expect(await screen.findByText('平台当前渠道：飞书')).toBeInTheDocument();
  expect(screen.getByLabelText('通知 App ID')).toBeInTheDocument();
  expect(screen.queryByLabelText('通知 RobotCode')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('群聊 AppKey')).not.toBeInTheDocument();
  expect(await screen.findByLabelText('群聊 App ID')).toBeInTheDocument();
});

it('keeps the persisted channel and reports selection save failures', async () => {
  server.use(
    http.get('/api/platform/branding', () => HttpResponse.json(brandingPayload())),
    http.get('/api/platform/im-channels', () => HttpResponse.json(imChannelsPayload())),
    http.put('/api/platform/im-channels/selection', () => HttpResponse.json({
      success: false,
      code: '10500',
      message: '渠道切换失败',
      traceId: null,
      data: null,
    })),
  );
  renderPage(); await openNotificationTab();
  await userEvent.click(await screen.findByRole('button', { name: '切换为飞书' }));
  await userEvent.click(await screen.findByRole('button', { name: '确定切换为飞书' }));

  await waitFor(() => expect(message.error).toHaveBeenCalledWith('渠道切换失败'));
  expect(screen.getByText('平台当前渠道：钉钉')).toBeInTheDocument();
  expect(screen.getByLabelText('通知 AppKey')).toHaveValue('ding-app');
});

it('hides the shared group-chat panel from non-admin operators', async () => {
  server.use(http.get('/api/platform/branding', () => HttpResponse.json({
    ...brandingPayload(),
    data: { ...brandingPayload().data, canManage: false },
  })));
  renderPage();

  // 非管理员不再渲染消息渠道页签，通知与群聊机器人面板均不可见。
  expect(await screen.findByRole('tab', { name: '品牌与主题' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('平台名称')).toHaveValue('AutoWonder'));
  expect(screen.queryByRole('tab', { name: '消息渠道' })).not.toBeInTheDocument();
  expect(screen.queryByText('群聊机器人')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '保存群聊机器人' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: '启用钉钉机器人' })).not.toBeInTheDocument();
});

it('warns about unsaved notification input before switching the platform channel', async () => {
  renderPage(); await openNotificationTab();

  const appKeyInput = await screen.findByLabelText('通知 AppKey');
  await waitFor(() => expect(appKeyInput).not.toBeDisabled());
  await userEvent.type(appKeyInput, '-dirty');
  await userEvent.click(screen.getByRole('button', { name: '切换为飞书' }));

  expect(await screen.findByText('有未保存修改。确认切换即明确放弃当前通知与群聊草稿；此提示不阻止切换。')).toBeInTheDocument();
});

it('does not flag unsaved input after the notification section is saved', async () => {
  let saved = 0;
  server.use(http.put('/api/platform/im-channels/dingtalk', () => {
    saved += 1;
    return HttpResponse.json(imChannelsPayload());
  }));
  renderPage(); await openNotificationTab();

  const appKeyInput = await screen.findByLabelText('通知 AppKey');
  await waitFor(() => expect(appKeyInput).not.toBeDisabled());
  await userEvent.type(appKeyInput, '-saved');
  await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));
  await waitFor(() => expect(saved).toBe(1));

  await userEvent.click(screen.getByRole('button', { name: '切换为飞书' }));
  expect(screen.queryByText('有未保存的修改，切换前请先保存或明确放弃。')).not.toBeInTheDocument();
});

it('saves only the notification section without touching selection or group-chat', async () => {
  let noticeSaves = 0;
  let selectionWrites = 0;
  let groupChatWrites = 0;
  server.use(
    http.put('/api/platform/im-channels/dingtalk', () => {
      noticeSaves += 1;
      return HttpResponse.json(imChannelsPayload());
    }),
    http.put('/api/platform/im-channels/selection', () => {
      selectionWrites += 1;
      return HttpResponse.json(imSelectionPayload());
    }),
    http.put('/api/platform/im-channels/DINGTALK/group-chat', () => {
      groupChatWrites += 1;
      return HttpResponse.json(groupChatPayload('DINGTALK'));
    }),
  );
  renderPage(); await openNotificationTab();

  const appKeyInput = await screen.findByLabelText('通知 AppKey');
  await waitFor(() => expect(appKeyInput).not.toBeDisabled());
  await userEvent.type(appKeyInput, '-independent');
  await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));
  await waitFor(() => expect(noticeSaves).toBe(1));

  expect(selectionWrites).toBe(0);
  expect(groupChatWrites).toBe(0);
});

it('performs no write when the channel switch is cancelled', async () => {
  let selectionWrites = 0;
  server.use(http.put('/api/platform/im-channels/selection', () => {
    selectionWrites += 1;
    return HttpResponse.json(imSelectionPayload('FEISHU', 2));
  }));
  renderPage(); await openNotificationTab();

  await userEvent.click(screen.getByRole('button', { name: '切换为飞书' }));
  await userEvent.click(await screen.findByRole('button', { name: /取\s*消/ }));

  await waitFor(() => expect(screen.queryByRole('button', { name: '确定切换为飞书' })).not.toBeInTheDocument());
  expect(selectionWrites).toBe(0);
  expect(screen.getByText('平台当前渠道：钉钉')).toBeInTheDocument();
});

it('hides message channel configuration and skips its requests for non-admin operators', async () => {
  let configRequests = 0;
  window.localStorage.setItem('autowonder.platform-config.tab', 'notification');
  server.use(
    http.get('/api/platform/branding', () => HttpResponse.json({
      ...brandingPayload(),
      data: { ...brandingPayload().data, canManage: false },
    })),
    http.get('/api/platform/im-channels', () => {
      configRequests += 1;
      return HttpResponse.json({ success: true, code: '0', data: [] });
    }),
    http.get('/api/platform/im-channels/selection', () => {
      configRequests += 1;
      return HttpResponse.json({ success: true, code: '0', data: { provider: 'DINGTALK' } });
    }),
  );
  renderPage();

  await waitFor(() => expect(screen.getByLabelText('平台名称')).toHaveValue('AutoWonder'));
  expect(await screen.findByRole('tab', { name: '品牌与主题' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('tab', { name: '消息渠道' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('通知 AppKey')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /保存通知机器人/ })).not.toBeInTheDocument();
  expect(configRequests).toBe(0);
});

it('shows an unknown channel after a selection read failure and only unlocks after retry', async () => {
  let reads = 0;
  let writes = 0;
  server.use(
    http.get('/api/platform/im-channels/selection', () => {
      reads += 1;
      return HttpResponse.json(reads === 1
        ? { success: false, code: '10500', message: 'selection unavailable', data: null, traceId: null }
        : imSelectionPayload('FEISHU', 4));
    }),
    http.put('/api/platform/im-channels/selection', () => {
      writes += 1;
      return HttpResponse.json(imSelectionPayload());
    }),
  );
  renderPage(); await openNotificationTab();
  expect(await screen.findByText('当前渠道加载失败')).toBeInTheDocument();
  expect(screen.getByText('平台当前渠道：未知')).toBeInTheDocument();
  expect(screen.queryByText('平台当前渠道：钉钉')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '切换渠道' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /保存通知机器人/ })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: /^重\s*试$/ }));
  expect(await screen.findByText('平台当前渠道：飞书')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '切换为钉钉' })).toBeEnabled());
  expect(writes).toBe(0);
});

it('locks channel switching throughout notification validation and response callbacks', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  pendingResponses.add(release);
  let writes = 0;
  server.use(http.put('/api/platform/im-channels/dingtalk', async () => {
    writes += 1;
    await pending;
    return HttpResponse.json(imChannelsPayload());
  }));
  const { container } = renderPage();
  const page = within(container);
  await userEvent.click(await page.findByRole('tab', { name: '消息渠道' }));
  await waitFor(() => expect(page.getByLabelText('通知 AppKey')).toBeEnabled());
  const save = page.getByRole('button', { name: /保存通知机器人/ });
  const switchChannel = page.getByRole('button', { name: '切换为飞书' });
  try {
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(switchChannel).toBeDisabled();
    await waitFor(() => expect(writes).toBe(1));
    expect(page.getByLabelText('通知 AppKey')).toBeDisabled();
    expect(page.getByRole('button', { name: /保存群聊机器人/ })).toBeDisabled();
  } finally {
    release();
  }
  await waitFor(() => expect(save).toBeEnabled());
  expect(switchChannel).toBeEnabled();
  expect(writes).toBe(1);
});

it('keeps notification and switching locked until successful cache refresh callbacks finish', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  pendingResponses.add(release);
  let reads = 0;
  let writes = 0;
  server.use(
    http.get('/api/platform/im-channels', async () => {
      reads += 1;
      if (reads > 1) await pending;
      return HttpResponse.json(imChannelsPayload());
    }),
    http.put('/api/platform/im-channels/dingtalk', () => {
      writes += 1;
      return HttpResponse.json({ ...imChannelsPayload(), data: imChannelsPayload().data[0] });
    }),
  );
  const { container } = renderPage();
  const page = within(container);
  await userEvent.click(await page.findByRole('tab', { name: '消息渠道' }));
  const save = page.getByRole('button', { name: /保存通知机器人/ });
  const switchChannel = page.getByRole('button', { name: '切换为飞书' });
  await waitFor(() => expect(save).toBeEnabled());
  try {
    await userEvent.click(save);
    await waitFor(() => expect(reads).toBe(2));
    expect(writes).toBe(1);
    expect(save).toBeDisabled();
    expect(switchChannel).toBeDisabled();
    expect(page.getByRole('button', { name: /保存群聊机器人/ })).toBeDisabled();
    await userEvent.click(save);
    expect(writes).toBe(1);
  } finally {
    release();
  }
  await waitFor(() => expect(save).toBeEnabled());
  expect(switchChannel).toBeEnabled();
  expect(writes).toBe(1);
});

it('locks notification saving and channel switching during a group-chat save', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  pendingResponses.add(release);
  let writes = 0;
  server.use(http.put('/api/platform/im-channels/DINGTALK/group-chat', async () => {
    writes += 1;
    await pending;
    return HttpResponse.json(groupChatPayload('DINGTALK'));
  }));
  const { container } = renderPage();
  const page = within(container);
  await userEvent.click(await page.findByRole('tab', { name: '消息渠道' }));
  const save = await page.findByRole('button', { name: /保存群聊机器人/ });
  const switchChannel = page.getByRole('button', { name: '切换为飞书' });
  await waitFor(() => expect(save).toBeEnabled());
  try {
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(writes).toBe(1));
    expect(switchChannel).toBeDisabled();
    expect(page.getByRole('button', { name: /保存通知机器人/ })).toBeDisabled();
  } finally {
    release();
  }
  await waitFor(() => expect(save).toBeEnabled());
  expect(switchChannel).toBeEnabled();
  expect(writes).toBe(1);
});

it('locks channel confirmation cancellation and both forms until switching finishes', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  pendingResponses.add(release);
  let writes = 0;
  server.use(http.put('/api/platform/im-channels/selection', async () => {
    writes += 1;
    await pending;
    return HttpResponse.json(imSelectionPayload('FEISHU', 2));
  }));
  const { container } = renderPage();
  const page = within(container);
  await userEvent.click(await page.findByRole('tab', { name: '消息渠道' }));
  const switchChannel = page.getByRole('button', { name: '切换为飞书' });
  const saveNotification = page.getByRole('button', { name: /保存通知机器人/ });
  await waitFor(() => expect(switchChannel).toBeEnabled());
  await userEvent.click(switchChannel);
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: '确定切换为飞书' });
  try {
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await waitFor(() => expect(writes).toBe(1));
    expect(within(dialog).getByRole('button', { name: /取\s*消/ })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    expect(page.getByLabelText('通知 AppKey')).toBeDisabled();
    expect(page.getByRole('button', { name: /保存群聊机器人/ })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 27 });
    expect(dialog).toBeInTheDocument();
  } finally {
    release();
  }
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(switchChannel).toBeEnabled();
    expect(saveNotification).toBeEnabled();
    expect(page.getByLabelText('通知 App ID')).toBeEnabled();
  });
  expect(page.getByText('平台当前渠道：飞书')).toBeInTheDocument();
  expect(writes).toBe(1);
});

it('keeps both channel drafts and the dialog after a rejected provider switch without resetting them from a refresh', async () => {
  let selectionReads = 0;
  let writes = 0;
  server.use(
    http.get('/api/platform/im-channels/selection', () => {
      selectionReads += 1;
      return HttpResponse.json(selectionReads === 1 ? imSelectionPayload() : imSelectionPayload('FEISHU', 9));
    }),
    http.get('/api/platform/im-channels/DINGTALK/group-chat', () => HttpResponse.json({
      ...groupChatPayload('DINGTALK'),
      data: { ...groupChatPayload('DINGTALK').data, configured: true, appKey: 'ding-shared', robotCode: 'robot_shared', secretConfigured: true, version: 4 },
    })),
    http.put('/api/platform/im-channels/selection', () => {
      writes += 1;
      return HttpResponse.json({ success: false, code: '10409', message: 'raw generation conflict', data: null, traceId: null });
    }),
  );
  renderPage(); await openNotificationTab();
  await waitFor(() => expect(screen.getByLabelText('通知 AppKey')).toHaveValue('ding-app'));
  await waitFor(() => expect(screen.getByLabelText('群聊 AppKey')).toHaveValue('ding-shared'));
  fireEvent.change(screen.getByLabelText('通知 AppKey'), { target: { value: 'ding-app-notice-draft' } });
  fireEvent.change(screen.getByLabelText('通知 AppSecret'), { target: { value: 'notice-draft-secret' } });
  fireEvent.change(screen.getByLabelText('群聊 AppKey'), { target: { value: 'ding-shared-group-draft' } });
  fireEvent.change(screen.getByLabelText('群聊 AppSecret'), { target: { value: 'group-draft-secret' } });
  await userEvent.click(screen.getByRole('button', { name: '切换为飞书' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: '确定切换为飞书' }));
  await waitFor(() => expect(message.error).toHaveBeenCalledWith('raw generation conflict'));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '确定切换为飞书' })).toBeEnabled());
  expect(dialog).toBeInTheDocument();
  expect(screen.getByLabelText('通知 AppKey')).toHaveValue('ding-app-notice-draft');
  expect(screen.getByLabelText('通知 AppSecret')).toHaveValue('notice-draft-secret');
  expect(screen.getByLabelText('群聊 AppKey')).toHaveValue('ding-shared-group-draft');
  expect(screen.getByLabelText('群聊 AppSecret')).toHaveValue('group-draft-secret');
  expect(selectionReads).toBe(1);
  expect(writes).toBe(1);
});

it('preserves an unsaved notification draft when group-chat saving refreshes channel data', async () => {
  server.use(http.put('/api/platform/im-channels/DINGTALK/group-chat', () => HttpResponse.json(groupChatPayload('DINGTALK'))));
  renderPage(); await openNotificationTab();
  const app = await screen.findByLabelText('通知 AppKey');
  await waitFor(() => expect(app).toBeEnabled());
  await userEvent.type(app, '-unsaved');
  await userEvent.click(screen.getByRole('button', { name: /保存群聊机器人/ }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('群聊机器人配置已保存'));
  expect(app).toHaveValue('ding-app-unsaved');
  await userEvent.click(screen.getByRole('button', { name: '切换为飞书' }));
  expect(await screen.findByText('有未保存修改。确认切换即明确放弃当前通知与群聊草稿；此提示不阻止切换。')).toBeInTheDocument();
});

it('configures the WeCom notification bot with BotID, Secret and connection state', async () => {
  let saved: UpdateDingTalkImChannelParams | undefined;
  server.use(
    http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload('WECOM', 2))),
    http.get('/api/platform/im-channels', () => HttpResponse.json({
      ...imChannelsPayload(),
      data: [{ provider: 'WECOM', enabled: true, appKey: 'wecom-bot', robotCode: '', secretConfigured: true, ready: true, connectionStatus: 'CONNECTED' }],
    })),
    http.get('/api/platform/im-channels/WECOM/group-chat', () => HttpResponse.json(groupChatPayload('WECOM'))),
    http.put('/api/platform/im-channels/wecom', async ({ request }) => {
      saved = await request.json() as UpdateDingTalkImChannelParams;
      return HttpResponse.json({
        ...imChannelsPayload(),
        data: [{ provider: 'WECOM', enabled: true, appKey: 'wecom-bot', robotCode: '', secretConfigured: true, ready: true, connectionStatus: 'CONNECTED' }],
      });
    }),
  );
  renderPage(); await openNotificationTab();

  expect(await screen.findByText('平台当前渠道：企业微信')).toBeInTheDocument();
  expect(await screen.findByLabelText('BotID')).toHaveValue('wecom-bot');
  expect(screen.getByLabelText('Secret')).toHaveValue('');
  expect(screen.queryByLabelText('RobotCode')).not.toBeInTheDocument();
  expect(screen.getByText('连接状态：已连接')).toBeInTheDocument();
  expect(screen.getAllByText('保存成功与连接成功分别展示').length).toBeGreaterThan(0);

  await userEvent.type(screen.getByLabelText('Secret'), 'wecom-secret');
  await userEvent.click(screen.getByRole('button', { name: /保存通知机器人/ }));
  await waitFor(() => expect(saved).toEqual({
    enabled: true,
    appKey: 'wecom-bot',
    appSecret: 'wecom-secret',
    robotCode: '',
  }));
});

it('explains why the WeCom notification channel is not ready', async () => {
  server.use(
    http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload('WECOM', 2))),
    http.get('/api/platform/im-channels', () => HttpResponse.json({
      ...imChannelsPayload(),
      data: [{ provider: 'WECOM', enabled: true, appKey: 'wecom-bot', robotCode: '', secretConfigured: false, ready: false, connectionStatus: 'CONNECTING' }],
    })),
    http.get('/api/platform/im-channels/WECOM/group-chat', () => HttpResponse.json(groupChatPayload('WECOM'))),
  );
  renderPage(); await openNotificationTab();

  expect(await screen.findByText('Secret 未配置')).toBeInTheDocument();
  expect(screen.getByText('连接未建立（连接中）')).toBeInTheDocument();
  expect(screen.getByText('连接状态：连接中')).toBeInTheDocument();
});

it('keeps unsaved notification drafts when the WeCom connection poll refreshes', async () => {
  let calls = 0;
  server.use(
    http.get('/api/platform/im-channels/selection', () => HttpResponse.json(imSelectionPayload('WECOM', 2))),
    http.get('/api/platform/im-channels', () => {
      calls += 1;
      return HttpResponse.json({
        ...imChannelsPayload(),
        data: [{
          provider: 'WECOM', enabled: true, appKey: 'wecom-bot', robotCode: '',
          secretConfigured: true, ready: true, connectionStatus: calls > 1 ? 'CONNECTED' : 'CONNECTING',
        }],
      });
    }),
    http.get('/api/platform/im-channels/WECOM/group-chat', () => HttpResponse.json(groupChatPayload('WECOM'))),
  );
  renderPage(); await openNotificationTab();

  await waitFor(
    () => expect(screen.getByLabelText('BotID')).toHaveValue('wecom-bot'),
    { timeout: 5000 },
  );
  expect(await screen.findByText('连接状态：连接中')).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('BotID'));
  await userEvent.type(screen.getByLabelText('BotID'), 'draft-bot');

  await waitFor(
    () => expect(screen.getByText('连接状态：已连接')).toBeInTheDocument(),
    { timeout: 8000 },
  );
  expect(screen.getByLabelText('BotID')).toHaveValue('draft-bot');
});

});
