import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import {
  AppLayout,
  getWorkspaceDeepLinkId,
  removeWorkspaceDeepLink,
} from './AppLayout';
import { useAuthStore } from '@/shared/auth/store';
import { refreshCurrentMembership } from '@/shared/auth/refreshCurrentMembership';

vi.mock('@/shared/ui/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="notification-bell">bell</div>,
}));
// 提醒宿主自带实时订阅与计时，布局用例不关心它；它有自己的组件测试。
vi.mock('@/features/notification/NotificationReminderHost', () => ({
  NotificationReminderHost: () => null,
}));
vi.mock('@/shared/auth/refreshCurrentMembership', () => ({
  refreshCurrentMembership: vi.fn(),
}));

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        {ui}
      </QueryClientProvider>,
    ),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

describe('AppLayout', () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the header on public help without platform navigation or workspace refresh', async () => {
    renderWithQueryClient(
      <MemoryRouter initialEntries={['/help?workspaceId=99']}>
        <Routes>
          <Route element={<AppLayout helpCenter />}>
            <Route path="/help" element={<h1>帮助正文</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '帮助正文' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /返回工单列表/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '帮助中心' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开 Chief' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /登\s*录/ })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /菜单/ })).not.toBeInTheDocument();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(refreshCurrentMembership).not.toHaveBeenCalled());
  });

  it('refreshes current membership on mount and when the window regains focus', () => {
    useAuthStore.getState().setCurrentWorkspace(
      { id: 7, name: '星云工坊', description: '' },
      'ADMIN',
    );
    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工单页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(refreshCurrentMembership).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));

    expect(refreshCurrentMembership).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/workitems/new', true],
    ['/workitems/new/', true],
    ['/workitems/recycled', true],
    ['/workitems/42', false],
    ['/workitems/42/', false],
    ['/scheduled-task-runs/12', false],
    ['/scheduled-task-runs/12/', false],
    ['/scheduled-tasks/7', false],
    ['/scheduled-tasks/7/edit', true],
    ['/scheduled-tasks/new', true],
    ['/insights', false],
    ['/insights/', false],
    ['/agents/42', true],
    ['/settings/members', false],
    ['/agents', false],
    ['/agents/new', false],
    ['/agents/reviews', false],
    ['/executors', false],
    ['/repos', false],
    ['/memories', false],
    ['/skills', false],
    ['/sdlcs', false],
    ['/status-templates', false],
    ['/integrations', false],
    ['/audit-logs', false],
  ])('applies the global frame correctly on %s', (path, framed) => {
    const { container } = renderWithQueryClient(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="*" element={<div data-testid="page-body">页面</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('.aw-content-frame')).toHaveLength(framed ? 1 : 0);
    if (framed) expect(screen.getByTestId('page-body').closest('.aw-content-frame')).not.toBeNull();
  });

  it('parses and removes one-shot workspace deep-link parameters', () => {
    expect(getWorkspaceDeepLinkId('?workspaceId=8')).toBe(8);
    expect(getWorkspaceDeepLinkId('?workspaceId=0')).toBeNull();
    expect(getWorkspaceDeepLinkId('?workspaceId=abc')).toBeNull();
    expect(removeWorkspaceDeepLink('?workspaceId=8&tab=timeline')).toBe('?tab=timeline');
    expect(removeWorkspaceDeepLink('?workspaceId=8')).toBe('');
  });

  it('aligns the sidebar brand divider with the page header divider', async () => {
    useAuthStore.getState().setCurrentWorkspace(
      { id: 7, name: '星云工坊', description: '' },
      'READ_ONLY',
    );

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工单页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const brand = await screen.findByRole('link', { name: /返回工作台/ });
    expect(brand.parentElement).toHaveClass('aw-brand');
  });

  it('renders workspace context and only a compact user avatar in the header', () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'ADMIN');

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/settings/roles']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/settings/roles" element={<div>角色权限页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getAllByText('星云工坊')).toHaveLength(1);
    const workspaceInitialMarks = screen.getAllByText('星');
    expect(workspaceInitialMarks).toHaveLength(1);
    workspaceInitialMarks.forEach((mark) => {
      expect(mark).toHaveClass('aw-initial-mark');
    });
    expect(screen.getByRole('button', { name: '用户菜单' })).toHaveTextContent('爱');
    // 配置项收进设置的轨道空间，面板列出设置页（含系统设置）；「设置」入口保持选中。
    expect(screen.getByRole('link', { name: '系统设置' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '成员管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'true');
    // 设置页由外壳自带画布，不再套全局 .aw-content-frame。
    expect(screen.queryByRole('region', { name: '页面内容' })).not.toBeInTheDocument();
    expect(screen.getByText('角色权限页')).toBeInTheDocument();
    expect(document.querySelector('.aw-page-header-context')?.textContent).toBe('');
    expect(screen.queryByText('爱丽丝')).not.toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('navigates to personal settings from user menu', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'READ_ONLY');

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工作项页</div>} />
            <Route path="/profile/settings" element={<div>个人设置页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: '用户菜单' }));
    await userEvent.click(await screen.findByText('个人设置'));

    expect(await screen.findByText('个人设置页')).toBeInTheDocument();
  });

  it('switches to the deep-linked workitem workspace and cleans the url', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setAccessToken('workspace-7-token');
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'READ_ONLY');
    server.use(
      http.get('/api/workspaces/mine', () => HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: [
          { id: 7, name: '星云工坊', description: '研发工作空间' },
          { id: 8, name: '平台商业化', description: '私有化工作空间' },
        ],
      })),
      http.post('/api/workspaces/8/switch', () => HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { accessToken: 'workspace-8-token', accessLevel: 'READ_ONLY' },
      })),
    );

    const { queryClient } = renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems/42?workspaceId=8']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems/:id" element={<><LocationProbe /><div>工单详情页</div></>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    queryClient.setQueryData(['workitems', { page: 1 }], { list: [{ id: 101 }] });
    queryClient.setQueryData(['workitem', '42'], { id: 42, title: '旧工作空间详情缓存' });
    queryClient.setQueryData(['workitem', '42', 'unified-timeline'], [{ id: 1 }]);

    await waitFor(() => {
      expect(useAuthStore.getState().currentWorkspace?.id).toBe(8);
    });
    expect(useAuthStore.getState().accessToken).toBe('workspace-8-token');
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workitems/42');
    await waitFor(() => expect(screen.getByTestId('location-probe')).not.toHaveTextContent('workspaceId=8'));
    expect(queryClient.getQueryData(['workitems', { page: 1 }])).toBeUndefined();
    expect(queryClient.getQueryData(['workitem', '42'])).toBeUndefined();
    expect(queryClient.getQueryData(['workitem', '42', 'unified-timeline'])).toBeUndefined();
  });

  it('opens workspace dropdown menu from the sidebar workspace chip', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setAccessToken('workspace-7-token');
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'READ_ONLY');
    server.use(
      http.get('/api/workspaces/mine', () => HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: [
          { id: 7, name: '星云工坊', description: '研发工作空间' },
          { id: 8, name: '平台商业化', description: '私有化工作空间' },
        ],
      })),
    );

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工单页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('星云工坊');
    await userEvent.click(screen.getByText('星云工坊'));

    expect(await screen.findByText('平台商业化')).toBeInTheDocument();
    expect(await screen.findByText('管理工作空间...')).toBeInTheDocument();
  });

  it('switches workspace from the sidebar dropdown without navigating away', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setAccessToken('workspace-7-token');
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'READ_ONLY');
    server.use(
      http.get('/api/workspaces/mine', () => HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: [
          { id: 7, name: '星云工坊', description: '研发工作空间' },
          { id: 8, name: '平台商业化', description: '私有化工作空间' },
        ],
      })),
      http.post('/api/workspaces/8/switch', () => HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { accessToken: 'workspace-8-token', accessLevel: 'READ_ONLY' },
      })),
    );

    const { queryClient } = renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<><LocationProbe /><div>工单页</div></>} />
            <Route path="/workspaces" element={<div>工作空间选择页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    queryClient.setQueryData(['workitems', { page: 1 }], { list: [{ id: 101 }] });
    queryClient.setQueryData(['agents', 1, 10], { list: [{ id: 1, name: 'stale-agent' }] });

    await screen.findByText('星云工坊');
    await userEvent.click(screen.getByText('星云工坊'));
    await userEvent.click(await screen.findByText('平台商业化'));

    await waitFor(() => {
      expect(useAuthStore.getState().currentWorkspace?.id).toBe(8);
    });
    expect(useAuthStore.getState().accessToken).toBe('workspace-8-token');
    expect(await screen.findByTestId('location-probe')).toHaveTextContent('/workitems');
    expect(screen.queryByText('工作空间选择页')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(['workitems', { page: 1 }])).toBeUndefined();
    expect(queryClient.getQueryData(['agents', 1, 10])).toBeUndefined();
  });

  it('removes the legacy "切换工作空间" menu item from the user dropdown', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setAccessToken('workspace-7-token');
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'READ_ONLY');

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工作项页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: '用户菜单' }));
    expect(screen.queryByText('切换工作空间')).not.toBeInTheDocument();
    expect(screen.getByText('个人设置')).toBeInTheDocument();
    expect(screen.getByText('退出登录')).toBeInTheDocument();
  });

  it('clears auth state and the entire query cache on logout', async () => {
    useAuthStore.getState().setUser({
      id: 1,
      username: 'alice',
      nickname: '爱丽丝',
      email: 'alice@example.com',
    });
    useAuthStore.getState().setAccessToken('session-token');
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '研发工作空间' }, 'ADMIN');

    const { queryClient } = renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工作项页</div>} />
          </Route>
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>,
    );
    queryClient.setQueryData(['workspaces', 'mine', 1], [{ id: 7, name: '星云工坊', description: '研发工作空间' }]);
    queryClient.setQueryData(['workitems', { page: 1, size: 20 }], { content: [{ id: 101, title: '租户数据' }] });

    await userEvent.click(screen.getByRole('button', { name: '用户菜单' }));
    await userEvent.click(screen.getByText('退出登录'));

    await waitFor(() => {
      expect(screen.getByText('登录页')).toBeInTheDocument();
    });
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().currentWorkspace).toBeNull();
    expect(queryClient.getQueryData(['workspaces', 'mine', 1])).toBeUndefined();
    expect(queryClient.getQueryData(['workitems', { page: 1, size: 20 }])).toBeUndefined();
  });

  it('truncates workspace text and hides long user names and email', () => {
    const longWorkspaceName = '超长工作空间名称'.repeat(12);
    const longNickname = '超长昵称'.repeat(12);
    const longEmail = `${'verylong'.repeat(8)}@example.com`;

    useAuthStore.getState().setUser({
      id: 2,
      username: 'long-user',
      nickname: longNickname,
      email: longEmail,
    });
    useAuthStore.getState().setCurrentWorkspace({ id: 8, name: longWorkspaceName, description: '长工作空间' }, 'READ_ONLY');

    renderWithQueryClient(
      <MemoryRouter initialEntries={['/status-templates']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/status-templates" element={<div>状态模版页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // The switcher name no longer carries an unconditional native title; the hover tooltip is
    // owned by EllipsisText and only appears when the text actually overflows (no layout in
    // jsdom, so it never appears here). The ellipsis styling itself is still asserted.
    const workspaceText = screen.getByText(longWorkspaceName);
    expect(workspaceText).toHaveStyle({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(screen.queryByTitle(longNickname)).not.toBeInTheDocument();
    expect(screen.queryByTitle(longEmail)).not.toBeInTheDocument();
    const userMenu = screen.getByRole('button', { name: '用户菜单' });
    expect(userMenu).toHaveStyle({ width: '36px', height: '36px' });
    expect(userMenu.querySelector('.aw-initial-mark')).toHaveStyle({ width: '28px', height: '28px', borderRadius: '50%' });
    expect(screen.queryByTitle('状态模版')).not.toBeInTheDocument();
  });

  it('offers the Chief entry left of the help center only when signed in with a workspace', async () => {
    useAuthStore.getState().setUser({ id: 1, username: 'alice', nickname: '爱丽丝', email: 'alice@example.com' });
    useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '' }, 'READ_ONLY');
    renderWithQueryClient(
      <MemoryRouter initialEntries={['/workitems']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/workitems" element={<div>工单页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const entry = await screen.findByRole('button', { name: '打开 Chief' });
    const help = screen.getByRole('link', { name: '帮助中心' });
    expect(entry.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('falls back to the expanded rail without matchMedia and with unreadable layout preferences', () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { writable: true, value: undefined });
    // Node 26 内置 localStorage 的方法是实例自有属性，需在实例上覆盖而非 spy 原型。
    const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let reads = 0;
    const storage = {
      getItem: () => { reads += 1; throw new Error('denied'); },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    vi.stubGlobal('localStorage', storage);
    try {
      useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '' }, 'ADMIN');
      renderWithQueryClient(
        <MemoryRouter initialEntries={['/workitems']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/workitems" element={<div>工单页</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByText('工单页')).toBeInTheDocument();
      expect(document.querySelector('.aw-sider')).not.toHaveClass('collapsed');
      expect(screen.getByRole('link', { name: '工单' })).toBeInTheDocument();
      expect(reads).toBeGreaterThan(0);
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
      vi.unstubAllGlobals();
    }
  });

  it('collapses the rail once the compact breakpoint matches', () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 1080px)', media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      }),
    });
    try {
      useAuthStore.getState().setCurrentWorkspace({ id: 7, name: '星云工坊', description: '' }, 'ADMIN');
      renderWithQueryClient(
        <MemoryRouter initialEntries={['/workitems']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/workitems" element={<div>工单页</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(document.querySelector('.aw-sider')).toHaveClass('collapsed');
      expect(screen.getByTitle('星云工坊')).toBeInTheDocument();
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    }
  });
});
