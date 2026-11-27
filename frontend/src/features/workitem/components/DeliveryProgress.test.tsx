import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import * as workitemApi from '../api';
import { ExecutionControlTimeline } from './ExecutionControlTimeline';
import { DeliveryProgress, formatDuration, convergeStepsForTerminalStatus } from './DeliveryProgress';
import type { Artifact, DeliveryProgress as DeliveryProgressModel, DeliveryStep, DispatchAttempt, RuntimeTrace, RuntimeTraceTokenUsage } from '@/shared/types/workitem';

const traceFixture = (dispatchId: number, usage: Partial<RuntimeTraceTokenUsage> = {}): RuntimeTrace => ({
  schemaVersion: 'autowonder.runtime-trace.v2', dispatchId, runtimeId: null, provider: 'qoder', source: 'LIVE',
  changed: true, lastSeq: 0, events: [], sessions: [],
  tokenUsage: { available: false, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, ...usage },
});

// jsdom 没有 PointerEvent 构造器，fireEvent.pointer* 会丢失坐标，用 MouseEvent 派生 pointer 事件
function firePointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: HTMLElement, coords: { clientX?: number; clientY?: number } = {}) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, ...coords }));
}

function stubMobileMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('767.98px'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // ResizeObserver is a browser API missing only in jsdom; keep the stub test-local.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  server.use(http.get('/api/dispatches/:dispatchId/runtime-trace', ({ params }) => HttpResponse.json({ success: true, code: '0', data: traceFixture(Number(params.dispatchId)) })));
  server.use(http.get('/api/dispatches/:dispatchId/runtime-trace/events', ({ params }) => HttpResponse.json({ success: true, code: '0', data: { dispatchId: Number(params.dispatchId), events: [], changed: true } })));
  server.use(http.get('/api/dispatches/:dispatchId/runtime-trace/events/window', ({ params }) => HttpResponse.json({ success: true, code: '0', data: { dispatchId: Number(params.dispatchId), events: [], changed: true } })));
  server.use(http.get('/api/dispatches/:dispatchId/runtime-trace/activities', ({ params }) => HttpResponse.json({
    success: true,
    code: '0',
    message: '',
    traceId: null,
    data: { dispatchId: Number(params.dispatchId), activities: [] },
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// The live activity panel subscribes to the realtime transport for active agents; stub it so
// renders do not open an unhandled /ws connection under msw's onUnhandledRequest:'error'.
vi.mock('@/shared/realtime/useRealtime', () => ({ useRealtime: () => undefined }));

// 新交付轨道：工作台入口收敛到数字人行与执行卡内「查看执行」，底部不再有整宽主按钮。
const openWorkbench = async (): Promise<HTMLElement> => {
  const rail = screen.getByTestId('delivery-rail');
  const row = within(rail).queryByTestId('current-agent-name')?.closest('button')
    ?? within(rail).getAllByTestId('delivery-agent-row')[0];
  fireEvent.click(row as HTMLElement);
  const workbench = await screen.findByTestId('delivery-workbench');
  fireEvent.click(within(workbench).getByRole('tab', { name: 'Terminal' }));
  return workbench;
};
// 执行卡内「查看执行」按 Dispatch 直达运行时日志，不经过执行详情 tab。
const openExecutionLog = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getAllByRole('button', { name: '查看执行' })[0]);
  return await screen.findByTestId('delivery-workbench');
};
const openDetails = async () => {
  const workbench = await openWorkbench();
  fireEvent.click(within(workbench).getByRole('tab', { name: '执行详情' }));
  await waitFor(() => expect(within(workbench).getByRole('tabpanel', { name: '执行详情' })).toBeVisible());
  return workbench;
};
const openArtifacts = async () => {
  const workbench = await openWorkbench();
  fireEvent.click(within(workbench).getByRole('tab', { name: /^产物（/ }));
  await waitFor(() => expect(within(workbench).getByRole('tabpanel', { name: /^产物（/ })).toBeVisible());
  return workbench;
};

describe('formatDuration', () => {
  it('returns empty string for null', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
  });

  it('formats sub-minute durations as seconds', () => {
    expect(formatDuration(30_000)).toBe('30秒');
  });

  it('formats minute durations', () => {
    expect(formatDuration(161_000)).toBe('2分41秒');
    expect(formatDuration(120_000)).toBe('2分');
  });

  it('formats hour durations', () => {
    expect(formatDuration(3_600_000)).toBe('1时');
    expect(formatDuration(3_960_000)).toBe('1时6分');
  });
});

describe('DeliveryProgress', () => {
  it('hides the workbench sidebar by default on mobile', () => {
    stubMobileMatchMedia();
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41, agentName: '开发', status: 'active', durationMs: null,
        steps: [{
          stepId: 101, name: '开发', status: 'active', agentName: '开发', executorName: null,
          error: null, subSteps: null, durationMs: null,
          attempts: [{ dispatchId: 301, agentName: '开发', executorName: null, status: 'RUNNING', startedAt: null, durationMs: null }],
        }],
      }],
    };
    render(<DeliveryProgress progress={progress} />);

    fireEvent.click(screen.getByRole('button', { name: '查看执行' }));

    const rail = within(screen.getByTestId('delivery-workbench')).getByRole('complementary', { hidden: true });
    expect(rail).toHaveAttribute('hidden');
  });

  it('follows the selected session in the workbench control history', async () => {
    const progress: DeliveryProgressModel = { steps: [], executions: [301, 302].map(dispatchId => ({
      dispatchId, agentId: 41, agentName: 'RD', executorName: null, status: 'PAUSED', startedAt: null, durationMs: null,
    })) };
    const items = [301, 302].map(dispatchId => ({ id: dispatchId, type: 'system' as const,
      authorId: null, authorName: null, authorType: 'SYSTEM', isAgent: false, content: '', gmtCreate: '2026-10-21T04:00:00Z',
      executionControl: { action: 'PAUSE', phase: 'CONFIRMED', dispatchId, requestedByName: `operator-${dispatchId}` },
    }));
    render(<DeliveryProgress progress={progress} renderControlTimeline={(dispatchId, compact) =>
      <ExecutionControlTimeline key={`controls-${dispatchId}`} dispatchId={dispatchId} items={items} compact={compact} />} />);
    // 控制记录只留在工作台「控制记录」tab，按所选会话渲染完整时间线。
    const workbench = await openWorkbench();
    // 每组默认只显示最近 1 次，更早的执行需先展开
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 301/ }));
    expect(within(workbench).queryByTestId('delivery-current-execution')).not.toBeInTheDocument();
    expect(within(workbench).queryByTestId('execution-control-timeline-301')).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('tab', { name: '控制记录' }));
    await waitFor(() => expect(within(workbench).getByTestId('execution-control-timeline-301')).toBeVisible());
    expect(within(workbench).getByTestId('execution-control-timeline-301')).toHaveTextContent('operator-301');
    expect(within(workbench).queryByTestId('execution-control-timeline-302')).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 302/ }));
    await waitFor(() => expect(within(workbench).getByTestId('execution-control-timeline-302')).toHaveTextContent('operator-302'));
    expect(within(workbench).queryByTestId('execution-control-timeline-301')).not.toBeInTheDocument();
  });

  it('expands only handoff and evidence, folding other categories and history', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{ agentId: 41, agentName: 'RD', status: 'failed', durationMs: null, steps: [{
        stepId: 101, name: '开发', status: 'failed', agentName: 'RD', executorName: null, error: null, subSteps: null, durationMs: null,
        attempts: [301, 302].map(dispatchId => ({ dispatchId, agentName: 'RD', executorName: null, status: 'FAILED', startedAt: null, durationMs: null })),
      }] }],
    };
    const artifacts: Artifact[] = [
      { id: 1, dispatchId: 301, name: 'artifacts/output/deliverables/old.md', type: 'DELIVERABLE' },
      { id: 2, dispatchId: 302, name: 'artifacts/output/deliverables/current.md', type: 'DELIVERABLE' },
      { id: 3, dispatchId: 302, name: 'artifacts/attempts/step-101/output/deliverables/snapshot.md', type: 'SNAPSHOT' },
      { id: 4, dispatchId: 302, name: 'artifacts/output/handoff/summary.md', type: 'HANDOFF' },
      { id: 5, dispatchId: 302, name: 'artifacts/output/evidence/triage-report.md', type: 'EVIDENCE' },
      { id: 6, dispatchId: 302, name: 'artifacts/output/deliverables/runtime-source-revision.json', type: 'DELIVERABLE' },
      { id: 7, dispatchId: 302, name: 'artifacts/output/handoff/metadata.json', type: 'HANDOFF' },
    ].map(file => ({ ...file, workitemId: 100, size: null, gmtCreate: '' }));
    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    // Narrow the query to the collapse header inside the progress card: the forceRendered
    // ArtifactPreviewModal keeps a hidden "产物预览" title in the DOM, which /产物/ also matched.
    const workbench = await openArtifacts();
    expect(screen.queryByText('current.md')).not.toBeInTheDocument();
    expect(screen.queryByText('old.md')).not.toBeInTheDocument();
    expect(screen.queryByText('snapshot.md')).not.toBeInTheDocument();
    expect(screen.queryByText(/优先阅读/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('交接说明（1）')).toBeVisible());
    expect(screen.getByText('验证证据（1）')).toBeVisible();
    expect(screen.getByText('summary.md')).toBeVisible();
    expect(screen.getByText('triage-report.md')).toBeVisible();
    expect(screen.queryByText('runtime-source-revision.json')).not.toBeInTheDocument();
    expect(screen.queryByText('metadata.json')).not.toBeInTheDocument();
    // 产物分类「执行记录」（runtime）默认折叠；限定在工作台内，避免撞上轨道卡的历史链。
    fireEvent.click(within(workbench).getByText(/^执行记录（\d+）$/));
    expect(screen.getByText('runtime-source-revision.json')).toBeVisible();
    expect(screen.getByText('metadata.json')).toBeVisible();
    const preview = screen.getByLabelText(`预览产物 ${artifacts[2].name}`);
    expect(preview.tagName).toBe('BUTTON');
    expect(preview).toBeVisible();
    fireEvent.click(screen.getByText('第 1 次执行 · 失败 · 1 个产物'));
    expect(screen.queryByText('old.md')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText('交付结果（1）')[1]);
    expect(screen.getByText('old.md')).toBeVisible();
  });

  it('shows readable size and type inline next to each artifact name', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'artifacts/output/handoff/summary.md', type: 'HANDOFF', size: 12595, gmtCreate: '' },
      { id: 2, workitemId: 100, dispatchId: 301, name: 'artifacts/output/handoff/empty.txt', type: 'HANDOFF', size: 0, gmtCreate: '' },
      { id: 3, workitemId: 100, dispatchId: 301, name: 'artifacts/output/handoff/bundle.bin', type: 'HANDOFF', size: 2_097_152, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    await openArtifacts();

    await waitFor(() => expect(screen.getByText('12.3 KB · 交接说明')).toBeVisible());
    expect(screen.getByText('0 B · 交接说明')).toBeVisible();
    expect(screen.getByText('2.0 MB · 交接说明')).toBeVisible();
  });

  it('shows only the type when an artifact has no size and falls back to the raw type otherwise', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'artifacts/output/handoff/no-size.md', type: 'HANDOFF', size: null, gmtCreate: '' },
      { id: 2, workitemId: 100, dispatchId: 301, name: 'artifacts/output/other/custom.bin', type: 'CUSTOM_TYPE', size: 100, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    await openArtifacts();

    const nameButton = await screen.findByRole('button', { name: '打开产物 artifacts/output/handoff/no-size.md' });
    const row = nameButton.closest('.delivery-artifact-row');
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe('no-size.md交接说明');
    expect(row?.textContent).not.toContain('·');
    expect(row?.textContent).not.toMatch(/NaN|undefined/);

    fireEvent.click(screen.getByText(/其他文件（1）/));
    await waitFor(() => expect(screen.getByText('100 B · CUSTOM_TYPE')).toBeVisible());
  });

  it('opens the artifact preview when the artifact name is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Dev Summary\nPASS', { status: 200 })));
    server.use(http.get('/api/artifacts/1/download', () => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null, data: 'https://oss.example/dev-summary.md',
    })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    await openArtifacts();
    fireEvent.click(screen.getByText(/其他文件（/));

    fireEvent.click(screen.getByRole('button', { name: '打开产物 dev-summary.md' }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/artifacts/1/preview');
    expect(await screen.findByRole('heading', { name: 'Dev Summary' })).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('keeps preview and download actions next to a very long artifact name', async () => {
    const longName = `artifacts/output/handoff/${'a'.repeat(160)}.md`;
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: longName, type: 'HANDOFF', size: 2048, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    await openArtifacts();

    const nameButton = await screen.findByRole('button', { name: `打开产物 ${longName}` });
    expect(nameButton).toHaveClass('delivery-artifact-name');
    expect(nameButton).toHaveTextContent(`${'a'.repeat(160)}.md`);
    await waitFor(() => expect(screen.getByRole('button', { name: `预览产物 ${longName}` })).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: `下载产物 ${longName}` })).toBeVisible());

    const row = nameButton.closest('.delivery-artifact-row');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('2.0 KB · 交接说明');
  });

  it('renders the latest workflow plan separately from live execution status', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      workflowPlan: {
        revision: 2,
        agentId: 41,
        agentName: '开发 Dev',
        targetStepId: 'coding',
        reason: '实现方式发生变化',
        sourceGuidanceIds: [184],
        steps: [
          { stepKey: 'analysis', name: '需求分析', planStatus: 'REUSED', sourceAttempt: 1 },
          { stepKey: 'coding', name: '编码实现', planStatus: 'RUN', sourceAttempt: 2 },
          { stepKey: 'review', name: '代码评审', planStatus: 'RUN', sourceAttempt: 1 },
          { stepKey: 'deploy', name: '部署', planStatus: 'SKIPPED', sourceAttempt: 0 },
        ],
      },
      agents: [{
        agentId: 41,
        agentName: '开发 Dev',
        status: 'active',
        durationMs: 30_000,
        currentActivity: '正在分析评论和当前上下文',
        steps: [{
          stepId: 102,
          stepKey: 'coding',
          name: '编码实现',
          status: 'active',
          planStatus: 'RUN',
          sourceAttempt: 2,
          agentName: '开发 Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 30_000,
          currentDispatchId: 310,
          attempts: [{ dispatchId: 310, agentId: 41, agentName: '开发 Dev', executorName: null, status: 'RUNNING', startedAt: null, durationMs: 30_000,
            stepTimings: [{ stepId: 102, name: '编码实现', status: 'active', durationMs: 30_000 }] }],
        }],
      }],
    };

    render(<DeliveryProgress progress={progress} />);

    const planCard = screen.getByTestId('workflow-plan-card');
    const progressCard = screen.getByTestId('delivery-progress-card');
    expect(within(planCard).getByText('本轮执行计划')).toBeInTheDocument();
    expect(within(progressCard).getByText('交付进度跟踪')).toBeInTheDocument();
    expect(screen.getByText('第 2 轮')).toBeInTheDocument();
    expect(screen.getByText(/原因：实现方式发生变化/)).toBeInTheDocument();
    expect(screen.getByText(/复用.*需求分析/)).toBeInTheDocument();
    expect(screen.getByText(/重跑.*编码实现.*代码评审/)).toBeInTheDocument();
    expect(screen.getByText(/跳过.*部署/)).toBeInTheDocument();
    expect(screen.getByTestId('agent-current-activity')).toHaveTextContent('Dispatch 310');
    expect(screen.getByTestId('rail-live-activity')).toBeInTheDocument();
    // 本轮重跑标记出现在所选 Dispatch 的详情阶段列表。
    const workbench = await openDetails();
    expect(within(workbench).getByLabelText('执行阶段')).toHaveTextContent('本轮重跑');
  });

  it('renders step duration next to status', () => {
    const steps: DeliveryStep[] = [
      {
        stepId: 20,
        name: '编码实现',
        status: 'done',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: null,
      },
    ];
    render(<DeliveryProgress steps={steps} />);
    expect(screen.getByText(/30秒/)).toBeInTheDocument();
  });

  it('keeps completed step execution records expandable after one successful attempt', () => {
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '获取上下文与评论',
        status: 'done',
        agentName: 'AW代码评审工程师', executorName: null,
        error: null,
        subSteps: [
          { name: '读取工单上下文', status: 'done' },
          { name: '发布评审评论', status: 'done' },
        ],
        durationMs: 240_000,
        attempts: [{
          dispatchId: 30,
          agentName: 'AW代码评审工程师', executorName: null,
          status: 'SUCCEEDED',
          error: null,
          startedAt: null,
          durationMs: 240_000,
        }],
      },
    ];

    render(<DeliveryProgress steps={steps} />);

    const stepCard = screen.getByTestId('delivery-step-10');
    fireEvent.click(within(stepCard).getByText('执行记录'));

    expect(within(stepCard).getByText(/执行者: AW代码评审工程师/)).toBeInTheDocument();
    expect(within(stepCard).getByText(/第1次: AW代码评审工程师 · 成功 · 4分/)).toBeInTheDocument();
    expect(within(stepCard).getByText('读取工单上下文')).toBeInTheDocument();
    expect(within(stepCard).getByText('发布评审评论')).toBeInTheDocument();
  });

  it('shows the real executor alongside the agent on steps and attempts', () => {
    const steps: DeliveryStep[] = [
      {
        stepId: 11,
        name: '编码实现',
        status: 'active',
        agentName: 'AW全栈开发', executorName: 'runner-daily-01',
        error: null,
        subSteps: null,
        durationMs: null,
        attempts: [{
          dispatchId: 40,
          agentName: 'AW全栈开发', executorName: 'runner-daily-01',
          status: 'RUNNING',
          error: null,
          startedAt: null,
          durationMs: null,
        }],
      },
    ];

    render(<DeliveryProgress steps={steps} />);

    const stepCard = screen.getByTestId('delivery-step-11');

    expect(within(stepCard).getByText(/执行者: AW全栈开发/)).toBeInTheDocument();
    expect(within(stepCard).getByText('执行器: runner-daily-01')).toBeInTheDocument();
    expect(within(stepCard).getByText(/第1次: AW全栈开发 @ runner-daily-01 · 执行中/)).toBeInTheDocument();
  });

  it('loads and renders safe activity messages for a default-expanded failed attempt', async () => {
    let requests = 0;
    server.use(http.get('/api/dispatches/301/runtime-trace/activities', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: {
          dispatchId: 301,
          activities: [
            {
              eventId: '301:1',
              seq: 1,
              eventTime: '2026-09-02T10:00:00Z',
              eventType: 'agent.message',
              level: 'INFO',
              content: '正在分析工单评论。',
            },
            {
              eventId: '301:2',
              seq: null,
              eventTime: '2026-09-02T10:00:02Z',
              eventType: 'dispatch.executor_failover',
              level: 'ERROR',
              content: 'Runtime 10067 执行失败，正在切换其他在线 Runtime',
            },
          ],
        },
      });
    }));
    const steps: DeliveryStep[] = [{
      stepId: 11,
      name: '执行代码评审',
      status: 'failed',
      agentName: '评审 Agent', executorName: null,
      error: 'Runtime 执行失败',
      subSteps: null,
      durationMs: 10_000,
      attempts: [{
        dispatchId: 301,
        agentName: '评审 Agent', executorName: null,
        status: 'FAILED',
        error: 'Runtime 执行失败',
        startedAt: null,
        durationMs: 10_000,
      }],
    }];

    render(<DeliveryProgress steps={steps} />);

    const stepCard = screen.getByTestId('delivery-step-11');
    const feed = await within(stepCard).findByTestId('dispatch-activities-301');
    expect(within(feed).getByText('正在分析工单评论。')).toBeInTheDocument();
    expect(within(feed).getByText('Runtime 10067 执行失败，正在切换其他在线 Runtime')).toHaveClass('ant-typography-danger');
    expect(requests).toBe(1);
  });

  it('does not start a second activity poll while an active attempt request is still pending', async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      let resolveFirstResponse: ((response: Response) => void) | undefined;
      let notifyFirstRequest: (() => void) | undefined;
      const firstRequest = new Promise<void>((resolve) => { notifyFirstRequest = resolve; });
      const firstResponse = new Promise<Response>((resolve) => { resolveFirstResponse = resolve; });
      server.use(http.get('/api/dispatches/303/runtime-trace/activities', () => {
        requests += 1;
        notifyFirstRequest?.();
        return firstResponse;
      }));
      const steps: DeliveryStep[] = [{
        stepId: 13,
        name: '正在执行的代码评审',
        status: 'active',
        agentName: '评审 Agent', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 10_000,
        attempts: [{
          dispatchId: 303,
          agentName: '评审 Agent', executorName: null,
          status: 'RUNNING',
          error: null,
          startedAt: null,
          durationMs: 10_000,
        }],
      }];

      const { unmount } = render(<DeliveryProgress steps={steps} />);
      await firstRequest;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(requests).toBe(1);
      unmount();
      resolveFirstResponse?.(HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { dispatchId: 303, activities: [] },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers completed-attempt activity requests until execution records expand', async () => {
    let requests = 0;
    server.use(http.get('/api/dispatches/302/runtime-trace/activities', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { dispatchId: 302, activities: [] },
      });
    }));
    const steps: DeliveryStep[] = [{
      stepId: 12,
      name: '已完成的代码评审',
      status: 'done',
      agentName: '评审 Agent', executorName: null,
      error: null,
      subSteps: null,
      durationMs: 10_000,
      attempts: [{
        dispatchId: 302,
        agentName: '评审 Agent', executorName: null,
        status: 'SUCCEEDED',
        error: null,
        startedAt: null,
        durationMs: 10_000,
      }],
    }];

    render(<DeliveryProgress steps={steps} />);

    expect(requests).toBe(0);
    fireEvent.click(within(screen.getByTestId('delivery-step-12')).getByText('执行记录'));
    await waitFor(() => expect(requests).toBe(1));
  });

  it('opens a stable step when it becomes active without reopening a user-collapsed active step', () => {
    const pendingStep: DeliveryStep = {
      stepId: 14,
      name: '等待执行的代码评审',
      status: 'pending',
      agentName: '评审 Agent', executorName: null,
      error: null,
      subSteps: null,
      durationMs: null,
      attempts: [{
        dispatchId: 304,
        agentName: '评审 Agent', executorName: null,
        status: 'RUNNING',
        error: null,
        startedAt: null,
        durationMs: null,
      }],
    };
    const activeStep: DeliveryStep = { ...pendingStep, status: 'active' };
    const { rerender } = render(<DeliveryProgress steps={[pendingStep]} />);
    const stepCard = screen.getByTestId('delivery-step-14');

    expect(within(stepCard).queryByTestId('dispatch-activities-304')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[activeStep]} />);

    expect(within(stepCard).getByTestId('dispatch-activities-304')).toBeInTheDocument();
    fireEvent.click(within(stepCard).getByText('执行记录'));
    expect(within(stepCard).queryByTestId('dispatch-activities-304')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[{ ...activeStep, durationMs: 1_000 }]} />);

    expect(within(stepCard).queryByTestId('dispatch-activities-304')).not.toBeInTheDocument();
  });

  it('opens records when a pending step becomes paused and preserves a user collapse across paused updates', async () => {
    let requests = 0;
    server.use(http.get('/api/dispatches/306/runtime-trace/activities', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { dispatchId: 306, activities: [] },
      });
    }));
    const pendingStep: DeliveryStep = {
      stepId: 16,
      name: '等待暂停的代码评审',
      status: 'pending',
      agentName: '评审 Agent', executorName: null,
      error: null,
      subSteps: null,
      durationMs: null,
      attempts: [{
        dispatchId: 306,
        agentName: '评审 Agent', executorName: null,
        status: 'PAUSED',
        error: null,
        startedAt: null,
        durationMs: null,
      }],
    };
    const pausedStep: DeliveryStep = { ...pendingStep, status: 'paused' };

    const { rerender } = render(<DeliveryProgress steps={[pendingStep]} />);
    const stepCard = screen.getByTestId('delivery-step-16');
    expect(within(stepCard).queryByTestId('dispatch-activities-306')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[pausedStep]} />);

    expect(await within(stepCard).findByTestId('dispatch-activities-306')).toBeInTheDocument();
    await waitFor(() => expect(requests).toBe(1));

    fireEvent.click(within(stepCard).getByText('执行记录'));
    expect(within(stepCard).queryByTestId('dispatch-activities-306')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[{ ...pausedStep, durationMs: 1_000 }]} />);

    expect(within(stepCard).queryByTestId('dispatch-activities-306')).not.toBeInTheDocument();
    expect(requests).toBe(1);
  });

  it('opens records when a completed step becomes failed and preserves a user collapse across failed updates', async () => {
    let requests = 0;
    server.use(http.get('/api/dispatches/307/runtime-trace/activities', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { dispatchId: 307, activities: [] },
      });
    }));
    const doneStep: DeliveryStep = {
      stepId: 17,
      name: '完成后失败的代码评审',
      status: 'done',
      agentName: '评审 Agent', executorName: null,
      error: null,
      subSteps: null,
      durationMs: null,
      attempts: [{
        dispatchId: 307,
        agentName: '评审 Agent', executorName: null,
        status: 'FAILED',
        error: '执行失败',
        startedAt: null,
        durationMs: null,
      }],
    };
    const failedStep: DeliveryStep = { ...doneStep, status: 'failed', error: '执行失败' };

    const { rerender } = render(<DeliveryProgress steps={[doneStep]} />);
    const stepCard = screen.getByTestId('delivery-step-17');
    expect(within(stepCard).queryByTestId('dispatch-activities-307')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[failedStep]} />);

    expect(await within(stepCard).findByTestId('dispatch-activities-307')).toBeInTheDocument();
    await waitFor(() => expect(requests).toBe(1));

    fireEvent.click(within(stepCard).getByText('执行记录'));
    expect(within(stepCard).queryByTestId('dispatch-activities-307')).not.toBeInTheDocument();

    rerender(<DeliveryProgress steps={[{ ...failedStep, durationMs: 1_000 }]} />);

    expect(within(stepCard).queryByTestId('dispatch-activities-307')).not.toBeInTheDocument();
    expect(requests).toBe(1);
  });

  it('keeps every completed step expandable inside a finished agent group', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: 'AW全栈开发',
          status: 'finished',
          durationMs: 600_000,
          steps: [
            {
              stepId: 101,
              name: '需求分析与评论',
              status: 'done',
              agentName: 'AW全栈开发', executorName: null,
              error: null,
              subSteps: [{ name: '发布分析评论', status: 'done' }],
              durationMs: 120_000,
              attempts: [
                { dispatchId: 301, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
            {
              stepId: 102,
              name: '编码实现',
              status: 'done',
              agentName: 'AW全栈开发', executorName: null,
              error: null,
              subSteps: [{ name: '提交修复代码', status: 'done' }],
              durationMs: 480_000,
              attempts: [
                { dispatchId: 302, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 480_000 },
              ],
            },
          ],
        },
      ],
    };

    render(<DeliveryProgress progress={progress} />);
    const workbench = await openDetails();

    expect(within(workbench).queryByTestId('delivery-step-101')).not.toBeInTheDocument();
    const secondStep = within(workbench).getByTestId('delivery-step-102');
    // 工作台详情平铺：子步骤直接展示，dispatch 元信息只在顶部出现一次
    expect(within(secondStep).queryByText('执行记录')).not.toBeInTheDocument();
    expect(within(workbench).getAllByText('执行者: AW全栈开发')).toHaveLength(1);
    expect(within(workbench).getAllByText('8分').length).toBeGreaterThan(0);
    expect(within(secondStep).getByText('提交修复代码')).toBeInTheDocument();

    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 301/ }));
    const firstStep = within(workbench).getByTestId('delivery-step-101');
    expect(within(workbench).getAllByText('2分').length).toBeGreaterThan(0);
    expect(within(firstStep).getByText('发布分析评论')).toBeInTheDocument();
    expect(within(workbench).queryByTestId('delivery-step-102')).not.toBeInTheDocument();
  });

  it('renders per-attempt durations when there are retries', () => {
    const steps: DeliveryStep[] = [
      {
        stepId: 20,
        name: '编码实现',
        status: 'active',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: [
          { dispatchId: 30, agentName: 'worker', executorName: null, status: 'FAILED', error: null, startedAt: null, durationMs: 161_000 },
          { dispatchId: 31, agentName: 'worker', executorName: null, status: 'PENDING', error: null, startedAt: null, durationMs: 30_000 },
        ],
      },
    ];
    render(<DeliveryProgress steps={steps} />);
    expect(screen.getByText(/第1次:/)).toBeInTheDocument();
    expect(screen.getByText(/2分41秒/)).toBeInTheDocument();
    expect(screen.getByText(/第2次:/)).toBeInTheDocument();
  });

  it('offers continue only for a resumable attempt', () => {
    const steps: DeliveryStep[] = [{
      stepId: 20,
      name: '编码实现',
      status: 'failed',
      agentName: 'worker', executorName: null,
      error: 'provider unavailable',
      subSteps: null,
      durationMs: 30_000,
      attempts: [{
        dispatchId: 30,
        agentName: 'worker', executorName: null,
        status: 'FAILED',
        error: 'provider unavailable',
        startedAt: null,
        durationMs: 30_000,
        canContinue: true,
      }],
    }];

    const onExecutionAction = vi.fn();
    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 30 }), 'resume');
  });

  it('offers pause for the active pauseable attempt', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [{
      stepId: 20,
      name: '编码实现',
      status: 'active',
      agentName: 'worker', executorName: null,
      error: null,
      subSteps: null,
      durationMs: 30_000,
      attempts: [{
        dispatchId: 30,
        agentName: 'worker', executorName: null,
        status: 'RUNNING',
        error: null,
        startedAt: null,
        durationMs: 30_000,
        canPause: true,
      }],
    }];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);
    fireEvent.click(screen.getByRole('button', { name: /暂停/ }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 30 }), 'pause');
  });

  it('shows pausing state without offering retry while pause is in flight', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [{
      stepId: 20,
      name: '编码实现',
      status: 'active',
      agentName: 'worker', executorName: null,
      error: null,
      subSteps: null,
      durationMs: 30_000,
      attempts: [{
        dispatchId: 30,
        agentName: 'worker', executorName: null,
        status: 'PAUSING',
        error: null,
        startedAt: null,
        durationMs: 30_000,
        canPause: true,
      }],
    }];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);

    expect(screen.getByTestId('delivery-step-20')).toHaveTextContent('暂停中');
    expect(screen.getByTestId('delivery-step-20')).not.toHaveTextContent('执行中');
    expect(screen.queryByRole('button', { name: '重试暂停' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    expect(onExecutionAction).not.toHaveBeenCalled();
  });

  it('shows the worker as pausing while its active attempt is pausing', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'AW全栈开发',
        status: 'active',
        durationMs: 30_000,
        steps: [{
          stepId: 20,
          name: '编码实现',
          status: 'active',
          agentName: 'worker', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 30_000,
          attempts: [{
            dispatchId: 30,
            agentName: 'worker', executorName: null,
            status: 'PAUSING',
            error: null,
            startedAt: null,
            durationMs: 30_000,
            canPause: true,
          }],
        }],
      }],
    };

    render(<DeliveryProgress progress={progress} onPause={vi.fn()} />);

    expect(screen.getAllByText('暂停中', { selector: '.ant-tag' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('执行中', { selector: '.ant-tag' })).not.toBeInTheDocument();
  });

  it('offers retry pause for failed pause attempt', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [{
      stepId: 20,
      name: '编码实现',
      status: 'failed',
      agentName: 'worker', executorName: null,
      error: null,
      subSteps: null,
      durationMs: 30_000,
      attempts: [{
        dispatchId: 30,
        agentName: 'worker', executorName: null,
        status: 'PAUSE_FAILED',
        error: null,
        startedAt: null,
        durationMs: 30_000,
        canPause: true,
      }],
    }];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);
    fireEvent.click(screen.getByRole('button', { name: '重试暂停' }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 30 }), 'pause');
  });

  it('renders one execution-level action instead of per-step actions', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '需求分析',
        status: 'done',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: [{
          dispatchId: 30,
          agentName: 'worker', executorName: null,
          status: 'RUNNING',
          error: null,
          startedAt: null,
          durationMs: 30_000,
          canPause: true,
        }],
      },
      {
        stepId: 20,
        name: '编码实现',
        status: 'active',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 10_000,
        attempts: null,
      },
    ];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);

    expect(within(screen.getByTestId('delivery-step-10')).queryByRole('button', { name: /暂停/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('delivery-step-20')).queryByRole('button', { name: /暂停/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /暂停/ }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 30 }), 'pause');
  });

  it('mounts a moved attempt activity feed only on the active action-owning step', async () => {
    let requests = 0;
    const getRuntimeActivities = vi.spyOn(workitemApi, 'getRuntimeActivities');
    server.use(http.get('/api/dispatches/30/runtime-trace/activities', () => {
      requests += 1;
      return HttpResponse.json({
        success: true,
        code: '0',
        message: '',
        traceId: null,
        data: { dispatchId: 30, activities: [] },
      });
    }));
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '需求分析',
        status: 'done',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: [{
          dispatchId: 30,
          agentName: 'worker', executorName: null,
          status: 'RUNNING',
          error: '迁移前的执行错误',
          startedAt: null,
          durationMs: 30_000,
          canPause: true,
        }],
      },
      {
        stepId: 20,
        name: '编码实现',
        status: 'active',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 10_000,
        attempts: null,
      },
    ];

    render(<DeliveryProgress steps={steps} />);

    const sourceStep = screen.getByTestId('delivery-step-10');
    const targetStep = screen.getByTestId('delivery-step-20');
    expect(await within(targetStep).findByTestId('dispatch-activities-30')).toBeInTheDocument();
    await waitFor(() => expect(requests).toBe(1));
    expect(getRuntimeActivities).toHaveBeenCalledTimes(1);

    fireEvent.click(within(sourceStep).getByText('执行记录'));

    expect(within(sourceStep).getByText(/第1次: worker · 执行中.*迁移前的执行错误/)).toBeInTheDocument();
    expect(getRuntimeActivities).toHaveBeenCalledTimes(1);
    expect(requests).toBe(1);
    expect(within(sourceStep).queryByTestId('dispatch-activities-30')).not.toBeInTheDocument();
    getRuntimeActivities.mockRestore();
  });

  it('does not offer pause for a comment interaction execution', () => {
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '需求分析',
        status: 'done',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: [{
          dispatchId: 30,
          agentName: 'worker', executorName: null,
          status: 'RUNNING',
          resumeMode: 'SIDE_INTERACTION',
          error: null,
          startedAt: null,
          durationMs: 30_000,
          canPause: true,
        }],
      },
      {
        stepId: 20,
        name: '编码实现',
        status: 'active',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 10_000,
        attempts: null,
      },
    ];

    render(<DeliveryProgress steps={steps} />);

    expect(screen.queryByRole('button', { name: /暂停/ })).not.toBeInTheDocument();
  });

  it('renders resumable execution actions at execution level', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '需求分析',
        status: 'done',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 30_000,
        attempts: [{
          dispatchId: 30,
          agentName: 'worker', executorName: null,
          status: 'FAILED',
          error: 'provider unavailable',
          startedAt: null,
          durationMs: 30_000,
          canContinue: true,
        }],
      },
      {
        stepId: 20,
        name: '编码实现',
        status: 'failed',
        agentName: 'worker', executorName: null,
        error: 'provider unavailable',
        subSteps: null,
        durationMs: 10_000,
        attempts: null,
      },
    ];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);

    expect(within(screen.getByTestId('delivery-step-10')).queryByRole('button', { name: /继续/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('delivery-step-20')).queryByRole('button', { name: /继续/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /继续/ }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 30 }), 'resume');
  });

  it('keeps resumable actions on the paused execution', () => {
    const onExecutionAction = vi.fn();
    const steps: DeliveryStep[] = [
      {
        stepId: 10,
        name: '需求分析',
        status: 'failed',
        agentName: 'worker', executorName: null,
        error: 'previous failure',
        subSteps: null,
        durationMs: 30_000,
        attempts: null,
      },
      {
        stepId: 20,
        name: '编码实现',
        status: 'paused',
        agentName: 'worker', executorName: null,
        error: null,
        subSteps: null,
        durationMs: 10_000,
        attempts: [{
          dispatchId: 40,
          agentName: 'worker', executorName: null,
          status: 'PAUSED',
          error: null,
          startedAt: null,
          durationMs: 10_000,
          canContinue: true,
        }],
      },
    ];

    render(<DeliveryProgress steps={steps} onExecutionAction={onExecutionAction} />);

    expect(within(screen.getByTestId('delivery-step-10')).queryByRole('button', { name: /继续/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('delivery-step-20')).queryByRole('button', { name: /继续/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /继续/ }));
    expect(onExecutionAction).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 40 }), 'resume');
  });

  it('renders agent grouped progress with error and artifact ownership', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: 'Agent Dev',
          status: 'finished',
          durationMs: 120_000,
          steps: [
            {
              stepId: 101,
              name: '需求分析与建分支',
              status: 'done',
              agentName: 'Agent Dev', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
          ],
        },
        {
          agentId: 42,
          agentName: 'Agent CR',
          status: 'active',
          durationMs: 340_000,
          steps: [
            {
              stepId: 201,
              name: 'Code Review',
              status: 'failed',
              agentName: 'Agent CR', executorName: null,
              error: 'execute dispatch: load skills: skill name is required.',
              subSteps: null,
              durationMs: 40_000,
              attempts: [
                {
                  dispatchId: 302,
                  agentName: 'Agent CR', executorName: null,
                  status: 'FAILED',
                  error: 'execute dispatch: load skills: skill name is required.',
                  startedAt: null,
                  durationMs: 40_000,
                },
              ],
            },
            {
              stepId: 202,
              name: '修复意见',
              status: 'active',
              agentName: 'Agent CR', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 300_000,
              attempts: [
                { dispatchId: 303, agentName: 'Agent CR', executorName: null, status: 'RUNNING', error: null, startedAt: null, durationMs: 300_000 },
              ],
            },
          ],
        },
      ],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
      { id: 2, workitemId: 100, dispatchId: 301, name: 'screenshot.png', type: 'IMAGE', size: 2048, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);

    expect(screen.getAllByText(/Agent Dev/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agent CR/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/执行中/).length).toBeGreaterThan(0);
    const workbench = await openDetails();
    expect(within(workbench).getByTestId('delivery-step-202')).toBeInTheDocument();
    expect(within(workbench).queryByTestId('delivery-step-201')).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 302/ }));
    expect(within(workbench).getByTestId('delivery-step-201')).toHaveTextContent('Code Review');
    expect(within(workbench).getByTestId('delivery-step-201')).toHaveTextContent('skill name is required');
    expect(within(workbench).queryByTestId('delivery-step-202')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('delivery-workbench')).getByText('Agent Dev', { selector: '[data-testid="agent-progress-name"]' }));
    fireEvent.click(within(screen.getByTestId('delivery-workbench')).getByRole('tab', { name: '产物（2）' }));
    fireEvent.click(screen.getByText(/其他文件（/));
    expect(screen.getByText('dev-summary.md')).toBeInTheDocument();
    expect(screen.getByText('screenshot.png')).toBeInTheDocument();
  });

  it('shows each agent output when historical executions no longer match current steps', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      executions: [16943, 16950, 16953].map((dispatchId, index) => ({
        dispatchId, agentId: index + 1, agentName: `Worker ${index + 1}`, executorName: null, status: 'SUCCEEDED',
        error: null, startedAt: null, durationMs: 1000,
      })),
      agents: [1, 2, 3].map(agentId => ({
        agentId, agentName: `Worker ${agentId}`, status: 'finished', durationMs: 1000, steps: [],
      })),
    };
    const artifacts: Artifact[] = [16943, 16950, 16953].map((dispatchId, index) => ({
      id: index + 1, workitemId: 100, dispatchId, name: `evidence/report-${dispatchId}.md`,
      type: 'EVIDENCE', size: 100, gmtCreate: '',
    }));
    render(<ConfigProvider theme={{ token: { motion: false } }}><DeliveryProgress progress={progress} artifacts={artifacts} /></ConfigProvider>);
    const workbench = within(await openDetails());
    for (const dispatchId of [16953, 16950, 16943]) {
      const index = [16943, 16950, 16953].indexOf(dispatchId);
      fireEvent.click(workbench.getByText(`Worker ${index + 1}`, { selector: '[data-testid="agent-progress-name"]' }));
      fireEvent.click(workbench.getByRole('tab', { name: '产物（1）' }));
      // The explicit aria-label identifies this control without a document-wide
      // accessible-role/style walk that can delay the modal's animation frames.
      const button = workbench.getByLabelText(`预览产物 evidence/report-${dispatchId}.md`);
      expect(button.tagName).toBe('BUTTON');
      await waitFor(() => expect(button).toBeVisible());
      expect(screen.queryByLabelText(`预览产物 evidence/report-${dispatchId === 16953 ? 16950 : 16953}.md`)).not.toBeInTheDocument();
    }
  }, 15_000);

  it('opens artifact previews from agent artifact lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Dev Summary\nPASS', { status: 200 })));
    server.use(http.get('/api/artifacts/1/download', () => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null, data: 'https://oss.example/dev-summary.md',
    })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);

    await openArtifacts();
    fireEvent.click(screen.getByText(/其他文件（/));
    fireEvent.click(screen.getByRole('button', { name: '预览产物 dev-summary.md' }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/artifacts/1/preview');
    expect(await screen.findByRole('heading', { name: 'Dev Summary' })).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('navigates same-suffix artifacts from the workbench artifact preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(
      String(input) === '/api/artifacts/1/preview' ? '# Dev Summary\nPASS' : '# QA Report\nPASS', { status: 200 })));
    server.use(http.get('/api/artifacts/:id/download', ({ params }) => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null,
      data: params.id === '1' ? 'https://oss.example/dev-summary.md' : 'https://oss.example/qa-report.md',
    })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
      { id: 2, workitemId: 100, dispatchId: 301, name: 'qa-report.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);

    await openArtifacts();
    fireEvent.click(screen.getByText(/其他文件（/));
    fireEvent.click(screen.getByRole('button', { name: '预览产物 dev-summary.md' }));

    expect(await screen.findByRole('heading', { name: 'Dev Summary' })).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一个' }));
    expect(await screen.findByRole('heading', { name: 'QA Report' })).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /下载/ })).toHaveAttribute('href', 'https://oss.example/qa-report.md');

    vi.unstubAllGlobals();
  });

  it('downloads agent artifacts without opening a popup tab', async () => {
    server.use(http.get('/api/artifacts/1/download', () => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null, data: 'https://oss.example/dev-summary.md',
    })));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'Agent Dev',
        status: 'finished',
        durationMs: 120_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'Agent Dev', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 120_000,
          attempts: [
            { dispatchId: 301, agentName: 'Agent Dev', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);

    await openArtifacts();
    fireEvent.click(screen.getByText(/其他文件（/));
    fireEvent.click(screen.getByRole('button', { name: '下载产物 dev-summary.md' }));

    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
    anchorClickSpy.mockRestore();
  });

  it('renders fixed compact graph nodes and static transitions with full summaries in tooltip and detail', async () => {
    server.use(http.get('/api/dispatches/305/runtime-trace', () => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null,
      data: {
        dispatchId: 305, runtimeId: null, provider: null, changed: true, lastSeq: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
        events: [], sessions: [],
      },
    })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: '开发',
          status: 'finished',
          durationMs: 240_000,
          steps: [
            {
              stepId: 101,
              name: '开发首轮',
              status: 'done',
              agentName: '开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 301, agentName: '开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: '2026-07-01T10:00:00Z', durationMs: 120_000 },
              ],
            },
            {
              stepId: 102,
              name: '开发返工',
              status: 'done',
              agentName: '开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 303, agentName: '开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: '2026-07-01T10:20:00Z', durationMs: 120_000 },
              ],
            },
          ],
        },
        {
          agentId: 42,
          agentName: '评审',
          status: 'finished',
          durationMs: 180_000,
          steps: [
            {
              stepId: 201,
              name: '评审驳回',
              status: 'failed',
              agentName: '评审', executorName: null,
              error: '需要返工',
              subSteps: null,
              durationMs: 60_000,
              attempts: [
                { dispatchId: 302, agentName: '评审', executorName: null, status: 'FAILED', error: '需要返工', startedAt: '2026-07-01T10:10:00Z', durationMs: 60_000 },
              ],
            },
            {
              stepId: 202,
              name: '评审通过',
              status: 'done',
              agentName: '评审', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 304, agentName: '评审', executorName: null, status: 'SUCCEEDED', error: null, startedAt: '2026-07-01T10:30:00Z', durationMs: 120_000 },
              ],
            },
          ],
        },
        {
          agentId: 43,
          agentName: '测试',
          status: 'active',
          durationMs: 60_000,
          steps: [
            {
              stepId: 301,
              name: '测试验证',
              status: 'active',
              agentName: '测试', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 60_000,
              attempts: [
                { dispatchId: 305, agentName: '测试', executorName: null, status: 'RUNNING', error: null, startedAt: '2026-07-01T10:40:00Z', durationMs: 60_000 },
              ],
            },
          ],
        },
      ],
      processGraph: {
        nodes: [
          { key: 'dispatch:301', dispatchId: 301, agentId: 41, agentName: '开发', stepName: '开发首轮', status: 'SUCCEEDED', durationMs: 120_000 },
          { key: 'dispatch:302', dispatchId: 302, agentId: 42, agentName: '评审', stepName: '评审驳回', status: 'FAILED', durationMs: 60_000, error: '需要返工' },
          { key: 'dispatch:303', dispatchId: 303, agentId: 41, agentName: '开发', stepName: '开发返工', status: 'SUCCEEDED', durationMs: 120_000, triggerCommentId: 11599 },
          { key: 'dispatch:304', dispatchId: 304, agentId: 42, agentName: '评审', stepName: '评审通过', status: 'SUCCEEDED', durationMs: 120_000 },
          { key: 'dispatch:305', dispatchId: 305, agentId: 43, agentName: '测试', stepName: '测试验证', status: 'RUNNING', durationMs: 60_000 },
        ],
        edges: [
          { sourceKey: 'dispatch:301', targetKey: 'dispatch:302', type: 'HANDOFF', sourceDispatchId: 301, targetDispatchId: 302, label: '交接' },
          { sourceKey: 'dispatch:302', targetKey: 'dispatch:303', type: 'COMMENT_REWORK', sourceDispatchId: 302, targetDispatchId: 303, commentId: 11599, label: '用户返工（评论 #11599）' },
          { sourceKey: 'dispatch:303', targetKey: 'dispatch:304', type: 'HANDOFF', sourceDispatchId: 303, targetDispatchId: 304, label: '交接' },
          { sourceKey: 'dispatch:304', targetKey: 'dispatch:305', type: 'HANDOFF', sourceDispatchId: 304, targetDispatchId: 305, label: '交接' },
        ],
      },
    };

    render(<DeliveryProgress progress={progress} />);

    const graph = screen.getByTestId('execution-process-graph');
    expect(screen.getAllByText('执行过程 Graph')).toHaveLength(1);
    const workers = within(graph).getAllByTestId('execution-graph-worker');
    const edges = within(graph).getAllByTestId('execution-graph-edge');
    expect(workers).toHaveLength(5);
    expect(edges).toHaveLength(4);
    expect(within(graph).getAllByTestId('execution-graph-lane')).toHaveLength(3);
    for (const [name, count] of [['开发', 2], ['评审', 2], ['测试', 1]] as const) expect(within(graph).getAllByText(name)).toHaveLength(count);
    workers.forEach((worker, index) => {
      const rect = worker.querySelector('rect');
      expect(rect).toHaveAttribute('width', '104');
      expect(rect).toHaveAttribute('height', '52');
      expect(rect).toHaveAttribute('y', String(22 + index * 76));
      expect(worker).toHaveTextContent(`#${301 + index}`);
    });
    edges.forEach(edge => {
      expect(edge.querySelector('path')).toHaveAttribute('stroke-width', '1.2');
      expect(edge.querySelector('path')).not.toHaveAttribute('marker-end');
      expect(edge.querySelector('animate')).toBeNull();
      expect(edge.querySelector('rect')).toHaveAttribute('width', '60');
    });
    expect(graph.querySelector('marker')).toBeNull();
    const rework = edges[1];
    expect(rework).toHaveTextContent('2 · 用户返工（评论 #11599）');
    expect(rework).not.toHaveTextContent('dispatch 302');
    fireEvent.mouseOver(rework);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('用户返工（评论 #11599） · dispatch 302 -> 303');
    fireEvent.click(rework);
    const detail = screen.getByTestId('execution-graph-detail-panel');
    expect(detail).toHaveTextContent('用户返工（评论 #11599）');
    expect(detail).toHaveTextContent('评审 → 开发 · Dispatch 302 → 303');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const activeWorker = workers.find(worker => worker.getAttribute('data-status') === 'RUNNING')!;
    expect(activeWorker).toHaveTextContent('1 段');
    expect(activeWorker).toHaveTextContent('#305 · 1 分');
    fireEvent.click(activeWorker);
    expect(within(detail).getByText('测试')).toBeInTheDocument();
    expect(detail).toHaveTextContent('测试验证');
    const workbench = await screen.findByTestId('delivery-workbench');
    expect(within(workbench).getByRole('tab', { name: 'Trace 时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 305');
    expect(document.querySelector('.ant-drawer')).toBeNull();
  });

  it('opens live runtime trace inside the workbench pinned to the selected dispatch slice', async () => {
    let requestedUrl = '';
    server.use(http.get('/api/dispatches/302/runtime-trace', ({ request }) => {
      requestedUrl = request.url;
      return HttpResponse.json({
        success: true, code: '0', message: '', traceId: null,
        data: {
          dispatchId: 302, runtimeId: 'rt-1', provider: 'codex', changed: true, lastSeq: 15,
          tokenUsage: { available: true, inputTokens: 1700, outputTokens: 400, reasoningTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0, totalTokens: 2100, credits: 12.34 },
          events: [
            { eventId: '302:0', seq: 0, eventType: 'runtime.started', eventTime: '2026-07-30T10:00:00Z', detail: { runtimeId: 'rt-1' } },
            { eventId: '302:1', seq: 1, eventType: 'runtime.recovery_completed', eventTime: '2026-07-30T10:00:01Z', detail: { mode: 'checkpoint' } },
            { eventId: '302:2', seq: 2, eventType: 'step.started', eventTime: '2026-07-30T10:00:02Z', detail: { stepId: 'implementation' } },
            { eventId: '302:14', seq: 14, eventType: 'upload.completed', eventTime: '2026-07-30T10:01:05Z', detail: { status: 'ok' } },
          ],
          sessions: [{
            sessionId: 's1', parentSessionId: null, status: 'INTERRUPTED',
            startedAt: '2026-07-30T10:00:00Z', endedAt: '2026-07-30T10:01:06Z', durationMs: 10000,
            tokenUsage: { available: true, inputTokens: 1700, outputTokens: 400, reasoningTokens: 80, cacheReadTokens: 400, cacheWriteTokens: 0, totalTokens: 2100, credits: 12.34 },
            boundaries: [
              { eventId: '302:1', kind: 'RESUMED', eventTime: '2026-07-30T10:00:00Z', label: 'RESUMED' },
              { eventId: '302:15', kind: 'INTERRUPTED', eventTime: '2026-07-30T10:01:06Z', label: 'INTERRUPTED · paused · checkpoint #18' },
            ],
            turns: [{
              turnId: 't2', stepId: 'implementation', stepName: 'Implementation', status: 'INTERRUPTED',
              startedAt: '2026-07-30T10:01:01Z', endedAt: '2026-07-30T10:01:05Z', durationMs: 4000,
              prompt: 'Run the implementation tests', systemPrompt: 'Follow the worker SDLC',
              tokenUsage: { available: true, inputTokens: 500, outputTokens: 100, reasoningTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 600 },
              spans: [
                { spanId: 't2:llm', parentSpanId: null, kind: 'LLM', name: 'gpt-5', status: 'COMPLETED', startedAt: '2026-07-30T10:01:01Z', endedAt: '2026-07-30T10:01:04Z', durationMs: 3000, model: 'gpt-5', inputSummary: null, outputSummary: null, errorCategory: null, tokenUsage: { available: true, inputTokens: 500, outputTokens: 100, reasoningTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 600 } },
                { spanId: 'thinking-1', parentSpanId: 't2:llm', kind: 'THINKING', name: 'Thinking', status: 'COMPLETED', startedAt: '2026-07-30T10:01:01Z', endedAt: '2026-07-30T10:01:02Z', durationMs: 1000, model: 'gpt-5', inputSummary: null, outputSummary: null, errorCategory: null, tokenUsage: { available: false, inputTokens: 0, outputTokens: 0, reasoningTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
                { spanId: 'bash-1', parentSpanId: 't2', kind: 'BASH', name: 'bash', status: 'COMPLETED', startedAt: '2026-07-30T10:01:02Z', endedAt: '2026-07-30T10:01:03Z', durationMs: 1000, model: null, inputSummary: 'pnpm test', outputSummary: '26 passed', input: { command: 'pnpm test' }, output: '26 passed', errorCategory: null, tokenUsage: { available: false, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
              ],
            }],
          }],
        },
      });
    }));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: '开发',
        status: 'active',
        durationMs: 10000,
        steps: [{
          stepId: 101,
          name: 'Implementation',
          status: 'active',
          agentName: '开发', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 10000,
          attempts: [
            { dispatchId: 301, agentName: '开发', executorName: null, status: 'PAUSED', error: null, startedAt: '2026-07-30T10:00:00Z', durationMs: 6000 },
            { dispatchId: 302, agentName: '开发', executorName: null, status: 'RUNNING', error: null, startedAt: '2026-07-30T10:01:00Z', durationMs: 4000 },
          ],
        }],
      }],
      processGraph: {
        nodes: [
          { key: 'dispatch:301', dispatchId: 301, agentId: 41, agentName: '开发', stepName: 'Implementation', status: 'PAUSED', durationMs: 6000 },
          { key: 'dispatch:302', dispatchId: 302, agentId: 41, agentName: '开发', stepName: 'Implementation', status: 'RUNNING', durationMs: 4000 },
        ],
        edges: [
          { sourceKey: 'dispatch:301', targetKey: 'dispatch:302', type: 'CONTINUE', sourceDispatchId: 301, targetDispatchId: 302, label: '恢复执行' },
        ],
      },
    };

    render(<DeliveryProgress progress={progress} />);
    fireEvent.click(screen.getAllByTestId('execution-graph-worker')[1]);

    const workbench = await screen.findByTestId('delivery-workbench');
    expect(within(workbench).getByRole('tab', { name: 'Trace 时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 302');
    expect(within(workbench).getByText('历史会话 · 已停止跟随')).toBeInTheDocument();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    const drawer = within(workbench).getByTestId('runtime-trace-drawer');
    await waitFor(() => expect(requestedUrl).toContain('/api/dispatches/302/runtime-trace'));
    await within(drawer).findByRole('button', { name: /会话\s*s1/ });
    expect(within(drawer).getByText(/Dispatch #302/)).toBeInTheDocument();
    expect(within(drawer).getByText(/恢复自 #301/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /会话\s*s1/ })).toBeInTheDocument();
    expect(within(drawer).getAllByText(/12\.34 credits/).length).toBeGreaterThan(0);
    expect(within(drawer).queryByText(/tokens/)).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Turn t2/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Runtime 与 SDLC/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: /Runtime 与 SDLC/ }));
    expect(within(drawer).getByText('runtime.recovery_completed')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByText(/Turn t2/));
    expect(within(drawer).getByText('用户提示词')).toBeInTheDocument();
    expect(within(drawer).getByText('系统提示词')).toBeInTheDocument();
    expect(within(drawer).getByText('Run the implementation tests')).toBeInTheDocument();
    expect(within(drawer).getByText('Follow the worker SDLC')).toBeInTheDocument();
    expect(within(drawer).queryByText(/Usage unavailable/)).not.toBeInTheDocument();
    expect(within(drawer).getByText(/checkpoint #18/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByText('bash'));
    expect(within(drawer).getByText(/pnpm test/)).toBeInTheDocument();
  });

  it('supports zoom, drag, reset, and fullscreen controls for the execution graph', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: '开发',
          status: 'finished',
          durationMs: 120_000,
          steps: [{
            stepId: 101,
            name: '开发',
            status: 'done',
            agentName: '开发', executorName: null,
            error: null,
            subSteps: null,
            durationMs: 120_000,
            attempts: [{ dispatchId: 301, agentName: '开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: '2026-07-01T10:00:00Z', durationMs: 120_000 }],
          }],
        },
        {
          agentId: 42,
          agentName: '评审',
          status: 'active',
          durationMs: 60_000,
          steps: [{
            stepId: 201,
            name: '评审',
            status: 'active',
            agentName: '评审', executorName: null,
            error: null,
            subSteps: null,
            durationMs: 60_000,
            attempts: [{ dispatchId: 302, agentName: '评审', executorName: null, status: 'RUNNING', error: null, startedAt: '2026-07-01T10:10:00Z', durationMs: 60_000 }],
          }],
        },
      ],
      processGraph: {
        nodes: [
          { key: 'dispatch:301', dispatchId: 301, agentId: 41, agentName: '开发', stepName: '开发', status: 'SUCCEEDED', durationMs: 120_000 },
          { key: 'dispatch:302', dispatchId: 302, agentId: 42, agentName: '评审', stepName: '评审', status: 'RUNNING', durationMs: 60_000 },
        ],
        edges: [
          { sourceKey: 'dispatch:301', targetKey: 'dispatch:302', type: 'HANDOFF', sourceDispatchId: 301, targetDispatchId: 302, label: '交接' },
        ],
      },
    };

    render(<DeliveryProgress progress={progress} />);

    const viewport = screen.getByTestId('execution-graph-viewport');
    expect(viewport).toHaveAttribute('data-zoom', '1.00');
    expect(viewport).toHaveAttribute('data-pan', '192,8');
    const svg = within(viewport).getByRole('img');
    const inverse = vi.fn(() => ({ a: 0.5, d: 0.25, e: -5, f: -10 }));
    const matrixTransform = vi.fn(function (this: { x: number; y: number }, matrix: ReturnType<typeof inverse>) {
      return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f };
    });
    Object.defineProperties(svg, {
      getScreenCTM: { value: () => ({ inverse }), configurable: true },
      createSVGPoint: { value: () => ({ x: 0, y: 0, matrixTransform }), configurable: true },
    });

    fireEvent.click(screen.getByLabelText('放大'));
    expect(viewport).toHaveAttribute('data-zoom', '1.12');
    fireEvent.wheel(viewport, { deltaY: -1 });
    expect(viewport).toHaveAttribute('data-zoom', '1.20');
    fireEvent.click(screen.getByLabelText('缩小'));
    expect(viewport).toHaveAttribute('data-zoom', '1.08');
    fireEvent.wheel(viewport, { deltaY: 1 });
    expect(viewport).toHaveAttribute('data-zoom', '1.00');

    fireEvent.mouseDown(viewport, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(viewport, { clientX: 124, clientY: 116 });
    fireEvent.mouseUp(viewport);
    expect(inverse).toHaveBeenCalledTimes(2);
    expect(matrixTransform).toHaveBeenCalledTimes(2);
    expect(viewport).toHaveAttribute('data-pan', '204,12');
    fireEvent.mouseMove(viewport, { clientX: 200, clientY: 200 });
    expect(viewport).toHaveAttribute('data-pan', '204,12');
    fireEvent.mouseDown(viewport, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(viewport, { clientX: 200, clientY: 200 });
    expect(viewport).toHaveAttribute('data-pan', '204,12');
    // 视口改挂 pointer 事件：触屏拖拽同样生效，pointerup 后移动不再平移（坐标按官方图几何重算）。
    firePointer('pointerdown', viewport, { clientX: 100, clientY: 100 });
    firePointer('pointermove', viewport, { clientX: 124, clientY: 116 });
    expect(viewport).toHaveAttribute('data-pan', '216,16');
    firePointer('pointerup', viewport, { clientX: 124, clientY: 116 });
    firePointer('pointermove', viewport, { clientX: 300, clientY: 300 });
    expect(viewport).toHaveAttribute('data-pan', '216,16');

    fireEvent.click(screen.getByLabelText('重置视图'));
    expect(viewport).toHaveAttribute('data-zoom', '1.00');
    expect(viewport).toHaveAttribute('data-pan', '0,0');
    fireEvent.click(screen.getByLabelText('适配宽度'));
    expect(viewport).toHaveAttribute('data-zoom', '2.14');
    expect(viewport).toHaveAttribute('data-pan', '24,8');

    fireEvent.click(screen.getByLabelText('全屏查看'));
    expect(screen.getByTestId('execution-graph-fullscreen')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('execution-graph-fullscreen')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('全屏查看'));
    fireEvent.click(screen.getByLabelText('退出全屏'));
    expect(screen.queryByTestId('execution-graph-fullscreen')).not.toBeInTheDocument();
  });

  it('does not infer execution graph edges from attempt timestamps or dispatch ids', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: '开发',
          status: 'finished',
          durationMs: 240_000,
          steps: [
            {
              stepId: 101,
              name: '开发首轮',
              status: 'done',
              agentName: '开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 301, agentName: '开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
            {
              stepId: 102,
              name: '开发返工',
              status: 'done',
              agentName: '开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 303, agentName: '开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
          ],
        },
        {
          agentId: 42,
          agentName: '评审',
          status: 'finished',
          durationMs: 180_000,
          steps: [
            {
              stepId: 201,
              name: '评审驳回',
              status: 'failed',
              agentName: '评审', executorName: null,
              error: '需要返工',
              subSteps: null,
              durationMs: 60_000,
              attempts: [
                { dispatchId: 302, agentName: '评审', executorName: null, status: 'FAILED', error: '需要返工', startedAt: null, durationMs: 60_000 },
              ],
            },
            {
              stepId: 202,
              name: '评审通过',
              status: 'done',
              agentName: '评审', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 304, agentName: '评审', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
          ],
        },
        {
          agentId: 43,
          agentName: '测试',
          status: 'active',
          durationMs: 60_000,
          steps: [
            {
              stepId: 301,
              name: '测试验证',
              status: 'active',
              agentName: '测试', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 60_000,
              attempts: [
                { dispatchId: 305, agentName: '测试', executorName: null, status: 'RUNNING', error: null, startedAt: null, durationMs: 60_000 },
              ],
            },
          ],
        },
      ],
    };

    render(<DeliveryProgress progress={progress} />);

    expect(screen.queryByTestId('execution-process-graph')).not.toBeInTheDocument();
  });

  it('renders execution graph when only nodes exist without edges (first worker just started)', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: '开发',
          status: 'active',
          durationMs: 30_000,
          steps: [
            {
              stepId: 101,
              name: '需求分析',
              status: 'active',
              agentName: '开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 30_000,
              attempts: [
                { dispatchId: 301, agentName: '开发', executorName: null, status: 'RUNNING', error: null, startedAt: '2026-08-03T10:00:00Z', durationMs: 30_000 },
              ],
            },
          ],
        },
      ],
      processGraph: {
        nodes: [
          { key: 'dispatch:301', dispatchId: 301, agentId: 41, agentName: '开发', stepName: '需求分析', status: 'RUNNING', durationMs: 30_000 },
        ],
        edges: [],
      },
    };

    render(<DeliveryProgress progress={progress} />);

    const graph = screen.getByTestId('execution-process-graph');
    expect(within(graph).getAllByTestId('execution-graph-worker')).toHaveLength(1);
    expect(within(graph).queryAllByTestId('execution-graph-edge')).toHaveLength(0);
    expect(within(graph).getByText('开发')).toBeInTheDocument();
  });

  it('opens finished execution history through the shared detail panel', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      executions: [301, 302].map(dispatchId => ({ dispatchId, agentId: 41, agentName: 'AW代码评审工程师', executorName: null, status: 'SUCCEEDED', startedAt: null, durationMs: 240_000,
        stepTimings: [{ stepId: 101, name: '获取上下文与评论', status: 'done' as const, durationMs: 240_000 }] })),
      agents: [
        {
          agentId: 41,
          agentName: 'AW代码评审工程师',
          status: 'finished',
          durationMs: 240_000,
          steps: [
            {
              stepId: 101,
              name: '获取上下文与评论',
              status: 'done',
              agentName: 'AW代码评审工程师', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 240_000,
              attempts: [
                { dispatchId: 301, agentName: 'AW代码评审工程师', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 240_000 },
                { dispatchId: 302, agentName: 'AW代码评审工程师', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 240_000 },
              ],
            },
          ],
        },
      ],
    };

    render(<DeliveryProgress progress={progress} />);
    await openDetails();

    const progressCard = screen.getByTestId('delivery-workbench');
    expect(within(progressCard).getAllByText('获取上下文与评论').length).toBeGreaterThan(0);
    // 工作台详情平铺：每次执行只展示所选 dispatch 的一份元信息，不再列出「第N次」执行记录
    expect(within(progressCard).queryByText('执行记录')).not.toBeInTheDocument();
    expect(within(progressCard).getAllByText('执行者: AW代码评审工程师')).toHaveLength(1);
    expect(within(progressCard).queryByText(/第2次:/)).not.toBeInTheDocument();
    expect(within(progressCard).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 302');
    fireEvent.click(within(progressCard).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(progressCard).getByRole('button', { name: /Dispatch 301/ }));
    expect(within(progressCard).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 301');
    expect(within(progressCard).getByText('历史会话 · 已停止跟随')).toBeInTheDocument();
    expect(within(progressCard).getAllByText('执行者: AW代码评审工程师')).toHaveLength(1);
    expect(within(progressCard).queryByText(/第2次:/)).not.toBeInTheDocument();
    expect(within(progressCard).getByTestId('dispatch-activities-301')).toBeInTheDocument();
    expect(within(progressCard).queryByTestId('dispatch-activities-302')).not.toBeInTheDocument();
  });

  it('mounts the live activity panel and defaults the dispatch selector to the latest attempt', async () => {
    server.use(http.get('/api/dispatches/302/live-activity', () => HttpResponse.json({
      success: true, code: '0', message: '', traceId: null,
      data: {
        schemaVersion: '1', dispatchId: 302, agentId: 41, workitemId: 100, sourceType: 'WORKITEM',
        attempt: 2, dispatchStatus: 'SUCCEEDED', changed: true, lastSeq: 1,
        lastUpdatedAt: '2026-09-02T10:00:00Z', currentAction: null,
        actions: [{
          eventId: 'e1', seq: 1, eventTime: '2026-09-02T10:00:00Z', eventType: 'step.completed',
          actionType: 'SDLC_STEP', summary: '返工完成', status: 'COMPLETED', stepId: null,
          stepKey: null, stepName: '编码', agentId: 41, dispatchId: 302, attempt: 2,
        }],
        totalActions: 1, truncated: false, awaitingRuntime: false,
      },
    })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'AW全栈开发',
        status: 'finished',
        durationMs: 240_000,
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'AW全栈开发', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 240_000,
          attempts: [
            { dispatchId: 301, agentName: 'AW全栈开发', executorName: null, status: 'FAILED', error: 'provider unavailable', startedAt: null, durationMs: 120_000 },
            { dispatchId: 302, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
          ],
        }],
      }],
    };

    render(<DeliveryProgress progress={progress} />);

    // NB-8: retry/multi-dispatch history stays reachable and the selector defaults to the latest.
    await openWorkbench();
    fireEvent.click(within(screen.getByTestId('delivery-workbench')).getByRole('tab', { name: '近期动作' }));
    const liveRegion = screen.getByTestId('delivery-workbench');
    expect(within(liveRegion).getByTestId('live-activity-dispatch-select')).toBeInTheDocument();
    expect(within(liveRegion).getByText(/Dispatch 302（最新）/)).toBeInTheDocument();
    // CR-1: a finished agent (realtime disabled) still shows its persisted actions.
    expect(await within(liveRegion).findByText('返工完成')).toBeInTheDocument();
  });

  it('keeps long agent names horizontal and collapses artifact files by default', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [
        {
          agentId: 41,
          agentName: 'AutoWonder前后端1号开发',
          status: 'finished',
          durationMs: 120_000,
          steps: [
            {
              stepId: 101,
              name: '需求分析与建分支',
              status: 'done',
              agentName: 'AutoWonder前后端1号开发', executorName: null,
              error: null,
              subSteps: null,
              durationMs: 120_000,
              attempts: [
                { dispatchId: 301, agentName: 'AutoWonder前后端1号开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 120_000 },
              ],
            },
          ],
        },
      ],
    };
    const artifacts: Artifact[] = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      workitemId: 100,
      dispatchId: 301,
      name: `artifact-${index + 1}.md`,
      type: 'MARKDOWN',
      size: 1024,
      gmtCreate: '',
    }));

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);

    const agentName = screen.getByTestId('current-agent-name');
    expect(agentName).toHaveTextContent('AutoWonder前后端1号开发');
    expect(screen.queryByText('artifact-1.md')).not.toBeInTheDocument();

    await openArtifacts();
    // 产物 tab 标签携带该数字人的产物计数，且文件名默认折叠。
    expect(screen.getAllByText('产物（6）').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(/其他文件（/));
    expect(screen.getByText('artifact-1.md')).toBeInTheDocument();
  });

  it('renders the selected dispatch duration rather than the accumulated agent duration in the details heading', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      executions: [{ dispatchId: 301, agentId: 1, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', startedAt: null, durationMs: 120_000, stepTimings: [] }],
      agents: [{ agentId: 1, agentName: 'AW全栈开发', status: 'finished', durationMs: 5_520_000, currentActivity: null, steps: [] }],
    };
    render(<DeliveryProgress progress={progress} />);
    const workbench = await openDetails();
    const heading = workbench.querySelector('.delivery-workbench-detail-heading')!;
    expect(within(heading as HTMLElement).getByText('2分')).toBeInTheDocument();
    expect(within(workbench).queryByText('1时32分')).not.toBeInTheDocument();
  });

  it('renders the workitem total duration in the card title', () => {
    const progress: DeliveryProgressModel = {
      steps: [{
        stepId: 101,
        stepKey: 'coding',
        name: '编码实现',
        status: 'done',
        executorName: null,
        error: null,
        subSteps: null,
        durationMs: null,
        attempts: null,
      }],
      totalDurationMs: 8_040_000,
    };

    render(<DeliveryProgress progress={progress} />);

    expect(screen.getByText(/总耗时/)).toBeInTheDocument();
    expect(screen.getByText('总耗时 2时14分 (Agents耗时)')).toBeInTheDocument();
  });

  it('omits the total duration from the card title when it is null', () => {
    const progress: DeliveryProgressModel = {
      steps: [{
        stepId: 101,
        stepKey: 'coding',
        name: '编码实现',
        status: 'done',
        executorName: null,
        error: null,
        subSteps: null,
        durationMs: null,
        attempts: null,
      }],
      totalDurationMs: null,
    };

    render(<DeliveryProgress progress={progress} />);

    expect(screen.queryByText(/总耗时/)).not.toBeInTheDocument();
  });
});

describe('DeliveryProgress restart round attribution', () => {
  const recovery = (restarts: unknown[]) => server.use(http.get('/api/workitems/100/recovery', () => HttpResponse.json({
    success: true, code: '0', message: '', traceId: 'trace-restart-attribution',
    data: { closed: false, canReopen: true, executions: [], restarts },
  })));
  // DeliveryProgress 只在拿到 workitemId 时才读 recovery，因此这些用例需要真实的数据源。
  const renderScoped = (progress: DeliveryProgressModel) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DeliveryProgress progress={progress} workitemId="100" />
    </QueryClientProvider>);
  const twoAgents = (): DeliveryProgressModel => ({
    steps: [],
    agents: [
      { agentId: 41, agentName: 'AW全栈开发', status: 'failed', durationMs: null, steps: [] },
      { agentId: 43, agentName: 'Chief of Staff', status: 'pending', durationMs: null, steps: [] },
    ],
  });

  it('keeps each agent’s rounds inside its own block card', async () => {
    recovery([
      { restart_round: 3, status: 'STARTED', dispatch_id: 88, agent_id: 41, agent_name: 'AW全栈开发', gmt_create: '2026-11-24T10:42:00Z' },
      { restart_round: 2, status: 'SUPERSEDED', dispatch_id: 80, agent_id: 41, agent_name: 'AW全栈开发', gmt_create: '2026-11-24T10:20:00Z' },
      { restart_round: 2, status: 'FAILED', stop_reason: '数字员工未上线', agent_id: 43, agent_name: 'Chief of Staff', gmt_create: '2026-11-24T10:09:00Z' },
    ]);
    renderScoped(twoAgents());
    const failing = await screen.findByTestId('recovery-controls', {}, { timeout: 3000 });
    const rows = within(screen.getByTestId('delivery-rail')).getAllByTestId('delivery-agent-row');
    const devRow = rows.find(row => row.textContent?.includes('AW全栈开发'))!;
    const chiefRow = rows.find(row => row.textContent?.includes('Chief of Staff'))!;
    const devBlock = devRow.closest('.aw-agent-block') as HTMLElement;
    const chiefBlock = chiefRow.closest('.aw-agent-block') as HTMLElement;
    // 关注块用段内折叠；非关注块只用一行摘要，归属都靠块卡结构。
    expect(devBlock).toHaveClass('is-open');
    expect(devBlock.contains(failing)).toBe(false);
    expect(chiefBlock.contains(failing)).toBe(true);
    expect(failing).toHaveTextContent('第 2 轮启动');
    expect(failing).toHaveTextContent('数字员工未上线');
    const section = within(devBlock).getByTestId('delivery-restart-rounds');
    expect(within(section).getByText('交付启动记录')).toBeInTheDocument();
    expect(within(section).queryByText('第 3 轮')).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: /全部 2 次/ }));
    expect(within(section).getByText('第 3 轮')).toBeInTheDocument();
    expect(within(section).getByText('Dispatch #88')).toBeInTheDocument();
    expect(within(section).getByText('Dispatch #80')).toBeInTheDocument();
  });

  it('adds a block for a restart target agent that never produced a dispatch', async () => {
    recovery([
      { restart_round: 1, status: 'FAILED', stop_reason: '数字员工未上线', agent_id: 43, agent_name: 'Chief of Staff', gmt_create: '2026-11-24T10:09:00Z' },
    ]);
    renderScoped({ steps: [], executions: [],
      agents: [{ agentId: 41, agentName: 'AW全栈开发', status: 'failed', durationMs: null, steps: [] }] });
    const chiefRow = await screen.findByText('Chief of Staff', {}, { timeout: 3000 });
    const row = chiefRow.closest('[data-testid="delivery-agent-row"]');
    expect(row).not.toBeNull();
    const summary = screen.getByTestId('recovery-controls');
    expect(row!.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary).toHaveTextContent('数字员工未上线');
  });

  it('shows a failed historical round without assigning it to any agent', async () => {
    recovery([
      { restart_round: 1, status: 'FAILED', stop_reason: '数字员工未上线', agent_id: null, agent_name: null, gmt_create: '2026-11-24T10:09:00Z' },
    ]);
    renderScoped(twoAgents());
    const history = await screen.findByTestId('delivery-restart-rounds');
    expect(history).toHaveTextContent('未记录目标数字人的交付启动记录');
    expect(history).toHaveTextContent('数字员工未上线');
    expect(screen.getByTestId('delivery-rail')).not.toContainElement(history);
    expect(screen.queryByTestId('recovery-controls')).not.toBeInTheDocument();
  });

  it('falls back to an em dash for a re-dispatched target whose name was not persisted', async () => {
    recovery([
      { restart_round: 1, status: 'FAILED', stop_reason: '数字员工未上线', agent_id: 43, agent_name: null, gmt_create: '2026-11-24T10:09:00Z' },
      { restart_round: 1, status: 'FAILED', stop_reason: '数字员工未上线', agent_id: null, agent_name: null, gmt_create: '2026-11-24T10:08:00Z' },
    ]);
    renderScoped({ steps: [], executions: [],
      agents: [{ agentId: 41, agentName: 'AW全栈开发', status: 'failed', durationMs: null, steps: [] }] });
    const rows = () => within(screen.getByTestId('delivery-rail')).getAllByTestId('delivery-agent-row');
    await waitFor(() => expect(rows()).toHaveLength(2), { timeout: 3000 });
    const names = rows().map((row) => row.querySelector('.aw-agent-name')?.textContent);
    expect(names).toContain('AW全栈开发');
    expect(names).toContain('—');
  });
});

describe('DeliveryProgress workbench dispatch isolation', () => {
  const snapshotProgress = (): DeliveryProgressModel => {
    const attempts: DispatchAttempt[] = [
      { dispatchId: 401, agentId: 41, agentName: 'Developer raw', executorName: 'runner-old', status: 'FAILED', startedAt: '2026-10-21T04:00:00Z', endedAt: '2026-10-21T04:01:00Z', durationMs: 60_000,
        stepTimings: [{ stepId: 101, name: '首轮分析原文', status: 'done', durationMs: 20_000 }, { stepId: 102, name: '首轮待实现原文', status: 'pending', durationMs: null }] },
      { dispatchId: 402, agentId: 41, agentName: 'Developer raw', executorName: 'runner-current', status: 'RUNNING', startedAt: '2026-10-21T04:02:00Z', endedAt: null, durationMs: 120_000,
        stepTimings: [{ stepId: 101, name: '本轮分析原文', status: 'done', durationMs: 10_000 }, { stepId: 102, name: '本轮实现原文', status: 'active', durationMs: 50_000 }, { stepId: 103, name: '本轮待验证原文', status: 'pending', durationMs: null }] },
    ];
    return {
      steps: [], executions: attempts,
      agents: [{ agentId: 41, agentName: 'Developer raw', status: 'active', durationMs: 9_000_000, usage: { credits: 999 },
        steps: [101, 102, 103, 104].map(stepId => ({ stepId, currentDispatchId: 402, name: `累计步骤 ${stepId}`, status: stepId === 102 ? 'active' : 'done', executorName: null,
          durationMs: 3_000_000, usage: { credits: 777 }, subSteps: null, attempts: stepId === 102 ? attempts : null })) }],
      processGraph: {
        nodes: attempts.map(attempt => ({ key: `dispatch:${attempt.dispatchId}`, dispatchId: attempt.dispatchId, agentId: 41, agentName: 'Developer raw', stepName: attempt.dispatchId === 401 ? '首轮入口' : '本轮入口', status: attempt.status, durationMs: attempt.durationMs })),
        edges: [{ sourceKey: 'dispatch:401', targetKey: 'dispatch:402', sourceDispatchId: 401, targetDispatchId: 402, type: 'CONTINUE', label: '恢复执行' }],
      },
    };
  };

  it('keeps seven ordered tabs, normal empty controls and selection/tab across grouping and sidebar changes', async () => {
    render(<DeliveryProgress progress={snapshotProgress()} />);
    const workbench = await openWorkbench();
    const tabs = within(workbench).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Terminal', '近期动作', '控制记录', '执行详情', 'Trace 时间线', 'SDLC 阶段耗时', '产物（0）']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const layout = workbench.querySelector('.delivery-workbench-layout') as HTMLElement;
    expect(layout.style.getPropertyValue('--delivery-rail-width')).toBe('228px');
    const grouping = within(workbench).getByRole('group', { name: '执行轨迹分组' });
    expect(within(grouping).getByRole('button', { name: '按数字人' })).toHaveAttribute('aria-pressed', 'true');
    expect(workbench.querySelectorAll('.delivery-workbench-agent-group')).toHaveLength(1);
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 401/ }));
    fireEvent.click(tabs[2]);
    await waitFor(() => expect(within(workbench).getByText('暂无控制记录')).toBeVisible());
    expect(within(workbench).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(within(grouping).getByRole('button', { name: '按时间' }));
    expect(workbench.querySelectorAll('.delivery-workbench-agent-group')).toHaveLength(0);
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 401');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByRole('button', { name: /Dispatch 401/ })).toHaveAttribute('aria-pressed', 'true');
    const resizer = within(workbench).getByRole('separator', { name: '侧栏宽度' });
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(layout.style.getPropertyValue('--delivery-rail-width')).toBe('236px');
    expect(resizer).toHaveAttribute('aria-valuenow', '236');
    fireEvent.doubleClick(resizer);
    expect(layout.style.getPropertyValue('--delivery-rail-width')).toBe('228px');
    fireEvent.click(within(workbench).getByRole('button', { name: '收起侧栏' }));
    expect(workbench.querySelector('aside')).not.toBeVisible();
    fireEvent.click(within(workbench).getByRole('button', { name: '显示侧栏' }));
    fireEvent.click(within(grouping).getByRole('button', { name: '按数字人' }));
    expect(workbench.querySelector('aside')).toBeVisible();
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 401');
  });

  it('uses selected and historical timing snapshots instead of accumulated stages, durations or pending records', async () => {
    render(<DeliveryProgress progress={snapshotProgress()} />);
    const workbench = await openDetails();
    const stages = within(workbench).getByLabelText('执行阶段');
    const stageNames = (scope: HTMLElement) => within(scope).getAllByRole('button').filter(button => !button.classList.contains('is-all')).map(button => button.querySelector(':scope > span:nth-child(2)')?.textContent);
    expect(within(stages).getByRole('button', { name: '全部阶段' })).toHaveAttribute('aria-pressed', 'true');
    expect(stageNames(stages)).toEqual(['本轮分析原文', '本轮实现原文', '本轮待验证原文']);
    expect(within(workbench).getByTestId('delivery-step-101')).toHaveTextContent('10秒');
    expect(within(workbench).getByTestId('delivery-step-102')).toHaveTextContent('50秒');
    expect(within(workbench).queryByTestId('delivery-step-104')).not.toBeInTheDocument();
    expect(within(workbench).queryByText(/累计步骤|50分|2时30分|999 credits|777 credits/)).not.toBeInTheDocument();
    expect(workbench.querySelector('.delivery-workbench-detail-heading')).toHaveTextContent('2分');
    fireEvent.click(within(stages).getByRole('button', { name: /本轮待验证原文$/ }));
    await waitFor(() => expect(within(workbench).getByText('未执行')).toBeVisible());
    expect(within(workbench).queryByTestId('delivery-step-103')).not.toBeInTheDocument();
    expect(within(workbench).queryByTestId('dispatch-activities-402')).not.toBeInTheDocument();
    // 再次点击已选阶段即取消筛选，回到全部阶段
    fireEvent.click(within(stages).getByRole('button', { name: /本轮待验证原文$/ }));
    expect(within(stages).getByRole('button', { name: '全部阶段' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(workbench).getByTestId('delivery-step-101')).toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 401/ }));
    expect(stageNames(within(workbench).getByLabelText('执行阶段'))).toEqual(['首轮分析原文', '首轮待实现原文']);
    expect(within(workbench).getByTestId('delivery-step-101')).toHaveTextContent('20秒');
    expect(workbench.querySelector('.delivery-workbench-detail-heading')).toHaveTextContent('Developer raw1分');
    expect(within(workbench).queryByText('本轮待验证原文')).not.toBeInTheDocument();
    expect(within(workbench).queryByTestId('delivery-step-102')).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('tab', { name: 'SDLC 阶段耗时' }));
    const chart = within(workbench).getByTestId('step-duration-chart');
    expect(chart).toHaveTextContent('本次执行 #401');
    expect(chart).toHaveTextContent('步骤累计 20秒');
    expect(chart).not.toHaveTextContent('本轮实现原文');
  });

  it('clears an open artifact preview when the followed dispatch changes', async () => {
    server.use(
      http.get('/api/artifacts/901/preview', () => HttpResponse.text('# Current dispatch artifact\nraw AI content', { headers: { 'Content-Type': 'text/markdown' } })),
      http.get('/api/artifacts/901/download', () => HttpResponse.json({ success: true, code: '0', data: 'https://oss.example/current.md' })),
    );
    const progress = snapshotProgress();
    const artifacts: Artifact[] = [{ id: 901, workitemId: 100, dispatchId: 402, name: 'artifacts/output/handoff/current.md', type: 'HANDOFF', size: 50, gmtCreate: '' }];
    const { rerender } = render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    const workbench = await openArtifacts();
    fireEvent.click(await within(workbench).findByRole('button', { name: '预览产物 artifacts/output/handoff/current.md' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Current dispatch artifact' })).toBeVisible());
    const next: DeliveryProgressModel = { ...progress, executions: [...progress.executions!.map(attempt => attempt.dispatchId === 402 ? { ...attempt, status: 'SUCCEEDED' } : attempt),
      { dispatchId: 403, agentId: 41, agentName: 'Developer raw', executorName: null, status: 'RUNNING', startedAt: null, durationMs: 1000, stepTimings: [] }] };
    rerender(<DeliveryProgress progress={next} artifacts={artifacts} />);
    // 轨道入口固定到员工 41 并跟随其最近一次执行，新 Dispatch 403 自动成为当前会话。
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 403');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Current dispatch artifact' })).not.toBeInTheDocument());
    expect(within(workbench).getByRole('tab', { name: /^产物（/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not borrow latest stages for historical dispatches without timing snapshots', async () => {
    const progress = snapshotProgress();
    progress.executions![0].stepTimings = null;
    render(<DeliveryProgress progress={progress} />);
    const workbench = await openDetails();
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 401/ }));
    expect(within(workbench).getByLabelText('执行阶段')).toBeEmptyDOMElement();
    expect(within(workbench).queryByTestId('delivery-step-102')).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 402/ }));
    expect(within(workbench).getByTestId('delivery-step-102')).toHaveTextContent('本轮实现原文');
  });

  it('draws one segment per actual nonpending stage with an N-stage count', () => {
    render(<DeliveryProgress progress={snapshotProgress()} />);
    const nodes = screen.getAllByTestId('execution-graph-worker');
    expect(within(nodes[0]).getByTestId('execution-graph-stage-count')).toHaveTextContent('1 段');
    expect(within(nodes[1]).getByTestId('execution-graph-stage-count')).toHaveTextContent('2 段');
    expect(Array.from(within(nodes[1]).getByTestId('execution-graph-stage-bar').querySelectorAll('rect')).map(cell => cell.getAttribute('data-stage-status'))).toEqual(['done', 'active']);
    expect(nodes[1]).not.toHaveTextContent('×');
  });

  it('keeps stage names off the node and lists every stage in the tooltip', async () => {
    const progress = snapshotProgress();
    progress.executions![1].stepTimings = [{ stepId: 100, name: '复用需求', status: 'reused', durationMs: null }, ...progress.executions![1].stepTimings!];
    render(<DeliveryProgress progress={progress} />);
    const nodes = screen.getAllByTestId('execution-graph-worker');
    expect(nodes[1]).not.toHaveTextContent('本轮分析原文');
    expect(nodes[1]).not.toHaveTextContent('本轮入口');
    expect(within(nodes[1]).getByTestId('execution-graph-stage-bar').querySelector('[data-stage-status="reused"]')).toHaveAttribute('stroke-dasharray', '2 1.5');
    fireEvent.mouseOver(nodes[1]);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('#402 · ');
    expect(within(tooltip).getByTestId('execution-graph-stage-list')).toHaveTextContent('复用需求复用本轮分析原文已完成 · 10秒本轮实现原文进行中 · 50秒');
    expect(tooltip).toHaveTextContent('合计 2分');
    expect(document.querySelector('.execution-graph-tip')).not.toBeNull();
  });

  it('keeps a real dispatch selectable in Trace even when its runtime has not reported a session or graph node', async () => {
    const progress = snapshotProgress();
    progress.processGraph = null;
    render(<DeliveryProgress progress={progress} />);
    const workbench = await openWorkbench();
    fireEvent.click(within(workbench).getByRole('button', { name: '更早 1 次' }));
    fireEvent.click(within(workbench).getByRole('button', { name: /Dispatch 401/ }));
    fireEvent.click(within(workbench).getByRole('tab', { name: 'Trace 时间线' }));
    const trace = within(workbench).getByTestId('runtime-trace-drawer');
    expect(await within(trace).findByText('Runtime 尚未上报 Session Trace')).toBeInTheDocument();
    expect(trace).toHaveTextContent('Dispatch #401');
    expect(trace).not.toHaveTextContent('Dispatch #402');
    expect(document.querySelector('.ant-drawer')).toBeNull();
  });

  it('shows no-session emptiness without fabricating a dispatch from an agent plan', async () => {
    const progress = snapshotProgress();
    progress.executions = [];
    progress.processGraph = null;
    progress.agents![0].steps.forEach(step => { step.attempts = null; step.currentDispatchId = null; });
    render(<DeliveryProgress progress={progress} />);
    const workbench = await openDetails();
    const detailsPanel = await within(workbench).findByRole('tabpanel', { name: '执行详情' });
    expect(within(detailsPanel).getByText('暂无执行会话')).toBeVisible();
    expect(within(workbench).queryByTestId('live-activity-dispatch-select')).not.toBeInTheDocument();
    expect(within(workbench).queryByLabelText('执行阶段')).not.toBeInTheDocument();
    expect(within(workbench).queryByRole('button', { name: /全部执行记录/ })).not.toBeInTheDocument();
    fireEvent.click(within(workbench).getByRole('tab', { name: 'Trace 时间线' }));
    const tracePanel = await within(workbench).findByRole('tabpanel', { name: 'Trace 时间线' });
    expect(within(tracePanel).getByText('暂无执行会话')).toBeVisible();
    expect(within(workbench).queryByTestId('runtime-trace-dispatch-summary')).not.toBeInTheDocument();
  });

  it('retains a pinned historical Trace when current execution hands off, and follows only on explicit return', async () => {
    const progress = snapshotProgress();
    const { rerender } = render(<DeliveryProgress progress={progress} />);
    fireEvent.click(screen.getAllByTestId('execution-graph-worker')[0]);
    const workbench = await screen.findByTestId('delivery-workbench');
    await within(workbench).findByText('Runtime 尚未上报 Session Trace');
    const next: DeliveryProgressModel = { ...progress, executions: [...progress.executions!.map(attempt => attempt.dispatchId === 402 ? { ...attempt, status: 'SUCCEEDED' } : attempt),
      { dispatchId: 403, agentId: 42, agentName: 'Reviewer raw', executorName: 'runner-review', status: 'RUNNING', startedAt: null, durationMs: 5000, stepTimings: [] }] };
    rerender(<DeliveryProgress progress={next} />);
    expect(within(workbench).getByRole('alert')).toHaveTextContent('已交接给 Reviewer raw，当前保留所查看的历史会话。');
    expect(within(workbench).getByRole('tab', { name: 'Trace 时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 401');
    expect(within(workbench).getByTestId('runtime-trace-dispatch-summary')).toHaveTextContent('Dispatch #401');
    fireEvent.click(within(workbench).getByRole('button', { name: '回到当前执行' }));
    await waitFor(() => expect(within(workbench).getByTestId('runtime-trace-dispatch-summary')).toHaveTextContent('Dispatch #403'));
    expect(within(workbench).getByText('跟随当前执行')).toBeInTheDocument();
  });

  it('does not load or poll Trace while its tab or workbench is hidden', async () => {
    const load = vi.spyOn(workitemApi, 'getRuntimeTrace');
    render(<DeliveryProgress progress={snapshotProgress()} />);
    expect(load).not.toHaveBeenCalled();
    const workbench = await openExecutionLog();
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(within(workbench).getByRole('tab', { name: 'Trace 时间线' }));
    await within(workbench).findByText('Runtime 尚未上报 Session Trace');
    // 合并保留本地轨迹分页：加载需带 limit 窗口参数。
    expect(load).toHaveBeenCalledWith(402, null, { limit: 100 });
    vi.useFakeTimers();
    try {
      fireEvent.click(within(workbench).getByRole('tab', { name: '控制记录' }));
      const hiddenCalls = load.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(load).toHaveBeenCalledTimes(hiddenCalls);
      expect(within(workbench).queryByTestId('runtime-trace-drawer')).not.toBeInTheDocument();
      fireEvent.click(within(workbench).getByRole('tab', { name: 'Trace 时间线' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(document.querySelector('.delivery-workbench-modal .ant-modal-close') as HTMLElement);
      const closedCalls = load.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(load.mock.calls.slice(closedCalls)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['Enter', ' '])('activates graph edge and node with the %j key without dragging', async key => {
    render(<DeliveryProgress progress={snapshotProgress()} />);
    const viewport = screen.getByTestId('execution-graph-viewport');
    const pan = viewport.getAttribute('data-pan');
    fireEvent.keyDown(screen.getByTestId('execution-graph-edge'), { key });
    expect(screen.getByTestId('execution-graph-detail-panel')).toHaveTextContent('Dispatch 401 → 402');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getAllByTestId('execution-graph-worker')[0], { key });
    const workbench = await screen.findByTestId('delivery-workbench');
    expect(within(workbench).getByRole('tab', { name: 'Trace 时间线' })).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByTestId('live-activity-dispatch-select')).toHaveTextContent('Dispatch 401');
    expect(viewport).toHaveAttribute('data-pan', pan);
  });

  it('fits many lanes below the old 0.45 minimum without clipping the graph', () => {
    const progress = snapshotProgress();
    progress.processGraph = { nodes: Array.from({ length: 20 }, (_, index) => ({ key: `dispatch:${500 + index}`, dispatchId: 500 + index, agentId: index, agentName: `Lane ${index}`, stepName: `Entry ${index}`, status: 'SUCCEEDED', durationMs: 0 })), edges: [] };
    render(<DeliveryProgress progress={progress} />);
    const viewport = screen.getByTestId('execution-graph-viewport');
    const zoom = Number(viewport.getAttribute('data-zoom'));
    expect(zoom).toBeGreaterThan(0);
    expect(zoom).toBeLessThan(0.45);
    expect(2384 * zoom).toBeLessThan(680);
    expect(1544 * zoom).toBeLessThan(420);
    expect(viewport.getAttribute('data-pan')).not.toBe('0,0');
    fireEvent.click(screen.getByRole('button', { name: '适配宽度' }));
    expect(Number(viewport.getAttribute('data-zoom'))).toBeLessThan(0.45);
    expect(screen.getAllByTestId('execution-graph-lane')).toHaveLength(20);
  });

  it.each([{ available: true, credits: 0, label: '0 credits' }, { available: true, credits: 7.25, label: '7.25 credits' }, { available: false, credits: 99, label: '本次 Dispatch 的 Credits 未记录' }])('loads $label lazily for graph tooltip/detail and selected dispatch details', async ({ available, credits, label }) => {
    const requested: number[] = [];
    server.use(http.get('/api/dispatches/:dispatchId/runtime-trace', ({ params }) => {
      requested.push(Number(params.dispatchId));
      return HttpResponse.json({ success: true, code: '0', data: traceFixture(Number(params.dispatchId), { available, credits }) });
    }));
    render(<DeliveryProgress progress={snapshotProgress()} />);
    expect(requested).toEqual([]);
    const node = screen.getAllByTestId('execution-graph-worker')[0];
    fireEvent.mouseOver(node);
    const tooltip = await screen.findByRole('tooltip');
    await waitFor(() => expect(tooltip).toHaveTextContent(label));
    expect(tooltip).not.toHaveTextContent('999 credits');
    expect(tooltip).not.toHaveTextContent('777 credits');
    expect(requested).toContain(401);
    expect(requested).not.toContain(402);
    fireEvent.mouseOut(node);
    fireEvent.click(node);
    const detail = screen.getByTestId('execution-graph-detail-panel');
    await waitFor(() => expect(detail).toHaveTextContent(label));
    expect(detail).not.toHaveTextContent('999 credits');
    const workbench = await screen.findByTestId('delivery-workbench');
    fireEvent.click(within(workbench).getByRole('tab', { name: '执行详情' }));
    const heading = workbench.querySelector('.delivery-workbench-detail-heading')!;
    await waitFor(() => expect(heading).toHaveTextContent(label));
    if (!available) {
      expect(detail).not.toHaveTextContent('99 credits');
      expect(heading).not.toHaveTextContent('99 credits');
    }
  });
});

describe('convergeStepsForTerminalStatus', () => {
  const makeStep = (stepId: number, name: string, status: DeliveryStep['status']): DeliveryStep => ({
    stepId,
    name,
    status,
    executorName: null,
    error: null,
    subSteps: null,
    durationMs: null,
    attempts: null,
  });

  it('keeps statuses unchanged without a terminal status', () => {
    const steps = [makeStep(1, '步骤一', 'done'), makeStep(2, '步骤二', 'active'), makeStep(3, '步骤三', 'pending')];
    expect(convergeStepsForTerminalStatus(steps, null).map((step) => step.status)).toEqual(['done', 'active', 'pending']);
    expect(convergeStepsForTerminalStatus(steps, 'RUNNING').map((step) => step.status)).toEqual(['done', 'active', 'pending']);
  });

  it('converges active steps to done when the run succeeded', () => {
    const steps = [makeStep(1, '步骤一', 'done'), makeStep(2, '步骤二', 'active'), makeStep(3, '步骤三', 'active')];
    expect(convergeStepsForTerminalStatus(steps, 'SUCCEEDED').map((step) => step.status)).toEqual(['done', 'done', 'done']);
  });

  it('marks only the last active step failed and earlier active steps done when the run failed', () => {
    const steps = [makeStep(1, '步骤一', 'active'), makeStep(2, '步骤二', 'done'), makeStep(3, '步骤三', 'active')];
    expect(convergeStepsForTerminalStatus(steps, 'FAILED').map((step) => step.status)).toEqual(['done', 'done', 'failed']);
  });

  it('converges active steps to cancelled when the run was cancelled', () => {
    const steps = [makeStep(1, '步骤一', 'done'), makeStep(2, '步骤二', 'active')];
    expect(convergeStepsForTerminalStatus(steps, 'CANCELLED').map((step) => step.status)).toEqual(['done', 'cancelled']);
  });

  it('treats a closed workitem status as succeeded', () => {
    const steps = [makeStep(1, '步骤一', 'active')];
    expect(convergeStepsForTerminalStatus(steps, '已关闭').map((step) => step.status)).toEqual(['done']);
    expect(convergeStepsForTerminalStatus(steps, 'closed').map((step) => step.status)).toEqual(['done']);
  });

  it('converges active sub-steps together with their step', () => {
    const steps: DeliveryStep[] = [{
      ...makeStep(1, '步骤一', 'active'),
      subSteps: [{ name: '子步骤', status: 'active' }],
    }];
    expect(convergeStepsForTerminalStatus(steps, 'SUCCEEDED')[0].subSteps?.[0].status).toBe('done');
    expect(convergeStepsForTerminalStatus(steps, 'CANCELLED')[0].subSteps?.[0].status).toBe('cancelled');
    expect(convergeStepsForTerminalStatus(steps, 'FAILED')[0].subSteps?.[0].status).toBe('failed');
  });
});

describe('DeliveryProgress terminal convergence rendering', () => {
  const makeStep = (stepId: number, name: string, status: DeliveryStep['status']): DeliveryStep => ({
    stepId,
    name,
    status,
    executorName: null,
    error: null,
    subSteps: null,
    durationMs: null,
    attempts: null,
  });

  it('shows 已完成 instead of a spinning step when the run succeeded with an incomplete event stream', () => {
    render(<DeliveryProgress steps={[makeStep(1, '步骤一', 'done'), makeStep(2, '步骤二', 'active')]} terminalStatus="SUCCEEDED" />);
    expect(within(screen.getByTestId('delivery-step-2')).getByText('已完成')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
  });

  it('shows the last started step as failed and earlier ones completed when the run failed', () => {
    render(<DeliveryProgress steps={[makeStep(1, '步骤一', 'active'), makeStep(2, '步骤二', 'active')]} terminalStatus="FAILED" />);
    expect(within(screen.getByTestId('delivery-step-1')).getByText('已完成')).toBeInTheDocument();
    expect(within(screen.getByTestId('delivery-step-2')).getByText('失败')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
  });

  it('shows the running step as cancelled when the run was cancelled', () => {
    render(<DeliveryProgress steps={[makeStep(1, '步骤一', 'active')]} terminalStatus="CANCELLED" />);
    expect(within(screen.getByTestId('delivery-step-1')).getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
  });

  it.each(['FAILED', 'SUCCEEDED', 'CANCELED', 'CANCELLED'])('converges the agent card for %s', (terminal) => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{ agentId: 41, agentName: '执行 Agent', status: 'active', durationMs: null,
        steps: [{
          ...makeStep(5, '执行步骤', 'active'),
          attempts: [{ dispatchId: 305, agentName: '执行 Agent', executorName: null, status: 'RUNNING', error: null, startedAt: null, durationMs: 1000 }],
        }] }],
    };
    render(<DeliveryProgress progress={progress} terminalStatus={terminal} />);
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
    expect(screen.getAllByText(terminal === 'FAILED' ? '失败' : terminal === 'SUCCEEDED' ? '已完成' : '已取消').length).toBeGreaterThan(0);
  });

  it('still renders active steps as running for non-terminal run statuses', () => {
    render(<DeliveryProgress steps={[makeStep(1, '步骤一', 'active')]} terminalStatus="RUNNING" />);
    expect(within(screen.getByTestId('delivery-step-1')).getByText('执行中')).toBeInTheDocument();
  });

  it('converges agent steps inside the agent panel when the run reached a terminal state', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: '执行 Agent',
        status: 'active',
        durationMs: null,
        steps: [{ ...makeStep(5, '执行步骤', 'active'), currentDispatchId: 305,
          attempts: [{ dispatchId: 305, agentId: 41, agentName: '执行 Agent', executorName: null, status: 'SUCCEEDED', startedAt: null, durationMs: 1000 }] }],
      }],
    };
    render(<DeliveryProgress progress={progress} terminalStatus="SUCCEEDED" />);
    await openDetails();
    const stepCard = screen.getByTestId('delivery-step-5');
    expect(within(stepCard).getByText('已完成')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
  });
});

describe('DeliveryProgress usage display', () => {
  it('keeps selected dispatch details compact without inheriting accumulated agent or step credits', async () => {
    server.use(http.get('/api/dispatches/301/runtime-trace', () => HttpResponse.json({ success: true, code: '0', data: traceFixture(301, { available: true, credits: 12.34, inputTokens: 500, outputTokens: 100, totalTokens: 600 }) })));
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 41,
        agentName: 'AW全栈开发',
        status: 'finished',
        durationMs: 1_050_000,
        usage: { model: 'auto', inputTokens: 800_000, outputTokens: 200_000, credits: 82.61 },
        steps: [{
          stepId: 101,
          name: '编码实现',
          status: 'done',
          agentName: 'AW全栈开发', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 1_050_000,
          usage: { inputTokens: 800_000, outputTokens: 200_000, credits: 82.61 },
          attempts: [
            { dispatchId: 301, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 1_050_000 },
          ],
        }],
      }],
    };
    const artifacts: Artifact[] = [
      { id: 1, workitemId: 100, dispatchId: 301, name: 'dev-summary.md', type: 'MARKDOWN', size: 1024, gmtCreate: '' },
      { id: 2, workitemId: 100, dispatchId: 301, name: 'run.log', type: 'TEXT', size: 128, gmtCreate: '' },
    ];

    render(<DeliveryProgress progress={progress} artifacts={artifacts} />);
    const workbench = await openDetails();
    expect(await within(workbench).findByText('12.34 credits')).toBeInTheDocument();
    expect(within(workbench).queryByText('82.61 credits')).not.toBeInTheDocument();
    expect(within(workbench).getByTestId('delivery-step-101')).not.toHaveTextContent('credits');
    expect(screen.queryByText('1M')).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/💰/)).not.toBeInTheDocument();
    expect(screen.queryByText('2 个产物')).not.toBeInTheDocument();
    expect(screen.queryByText('无产物')).not.toBeInTheDocument();
    expect(screen.getAllByText('产物（2）').length).toBeGreaterThan(0);
  });

  it('hides the usage badge when the backend still reports tokens without credits', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 42,
        agentName: 'AW全栈开发',
        status: 'finished',
        durationMs: 60_000,
        usage: { model: 'auto', inputTokens: 800_000, outputTokens: 200_000 },
        steps: [{
          stepId: 201,
          name: '编码实现',
          status: 'done',
          agentName: 'AW全栈开发', executorName: null,
          error: null,
          subSteps: null,
          durationMs: 60_000,
          usage: { inputTokens: 800_000, outputTokens: 200_000 },
          attempts: [{ dispatchId: 201, agentName: 'AW全栈开发', executorName: null, status: 'SUCCEEDED', error: null, startedAt: null, durationMs: 60_000 }],
        }],
      }],
    };

    render(<DeliveryProgress progress={progress} />);

    expect(screen.getAllByText('AW全栈开发').length).toBeGreaterThan(0);
    expect(screen.queryByText(/credits/)).not.toBeInTheDocument();
    expect(screen.queryByText('1M')).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/i)).not.toBeInTheDocument();
  });

  it('removes the standalone workbench button and keeps the agent row as the only entry', async () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{
        agentId: 42, agentName: 'AW全栈开发', status: 'failed', durationMs: 60_000,
        steps: [{
          stepId: 201, name: '编码实现', status: 'failed', agentName: 'AW全栈开发', executorName: null,
          error: null, subSteps: null, durationMs: 60_000,
          attempts: [{ dispatchId: 201, agentName: 'AW全栈开发', executorName: null, status: 'FAILED', error: null, startedAt: null, durationMs: 60_000 }],
        }],
      }],
    };
    render(<DeliveryProgress progress={progress} />);
    expect(screen.queryByTestId('delivery-enter-workbench')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delivery-current-execution'));
    expect(screen.queryByTestId('delivery-workbench')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('delivery-agent-row'));
    expect(await screen.findByTestId('delivery-workbench')).toBeInTheDocument();
  });

  it('renders no workbench entry when the squad has no execution yet', () => {
    const progress: DeliveryProgressModel = {
      steps: [],
      agents: [{ agentId: 42, agentName: 'AW全栈开发', status: 'pending', durationMs: null, steps: [] }],
    };
    render(<DeliveryProgress progress={progress} />);
    expect(screen.queryByTestId('delivery-agent-row')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看执行' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('delivery-enter-workbench')).not.toBeInTheDocument();
  });
});

describe('DeliveryProgress notice and rail fallbacks', () => {
  it('surfaces the delivery-closed notice above an active squad', () => {
    render(<DeliveryProgress progress={{
      steps: [], executions: [], closed: true,
      agents: [{ agentId: 42, agentName: 'AW全栈开发', status: 'active', durationMs: 60_000, steps: [] }],
    }} />);
    expect(screen.getByText('交付已关闭')).toBeInTheDocument();
    expect(screen.getByText(/关闭交付会停止当前所有未结束的执行/)).toBeInTheDocument();
  });

  it('surfaces the delivery-closed notice before any agent exists', () => {
    render(<DeliveryProgress progress={{ steps: [], executions: [], closed: true, agents: [] }} />);
    expect(screen.getByText('交付已关闭')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-rail')).not.toBeInTheDocument();
  });

  it('explains a squad whose agents have not joined any dispatch yet', () => {
    render(<DeliveryProgress progress={{ steps: [], executions: [], agents: [
      { agentId: 42, agentName: 'AW全栈开发', status: 'pending', durationMs: null, steps: [] },
      { agentId: 43, agentName: 'Chief of Staff', status: 'pending', durationMs: null, steps: [] },
    ] }} />);
    expect(screen.getByText(/交付团队 2 名数字员工尚未参与/)).toBeInTheDocument();
    expect(screen.getByTestId('delivery-current-execution')).toHaveTextContent('暂无执行');
  });

  it('renders a dot mark and no dispatch count for a nameless agent without executions', () => {
    render(<DeliveryProgress progress={{ steps: [], executions: [], agents: [
      { agentId: 42, agentName: '  ', status: 'active', durationMs: null, steps: [] },
    ] }} />);
    const row = screen.getByTestId('delivery-agent-row');
    expect(row.querySelector('.aw-fn-mark')).toHaveTextContent('·');
    expect(row.querySelector('.aw-agent-meta:not(.is-credits)')).toBeNull();
  });
});
