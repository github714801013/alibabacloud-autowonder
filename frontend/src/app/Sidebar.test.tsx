import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18n } from '@/shared/i18n';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { useAuthStore } from '@/shared/auth/store';
import { PENDING_REVIEW_COUNT_QUERY_KEY } from '@/features/agent/hooks';
import { scheduledTaskCapabilityQueryKey } from '@/features/scheduledTask/hooks';
import type { ScheduledTaskCapability } from '@/features/scheduledTask/types';
import {
  ABOUT_NAV_ITEM,
  NAV_SPACES,
  resolveSelectedNavKey,
  resolveSelectedSpaceKey,
  SETTINGS_SPACE,
  Sidebar,
  visibleSpaceItems,
} from './Sidebar';
import { isSettingsRoute } from '@/features/settings/settingsRoutes';

const readyCapability: ScheduledTaskCapability = {
  available: true,
  mode: 'V037_READY',
  clusterReady: true,
  reason: null,
};

const SETTINGS_PANEL_LABELS = [
  '数字员工', '小队', 'SDLC 流程', '执行器',
  '仓库', '记忆', '能力',
  '状态模版', '环境变量', '平台集成',
  '成员管理', '项目配置备份', '系统设置',
  '审计日志',
];

beforeEach(() => {
  useAuthStore.getState().clear();
});

afterEach(async () => { cleanup(); await act(async () => { await i18n.changeLanguage('zh-CN'); }); });

const deliverySpace = NAV_SPACES.find((space) => space.key === 'delivery')!;

describe('Sidebar', () => {
  it('uses translated group titles and page names without decorative glyph names', async () => {
    const { container } = render(<TestWrapper><Sidebar /></TestWrapper>);
    expect(screen.getByText('交付')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '工单' })).toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    await act(async () => { await i18n.changeLanguage('en-US'); });
    expect(screen.getByText('Delivery')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Work items' })).toBeInTheDocument();
    expect(screen.queryByText('交付')).not.toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText('交付')).toBeInTheDocument();
  });

  it('renders delivery and insights groups inline, with settings/about in the footer and no panel', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(scheduledTaskCapabilityQueryKey, readyCapability);
    const { container } = render(<TestWrapper queryClient={queryClient}><Sidebar /></TestWrapper>);

    const rail = container.querySelector('.aw-rail-nav') as HTMLElement;
    expect(Array.from(rail.querySelectorAll('.aw-rail-group-title')).map((node) => node.textContent))
      .toEqual(['交付', '洞察']);
    expect(Array.from(rail.querySelectorAll('.aw-rail-row')).map((node) => node.textContent))
      .toEqual(['工作台', '工单', '定时任务', '执行记录', '回收站', '数据洞察']);

    expect(container.querySelector('.aw-panel')).toBeNull();
    expect(await screen.findByRole('link', { name: '定时任务' })).toBeInTheDocument();

    const footer = container.querySelector('.aw-rail-foot') as HTMLElement;
    expect(Array.from(footer.querySelectorAll('.aw-rail-row')).map((node) => node.textContent))
      .toEqual(['设置', '关于平台']);
  });

  it('marks the current rail item and opens the settings panel from the rail', async () => {
    const { container } = render(<TestWrapper initialEntry="/workitems"><Sidebar /></TestWrapper>);

    expect(screen.getByRole('link', { name: '工单' })).toHaveAttribute('aria-current', 'page');
    expect(container.querySelector('.aw-panel')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '设置' }));

    const panel = container.querySelector('.aw-panel') as HTMLElement;
    expect(panel.querySelector('.aw-panel-title')).toHaveTextContent('设置');
    expect(Array.from(panel.querySelectorAll('.aw-panel-item')).map((node) => node.textContent))
      .toEqual(SETTINGS_PANEL_LABELS);
    expect(Array.from(panel.querySelectorAll('.aw-panel-group-title')).map((node) => node.textContent))
      .toEqual(['数字员工', '知识', '配置', '空间与权限', '合规']);
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'true');
    // 面板只补页面入口，轨道分组仍保留。
    expect(screen.getByRole('link', { name: '工单' })).toBeInTheDocument();
  });

  it('keeps the settings space selected on settings, employees and knowledge pages', () => {
    const { container, unmount } = render(<TestWrapper initialEntry="/settings/members"><Sidebar /></TestWrapper>);

    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: '成员管理' })).toHaveAttribute('aria-current', 'page');
    const settingsPanel = container.querySelector('.aw-panel') as HTMLElement;
    expect(Array.from(settingsPanel.querySelectorAll('.aw-panel-item')).map((node) => node.textContent))
      .toEqual(SETTINGS_PANEL_LABELS);
    unmount();

    const second = render(<TestWrapper initialEntry="/agents"><Sidebar /></TestWrapper>);
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: '数字员工' })).toHaveAttribute('aria-current', 'page');
    expect(second.container.querySelector('.aw-panel')).not.toBeNull();
  });

  it('keeps the pending review count on the settings panel entry only', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(PENDING_REVIEW_COUNT_QUERY_KEY, 4);
    render(<TestWrapper queryClient={queryClient} initialEntry="/agents"><Sidebar collapsed /></TestWrapper>);

    expect(await screen.findByRole('link', { name: '数字员工，4 个版本待审核' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /4 个版本待审核/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('labels the rail toggle 收起 / 展开 and calls the layout handler', async () => {
    const onToggleCollapsed = vi.fn();
    const { rerender } = render(
      <TestWrapper><Sidebar onToggleCollapsed={onToggleCollapsed} /></TestWrapper>,
    );
    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    rerender(<TestWrapper><Sidebar collapsed onToggleCollapsed={onToggleCollapsed} /></TestWrapper>);
    expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument();
  });

  it('hides 定时任务 until the capability request is ready', async () => {
    let resolveCapability: (() => void) | undefined;
    server.use(
      http.get('/api/capabilities/scheduled-task', async () => {
        await new Promise<void>((resolve) => { resolveCapability = resolve; });
        return HttpResponse.json({ success: true, code: '0', message: '', data: { available: true, mode: 'V037_READY', clusterReady: true, reason: null } });
      }),
    );

    render(<TestWrapper><Sidebar /></TestWrapper>);

    expect(screen.queryByText('定时任务')).not.toBeInTheDocument();
    expect(screen.getByText('工单')).toBeInTheDocument();
    await waitFor(() => expect(resolveCapability).toBeTypeOf('function'));
    act(() => resolveCapability?.());
    expect(await screen.findByText('定时任务')).toBeInTheDocument();
  });

  it('hides 定时任务 when the capability is unavailable', async () => {
    server.use(
      http.get('/api/capabilities/scheduled-task', () => HttpResponse.json({ success: true, code: '0', message: '', data: { available: false, mode: 'LEGACY', clusterReady: false, reason: 'DATABASE_UPGRADE_REQUIRED' } })),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<TestWrapper queryClient={queryClient}><Sidebar /></TestWrapper>);

    await waitFor(() => expect(queryClient.getQueryState(scheduledTaskCapabilityQueryKey)?.status).toBe('success'));
    expect(screen.getByText('工单')).toBeInTheDocument();
    expect(screen.queryByText('定时任务')).not.toBeInTheDocument();
  });

  it('hides 定时任务 while stale cached readiness is revalidated', async () => {
    let resolveCapability: (() => void) | undefined;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(scheduledTaskCapabilityQueryKey, readyCapability, { updatedAt: 0 });
    server.use(
      http.get('/api/capabilities/scheduled-task', async () => {
        await new Promise<void>((resolve) => { resolveCapability = resolve; });
        return HttpResponse.json({ success: true, code: '0', message: '', data: readyCapability });
      }),
    );

    render(<TestWrapper queryClient={queryClient}><Sidebar /></TestWrapper>);

    await waitFor(() => expect(queryClient.getQueryState(scheduledTaskCapabilityQueryKey)?.fetchStatus).toBe('fetching'));
    expect(screen.queryByText('定时任务')).not.toBeInTheDocument();
    act(() => resolveCapability?.());
    await waitFor(() => expect(queryClient.getQueryState(scheduledTaskCapabilityQueryKey)?.fetchStatus).toBe('idle'));
    expect(await screen.findByText('定时任务')).toBeInTheDocument();
  });

  const stubMatchMedia = (predicate: (query: string) => boolean) => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: predicate(query), media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      }),
    });
    return () => Object.defineProperty(window, 'matchMedia', { writable: true, value: original });
  };

  it('uses an icon-only rail and an overlay settings panel on narrow screens', async () => {
    const restore = stubMatchMedia((query) => /max-width: (?:1080|900)px/.test(query));
    try {
      const { container } = render(<TestWrapper initialEntry="/workitems"><Sidebar /></TestWrapper>);
      expect(screen.queryByRole('button', { name: '收起' })).not.toBeInTheDocument();
      const rows = Array.from(container.querySelectorAll('.aw-rail-row'));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const label = row.querySelector('.aw-rail-label')?.textContent ?? '';
        expect(row.getAttribute('aria-label')).toBe(label);
        expect(label).not.toBe('');
      }
      await userEvent.click(screen.getByRole('button', { name: '设置' }));
      expect(container.querySelector('.aw-panel')).toHaveClass('open');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(container.querySelector('.aw-panel')).toBeNull());
      fireEvent.mouseEnter(screen.getByRole('button', { name: '设置' }));
      expect(container.querySelector('.aw-panel')).toHaveClass('open');
      fireEvent.mouseLeave(container.querySelector('.aw-nav-wrap') as HTMLElement);
      await waitFor(() => expect(container.querySelector('.aw-panel')).toBeNull());
      fireEvent.focus(screen.getByRole('button', { name: '设置' }));
      expect(container.querySelector('.aw-panel')).toHaveClass('open');
    } finally { restore(); }
  });

  it('ignores a stored settings path outside the settings space', async () => {
    localStorage.setItem('autowonder.sidebar.lastSettingsPath', '/workitems');
    try {
      const { container } = render(<TestWrapper initialEntry="/workitems"><Sidebar /></TestWrapper>);
      await userEvent.click(screen.getByRole('button', { name: '设置' }));
      expect(container.querySelector('.aw-panel')).not.toBeNull();
      expect(screen.getByRole('link', { name: '数字员工' })).toHaveAttribute('aria-current', 'page');
    } finally {
      localStorage.removeItem('autowonder.sidebar.lastSettingsPath');
    }
  });

  it('survives storage read and write failures', async () => {
    // Node 26 内置 localStorage 的 getItem/setItem 是实例自有属性，Storage.prototype 的 spy 不会生效。
    const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let reads = 0;
    let writes = 0;
    const storage = {
      getItem: () => { reads += 1; throw new Error('denied'); },
      setItem: () => { writes += 1; throw new Error('denied'); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    vi.stubGlobal('localStorage', storage);
    try {
      const { container } = render(<TestWrapper initialEntry="/workitems"><Sidebar /></TestWrapper>);
      expect(screen.getByRole('link', { name: '工单' })).toHaveAttribute('aria-current', 'page');
      await userEvent.click(screen.getByRole('button', { name: '设置' }));
      expect(container.querySelector('.aw-panel')).not.toBeNull();
      expect(reads).toBeGreaterThan(0);
      expect(writes).toBeGreaterThan(0);
    } finally {
      if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
      vi.unstubAllGlobals();
    }
  });
});

function TestWrapper({
  children,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  initialEntry = '/workitems',
}: {
  children: React.ReactNode;
  queryClient?: QueryClient;
  initialEntry?: string;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="*" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const keysOf = (items: { key: string }[]) => items.map((item) => item.key);

describe('Sidebar helpers', () => {
  it('keeps only delivery and insights in the rail and folds employees/knowledge into settings', () => {
    expect(NAV_SPACES.map((space) => space.key)).toEqual(['delivery', 'insights']);
    expect(NAV_SPACES.map((space) => keysOf(space.items))).toEqual([
      ['/workbench', '/workitems', '/scheduled-tasks', '/executions', '/workitems/recycled'],
      ['/insights'],
    ]);
    expect(SETTINGS_SPACE.key).toBe('settings');
    expect(keysOf(SETTINGS_SPACE.items)).toEqual([
      '/agents', '/squads', '/sdlcs', '/executors',
      '/repos', '/memories', '/skills',
      '/status-templates',
      '/settings/environment-variables',
      '/integrations',
      '/settings/members',
      '/settings/backups',
      '/settings',
      '/audit-logs',
    ]);
    expect(SETTINGS_SPACE.items.map((item) => item.groupLabelKey)).toEqual([
      'nav.agentsGroup', 'nav.agentsGroup', 'nav.agentsGroup', 'nav.agentsGroup',
      'nav.knowledge', 'nav.knowledge', 'nav.knowledge',
      'nav.groupDeliveryConfig',
      'nav.groupDeliveryConfig',
      'nav.groupDeliveryConfig',
      'nav.groupWorkspace',
      'nav.groupWorkspace',
      'nav.groupWorkspace',
      'nav.groupCompliance',
    ]);
    expect(ABOUT_NAV_ITEM.key).toBe('/about');
  });

  it('gates the 定时任务 rail entry behind the scheduled task capability', () => {
    expect(keysOf(visibleSpaceItems(deliverySpace, false)))
      .toEqual(['/workbench', '/workitems', '/executions', '/workitems/recycled']);
    expect(keysOf(visibleSpaceItems(deliverySpace, true)))
      .toEqual(['/workbench', '/workitems', '/scheduled-tasks', '/executions', '/workitems/recycled']);
  });

  it('treats settings-center prefixes as settings and leaves spaces to the rail', () => {
    for (const path of ['/settings', '/settings/members', '/status-templates', '/integrations', '/integrations/channels', '/audit-logs']) {
      expect(isSettingsRoute(path)).toBe(true);
    }
    for (const path of ['/agents', '/executors', '/repos/map', '/memories', '/skills', '/sdlcs', '/workitems', '/profile/settings']) {
      expect(isSettingsRoute(path)).toBe(false);
    }
  });

  it('matches the most specific navigation item for nested and legacy routes', () => {
    expect(resolveSelectedNavKey('/workitems/recycled')).toBe('/workitems/recycled');
    expect(resolveSelectedNavKey('/workitems/recycled/42')).toBe('/workitems/recycled');
    expect(resolveSelectedNavKey('/scheduled-tasks/7/edit')).toBe('/scheduled-tasks');
    expect(resolveSelectedNavKey('/scheduled-task-runs/12')).toBe('/scheduled-tasks');
    expect(resolveSelectedNavKey('/insights')).toBe('/insights');
    expect(resolveSelectedNavKey('/about')).toBe('/about');
    expect(resolveSelectedNavKey('/agents/reviews')).toBe('/agents');
    expect(resolveSelectedNavKey('/agents/42')).toBe('/agents');
    expect(resolveSelectedNavKey('/repos/map')).toBe('/repos');
    expect(resolveSelectedNavKey('/integrations/channels')).toBe('/integrations');
    expect(resolveSelectedNavKey('/settings/environment-variables')).toBe('/settings/environment-variables');
    expect(resolveSelectedNavKey('/status-templates')).toBe('/status-templates');
    expect(resolveSelectedNavKey('/settings/overview')).toBe('/settings');
    expect(resolveSelectedNavKey('/settings/members-roles/roles')).toBe('/settings');
    expect(resolveSelectedNavKey('/overview')).toBe('');
  });

  it('resolves which rail space owns the current route', () => {
    expect(resolveSelectedSpaceKey('/workitems/42')).toBe('delivery');
    expect(resolveSelectedSpaceKey('/scheduled-task-runs/12')).toBe('delivery');
    expect(resolveSelectedSpaceKey('/insights')).toBe('insights');
    expect(resolveSelectedSpaceKey('/agents/42')).toBe('settings');
    expect(resolveSelectedSpaceKey('/executors')).toBe('settings');
    expect(resolveSelectedSpaceKey('/repos/map')).toBe('settings');
    expect(resolveSelectedSpaceKey('/skills')).toBe('settings');
    expect(resolveSelectedSpaceKey('/settings/members')).toBe('settings');
    expect(resolveSelectedSpaceKey('/status-templates')).toBe('settings');
    expect(resolveSelectedSpaceKey('/about')).toBeNull();
  });

  it('no longer exposes the removed platform entries', () => {
    const keys = [...NAV_SPACES.flatMap((space) => space.items), ...SETTINGS_SPACE.items, ABOUT_NAV_ITEM]
      .map((item) => item.key);

    expect(keys).not.toContain('/evolution');
    expect(keys).not.toContain('/open-platform');
    expect(resolveSelectedNavKey('/evolution')).toBe('');
    expect(resolveSelectedNavKey('/platform/branding')).toBe('');
  });
});
