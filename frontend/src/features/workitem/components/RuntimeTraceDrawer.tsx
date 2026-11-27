import { DispatchDiagnostics } from './DispatchDiagnostics';
import { graphAgentName } from '../runtimeLabels';
import { CloseOutlined, CloseCircleFilled } from '@ant-design/icons';
import { i18n } from '@/shared/i18n';
import { formatDateTime, formatNumber } from '@/shared/i18n/format';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import { formatDuration } from '../duration';
import { runtimeStatusLabel } from '../runtimeLabels';
import { useTranslation } from 'react-i18next';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Drawer, Empty, Space, Spin, Tag, Typography } from 'antd';
import type {
  ProcessGraph, ProcessGraphNode, RuntimeTrace, RuntimeTraceBoundary, RuntimeTraceContextFile,
  RuntimeTraceEvent, RuntimeTraceObservation, RuntimeTraceSession, RuntimeTraceSpan, RuntimeTraceTurn,
} from '@/shared/types/workitem';
import { getRuntimeTrace, getRuntimeTraceContext, getRuntimeTraceObservation, getRuntimeTraceTurn } from '../api';
import { failureHistoryOf } from './failureHistory';
import { FailureHistoryPanel } from './FailureHistoryPanel';
import './RuntimeTraceDrawer.css';

const { Text } = Typography;
const TRACE_PAGE_SIZE = 100;
const ACTIVE_STATUSES = new Set(['RUNNING', 'ACKED', 'DISPATCHED', 'PAUSING']);
const FAILURE_EVENT_TYPES = new Set(['step.failed', 'session.failed']);
const FIRST_CAUSE_REASON = /^tool_hook_blocked\b/;
const SEP = ' · ';
const KIND_LABEL_KEYS = {
  PROVIDER: 'trace.kinds.model', LLM: 'trace.kinds.model', THINKING: 'trace.kinds.thinking',
  BASH: 'trace.kinds.command', CLI: 'trace.kinds.command', TOOL: 'trace.kinds.tool', MCP: 'trace.kinds.mcp',
  SKILL: 'trace.kinds.skill', WAIT: 'trace.kinds.wait', GUIDANCE: 'trace.kinds.guidance',
  ARTIFACT: 'trace.kinds.artifact', AGENT: 'trace.kinds.agent',
} as const;
type KindLabelKey = (typeof KIND_LABEL_KEYS)[keyof typeof KIND_LABEL_KEYS];
const ROLE_ORDER = ['CONTEXT', 'HARNESS'];

/**
 * Returns the first causal failure of a dispatch. A blocking tool hook is
 * always the cause of the symptoms recorded after it, so it wins regardless of
 * position; otherwise the earliest failure event is the one closest to the root
 * cause.
 */
export function dispatchFailureReason(events?: RuntimeTraceEvent[] | null): string | null {
  if (!events) return null;
  let earliest: string | null = null;
  for (const event of events) {
    if (!FAILURE_EVENT_TYPES.has(event.eventType)) continue;
    const reason = event.detail?.reason;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    const trimmed = reason.trim();
    if (FIRST_CAUSE_REASON.test(trimmed)) return trimmed;
    if (earliest === null) earliest = trimmed;
  }
  return earliest;
}

interface RuntimeTraceDrawerProps {
  node: ProcessGraphNode | null;
  processGraph: ProcessGraph;
  onClose: () => void;
}

export interface RuntimeTracePanelProps {
  dispatchId: number | null;
  status?: string;
  node?: ProcessGraphNode | null;
  processGraph?: ProcessGraph;
  visible?: boolean;
}

interface TurnStats {
  count: number;
  failed: number;
  kinds: Array<[string, number]>;
  model?: string;
}

type Selection =
  | { kind: 'session'; session: RuntimeTraceSession }
  | { kind: 'turn'; session: RuntimeTraceSession; turn: RuntimeTraceTurn; spansInTree?: boolean; stats?: TurnStats }
  | { kind: 'observation'; observation: RuntimeTraceObservation }
  | { kind: 'span'; span: RuntimeTraceSpan }
  | { kind: 'boundary'; boundary: RuntimeTraceBoundary };

function duration(ms?: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : formatDuration(ms);
}

function usage(value?: { available?: boolean; availability?: string | null; credits?: number | null } | null, prefix = ' · '): string {
  if (!value || value.available !== true) return '';
  const credit = value.credits != null && value.credits > 0 ? `💰${i18n.t('workitem:usage.creditAmount', { amount: value.credits.toFixed(2) })}` : '';
  return credit ? `${prefix}${credit}` : '';
}

function startedAt(value?: string | null): string | null {
  return value ? formatDateTime(value, { dateStyle: 'short', timeStyle: 'medium' }) : null;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${formatNumber(size)} B`;
  if (size < 1024 * 1024) return `${formatNumber(size / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(size / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function statusColor(status?: string | null): string {
  const value = status?.toUpperCase();
  if (value === 'COMPLETED' || value === 'SUCCEEDED') return 'success';
  if (value === 'FAILED' || value === 'CANCELLED') return 'error';
  if (value === 'INTERRUPTED' || value === 'PAUSED') return 'warning';
  return 'processing';
}

function isFailed(status?: string | null, error?: unknown): boolean {
  const value = status?.toUpperCase();
  return value === 'FAILED' || value === 'ERROR' || (error != null && error !== '');
}

function kindLabelKey(kind: string): KindLabelKey | undefined {
  return (KIND_LABEL_KEYS as Record<string, KindLabelKey>)[kind.toUpperCase()];
}

function useKindLabel() {
  const { t } = useTranslation('workitem');
  return (kind: string) => {
    const key = kindLabelKey(kind);
    return key ? t(key) : kind;
  };
}

function kindColor(kind: string, failed = false): string | undefined {
  if (failed) return 'error';
  const value = kind.toUpperCase();
  if (value === 'PROVIDER' || value === 'LLM') return 'purple';
  if (value === 'TOOL' || value === 'MCP' || value === 'SKILL' || value === 'AGENT') return 'blue';
  return undefined;
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0].trim();
}

function shortPath(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value;
}

function stepSummary(kind: string, input: unknown, content?: string | null, inputSummary?: string | null): string | undefined {
  if (kind.toUpperCase() === 'THINKING') return content?.trim() ? firstLine(content) : undefined;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.description === 'string' && record.description.trim()) return firstLine(record.description);
    for (const key of ['file_path', 'path']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return shortPath(value.trim());
    }
    return undefined;
  }
  if (input == null && inputSummary?.trim()) {
    const line = firstLine(inputSummary);
    return line.startsWith('/') && !line.includes(' ') ? shortPath(line) : line;
  }
  return undefined;
}

function flattenObservations(items: RuntimeTraceObservation[]): RuntimeTraceObservation[] {
  return items.flatMap((item) => [item, ...flattenObservations(item.children || [])]);
}

function turnStats(turn: RuntimeTraceTurn): TurnStats {
  const observations = flattenObservations(turn.observations || []);
  const steps = observations.length
    ? observations.map((item) => ({ kind: item.type, failed: isFailed(item.status, item.error), model: item.model }))
    : (turn.spans || []).map((span) => ({ kind: span.kind, failed: isFailed(span.status, span.errorCategory), model: span.model }));
  const kinds = new Map<string, [string, number]>();
  for (const step of steps) {
    const group = kindLabelKey(step.kind) ?? step.kind;
    const entry = kinds.get(group);
    if (entry) entry[1] += 1;
    else kinds.set(group, [step.kind, 1]);
  }
  return {
    count: steps.length,
    failed: steps.filter((step) => step.failed).length,
    kinds: [...kinds.values()].sort((a, b) => b[1] - a[1]),
    model: steps.find((step) => step.model)?.model ?? undefined,
  };
}

function turnKey(turn: RuntimeTraceTurn): string {
  return turn.traceId || turn.turnId;
}

function shortTurnId(turnId: string): string {
  return turnId.replace(/^.*:turn:/, '');
}

function Payload({ title, value, extra }: { title: string; value: unknown; extra?: ReactNode }) {
  if (value == null || value === '') return null;
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <section className="runtime-trace-section">
      <div className="runtime-trace-h">{title}{extra != null && <span className="runtime-trace-x">{extra}</span>}</div>
      <pre className="runtime-trace-pre">{content}</pre>
    </section>
  );
}

function TextPayload({ title, value }: { title: string; value?: string | null }) {
  const { t } = useTranslation('workitem');
  if (!value) return null;
  return <Payload title={title} value={value} extra={t('trace.charCount', { count: value.length, size: formatNumber(value.length) })} />;
}

function spanKey(span: RuntimeTraceSpan): string {
  return `p:${span.kind}:${span.spanId}`;
}

function selectionKey(selection: Selection): string {
  if (selection.kind === 'session') return `s:${selection.session.sessionId}`;
  if (selection.kind === 'turn') return `t:${turnKey(selection.turn)}`;
  if (selection.kind === 'observation') return `o:${selection.observation.observationId}`;
  if (selection.kind === 'span') return spanKey(selection.span);
  return `b:${selection.boundary.eventId ?? `${selection.boundary.kind}:${selection.boundary.eventTime || selection.boundary.time || ''}`}`;
}

function rowClass(base: string, selected: boolean): string {
  return selected ? `${base} is-selected` : base;
}

function Chevron({ open }: { open: boolean }) {
  return <AwStrokeIcon name={open ? 'chev-d' : 'chev-r'} size={12} />;
}

interface StepRowProps {
  kind: string;
  name?: string | null;
  status?: string | null;
  error?: unknown;
  summary?: string;
  durationMs?: number | null;
  nested: boolean;
  selected: boolean;
  onClick: () => void;
  children?: ReactNode;
}

function StepRow({ kind, name, status, error, summary, durationMs, nested, selected, onClick, children }: StepRowProps) {
  const kindLabel = useKindLabel();
  const label = name || kind;
  const failed = isFailed(status, error);
  const muted = kind.toUpperCase() === 'THINKING';
  return <div className={nested ? 'runtime-trace-obs-children' : undefined}>
    <button type="button" title={[label, summary].filter(Boolean).join(SEP)} className={rowClass(`runtime-trace-obs${failed ? ' is-error' : ''}${muted ? ' is-muted' : ''}`, selected)} onClick={onClick}>
      <Tag color={kindColor(kind, failed)}>{kindLabel(kind)}</Tag>
      <span className="runtime-trace-nm">{label}</span>
      {summary && <span className="runtime-trace-su">{summary}</span>}
      <span className="runtime-trace-dur">{duration(durationMs)}</span>
    </button>
    {children}
  </div>;
}

function ObservationTree({ items, selectedKey, onSelect }: { items: RuntimeTraceObservation[]; selectedKey: string | null; onSelect: (item: RuntimeTraceObservation) => void }) {
  return <>{items.map((item) => (
    <StepRow key={item.observationId} kind={item.type} name={item.name} status={item.status} error={item.error} summary={stepSummary(item.type, item.input)}
      durationMs={item.durationMs} nested={!!item.parentObservationId} selected={selectedKey === `o:${item.observationId}`} onClick={() => onSelect(item)}>
      <ObservationTree items={item.children || []} selectedKey={selectedKey} onSelect={onSelect} />
    </StepRow>
  ))}</>;
}

function SpanTree({ spans, parentId, selectedKey, onSelect }: { spans: RuntimeTraceSpan[]; parentId: string | null; selectedKey: string | null; onSelect: (span: RuntimeTraceSpan) => void }) {
  const ids = new Set(spans.map((span) => span.spanId));
  const items = spans.filter((span) => (parentId == null
    ? !span.parentSpanId || span.parentSpanId === span.spanId || !ids.has(span.parentSpanId)
    : span.parentSpanId === parentId && span.spanId !== parentId));
  return <>{items.map((span) => (
    <StepRow key={spanKey(span)} kind={span.kind} name={span.name} status={span.status} error={span.errorCategory}
      summary={stepSummary(span.kind, span.input, span.content, span.inputSummary)} durationMs={span.durationMs}
      nested={parentId != null} selected={selectedKey === spanKey(span)} onClick={() => onSelect(span)}>
      <SpanTree spans={spans} parentId={span.spanId} selectedKey={selectedKey} onSelect={onSelect} />
    </StepRow>
  ))}</>;
}

interface TurnCardProps {
  session: RuntimeTraceSession;
  turn: RuntimeTraceTurn;
  stats: TurnStats;
  open: boolean;
  selectedKey: string | null;
  onToggle: () => void;
  onSelect: (selection: Selection) => void;
}

function TurnCard({ session, turn, stats, open, selectedKey, onToggle, onSelect }: TurnCardProps) {
  const { t } = useTranslation('workitem');
  const bodyId = useId();
  const key = turnKey(turn);
  const id = shortTurnId(turn.turnId);
  const observations = turn.observations || [];
  const spansInTree = !observations.length && !!turn.spans?.length;
  const status = turn.status?.toUpperCase() || '';
  const dot = stats.failed || status === 'FAILED' ? ' is-error'
    : ACTIVE_STATUSES.has(status) ? ' is-run'
      : status === 'INTERRUPTED' || status === 'PAUSED' ? ' is-warn' : '';
  return <div className={rowClass('runtime-trace-tc', selectedKey === `t:${key}`)}>
    <div className="runtime-trace-th">
      {stats.count
        ? <button type="button" className="runtime-trace-tchev" aria-expanded={open} aria-controls={open ? bodyId : undefined} aria-label={t('trace.turnSteps', { id, count: stats.count })} onClick={onToggle}><Chevron open={open} /></button>
        : <span className="runtime-trace-tchev" aria-hidden="true" />}
      <button type="button" title={turn.stepName || undefined} className="runtime-trace-turn" onClick={() => onSelect({ kind: 'turn', session, turn, spansInTree, stats })}>
        <span className="runtime-trace-tr1">
          <span className={`runtime-trace-dot${dot}`} aria-hidden="true" />
          <b>{t('trace.turn', { id })}</b>
          <span className="runtime-trace-dur">{duration(turn.durationMs)}</span>
        </span>
        {(turn.stepName || stats.count > 0) && <span className="runtime-trace-tr2">
          {turn.stepName && <span className="runtime-trace-sub">{turn.stepName}</span>}
          {stats.failed > 0 && <span className="runtime-trace-fail">{t('trace.failCount', { count: stats.failed })}</span>}
          {stats.count > 0 && <span className="runtime-trace-steps">{t('trace.stepCount', { count: stats.count })}</span>}
        </span>}
      </button>
    </div>
    {open && stats.count > 0 && <div id={bodyId} className="runtime-trace-tb">
      {spansInTree
        ? <SpanTree spans={turn.spans || []} parentId={null} selectedKey={selectedKey} onSelect={(span) => onSelect({ kind: 'span', span })} />
        : <ObservationTree items={observations} selectedKey={selectedKey} onSelect={(observation) => onSelect({ kind: 'observation', observation })} />}
    </div>}
  </div>;
}

interface TraceTimelineProps {
  trace: RuntimeTrace;
  selectedKey: string | null;
  onSelect: (selection: Selection) => void;
  onLoadEarlier: () => void;
  onBackToLatest: () => void;
  loadingEarlier: boolean;
  browsingEarlier: boolean;
}

function TraceTimeline({ trace, selectedKey, onSelect, onLoadEarlier, onBackToLatest, loadingEarlier, browsingEarlier }: TraceTimelineProps) {
  const { t } = useTranslation('workitem');
  const runtimeEvents = (trace.events || []).filter((event) => !event.detail?.sessionId);
  const [runtimeOpen, setRuntimeOpen] = useState<boolean | null>(null);
  const [openTurns, setOpenTurns] = useState<Record<string, boolean>>({});
  const stats = useMemo(() => new Map(trace.sessions.flatMap((session) => session.turns.map((turn) => [turnKey(turn), turnStats(turn)] as const))), [trace]);
  const isOpen = (key: string) => openTurns[key] ?? false;
  const groupOpen = runtimeOpen ?? (runtimeEvents.some((event) => FAILURE_EVENT_TYPES.has(event.eventType)) || !trace.sessions.length);
  return <div className="runtime-trace-tl">
    {(trace.nextBeforeId != null || browsingEarlier) && <Space style={{ marginBottom: 12 }}>
      {trace.nextBeforeId != null && <Button size="small" loading={loadingEarlier} onClick={onLoadEarlier}>{t('trace.loadEarlier')}</Button>}
      {browsingEarlier && <Button size="small" onClick={onBackToLatest}>{t('trace.backToLatest')}</Button>}
    </Space>}
    {!!runtimeEvents.length && <div>
      <button type="button" className="runtime-trace-grp" aria-expanded={groupOpen} onClick={() => setRuntimeOpen(!groupOpen)}>
        <Chevron open={groupOpen} />
        <span>{t('trace.runtime')}</span>
        <span className="runtime-trace-cnt">{runtimeEvents.length}</span>
      </button>
      {groupOpen && runtimeEvents.map((event, index) => {
        const failureReason = FAILURE_EVENT_TYPES.has(event.eventType) && typeof event.detail?.reason === 'string' ? event.detail.reason : null;
        const boundary: RuntimeTraceBoundary = { eventId: event.eventId, kind: event.eventType, label: event.eventType, eventTime: event.eventTime, detail: event.detail };
        return <button key={event.eventId || index} type="button" className={rowClass('runtime-trace-ev', selectedKey === selectionKey({ kind: 'boundary', boundary }))} onClick={() => onSelect({ kind: 'boundary', boundary })}>
          <code>{event.eventType}</code>
          {failureReason && <span className="runtime-trace-ev-reason">{failureReason}</span>}
        </button>;
      })}
    </div>}
    {trace.sessions.map((session) => {
      const rows = [
        ...(session.boundaries || []).map((boundary, index) => ({ kind: 'boundary' as const, time: boundary.eventTime || boundary.time || '', key: boundary.eventId || `b:${index}`, boundary })),
        ...(session.turns || []).map((turn) => ({ kind: 'turn' as const, time: turn.startedAt || '', key: turnKey(turn), turn })),
      ].sort((a, b) => a.time.localeCompare(b.time));
      return (
        <div key={session.sessionId} className="runtime-trace-sgrp">
          <button type="button" className={rowClass('runtime-trace-sess', selectedKey === `s:${session.sessionId}`)} onClick={() => onSelect({ kind: 'session', session })}>
            <span className="runtime-trace-sess-r1">
              <span>{t('trace.session')}</span>
              <span className="runtime-trace-sess-id" title={session.sessionId}>{session.sessionId}</span>
              {session.parentSessionId && <Tag color="blue">{t('trace.fork')}</Tag>}
              <Tag color={statusColor(session.status)}>{runtimeStatusLabel(session.status || 'RUNNING')}</Tag>
            </span>
            <span className="runtime-trace-sess-r2">{session.provider || trace.provider || t('trace.provider')}{SEP}{duration(session.durationMs)}{SEP}{t('trace.turnCount', { count: session.turns.length })}{usage(session.tokenUsage)}</span>
          </button>
          {!!rows.length && <div className="runtime-trace-kids">
            {rows.map((row) => row.kind === 'boundary' ? (
              <button key={row.key} type="button" className={rowClass('runtime-trace-bound', selectedKey === selectionKey({ kind: 'boundary', boundary: row.boundary }))} onClick={() => onSelect({ kind: 'boundary', boundary: row.boundary })}>
                ◆ {row.boundary.label || row.boundary.kind || row.boundary.type}
              </button>
            ) : (
              <TurnCard key={row.key} session={session} turn={row.turn} stats={stats.get(row.key) ?? turnStats(row.turn)} open={isOpen(row.key)} selectedKey={selectedKey}
                onToggle={() => setOpenTurns((prev) => ({ ...prev, [row.key]: !isOpen(row.key) }))}
                onSelect={(next) => {
                  if (next.kind === 'turn') setOpenTurns((prev) => ({ ...prev, [row.key]: true }));
                  onSelect(next);
                }} />
            ))}
          </div>}
        </div>
      );
    })}
  </div>;
}

function SpanDetails({ spans }: { spans: RuntimeTraceSpan[] }) {
  const { t } = useTranslation('workitem');
  const kindLabel = useKindLabel();
  if (!spans.length) return null;
  return <section className="runtime-trace-section"><div className="runtime-trace-h">{t('trace.observations')}</div>{spans.map((span) => (
    <div key={`${span.kind}:${span.spanId}`} className="runtime-trace-span">
      <div className="runtime-trace-span-head"><Tag color={kindColor(span.kind)}>{kindLabel(span.kind)}</Tag><strong>{span.name || span.kind}</strong><span className="runtime-trace-dur">{duration(span.durationMs)}{usage(span.tokenUsage)}</span></div>
      <Payload title={t('trace.input')} value={span.input ?? span.inputSummary} />
      <Payload title={t('trace.output')} value={span.output ?? span.content ?? span.outputSummary} />
    </div>
  ))}</section>;
}

function Meta({ items }: { items: Array<[string, ReactNode] | null | false | undefined> }) {
  const visible = items.filter((item): item is [string, ReactNode] => !!item && item[1] != null && item[1] !== '');
  if (!visible.length) return null;
  return <div className="runtime-trace-dmeta">{visible.map(([label, value]) => <span key={label}>{label} <b>{value}</b></span>)}</div>;
}

function DetailHead({ title, status, kind, failed, hideStatus }: { title: string; status?: string | null; kind?: string; failed?: boolean; hideStatus?: boolean }) {
  const { t } = useTranslation('workitem');
  const kindLabel = useKindLabel();
  return <div className="runtime-trace-dh">
    {kind && <Tag color={kindColor(kind, failed)}>{kindLabel(kind)}</Tag>}
    <span className="runtime-trace-dt">{title}</span>
    {failed ? <Tag color="error">{t('trace.failed')}</Tag>
      : status && !hideStatus && <Tag color={statusColor(status)}>{runtimeStatusLabel(status)}</Tag>}
  </div>;
}

function ContextFiles({ files, onContext }: { files: RuntimeTraceContextFile[]; onContext: (file: RuntimeTraceContextFile) => void }) {
  const { t } = useTranslation('workitem');
  const roles = [...new Set(files.map((file) => file.role))].sort((a, b) => {
    const rank = (role: string) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);
    return rank(a) - rank(b);
  });
  const roleLabel = (role: string) => (role === 'CONTEXT' ? t('trace.roleContext') : role === 'HARNESS' ? t('trace.roleHarness') : role);
  return <section className="runtime-trace-section">
    <div className="runtime-trace-h">{t('trace.context')}<span className="runtime-trace-x">{t('trace.fileCount', { count: files.length })}</span></div>
    <div className="runtime-trace-files">
      {roles.map((role) => {
        const group = files.filter((file) => file.role === role);
        return <div key={role}>
          <div className="runtime-trace-fg">{roleLabel(role)}<span className="runtime-trace-x">{formatNumber(group.length)}</span></div>
          {group.map((file) => <button key={file.contentRef} type="button" className="runtime-trace-file" title={file.name} onClick={() => onContext(file)}>
            <span className="runtime-trace-file-nm">{file.name}</span>
            {file.sizeBytes != null && <span className="runtime-trace-file-sz">{formatFileSize(file.sizeBytes)}</span>}
            <span className="runtime-trace-file-act">{file.previewable ? t('trace.preview') : t('artifacts.download')}</span>
          </button>)}
        </div>;
      })}
    </div>
  </section>;
}

function DetailPanel({ dispatchId, selection, loading, onContext }: { dispatchId: number; selection: Selection | null; loading: boolean; onContext: (file: RuntimeTraceContextFile) => void }) {
  const { t } = useTranslation('workitem');
  const kindLabel = useKindLabel();
  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>;
  if (!selection) return <Empty description={t('trace.choose')} />;
  if (selection.kind === 'session') {
    const session = selection.session;
    const rows: Array<[string, ReactNode, boolean?]> = [
      [t('trace.sessionId'), session.sessionId, true],
      [t('trace.lineage'), session.parentSessionId, true],
      [t('trace.provider'), session.provider],
      [t('trace.duration'), session.durationMs != null ? duration(session.durationMs) : null],
      [t('trace.started'), startedAt(session.startedAt)],
      [t('trace.turns'), formatNumber(session.turns.length)],
      [t('trace.usage'), usage(session.tokenUsage, '')],
    ];
    return <div>
      <DetailHead title={t('trace.session')} status={session.status} />
      <dl className="runtime-trace-kv">{rows.filter(([, value]) => value != null && value !== '').map(([label, value, mono]) => <div key={label}>
        <dt>{label}</dt><dd className={mono ? 'is-mono' : undefined}>{value}</dd>
      </div>)}</dl>
    </div>;
  }
  if (selection.kind === 'boundary') return <div>
    <DetailHead title={selection.boundary.label || selection.boundary.kind || selection.boundary.type || ''} />
    <Meta items={[[t('trace.time'), selection.boundary.eventTime || selection.boundary.time]]} />
    <Payload title={t('trace.detail')} value={selection.boundary.detail} />
  </div>;
  if (selection.kind === 'observation') {
    const observation = selection.observation;
    return <div>
      <DetailHead kind={observation.type} title={observation.name || observation.type} status={observation.status} failed={isFailed(observation.status, observation.error)} />
      <Meta items={[[t('trace.duration'), duration(observation.durationMs)], [t('trace.started'), startedAt(observation.startedAt)], [t('trace.model'), observation.model], [t('trace.usage'), usage(observation.usage, '')]]} />
      <Payload title={t('trace.input')} value={observation.input} />
      <Payload title={t('trace.output')} value={observation.output} />
      <Payload title={t('trace.error')} value={observation.error} />
    </div>;
  }
  if (selection.kind === 'span') {
    const span = selection.span;
    return <div>
      <DetailHead kind={span.kind} title={span.name || span.kind} status={span.status} failed={isFailed(span.status, span.errorCategory)} hideStatus={span.kind.toUpperCase() === 'THINKING'} />
      <Meta items={[[t('trace.duration'), duration(span.durationMs)], [t('trace.started'), startedAt(span.startedAt)], [t('trace.model'), span.model], [t('trace.usage'), usage(span.tokenUsage, '')]]} />
      <Payload title={t('trace.input')} value={span.input ?? span.inputSummary} />
      <Payload title={t('trace.output')} value={span.output ?? span.content ?? span.outputSummary} />
      <Payload title={t('trace.error')} value={span.errorCategory} />
    </div>;
  }
  const turn = selection.turn;
  const stats = selection.stats;
  return <div>
    <DetailHead title={[t('trace.turn', { id: shortTurnId(turn.turnId) }), turn.stepName].filter(Boolean).join(SEP)} status={turn.status} />
    <div className="runtime-trace-dmeta">
      <span>{t('trace.duration')} <b>{duration(turn.durationMs)}</b></span>
      {startedAt(turn.startedAt) && <span>{t('trace.started')} <b>{startedAt(turn.startedAt)}</b></span>}
      {!!stats?.count && <span>{t('trace.steps')} <b>{formatNumber(stats.count)}</b></span>}
      {stats?.model && <span>{t('trace.model')} <b>{stats.model}</b></span>}
      <span>{t(turn.providerCoverage === 'PARTIAL' ? 'trace.partialCoverage' : 'trace.fullCoverage')}</span>
      {usage(turn.usage || turn.tokenUsage, '') && <span><b>{usage(turn.usage || turn.tokenUsage, '')}</b></span>}
    </div>
    {!!stats?.kinds.length && <div className="runtime-trace-kinds">
      {stats.kinds.map(([kind, count]) => <Tag key={kind} color={kindColor(kind)}>{kindLabel(kind)} {formatNumber(count)}</Tag>)}
      {stats.failed > 0 && <Tag color="error">{t('trace.failed')} {formatNumber(stats.failed)}</Tag>}
    </div>}
    <TextPayload title={t('trace.systemPrompt')} value={turn.systemPrompt} />
    <TextPayload title={t('trace.userPrompt')} value={turn.prompt} />
    {!!turn.contextFiles?.length && <ContextFiles files={turn.contextFiles} onContext={onContext} />}
    <TextPayload title={t('trace.agentOutput')} value={turn.output} />
    {!selection.spansInTree && <SpanDetails spans={turn.spans || []} />}
    <Text type="secondary" style={{ display: 'none' }}>{dispatchId}</Text>
  </div>;
}

export function RuntimeTracePanel({ dispatchId, status, node, processGraph, visible = true }: RuntimeTracePanelProps) {
  const { t } = useTranslation('workitem');
  const [trace, setTrace] = useState<RuntimeTrace | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message?: string; fallback: 'trace.loadFailed' | 'trace.detailFailed' } | null>(null);
  const [contextPreview, setContextPreview] = useState<{ name: string; size?: number | null; content: string } | null>(null);
  const [contextDownload, setContextDownload] = useState<{
    file: RuntimeTraceContextFile;
    bytes: ArrayBuffer;
    isCurrent: () => boolean;
  } | null>(null);
  const [browsingEarlier, setBrowsingEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const lastSeq = useRef<number | null>(null);
  const traceEpoch = useRef(0);
  const detailPane = useRef<HTMLDivElement | null>(null);
  const selectionGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const active = ACTIVE_STATUSES.has(status?.toUpperCase() || '');
  const nodeKey = node?.key;
  const lifecycle = useRef({ dispatchId, nodeKey, active, visible, valid: true });
  // Invalidate synchronously so a late response cannot update or download after a switch.
  if (lifecycle.current.dispatchId !== dispatchId || lifecycle.current.nodeKey !== nodeKey
    || lifecycle.current.active !== active || lifecycle.current.visible !== visible) {
    lifecycle.current.valid = false;
    lifecycle.current = { dispatchId, nodeKey, active, visible, valid: true };
    selectionGeneration.current += 1;
    contextGeneration.current += 1;
    traceEpoch.current += 1;
    lastSeq.current = null;
    setTrace(null); setSelection(null); setPendingKey(null); setDetailLoading(false); setError(null); setContextPreview(null);
    setContextDownload(null); setBrowsingEarlier(false); setLoadingEarlier(false);
    setLoading(visible && dispatchId != null);
  }
  const scope = lifecycle.current;
  const isCurrent = () => scope.valid && lifecycle.current === scope && scope.visible && scope.dispatchId != null;
  useLayoutEffect(() => {
    scope.valid = true;
    return () => { scope.valid = false; };
  }, [scope]);

  const failureReason = useMemo(
    () => (status?.toUpperCase() === 'FAILED' ? dispatchFailureReason(trace?.events) : null),
    [status, trace],
  );
  const failureHistory = useMemo(() => failureHistoryOf(trace?.events), [trace]);

  useEffect(() => {
    if (!visible || dispatchId == null || browsingEarlier) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const current = () => !cancelled && scope.valid && lifecycle.current === scope;
    setLoading(true);
    const load = async () => {
      if (!current()) return;
      const epoch = traceEpoch.current;
      try {
        const next = await getRuntimeTrace(dispatchId, lastSeq.current, { limit: TRACE_PAGE_SIZE });
        if (!current() || epoch !== traceEpoch.current) return;
        if (next.changed || lastSeq.current == null) {
          setTrace(next);
          setSelection((selection) => selection || (next.sessions[0] ? { kind: 'session', session: next.sessions[0] } : null));
        }
        lastSeq.current = next.lastSeq ?? lastSeq.current;
      } catch (reason) {
        if (current()) setError({ message: reason instanceof Error ? reason.message : undefined, fallback: 'trace.loadFailed' });
      } finally {
        if (current()) {
          setLoading(false);
          // Schedule only after completion, so slow requests never overlap.
          if (active) timer = window.setTimeout(() => void load(), 2000);
        }
      }
    };
    void load();
    return () => { cancelled = true; if (timer != null) window.clearTimeout(timer); };
  }, [active, dispatchId, visible, scope, browsingEarlier]);

  const loadEarlier = async () => {
    if (dispatchId == null || trace?.nextBeforeId == null) return;
    const beforeId = trace.nextBeforeId;
    const epoch = ++traceEpoch.current;
    setLoadingEarlier(true);
    try {
      const older = await getRuntimeTrace(dispatchId, null, { limit: TRACE_PAGE_SIZE, beforeId });
      if (epoch !== traceEpoch.current || !scope.valid) return;
      // 成功后再次递增，作废本轮在途的轮询响应，避免旧窗口覆盖刚追加的页。
      traceEpoch.current += 1;
      setBrowsingEarlier(true);
      setTrace((previous) => previous == null ? older : {
        ...previous,
        events: [...(older.events || []), ...(previous.events || [])],
        nextBeforeId: older.nextBeforeId ?? null,
      });
    } catch (reason) {
      if (epoch !== traceEpoch.current) return;
      setError({ message: reason instanceof Error ? reason.message : undefined, fallback: 'trace.loadFailed' });
    } finally { setLoadingEarlier(false); }
  };

  const backToLatest = () => {
    traceEpoch.current += 1;
    lastSeq.current = null;
    setBrowsingEarlier(false);
  };

  const continuity = useMemo(() => {
    if (!node || !processGraph) return { previous: null, next: null };
    return {
      previous: processGraph.edges.find((edge) => edge.type === 'CONTINUE' && edge.targetKey === node.key)?.sourceDispatchId ?? null,
      next: processGraph.edges.find((edge) => edge.type === 'CONTINUE' && edge.sourceKey === node.key)?.targetDispatchId ?? null,
    };
  }, [node, processGraph]);

  // The detail pane scrolls on its own, so a new target must start at its own top.
  useEffect(() => {
    const pane = detailPane.current;
    if (pane) pane.scrollTop = 0;
  }, [selection, contextPreview]);

  // Download side effects wait for the scope and selection changes in the same render batch.
  useEffect(() => {
    if (!contextDownload) return;
    setContextDownload(pending => pending === contextDownload ? null : pending);
    const { file, bytes, isCurrent } = contextDownload;
    if (!isCurrent()) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: file.mediaType || 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
    } catch (reason) {
      setError({ message: reason instanceof Error ? reason.message : undefined, fallback: 'trace.detailFailed' });
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }, [contextDownload]);

  const select = async (next: Selection) => {
    const generation = ++selectionGeneration.current;
    contextGeneration.current += 1;
    setContextPreview(null); setError(null); setSelection(null); setPendingKey(selectionKey(next)); setDetailLoading(false);
    if (!isCurrent() || dispatchId == null) return;
    if (trace?.source !== 'OSS' || next.kind === 'session' || next.kind === 'boundary' || next.kind === 'span') { setSelection(next); return; }
    const current = () => isCurrent() && selectionGeneration.current === generation;
    setDetailLoading(true);
    try {
      if (next.kind === 'turn') {
        const detail = await getRuntimeTraceTurn(dispatchId, next.turn.traceId || next.turn.turnId);
        if (current()) setSelection({ ...next, turn: detail });
      } else {
        const observation = await getRuntimeTraceObservation(dispatchId, next.observation.observationId);
        if (current()) setSelection({ kind: 'observation', observation });
      }
    } catch (reason) {
      if (current()) setError({ message: reason instanceof Error ? reason.message : undefined, fallback: 'trace.detailFailed' });
    } finally { if (current()) setDetailLoading(false); }
  };

  const openContext = async (file: RuntimeTraceContextFile) => {
    const generation = ++contextGeneration.current;
    const selected = selectionGeneration.current;
    if (!isCurrent() || dispatchId == null) return;
    const current = () => isCurrent() && contextGeneration.current === generation && selectionGeneration.current === selected;
    setContextPreview(null); setError(null);
    try {
      const bytes = await getRuntimeTraceContext(dispatchId, file.contentRef);
      if (!current()) return;
      if (!file.previewable) {
        setContextDownload({ file, bytes, isCurrent: current });
        return;
      }
      setContextPreview({ name: file.name, size: file.sizeBytes, content: new TextDecoder().decode(bytes) });
    } catch (reason) {
      if (current()) setError({ message: reason instanceof Error ? reason.message : undefined, fallback: 'trace.detailFailed' });
    }
  };

  if (!visible) return null;
  return <div data-testid="runtime-trace-drawer" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {dispatchId != null && <div data-testid="runtime-trace-dispatch-summary" className="runtime-trace-summary" style={{ flexShrink: 0 }}>
        <Text strong>Dispatch #{dispatchId}</Text>{status && <Tag color={statusColor(status)}>{runtimeStatusLabel(status)}</Tag>}
        {continuity.previous != null && <Text type="secondary">{t('trace.previous', { id: continuity.previous })}</Text>}
        {continuity.next != null && <Text type="secondary">{t('trace.next', { id: continuity.next })}</Text>}
        {trace && <span className="runtime-trace-summary-meta">{trace.source || 'LIVE'}{SEP}{trace.provider || t('trace.provider')} · {t('trace.turnCount', { count: trace.sessions.reduce((sum, item) => sum + item.turns.length, 0) })}{usage(trace.tokenUsage)}</span>}
      </div>}
      {dispatchId != null && <DispatchDiagnostics key={dispatchId} dispatchId={dispatchId} />}
      {failureReason && <Alert data-testid="dispatch-failure-reason" style={{ marginTop: 12, flexShrink: 0 }} type="error" showIcon icon={<CloseCircleFilled aria-hidden="true" />} message={t('trace.failure')} description={failureReason} />}
      {failureHistory && <div style={{ marginTop: 12, flexShrink: 0, maxHeight: '40%', overflow: 'auto' }}>
        <FailureHistoryPanel history={failureHistory} testId="dispatch-failure-history" />
      </div>}
      {error && <Alert closable={{ 'aria-label': t('projection.close'), closeIcon: <CloseOutlined aria-hidden="true" /> }} onClose={() => setError(null)} style={{ marginTop: 12, flexShrink: 0 }} type="error" showIcon icon={<CloseCircleFilled aria-hidden="true" />} message={error.message ?? t(error.fallback)} />}
      {loading && !trace ? <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div> : trace && (
        <div data-testid="runtime-trace-panes" className="runtime-trace-panes" style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 30%) 1fr', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div data-testid="runtime-trace-timeline-pane" className="runtime-trace-time" style={{ overflow: 'auto' }}>
            <TraceTimeline
              trace={trace}
              selectedKey={pendingKey ?? (selection ? selectionKey(selection) : null)}
              onSelect={(next) => void select(next)}
              onLoadEarlier={() => void loadEarlier()}
              onBackToLatest={backToLatest}
              loadingEarlier={loadingEarlier}
              browsingEarlier={browsingEarlier}
            />
            {!trace.sessions.length && <Empty description={t('trace.empty')} />}
          </div>
          <div data-testid="runtime-trace-detail-pane" className="runtime-trace-detail" ref={detailPane} style={{ overflow: 'auto' }}>
            {contextPreview ? <div>
              <div className="runtime-trace-ph">
                <Button className="runtime-trace-back" onClick={() => setContextPreview(null)}>{t('trace.back')}</Button>
                <span className="runtime-trace-ph-nm" title={contextPreview.name}>{contextPreview.name}</span>
                {contextPreview.size != null && <span className="runtime-trace-x">{formatFileSize(contextPreview.size)}</span>}
              </div>
              <pre className="runtime-trace-pre is-full">{contextPreview.content}</pre>
            </div>
              : <DetailPanel dispatchId={dispatchId ?? 0} selection={selection} loading={detailLoading} onContext={(file) => void openContext(file)} />}
          </div>
        </div>
      )}
    </div>;
}

export function RuntimeTraceDrawer({ node, processGraph, onClose }: RuntimeTraceDrawerProps) {
  const { t } = useTranslation('workitem');
  return <Drawer closeIcon={<CloseOutlined aria-hidden="true" />} closable={{ 'aria-label': t('projection.close') }} open={node != null} onClose={onClose} width={1100} title={node ? t('trace.drawerTitle', { name: graphAgentName(node), step: node.stepName || t('trace.title') }) : t('trace.title')} destroyOnClose
    styles={{ body: { display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 } }}>
    <RuntimeTracePanel dispatchId={node?.dispatchId ?? null} status={node?.status ?? undefined} node={node} processGraph={processGraph} visible={node != null} />
  </Drawer>;
}
