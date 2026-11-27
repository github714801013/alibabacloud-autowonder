import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { summaryPage } from '@/test/mocks/handlers';
import { PrdConversation } from './PrdConversation';
import { selectText, stubRangeRect } from '@/test/selection';
import { File as UploadFile } from 'node:buffer';

vi.mock('@/features/workitem/clarification/SquadAgentSelector', () => ({ SquadAgentSelector: () => null }));
vi.mock('./PrdBrowserSettings', () => ({
  browserSelectionValid: (value: unknown) => !!value,
  PrdBrowserSettings: ({ onChange }: { onChange: (value: unknown) => void }) => <button onClick={() => onChange({ codeOnly: true })}>Code only</button>,
}));
const ok = (data: unknown) => HttpResponse.json({ success: true, code: '0', data });

describe('PrdConversation API routing', () => {
  it('subscribes to the independent active turn outside the latest message window', async () => {
    const subscribed = vi.fn();
    server.use(
      http.get('/api/workitems/13/prd/conversation', () => ok({ id: 62, processingStatus: 'PROCESSING', processingTurnId: 1,
        turns: [{ id: 51, direction: 'IN', content: 'Queued later', status: 'QUEUED' }] })),
      http.get('/api/workitems/13/prd/conversation/62/turns/:turnId/event-summaries', ({ params }) => { subscribed(String(params.turnId)); return ok(summaryPage([])); }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}><QueryClientProvider client={client}><PrdConversation workitemId="13" /></QueryClientProvider></MemoryRouter>);
    await waitFor(() => expect(subscribed).toHaveBeenCalledWith('1'));
    expect(subscribed).not.toHaveBeenCalledWith('51');
    view.unmount(); client.clear();
  });
  it('returns to the latest messages when sending from an older message window', async () => {
    let sent = false;
    server.use(
      http.get('/api/workitems/14/prd/conversation', () => ok({ id: 63, turnsHasMore: true, nextBeforeTurnId: 51,
        turns: [{ id: 51, direction: 'IN', content: sent ? 'New message persisted' : 'Latest message', status: 'COMPLETED' }] })),
      http.get('/api/workitems/14/prd/conversation/63/turns/page', () => ok({ items: [{ id: 1, direction: 'IN', content: 'Older message', status: 'COMPLETED' }], hasMore: false, nextBeforeTurnId: null })),
      http.get('/api/workitems/14/prd/conversation/63/turns/51/event-summaries', () => ok(summaryPage([]))),
      http.post('/api/workitems/14/prd/conversation', () => { sent = true; return ok(null); }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}><QueryClientProvider client={client}><PrdConversation workitemId="14" /></QueryClientProvider></MemoryRouter>);
    const latest = await screen.findByText('Latest message');
    fireEvent.scroll(latest.closest('div[style*="40vh"]')!);
    expect(await screen.findByText('Older message')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    await userEvent.type(screen.getByRole('textbox', { name: '设计对话' }), 'Send from history');
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));
    expect(await screen.findByText('New message persisted')).toBeInTheDocument();
    expect(screen.queryByText('Older message')).toBeNull();
    view.unmount(); client.clear();
  });
  it('restores bounded final design content for preview and draft publication', async () => {
    const content = JSON.stringify({ title: 'Large design', changeLog: 'Restored design' });
    const onDraftChange = vi.fn();
    server.use(
      http.get('/api/workitems/12/prd/conversation', () => ok({ id: 61, turns: [{ id: 2, direction: 'OUT', content: content.slice(0, 10), contentHasMore: true, status: 'COMPLETED' }] })),
      http.get('/api/workitems/12/prd/conversation/61/turns/2/content', ({ request }) => {
        const second = new URL(request.url).searchParams.get('cursor') === 'next';
        return ok({ content: second ? content.slice(20) : content.slice(0, 20), segmentIndex: second ? 1 : 0, nextCursor: second ? null : 'next', hasMore: !second });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}><QueryClientProvider client={client}><PrdConversation workitemId="12" onDraftChange={onDraftChange} /></QueryClientProvider></MemoryRouter>);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 61, turnId: 2, content })));
    view.unmount(); client.clear();
  });
  it('uploads pasted screenshots as multipart and attributes shared messages to their authors', async () => {
    let uploaded = false;
    let submitted: unknown;
    server.use(
      http.get('/api/workitems/10/prd/conversation', () => ok({ id: 50, participants: { 7: 'Alice', 8: 'Bob' }, turns: [
        { id: 1, direction: 'IN', content: 'First idea', sourceContext: '{}', submittedUserId: 7, status: 'COMPLETED' },
        { id: 2, direction: 'IN', content: 'Another idea', sourceContext: '{}', submittedUserId: 8, status: 'COMPLETED' },
      ] })),
      http.get('/api/workitems/10/prd/conversation/50/events', () => ok([])),
      http.post('/api/workitems/10/prd/conversation/prepare', () => ok({ id: 50, turns: [] })),
      http.post('/api/workitems/10/prd/conversation/50/attachments', async ({ request }) => {
        expect(request.headers.get('content-type')).toContain('multipart/form-data');
        const form = await request.formData();
        const file = form.get('file');
        expect(file).toBeInstanceOf(UploadFile);
        const uploadedFile = file as File;
        expect(uploadedFile.name).toBe('screen.png');
        expect(uploadedFile.type).toBe('image/png');
        expect(Array.from(new Uint8Array(await uploadedFile.arrayBuffer()))).toEqual([105, 109, 97, 103, 101]);
        uploaded = true;
        return ok({ id: 90 });
      }),
      http.post('/api/workitems/10/prd/conversation', async ({ request }) => { submitted = await request.json(); return ok(null); }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="10" /></QueryClientProvider>
    </MemoryRouter>);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('internal prompt')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new UploadFile(['image'], 'screen.png', { type: 'image/png' })] } });
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));
    await waitFor(() => expect(submitted).toMatchObject({ agentId: 42, content: '', attachmentIds: [90] }));
    expect(uploaded).toBe(true);
    view.unmount(); client.clear();
  });
  it('attaches the picked prototype element to the next design message', async () => {
    let submitted: unknown;
    const cleared = vi.fn();
    server.use(
      http.get('/api/workitems/11/prd/conversation', () => ok({ id: 60, turns: [
        { id: 1, direction: 'IN', content: 'Round the corners', status: 'COMPLETED', submittedUserId: 7,
          sourceContext: '{"element":{"tag":"button","selector":"#save","cssPath":"body > button","xpath":"/x","text":"Save"}}' },
      ] })),
      http.get('/api/workitems/11/prd/conversation/60/events', () => ok([])),
      http.post('/api/workitems/11/prd/conversation', async ({ request }) => { submitted = await request.json(); return ok(null); }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="11" onClearElement={cleared} element={{
        tag: 'button', selector: '#save', cssPath: 'body > button', xpath: '/html[1]/body[1]/button[1]', text: 'Save changes', page: 'Home',
      }} /></QueryClientProvider>
    </MemoryRouter>);
    expect(await screen.findByText('Round the corners')).toBeInTheDocument();
    expect(screen.getAllByText('已选中：Save').length).toBeGreaterThan(0);
    expect(screen.getByText('已选中：Save changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    await userEvent.type(screen.getByRole('textbox', { name: '设计对话' }), 'Make the button blue');
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));
    await waitFor(() => expect(submitted).toMatchObject({ content: 'Make the button blue',
      element: { tag: 'button', selector: '#save', text: 'Save changes' } }));
    expect(cleared).toHaveBeenCalledOnce();
    view.unmount(); client.clear();
  });
  it('loads history, sends and saves through the /api workitem routes', async () => {
    let submitted: unknown;
    const saved = vi.fn();
    const onDraftChange = vi.fn();
    const onPreview = vi.fn();
    server.use(
      http.get('/api/workitems/39089/prd/conversation', ({ request }) => {
        expect(new URL(request.url).searchParams.get('agentId')).toBe('42');
        return ok({ id: 50, turns: [{ id: 60, direction: 'OUT', content: JSON.stringify({ title: 'Design', changeLog: 'Design response' }), status: 'COMPLETED' }] });
      }),
      http.post('/api/workitems/39089/prd/conversation', async ({ request }) => {
        submitted = await request.json(); return ok(null);
      }),
      http.get('/api/workitems/39089/prd/conversation/50/events', () => ok([])),
      http.post('/api/workitems/39089/prd/conversation/preview', () => ok('<h1>Live design</h1>')),
      http.post('/api/workitems/39089/prd/conversation/50/turns/60/save', () => { saved(); return ok({ id: 70 }); }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="39089" onDraftChange={onDraftChange} onPreview={onPreview} /></QueryClientProvider>
    </MemoryRouter>);
    expect(await screen.findByText('Design response')).toBeInTheDocument();
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('<h1>Live design</h1>'));
    expect(saved).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Code only' }));
    await user.type(screen.getByRole('textbox', { name: '设计对话' }), 'Generate PRD');
    await user.click(screen.getByRole('button', { name: /发\s*送/ }));
    await waitFor(() => expect(submitted).toEqual({ agentId: 42, content: 'Generate PRD', clientMessageId: expect.any(String), attachmentIds: [], browser: { codeOnly: true } }));
    expect(screen.queryByRole('button', { name: '采用当前设计' })).not.toBeInTheDocument();
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 50, turnId: 60 })));
    expect(saved).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
  it('falls back to the element selector when the picked element has no text', async () => {
    server.use(
      http.get('/api/workitems/12/prd/conversation', () => ok({ id: 60, turns: [] })),
      http.get('/api/workitems/12/prd/conversation/60/events', () => ok([])),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="12" element={{
        tag: 'button', selector: '#save', cssPath: 'body > button', xpath: '/html[1]/body[1]/button[1]',
      }} /></QueryClientProvider>
    </MemoryRouter>);
    expect(await screen.findByText('已选中：#save')).toBeInTheDocument();
    view.unmount(); client.clear();
  });
  it('quotes the selected reply into the next design message', async () => {
    let submitted: unknown;
    server.use(
      http.get('/api/workitems/14/prd/conversation', () => ok({ id: 70, turns: [
        { id: 1, direction: 'OUT', content: '设计稿第一版已经生成', status: 'COMPLETED' },
      ] })),
      http.get('/api/workitems/14/prd/conversation/70/events', () => ok([])),
      http.post('/api/workitems/14/prd/conversation', async ({ request }) => { submitted = await request.json(); return ok(null); }),
    );
    stubRangeRect();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="14" /></QueryClientProvider>
    </MemoryRouter>);
    const reply = await screen.findByText('设计稿第一版已经生成');
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    selectText(reply);
    await userEvent.click(screen.getByRole('button', { name: '引用此内容' }));
    await userEvent.type(screen.getByRole('textbox', { name: '设计对话' }), '按这个方向继续');
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));

    await waitFor(() => expect(submitted).toMatchObject({ content: '> 设计稿第一版已经生成\n\n按这个方向继续' }));
    await waitFor(() => expect(screen.queryByText('引用内容')).not.toBeInTheDocument());
    view.unmount(); client.clear();
  });

  it('sends the quote alone when the input is empty', async () => {
    let submitted: unknown;
    server.use(
      http.get('/api/workitems/16/prd/conversation', () => ok({ id: 72, turns: [
        { id: 1, direction: 'OUT', content: '设计稿第一版已经生成', status: 'COMPLETED' },
      ] })),
      http.get('/api/workitems/16/prd/conversation/72/events', () => ok([])),
      http.post('/api/workitems/16/prd/conversation', async ({ request }) => { submitted = await request.json(); return ok(null); }),
    );
    stubRangeRect();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="16" /></QueryClientProvider>
    </MemoryRouter>);
    const reply = await screen.findByText('设计稿第一版已经生成');
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    selectText(reply);
    await userEvent.click(screen.getByRole('button', { name: '引用此内容' }));
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));

    await waitFor(() => expect(submitted).toMatchObject({ content: '> 设计稿第一版已经生成' }));
    view.unmount(); client.clear();
  });

  it('keeps the quote when the design message fails to send', async () => {
    server.use(
      http.get('/api/workitems/15/prd/conversation', () => ok({ id: 71, turns: [
        { id: 1, direction: 'OUT', content: '设计稿第一版已经生成', status: 'COMPLETED' },
      ] })),
      http.get('/api/workitems/15/prd/conversation/71/events', () => ok([])),
      http.post('/api/workitems/15/prd/conversation', () => HttpResponse.json(
        { success: false, code: 'SEND_FAILED', message: '发送失败', traceId: null, data: null }, { status: 500 },
      )),
    );
    stubRangeRect();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="15" /></QueryClientProvider>
    </MemoryRouter>);
    const reply = await screen.findByText('设计稿第一版已经生成');
    await userEvent.click(screen.getByRole('button', { name: 'Code only' }));
    selectText(reply);
    await userEvent.click(screen.getByRole('button', { name: '引用此内容' }));
    await userEvent.type(screen.getByRole('textbox', { name: '设计对话' }), '按这个方向继续');
    await userEvent.click(screen.getByRole('button', { name: /发\s*送/ }));

    await waitFor(() => expect(screen.getByText('引用内容')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: '设计对话' })).toHaveValue('按这个方向继续');
    view.unmount(); client.clear();
  });

  it('degrades safely when stored turns carry no or broken source context', async () => {
    server.use(
      http.get('/api/workitems/13/prd/conversation', () => ok({ id: 61, participants: { 7: 'Alice' }, turns: [
        { id: 1, direction: 'IN', content: 'raw first idea', status: 'COMPLETED', submittedUserId: 7 },
        { id: 2, direction: 'IN', content: 'raw second idea', status: 'COMPLETED', submittedUserId: 7, sourceContext: 'not-json' },
      ] })),
      http.get('/api/workitems/13/prd/conversation/61/events', () => ok([])),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<MemoryRouter initialEntries={['/?prdAgent=42&prdSquad=7']}>
      <QueryClientProvider client={client}><PrdConversation workitemId="13" /></QueryClientProvider>
    </MemoryRouter>);
    expect(await screen.findByText('raw first idea')).toBeInTheDocument();
    expect(screen.getByText('raw second idea')).toBeInTheDocument();
    expect(screen.queryByText(/已选中/)).not.toBeInTheDocument();
    view.unmount(); client.clear();
  });
});
