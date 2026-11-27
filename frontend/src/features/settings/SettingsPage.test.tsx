import { beforeEach, describe, it, expect } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { SettingsPage } from './SettingsPage';
import type { NotifyPrefItem, SettingItem } from './api';
import { useAuthStore } from '@/shared/auth/store';

function apiOk<T>(data: T) {
  return { success: true, code: '0', message: '', traceId: null, data };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><SettingsPage /></MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

function useCommonSettingsHandlers(overrides: Parameters<typeof server.use>) {
  server.use(
    ...overrides,
    http.get('/api/platform/im-channels', () => HttpResponse.json(apiOk([{ provider: 'DINGTALK', selected: true }]))),
    http.get('/api/ai-usage/quota', () => HttpResponse.json(apiOk({
      periodType: 'MONTH',
      maxCalls: 20000,
      maxTokens: 10000000,
      concurrencyLimit: 8,
    }))),
    http.get('/api/ai-usage', () => HttpResponse.json(apiOk([
      { period: '2026-07', scene: '仓库扫描', callCount: 12, inputTokens: 1000, outputTokens: 500 },
      { period: '2026-07', scene: 'SDLC生成', callCount: 3, inputTokens: 300, outputTokens: 120 },
    ]))),
    http.get('/api/settings/AI', () => HttpResponse.json(apiOk([
      { key: 'default_model', valueJson: 'qwen-max', secret: false },
      { key: 'request_timeout_seconds', valueJson: '60', secret: false },
      { key: 'api_key', valueJson: '********', secret: true },
    ]))),
    http.get('/api/notifications/prefs', () => HttpResponse.json(apiOk([
      { type: 'WORKITEM_ASSIGNED', inApp: true, dingtalk: false },
      { type: 'DELIVERY_BLOCKED', inApp: true, dingtalk: true },
    ]))),
    http.get('/api/settings/NOTIFY', () => HttpResponse.json(apiOk([
      { key: 'dingtalk_enabled', valueJson: 'true', secret: false },
      { key: 'dingtalk_webhook', valueJson: '********', secret: true },
    ]))),
    http.get('/api/settings/SYSTEM', () => HttpResponse.json(apiOk([
      { key: 'default_sdlc_id', valueJson: '334208147726012416', secret: false },
      { key: 'default_status_template_id', valueJson: 'default-coding', secret: false },
      { key: 'artifact_bucket', valueJson: 'auto-wonder-artifacts', secret: false },
    ]))),
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'ADMIN');
  });

  it('renders AI quota and usage from dedicated APIs', async () => {
    useCommonSettingsHandlers([]);

    renderPage();
    const calls = await screen.findByLabelText('月调用次数');
    await waitFor(() => {
      expect(calls).toHaveValue('20000');
      expect(screen.getByLabelText('月 Token 上限')).toHaveValue('10000000');
      expect(screen.getByLabelText('默认模型')).toHaveValue('qwen-max');
    });
    expect(screen.getByText('仓库扫描')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it.each(['quota', 'usage', 'settings'] as const)('initializes both AI forms when %s resolves before the other queries', async first => {
    const gates = Object.fromEntries(['quota', 'usage', 'settings'].map(key => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return [key, { promise, resolve }];
    })) as Record<'quota' | 'usage' | 'settings', { promise: Promise<void>; resolve: () => void }>;
    const keys = { quota: ['ai-quota'], usage: ['ai-usage'], settings: ['settings', 'AI'] };
    useCommonSettingsHandlers([
      http.get('/api/ai-usage/quota', async () => {
        await gates.quota.promise;
        return HttpResponse.json(apiOk({ periodType: 'MONTH', maxCalls: 20000, maxTokens: 10000000, concurrencyLimit: 8 }));
      }),
      http.get('/api/ai-usage', async () => {
        await gates.usage.promise;
        return HttpResponse.json(apiOk([{ period: '2026-07', scene: '仓库扫描', callCount: 15, inputTokens: 1000, outputTokens: 500 }]));
      }),
      http.get('/api/settings/AI', async () => {
        await gates.settings.promise;
        return HttpResponse.json(apiOk([{ key: 'default_model', valueJson: 'qwen-max', secret: false }]));
      }),
    ]);
    const { queryClient, unmount } = renderPage();
    try {
      await act(async () => { gates[first].resolve(); });
      await waitFor(() => expect(queryClient.getQueryState(keys[first])?.status).toBe('success'));
      expect(screen.queryByLabelText('月调用次数')).not.toBeInTheDocument();
      await act(async () => { Object.values(gates).forEach(gate => gate.resolve()); });
      await waitFor(() => {
        expect(screen.getByLabelText('月调用次数')).toHaveValue('20000');
        expect(screen.getByLabelText('月 Token 上限')).toHaveValue('10000000');
        expect(screen.getByLabelText('并发限制')).toHaveValue('8');
        expect(screen.getByLabelText('默认模型')).toHaveValue('qwen-max');
      });
      expect(screen.getByText('仓库扫描')).toBeInTheDocument();
    } finally {
      await act(async () => { Object.values(gates).forEach(gate => gate.resolve()); });
      unmount();
      await queryClient.cancelQueries();
      queryClient.clear();
    }
  });

  it('saves AI quota and model defaults', async () => {
    const saved: { quota?: unknown; aiSettings?: unknown } = {};
    useCommonSettingsHandlers([
      http.put('/api/ai-usage/quota', async ({ request }) => {
        saved.quota = await request.json();
        return HttpResponse.json(apiOk(null));
      }),
      http.put('/api/settings/AI', async ({ request }) => {
        saved.aiSettings = await request.json();
        return HttpResponse.json(apiOk(null));
      }),
    ]);

    renderPage();
    const callsInput = await screen.findByDisplayValue('20000');
    await userEvent.clear(callsInput);
    await userEvent.type(callsInput, '30000');
    await userEvent.click(screen.getByRole('button', { name: /保存AI配置/ }));

    await waitFor(() => {
      expect(saved.quota).toMatchObject({ maxCalls: 30000, maxTokens: 10000000, concurrencyLimit: 8 });
      expect(saved.aiSettings).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ key: 'default_model', valueJson: 'qwen-max', secret: false }),
        ]),
      });
      expect((saved.aiSettings as { items: Array<{ key: string }> }).items.some((item) => item.key === 'api_key')).toBe(false);
    });
  });

  it('renders and saves notification preferences', async () => {
    const saved: { prefs?: unknown; notifySettings?: unknown } = {};
    useCommonSettingsHandlers([
      http.put('/api/notifications/prefs', async ({ request }) => {
        saved.prefs = await request.json();
        return HttpResponse.json(apiOk(null));
      }),
      http.put('/api/settings/NOTIFY', async ({ request }) => {
        saved.notifySettings = await request.json();
        return HttpResponse.json(apiOk(null));
      }),
    ]);

    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: '通知配置' }));

    expect(await screen.findByText('工单指派')).toBeInTheDocument();
    expect(screen.getByText('交付阻塞')).toBeInTheDocument();
    const notifyPanel = screen.getByTestId('notify-settings-panel');
    expect(within(notifyPanel).getByText(/复用平台协作通知的机器人凭据/)).toBeInTheDocument();
    expect(within(notifyPanel).queryByLabelText('钉钉 Webhook')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /保存通知配置/ }));

    await waitFor(() => {
      expect(saved.prefs).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ type: 'WORKITEM_ASSIGNED', inApp: true, dingtalk: false }),
        ]),
      });
      expect(saved.notifySettings).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ key: 'dingtalk_enabled', valueJson: 'true', secret: false }),
        ]),
      });
      expect((saved.notifySettings as { items: Array<{ key: string }> }).items.some((item) => item.key === 'dingtalk_webhook')).toBe(false);
    });
  });

  it('uses SYSTEM group for system defaults', async () => {
    const saved: { systemSettings?: unknown } = {};
    useCommonSettingsHandlers([
      http.put('/api/settings/SYSTEM', async ({ request }) => {
        saved.systemSettings = await request.json();
        return HttpResponse.json(apiOk(null));
      }),
    ]);

    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: '系统配置' }));

    expect(await screen.findByDisplayValue('334208147726012416')).toBeInTheDocument();
    expect(screen.getByDisplayValue('auto-wonder-artifacts')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /保存系统配置/ }));

    await waitFor(() => {
      expect(saved.systemSettings).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ key: 'default_sdlc_id', valueJson: '334208147726012416' }),
          expect.objectContaining({ key: 'artifact_bucket', valueJson: 'auto-wonder-artifacts' }),
        ]),
      });
    });
  });

  it('renders AI collaboration defaults in a dedicated settings tab', async () => {
    useCommonSettingsHandlers([]);

    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'AI 默认值' }));

    expect(await screen.findByText('需求澄清')).toBeInTheDocument();
    expect(screen.getByText('开始交付')).toBeInTheDocument();
    expect(await screen.findByText('保存后仅对当前浏览器生效')).toBeInTheDocument();
  });

  it('shows all four tabs to workspace admins', async () => {
    useCommonSettingsHandlers([]);

    renderPage();

    expect(await screen.findByRole('tab', { name: 'AI 配置' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '通知配置' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '系统配置' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI 默认值' })).toBeInTheDocument();
  });

  it.each(['READ_WRITE', 'READ_ONLY'] as const)(
    'keeps all settings tabs visible to %s members',
    async (accessLevel) => {
      useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, accessLevel);
      useCommonSettingsHandlers([]);

      renderPage();

      expect(await screen.findByRole('tab', { name: 'AI 配置' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '通知配置' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '系统配置' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'AI 默认值' })).toBeInTheDocument();
    },
  );
});

it('only saves Feishu settings and preferences when the platform selects Feishu', async () => {
  const saved: { prefs?: { items: NotifyPrefItem[] }; settings?: { items: SettingItem[] } } = {};
  useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'ADMIN');
  useCommonSettingsHandlers([
    http.get('/api/platform/im-channels', () => HttpResponse.json(apiOk([{ provider: 'FEISHU', selected: true, enabled: false }]))),
    http.get('/api/settings/NOTIFY', () => HttpResponse.json(apiOk([{ key: 'feishu_enabled', valueJson: 'true', secret: false }]))),
    http.get('/api/notifications/prefs', () => HttpResponse.json(apiOk([{ type: 'WORKITEM_ASSIGNED', inApp: true, feishu: true, dingtalk: false }]))),
    http.put('/api/notifications/prefs', async ({ request }) => { saved.prefs = await request.json() as { items: NotifyPrefItem[] }; return HttpResponse.json(apiOk(null)); }),
    http.put('/api/settings/NOTIFY', async ({ request }) => { saved.settings = await request.json() as { items: SettingItem[] }; return HttpResponse.json(apiOk(null)); }),
  ]);
  renderPage();
  await userEvent.click(await screen.findByRole('tab', { name: '通知配置' }));
  expect(await screen.findByLabelText('启用飞书通知')).toBeInTheDocument();
  expect(screen.queryByLabelText('启用钉钉通知')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /保存通知配置/ }));
  await waitFor(() => expect(saved.prefs?.items[0]).toEqual({ type: 'WORKITEM_ASSIGNED', inApp: true, feishu: true, dingtalk: false, wecom: false }));
  expect(saved.settings?.items).toEqual([{ key: 'feishu_enabled', valueJson: 'true', secret: false }]);
});

it('starts the WeCom preference off and saves only the WeCom switch', async () => {
  const saved: { prefs?: { items: NotifyPrefItem[] }; settings?: { items: SettingItem[] } } = {};
  useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'ADMIN');
  useCommonSettingsHandlers([
    http.get('/api/platform/im-channels', () => HttpResponse.json(apiOk([{ provider: 'WECOM', selected: true, enabled: false }]))),
    http.get('/api/settings/NOTIFY', () => HttpResponse.json(apiOk([{ key: 'wecom_enabled', valueJson: 'true', secret: false }]))),
    http.get('/api/notifications/prefs', () => HttpResponse.json(apiOk([{ type: 'WORKITEM_ASSIGNED', inApp: true, wecom: false }]))),
    http.put('/api/notifications/prefs', async ({ request }) => { saved.prefs = await request.json() as { items: NotifyPrefItem[] }; return HttpResponse.json(apiOk(null)); }),
    http.put('/api/settings/NOTIFY', async ({ request }) => { saved.settings = await request.json() as { items: SettingItem[] }; return HttpResponse.json(apiOk(null)); }),
  ]);
  renderPage();
  await userEvent.click(await screen.findByRole('tab', { name: '通知配置' }));

  expect(await screen.findByLabelText('启用企业微信通知')).toBeInTheDocument();
  expect(screen.queryByLabelText('启用飞书通知')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('启用钉钉通知')).not.toBeInTheDocument();
  const preference = screen.getByRole('switch', { name: '工单指派：企业微信' });
  expect(preference).not.toBeChecked();

  await userEvent.click(preference);
  await userEvent.click(screen.getByRole('button', { name: /保存通知配置/ }));

  await waitFor(() => expect(saved.prefs?.items[0]).toEqual({ type: 'WORKITEM_ASSIGNED', inApp: true, wecom: true, dingtalk: false, feishu: false }));
  expect(saved.settings?.items).toEqual([{ key: 'wecom_enabled', valueJson: 'true', secret: false }]);
});

it('defaults the conversation dispatch failure WeCom switch on and saves an explicit off', async () => {
  const saved: { prefs?: { items: NotifyPrefItem[] } } = {};
  useAuthStore.getState().setCurrentWorkspace({ id: 1, name: 'O', description: '' }, 'ADMIN');
  useCommonSettingsHandlers([
    http.get('/api/platform/im-channels', () => HttpResponse.json(apiOk([{ provider: 'WECOM', selected: true, enabled: true }]))),
    http.get('/api/settings/NOTIFY', () => HttpResponse.json(apiOk([{ key: 'wecom_enabled', valueJson: 'true', secret: false }]))),
    http.get('/api/notifications/prefs', () => HttpResponse.json(apiOk([{ type: 'WORKITEM_ASSIGNED', inApp: true, wecom: false }]))),
    http.put('/api/notifications/prefs', async ({ request }) => { saved.prefs = await request.json() as { items: NotifyPrefItem[] }; return HttpResponse.json(apiOk(null)); }),
    http.put('/api/settings/NOTIFY', () => HttpResponse.json(apiOk(null))),
  ]);
  renderPage();
  await userEvent.click(await screen.findByRole('tab', { name: '通知配置' }));

  const wecomSwitch = await screen.findByRole('switch', { name: '会话推送失败：企业微信' });
  expect(wecomSwitch).toBeChecked();
  expect(screen.getByRole('switch', { name: '会话推送失败：站内' })).toBeChecked();

  await userEvent.click(wecomSwitch);
  await userEvent.click(screen.getByRole('button', { name: /保存通知配置/ }));

  await waitFor(() => expect(saved.prefs?.items).toContainEqual({
    type: 'CONVERSATION_DISPATCH_FAILED', inApp: true, wecom: false, dingtalk: false, feishu: false,
  }));
});
