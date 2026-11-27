import { Fragment, useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAgentPendingReviewCount } from '@/features/agent/hooks';
import { useScheduledTaskCapability } from '@/features/scheduledTask/hooks';
import { isScheduledTaskCapabilityQueryReady } from '@/features/scheduledTask/ScheduledTaskCapabilityGate';
import { isSettingsRoute } from '@/features/settings/settingsRoutes';
import { AwStrokeIcon } from '@/shared/ui/AwStrokeIcon';
import './Sidebar.css';

export type NavLabelKey =
  | 'nav.delivery'
  | 'nav.agentsGroup'
  | 'nav.knowledge'
  | 'nav.insightsGroup'
  | 'nav.workbench'
  | 'nav.workitems'
  | 'nav.scheduledTasks'
  | 'nav.executions'
  | 'nav.recycled'
  | 'nav.squads'
  | 'nav.sdlc'
  | 'nav.executors'
  | 'nav.repos'
  | 'nav.memories'
  | 'nav.skills'
  | 'nav.insights'
  | 'nav.settingsHub'
  | 'nav.settings'
  | 'nav.groupDeliveryConfig'
  | 'nav.groupWorkspace'
  | 'nav.groupCompliance'
  | 'nav.statusTemplates'
  | 'nav.environment'
  | 'nav.integrations'
  | 'nav.members'
  | 'nav.backups'
  | 'nav.audit'
  | 'nav.about';

export interface NavEntry {
  key: string;
  labelKey: NavLabelKey;
  icon: string;
  aliases?: string[];
  /** 面板分组标题；同组连续项只渲染一次标题，未设置的面板保持扁平列表。 */
  groupLabelKey?: NavLabelKey;
  /** 定时任务相关页面随空间能力门控，未就绪时不显示。 */
  requiresScheduledTasks?: boolean;
}

export type NavSpaceKey = 'delivery' | 'insights' | 'settings';

export interface NavSpace {
  key: NavSpaceKey;
  labelKey: NavLabelKey;
  icon: string;
  items: NavEntry[];
}

const AGENTS_ITEM_KEY = '/agents';

/** 34j：轨道只留交付 / 洞察两个内容空间，分组标题与页面项直接在轨道上；两者都没有面板。 */
export const NAV_SPACES: NavSpace[] = [
  {
    key: 'delivery',
    labelKey: 'nav.delivery',
    icon: 'file',
    items: [
      { key: '/workbench', labelKey: 'nav.workbench', icon: 'dash' },
      { key: '/workitems', labelKey: 'nav.workitems', icon: 'file' },
      { key: '/scheduled-tasks', labelKey: 'nav.scheduledTasks', icon: 'clock', aliases: ['/scheduled-task-runs'], requiresScheduledTasks: true },
      { key: '/executions', labelKey: 'nav.executions', icon: 'history' },
      { key: '/workitems/recycled', labelKey: 'nav.recycled', icon: 'trash' },
    ],
  },
  {
    key: 'insights',
    labelKey: 'nav.insightsGroup',
    icon: 'chart',
    items: [
      { key: '/insights', labelKey: 'nav.insights', icon: 'chart' },
    ],
  },
];

/** 设置是唯一带面板的空间：数字员工与知识作为分组并入，其余为原设置中心页面。 */
export const SETTINGS_SPACE: NavSpace = {
  key: 'settings',
  labelKey: 'nav.settingsHub',
  icon: 'gear',
  items: [
    { key: '/agents', labelKey: 'nav.agentsGroup', icon: 'robot', groupLabelKey: 'nav.agentsGroup' },
    { key: '/squads', labelKey: 'nav.squads', icon: 'team', groupLabelKey: 'nav.agentsGroup' },
    { key: '/sdlcs', labelKey: 'nav.sdlc', icon: 'node', groupLabelKey: 'nav.agentsGroup' },
    { key: '/executors', labelKey: 'nav.executors', icon: 'zap', groupLabelKey: 'nav.agentsGroup' },
    { key: '/repos', labelKey: 'nav.repos', icon: 'branch', groupLabelKey: 'nav.knowledge' },
    { key: '/memories', labelKey: 'nav.memories', icon: 'book', groupLabelKey: 'nav.knowledge' },
    { key: '/skills', labelKey: 'nav.skills', icon: 'bulb', groupLabelKey: 'nav.knowledge' },
    { key: '/status-templates', labelKey: 'nav.statusTemplates', icon: 'node', groupLabelKey: 'nav.groupDeliveryConfig' },
    { key: '/settings/environment-variables', labelKey: 'nav.environment', icon: 'key', groupLabelKey: 'nav.groupDeliveryConfig' },
    { key: '/integrations', labelKey: 'nav.integrations', icon: 'api', groupLabelKey: 'nav.groupDeliveryConfig' },
    { key: '/settings/members', labelKey: 'nav.members', icon: 'team', groupLabelKey: 'nav.groupWorkspace' },
    { key: '/settings/backups', labelKey: 'nav.backups', icon: 'backup', groupLabelKey: 'nav.groupWorkspace' },
    { key: '/settings', labelKey: 'nav.settings', icon: 'gear', groupLabelKey: 'nav.groupWorkspace' },
    { key: '/audit-logs', labelKey: 'nav.audit', icon: 'audit', groupLabelKey: 'nav.groupCompliance' },
  ],
};

export const ABOUT_NAV_ITEM: NavEntry = { key: '/about', labelKey: 'nav.about', icon: 'compass' };

const ALL_NAV_ITEMS: NavEntry[] = [...NAV_SPACES.flatMap((space) => space.items), ...SETTINGS_SPACE.items, ABOUT_NAV_ITEM];

export function navItemMatchesPath(item: NavEntry, pathname: string) {
  return [item.key, ...(item.aliases ?? [])].some((key) => pathname === key || pathname.startsWith(`${key}/`));
}

export function visibleSpaceItems(space: NavSpace, scheduledTaskAvailable = false): NavEntry[] {
  return space.items.filter((item) => !item.requiresScheduledTasks || scheduledTaskAvailable);
}

export function resolveSelectedSpaceKey(pathname: string): NavSpaceKey | null {
  if (isSettingsRoute(pathname)) {
    return 'settings';
  }
  if (SETTINGS_SPACE.items.some((item) => navItemMatchesPath(item, pathname))) {
    return 'settings';
  }
  return NAV_SPACES.find((space) => space.items.some((item) => navItemMatchesPath(item, pathname)))?.key ?? null;
}

export function resolveSelectedNavKey(pathname: string) {
  return ALL_NAV_ITEMS
    .filter((item) => navItemMatchesPath(item, pathname))
    .sort((a, b) => b.key.length - a.key.length)[0]?.key ?? '';
}

/** ≤1080 轨道自动收起为 56；≤900 再让设置面板变浮层。测试环境无 matchMedia 时按桌面处理。 */
const COMPACT_QUERY = '(max-width: 1080px)';
const OVERLAY_QUERY = '(max-width: 900px)';

function subscribeMedia(query: string, callback: () => void) {
  if (typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mediaQuery = window.matchMedia(query);
  mediaQuery.addEventListener('change', callback);
  return () => mediaQuery.removeEventListener('change', callback);
}

function subscribeCompact(callback: () => void) {
  return subscribeMedia(COMPACT_QUERY, callback);
}

function subscribeOverlay(callback: () => void) {
  return subscribeMedia(OVERLAY_QUERY, callback);
}

function getMediaSnapshot(query: string) {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function getCompactSnapshot() {
  return getMediaSnapshot(COMPACT_QUERY);
}

function getOverlaySnapshot() {
  return getMediaSnapshot(OVERLAY_QUERY);
}

function useCompactNav() {
  return useSyncExternalStore(subscribeCompact, getCompactSnapshot, () => false);
}

function useOverlayNav() {
  return useSyncExternalStore(subscribeOverlay, getOverlaySnapshot, () => false);
}

const SETTINGS_LAST_PATH_KEY = 'autowonder.sidebar.lastSettingsPath';

function readLastSettingsPath(): string | null {
  try {
    const value = localStorage.getItem(SETTINGS_LAST_PATH_KEY);
    return value && SETTINGS_SPACE.items.some((item) => navItemMatchesPath(item, value)) ? value : null;
  } catch {
    return null;
  }
}

function writeLastSettingsPath(pathname: string) {
  if (!SETTINGS_SPACE.items.some((item) => navItemMatchesPath(item, pathname))) {
    return;
  }
  try {
    localStorage.setItem(SETTINGS_LAST_PATH_KEY, pathname);
  } catch {
    /* ignore */
  }
}

export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  workspaceSwitcher,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  workspaceSwitcher?: ReactNode;
}) {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const location = useLocation();
  const compact = useCompactNav();
  const overlay = useOverlayNav();

  const { data: agentCount = 0 } = useAgentPendingReviewCount();
  const scheduledTaskCapability = useScheduledTaskCapability();
  const scheduledTaskReady = isScheduledTaskCapabilityQueryReady(scheduledTaskCapability);

  const routeSpaceKey = resolveSelectedSpaceKey(location.pathname);
  const [selectedSpaceKey, setSelectedSpaceKey] = useState<NavSpaceKey>(
    () => routeSpaceKey ?? 'delivery',
  );
  const [overlayPanelOpen, setOverlayPanelOpen] = useState(false);

  useEffect(() => {
    if (routeSpaceKey) {
      setSelectedSpaceKey(routeSpaceKey);
    }
  }, [routeSpaceKey]);

  useEffect(() => {
    writeLastSettingsPath(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (routeSpaceKey !== 'settings') {
      setOverlayPanelOpen(false);
    }
  }, [routeSpaceKey]);

  const selectedItemKey = resolveSelectedNavKey(location.pathname);
  const aboutActive = location.pathname === '/about';
  const settingsActive = selectedSpaceKey === 'settings';
  const panelVisible = settingsActive && (!overlay || overlayPanelOpen);
  const iconOnly = collapsed || compact;

  const onSettingsItem = SETTINGS_SPACE.items.some((item) => navItemMatchesPath(item, location.pathname));

  // 窄屏浮层只负责打开；不在设置页时点设置直接落到上次访问的设置页（没有则第一项）。
  const openSettings = () => {
    setSelectedSpaceKey('settings');
    if (overlay) {
      setOverlayPanelOpen(true);
    }
    if (!onSettingsItem) {
      const target = readLastSettingsPath()
        ?? visibleSpaceItems(SETTINGS_SPACE, scheduledTaskReady)[0]?.key;
      if (target) {
        navigate(target);
      }
    }
  };

  const go = (key: string) => (event: MouseEvent) => {
    event.preventDefault();
    setOverlayPanelOpen(false);
    navigate(key);
  };

  // 轨道只留图标时用 Tooltip 即时显示名称；展开态不需要。
  const railTooltipVisible = iconOnly;

  const renderRailItem = (space: NavSpace, item: NavEntry) => {
    const label = t(item.labelKey);
    const active = selectedItemKey === item.key;
    const row = (
      <a
        className={active ? 'aw-rail-row active' : 'aw-rail-row'}
        href={item.key}
        aria-current={active ? 'page' : undefined}
        aria-label={iconOnly ? label : undefined}
        onClick={(event) => {
          setSelectedSpaceKey(space.key);
          go(item.key)(event);
        }}
      >
        <AwStrokeIcon name={item.icon} size={16} />
        <span className="aw-rail-label">{label}</span>
      </a>
    );
    return railTooltipVisible
      ? <Tooltip key={item.key} title={label} placement="right">{row}</Tooltip>
      : <Fragment key={item.key}>{row}</Fragment>;
  };

  const renderSettingsRow = () => {
    const label = t(SETTINGS_SPACE.labelKey);
    const row = (
      <button
        type="button"
        className={settingsActive ? 'aw-rail-row active' : 'aw-rail-row'}
        aria-current={settingsActive ? 'true' : undefined}
        aria-label={iconOnly ? label : undefined}
        onMouseEnter={overlay ? () => setOverlayPanelOpen(true) : undefined}
        onFocus={overlay ? () => setOverlayPanelOpen(true) : undefined}
        onClick={openSettings}
      >
        <AwStrokeIcon name={SETTINGS_SPACE.icon} size={16} />
        <span className="aw-rail-label">{label}</span>
      </button>
    );
    return railTooltipVisible ? <Tooltip title={label} placement="right">{row}</Tooltip> : row;
  };

  const renderAboutItem = () => {
    const label = t(ABOUT_NAV_ITEM.labelKey);
    const row = (
      <a
        className={aboutActive ? 'aw-rail-row active' : 'aw-rail-row'}
        href={ABOUT_NAV_ITEM.key}
        aria-current={aboutActive ? 'page' : undefined}
        aria-label={iconOnly ? label : undefined}
        onClick={go(ABOUT_NAV_ITEM.key)}
      >
        <AwStrokeIcon name={ABOUT_NAV_ITEM.icon} size={16} />
        <span className="aw-rail-label">{label}</span>
      </a>
    );
    return railTooltipVisible ? <Tooltip title={label} placement="right">{row}</Tooltip> : row;
  };

  const renderToggle = () => {
    if (!onToggleCollapsed || compact) return null;
    const label = collapsed ? t('nav.expand') : t('nav.collapse');
    const toggle = (
      <button
        type="button"
        className="aw-rail-toggle"
        aria-label={label}
        onClick={onToggleCollapsed}
      >
        <AwStrokeIcon name={collapsed ? 'chev-r' : 'chev-l'} size={16} />
        <span className="aw-rail-label">{label}</span>
      </button>
    );
    return railTooltipVisible ? <Tooltip title={label} placement="right">{toggle}</Tooltip> : toggle;
  };

  const renderPanelContent = (space: NavSpace) => {
    const items = visibleSpaceItems(space, scheduledTaskReady);
    return (
      <>
        <div className="aw-panel-head">
          <span className="aw-panel-title">{t(space.labelKey)}</span>
        </div>
        <div className="aw-panel-body">
          {items.map((item, index) => {
            const label = t(item.labelKey);
            const active = selectedItemKey === item.key;
            const badge = item.key === AGENTS_ITEM_KEY && agentCount > 0 ? agentCount : null;
            const groupLabelKey = item.groupLabelKey;
            return (
              <Fragment key={item.key}>
                {groupLabelKey != null && groupLabelKey !== items[index - 1]?.groupLabelKey && (
                  <div className="aw-panel-group-title">{t(groupLabelKey)}</div>
                )}
                <a
                  className={active ? 'aw-panel-item active' : 'aw-panel-item'}
                  href={item.key}
                  aria-current={active ? 'page' : undefined}
                  aria-label={badge != null ? t('nav.attention.pendingReviewItem', { label, value: badge }) : undefined}
                  onClick={go(item.key)}
                >
                  <AwStrokeIcon name={item.icon} size={15} />
                  <span className="aw-panel-label">{label}</span>
                  {badge != null && <span className="aw-panel-badge">{badge}</span>}
                </a>
              </Fragment>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div
      className="aw-nav-wrap"
      onMouseLeave={overlay ? () => setOverlayPanelOpen(false) : undefined}
      onKeyDown={overlay ? (event) => { if (event.key === 'Escape') setOverlayPanelOpen(false); } : undefined}
    >
      <aside className="aw-rail">
        {workspaceSwitcher && <div className="aw-rail-ws">{workspaceSwitcher}</div>}
        <nav className="aw-rail-nav" aria-label={t('nav.title')}>
          {NAV_SPACES.map((space) => (
            <div className="aw-rail-group" key={space.key}>
              <div className="aw-rail-group-title">{t(space.labelKey)}</div>
              {visibleSpaceItems(space, scheduledTaskReady).map((item) => renderRailItem(space, item))}
            </div>
          ))}
        </nav>
        <div className="aw-rail-foot">
          {renderSettingsRow()}
          {renderAboutItem()}
          {renderToggle()}
        </div>
      </aside>
      {panelVisible && (
        <nav className={overlay ? 'aw-panel open' : 'aw-panel'} aria-label={t(SETTINGS_SPACE.labelKey)}>
          {renderPanelContent(SETTINGS_SPACE)}
        </nav>
      )}
    </div>
  );
}
