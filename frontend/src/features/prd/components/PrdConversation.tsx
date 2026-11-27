import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Spin, Upload, Tag, Tooltip, message } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/shared/i18n';
import { apiClient } from '@/shared/api/client';
import { SquadAgentSelector } from '@/features/workitem/clarification/SquadAgentSelector';
import type { SquadAgentSelection } from '@/features/workitem/clarification/SquadAgentSelector';
import { createClientMessageId } from '@/features/workitem/clarification/api';
import { MarkdownView } from '@/shared/ui/MarkdownView';
import { AutoConversationTurnContent, readConversationTurnText } from '@/shared/ui/AutoConversationTurnContent';
import { useConversationTurnHistory } from '@/shared/ui/useConversationTurnHistory';
import { composeQuotedContent } from '@/shared/ui/quote-block';
import { QuoteCard, QuotePill, useTextQuote } from '@/shared/ui/TextQuote';
import { ConversationEventView } from '@/features/workitem/clarification/ConversationEventView';
import { EventSyncStatus } from '@/features/workitem/clarification/EventSyncStatus';
import { createEventDisplaySource } from '@/features/workitem/clarification/eventDisplay';
import { useEventSummaryFeed } from '@/features/workitem/clarification/useEventSummaryFeed';
import { prototypePages, type PrototypeElement, type PrototypePage } from './PrdPrototypePreview';
import { PrdScreenshot } from './PrdScreenshot';
import { PrdBrowserSettings, browserSelectionValid, type BrowserSelection } from './PrdBrowserSettings';

interface Turn { id: number; direction: string; content: string; contentHasMore?: boolean; status: string; error?: string; submittedUserId?: number; sourceContext?: string; gmtCreate?: string | number }
interface History { id: number | null; turns: Turn[]; processingTurnId?: number | null; processingStatus?: string | null; turnsHasMore?: boolean; nextBeforeTurnId?: number | null; participants?: Record<string, string>; attachments?: Record<string, {id: number; name: string; previewable: boolean}[]> }
const isReply = (turn: Turn) => turn.direction === 'OUT';
const active = (turn: Turn) => ['QUEUED', 'PROCESSING', 'RUNNING'].includes(turn.status);
function elementLabel(element: PrototypeElement): string {
  return element.text?.trim() || element.selector;
}
function turnElement(turn: Turn): PrototypeElement | null {
  try {
    const element = JSON.parse(turn.sourceContext || '{}').element;
    return element && typeof element.selector === 'string' ? element : null;
  } catch { return null; }
}
function designData(content: string) {
  try {
    const data = JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) && typeof data.title === 'string' ? data : null;
  } catch { return null; }
}
export interface DesignReply { conversationId: number; turnId: number; content: string; createdAt?: string | number }
export function PrdConversation({ workitemId, onDraftChange, suggestion, onPreview, onPrototype, element, onClearElement }: {
  workitemId: string;
  onDraftChange?: (draft: DesignReply | null) => void;
  suggestion?: { text: string; id: number };
  onPreview?: (html: string) => void;
  onPrototype?: (pages: PrototypePage[]) => void;
  element?: PrototypeElement | null;
  onClearElement?: () => void;
}) {
  const { t } = useTranslation('prd');
  const [params, setParams] = useSearchParams();
  const agentId = Number(params.get('prdAgent'));
  const squadId = Number(params.get('prdSquad'));
  const selection: SquadAgentSelection | null = squadId > 0 ? { agentId, squadId } : null;
  const setSelection = (next: SquadAgentSelection | null) => {
    setParams(current => {
      const updated = new URLSearchParams(current);
      if (next) { updated.set('prdAgent', String(next.agentId)); updated.set('prdSquad', String(next.squadId)); }
      else { updated.delete('prdAgent'); updated.delete('prdSquad'); }
      return updated;
    }, { replace: true });
  };
  const [input, setInput] = useState('');
  const [browser, setBrowser] = useState<BrowserSelection | null>(null);
  const browserEdited = useRef(false);
  useEffect(() => { setBrowser(null); browserEdited.current = false; }, [workitemId, agentId]);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [requestId, setRequestId] = useState(createClientMessageId);
  const feedRef = useRef<HTMLDivElement>(null);
  const followFeed = useRef(true);
  const inputRef = useRef<TextAreaRef>(null);
  useEffect(() => {
    if (!suggestion) return;
    setInput(previous => previous ? `${previous}\n\n${suggestion.text}` : suggestion.text);
    setRequestId(createClientMessageId());
    inputRef.current?.focus({ cursor: 'end' });
    inputRef.current?.resizableTextArea?.textArea.scrollIntoView({ block: 'nearest' });
  }, [suggestion]);
  const base = `/api/workitems/${workitemId}/prd/conversation`;
  const rememberedSelection = useQuery({
    queryKey: ['prd-selection', workitemId],
    queryFn: async () => (await apiClient.get<SquadAgentSelection | null>(`${base}/selection`)).data,
    enabled: !params.has('prdSquad'),
  });
  useEffect(() => {
    if (!params.has('prdSquad') && rememberedSelection.data) setSelection(rememberedSelection.data);
  }, [rememberedSelection.data, params]);
  const history = useQuery({
    queryKey: ['prd-conversation', workitemId, selection?.agentId],
    queryFn: async () => (await apiClient.get<History>(base, { params: { agentId: selection!.agentId } })).data,
    enabled: !!selection?.agentId,
    refetchInterval: 2000,
  });
  const conversationId = history.data?.id;
  const turnHistory = useConversationTurnHistory({ base: `${base}/${conversationId}`, conversationId, snapshot: history.data });
  const { t: sharedT } = useTranslation('shared');
  const historyLatestLabel = sharedT('conversationContent.latest');
  const { quote, truncated, pill, acceptPill, removeQuote } = useTextQuote({
    containerRef: feedRef,
    enabled: !sending,
    resetKey: conversationId,
    onAccept: () => inputRef.current?.focus(),
  });
  useEffect(() => {
    if (browserEdited.current || !history.data) return;
    for (const turn of [...history.data.turns].reverse()) {
      if (turn.direction !== 'IN') continue;
      try {
        const saved = JSON.parse(turn.sourceContext || '{}').browser as BrowserSelection | undefined;
        if (saved && typeof saved.codeOnly === 'boolean') { setBrowser(saved); break; }
      } catch { /* Older turns have no browser selection. */ }
    }
  }, [history.data]);
  const processing = history.data?.processingStatus != null
    ? ['QUEUED', 'PROCESSING', 'RUNNING'].includes(history.data.processingStatus)
    : history.data?.turns.some(active) ?? false;
  const latestReply = history.data?.turns.filter(isReply).at(-1);
  const [completeReply, setCompleteReply] = useState<{ id: number; content: string } | null>(null);
  useEffect(() => {
    setCompleteReply(null);
    if (!latestReply?.contentHasMore || !conversationId || processing) return;
    let controller: AbortController | null = null;
    let completed = false;
    const read = () => {
      if (document.hidden || completed) return;
      const request = new AbortController(); controller = request;
      void readConversationTurnText(`${base}/${conversationId}`, conversationId, latestReply.id, request.signal)
        .then(content => { if (!request.signal.aborted) { completed = true; setCompleteReply({ id: latestReply.id, content }); } })
        .catch(() => { if (!request.signal.aborted) setPreviewFailed(true); });
    };
    read();
    const hide = () => { if (document.hidden) controller?.abort(); else read(); };
    document.addEventListener('visibilitychange', hide);
    return () => { controller?.abort(); document.removeEventListener('visibilitychange', hide); };
  }, [base, conversationId, latestReply?.id, latestReply?.contentHasMore, processing]);
  const latestReplyContent = completeReply?.id === latestReply?.id ? completeReply?.content : latestReply?.content;
  const inboundTurns = history.data?.turns.filter(turn => !isReply(turn)) ?? [];
  const latestTurn = inboundTurns.find(turn => ['PROCESSING', 'RUNNING'].includes(turn.status))
    ?? inboundTurns.find(active) ?? inboundTurns.at(-1);
  const feedTurnId = history.data?.processingTurnId ?? latestTurn?.id ?? null;
  const eventSource = useMemo(
    () => createEventDisplaySource(`/api/workitems/${workitemId}/prd/conversation/${conversationId ?? 0}`),
    [conversationId, workitemId],
  );
  const feed = useEventSummaryFeed({
    source: eventSource,
    conversationId: conversationId ?? null,
    turnId: feedTurnId,
    enabled: !!conversationId && feedTurnId != null,
    processing,
    retainBusinessText: true,
  });
  const currentTimeline = feed.timeline;
  const streamingText = currentTimeline.filter(node => node.kind === 'text').map(node => node.text ?? '').join('');
  const draftText = processing
    ? (feed.businessText || streamingText)
    : latestReplyContent;
  useEffect(() => {
    onDraftChange?.(!processing && !sending && conversationId && latestReply && latestReplyContent && designData(latestReplyContent)
      ? { conversationId, turnId: latestReply.id, content: latestReplyContent, createdAt: latestReply.gmtCreate } : null);
  }, [processing, sending, conversationId, latestReply?.id, latestReplyContent, latestReply?.gmtCreate, onDraftChange]);
  useEffect(() => {
    if (followFeed.current && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [history.data, feed.items, sending]);
  useEffect(() => {
    if (!draftText || !onPreview) return;
    let cancelled = false;
    const timer = setTimeout(() => {
    const data = designData(draftText);
    if (data) {
      onPrototype?.(prototypePages(data));
      void apiClient.post<string>(`${base}/preview`, { designJson: JSON.stringify(data) })
        .then(response => { if (!cancelled) { onPreview(response.data); setPreviewFailed(false); } })
        .catch(() => { if (!cancelled) setPreviewFailed(true); });
    } else {
      const pages = [...draftText.matchAll(/"mockHtml"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]) as string);
      if (pages.length) onPrototype?.(pages.map(html => ({ html })));
    }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draftText, base, onPreview, onPrototype]);
  const send = async () => {
    turnHistory.returnLatest();
    followFeed.current = true;
    // 引用块随正文提交，只有成功后才清空；失败时输入与引用都保留，便于原样重试。
    const content = composeQuotedContent(quote, input.trim());
    setSending(true);
    try {
      const prepared = files.length ? (await apiClient.post<History>(`${base}/prepare`, { agentId: selection!.agentId })).data : null;
      const attachmentIds: number[] = [];
      for (const file of files) {
        const form = new FormData(); form.append('file', file);
        attachmentIds.push((await apiClient.post<{ id: number }>(`${base}/${prepared!.id}/attachments`, form, {
          transformRequest: [(data, headers) => {
            headers.delete?.('Content-Type');
            delete headers['Content-Type'];
            delete headers['content-type'];
            return data;
          }],
        })).data.id);
      }
      await apiClient.post(base, { agentId: selection!.agentId, content, clientMessageId: requestId, attachmentIds, browser,
        ...(element ? { element } : {}) });
      setInput(''); removeQuote(); setFiles([]); setRequestId(createClientMessageId()); onClearElement?.(); await history.refetch();
    } catch (error) { message.error(error instanceof Error ? error.message : t('conversation.failed')); }
    finally { setSending(false); }
  };
  return <Space direction="vertical" style={{ width: '100%', padding: 16 }}>
    <QuotePill pill={pill} label={i18n.t('shared:quote.pill')} onAccept={acceptPill} />
    <details open={!selection?.agentId}><summary>{t('conversation.employee')}</summary>
      <SquadAgentSelector value={selection} onChange={setSelection} locked={sending || processing} />
    </details>
    <PrdBrowserSettings workitemId={workitemId} agentId={selection?.agentId} value={browser}
      onChange={value => { browserEdited.current = true; setBrowser(value); }} disabled={sending || processing} />
    {history.isError && <Alert type="error" closable message={t('conversation.failed')} action={<Button type="link" onClick={() => void history.refetch()}>{t('preview.retry')}</Button>} />}
    {feed.error && <Alert type="warning" closable message={t('conversation.progressFailed')} action={<Button type="link" onClick={() => void feed.reload()}>{t('preview.retry')}</Button>} />}
    <EventSyncStatus
      preparationStatus={feed.preparationStatus}
      syncing={feed.syncing}
      error={false}
      onRetry={() => void feed.reload()}
    />
    {feed.businessPaused && <Alert type="warning" message={t('conversation.businessTextPaused')} />}
    {previewFailed && <Alert type="warning" closable message={t('conversation.previewFailed')} />}
    <div ref={feedRef} style={{ height: '40vh', overflow: 'auto' }} onScroll={event => {
      const el = event.currentTarget;
      turnHistory.onScroll(el);
      followFeed.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {turnHistory.turns.map(turn => <div key={turn.id} data-turn-id={turn.id} data-quote-message style={{ marginBottom: 16 }}>
        <Tag data-quote-ignore>{isReply(turn) ? t('conversation.employee') : turnHistory.participants?.[String(turn.submittedUserId)] ?? t('conversation.participant', { id: turn.submittedUserId ?? '' })}</Tag>
        {isReply(turn) ? <>
          {turn.contentHasMore ? <AutoConversationTurnContent base={`${base}/${conversationId}`} conversationId={conversationId!} turn={turn} /> : <MarkdownView content={designData(turn.content)?.changeLog || (designData(turn.content) ? t('conversation.previewUpdated') : turn.content)} />}
        </> : <>
          {turnElement(turn) && <div data-quote-ignore><Tag color="blue">{t('conversation.selectedElement', { label: elementLabel(turnElement(turn)!) })}</Tag></div>}
          <AutoConversationTurnContent base={`${base}/${conversationId}`} conversationId={conversationId!} turn={turn} />
        </>}
        {!!turnHistory.attachments?.[String(turn.id)]?.length && (
          <div data-quote-ignore>
            {turnHistory.attachments![String(turn.id)].map(file => file.previewable
              ? <PrdScreenshot key={file.id} name={file.name} source={`${base}/${conversationId}/attachments/${file.id}/preview`} />
              : <Tag key={file.id}>{file.name}</Tag>)}
          </div>
        )}
        {turn.error && !isReply(turn) && <Alert type="error" closable message={turn.error} />}
      </div>)}
      {turnHistory.browsingHistory && <Button onClick={() => { turnHistory.returnLatest(); followFeed.current = true; requestAnimationFrame(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }); }}>{historyLatestLabel}</Button>}
      {(processing || sending) && <Space><Spin size="small" />{t('conversation.working')}</Space>}
      <ConversationEventView
        nodes={processing ? currentTimeline : currentTimeline.filter(node => node.kind !== 'text' || !!node.contentWindow)}
        isProcessing={processing}
        foldScope={`prd:${conversationId ?? 0}`}
      />
    </div>
    {element && <Space size={6} wrap>
      <Tag color="blue" closable={!sending} title={element.selector} onClose={() => onClearElement?.()}>
        {t('conversation.selectedElement', { label: elementLabel(element) })}
      </Tag>
      {element.page && <Tag>{element.page}</Tag>}
    </Space>}
    {quote && (
      <QuoteCard
        quote={quote}
        truncated={truncated}
        label={i18n.t('shared:quote.cardLabel')}
        removeLabel={i18n.t('shared:quote.remove')}
        truncatedLabel={i18n.t('shared:quote.truncated')}
        onRemove={removeQuote}
      />
    )}
    <Input.TextArea ref={inputRef} aria-label={t('conversation.title')} placeholder={t('conversation.inputHint')} value={input} rows={3} disabled={sending}
      onPaste={event => {
        const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
        if (images.length) { event.preventDefault(); setFiles(previous => [...previous, ...images]); }
      }}
      onChange={event => { setInput(event.target.value); setRequestId(createClientMessageId()); }} />
    {files.length > 0 && <Space wrap>{files.map((file, index) => <span key={index}><PrdScreenshot source={file} name={file.name} />
      <Tag closable={!sending} onClose={() => setFiles(previous => previous.filter((_, i) => i !== index))}>{file.name}</Tag></span>)}</Space>}
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <Upload accept="image/*" multiple beforeUpload={file => { setFiles(previous => [...previous, file]); return false; }} showUploadList={false}>
      <Tooltip title={t('conversation.screenshot')}><Button type="text" aria-label={t('conversation.screenshot')} icon={<PaperClipOutlined />} disabled={sending} /></Tooltip>
    </Upload>
    <Button type="primary" loading={sending} disabled={!selection?.agentId || !browserSelectionValid(browser) || (!input.trim() && !files.length && !quote)} onClick={() => void send()}>
      {t('conversation.send')}
    </Button>
    </div>
  </Space>;
}
