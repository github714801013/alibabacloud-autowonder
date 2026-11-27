import { protectBigInts } from './protectBigInts';
import { i18n, normalizeLocale } from '@/shared/i18n';
import axios, { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { ApiError, ErrorCodes } from '@/shared/types/common';
import type { ApiResult } from '@/shared/types/common';
import { useAuthStore } from '@/shared/auth/store';
import { refreshCurrentMembership } from '@/shared/auth/refreshCurrentMembership';
import { rememberReturnPath } from '@/shared/auth/returnPath';
import { installUserActivityTracking, isUserActive } from '@/shared/auth/activity';
import { createElement } from 'react';
import { Button, notification } from 'antd';
import { migrateAuthState } from '@/shared/auth/store';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 定时轮询/自动刷新请求：即使页面活跃也不得顺延会话。 */
    backgroundActivity?: boolean;
  }
}

installUserActivityTracking();


function safeParse(text: string) {
  return JSON.parse(protectBigInts(text));
}

function isAccessDenied(code: string): boolean {
  return code === ErrorCodes.NO_PERMISSION
    || code === ErrorCodes.WORKSPACE_ACCESS_INSUFFICIENT;
}

// A 401 from the login endpoints is a business error (wrong credentials, expired
// one-time SSO ticket), not a session expiry; routing it through handleUnauthorized
// would redirect/reload the login page and swallow the backend's specific error message.
const AUTH_ENTRY_URLS = new Set(['/api/auth/login', '/api/auth/sso/session', '/api/auth/sso/bind']);

function isAuthEntryRequest(config?: InternalAxiosRequestConfig): boolean {
  return config?.url != null && AUTH_ENTRY_URLS.has(config.url);
}

// Each platform-admin addition requires explicit confirmation; never silently replay it.
function isPlatformAdminAddRequest(config?: InternalAxiosRequestConfig): boolean {
  return config?.method?.toUpperCase() === 'POST' && config?.url === '/api/platform/admins';
}

async function synchronizeWorkspaceAfterFailure(code: string, config?: InternalAxiosRequestConfig): Promise<void> {
  if (code === ErrorCodes.ORG_DELETED_OR_DISABLED) {
    const sent = config && requestContexts.get(config);
    synchronizePersistedAuth();
    if (sent && !sameSession(sent)) return;
    await recoverWorkspaceSession();
    return;
  }
  if (code === ErrorCodes.WORKSPACE_NOT_MEMBER) {
    await refreshCurrentMembership();
    return;
  }
  if (isAccessDenied(code)) {
    await refreshCurrentMembership();
  }
}

/** 前台用户操作触发的续期可顺延会话；后台轮询与自动重连只换发访问令牌。 */
export type RefreshTrigger = 'user' | 'background';

let refreshPromise: Promise<string | null> | null = null;
let refreshContext = '';
let refreshTrigger: RefreshTrigger = 'background';
type SessionContext = { workspaceId?: number; refreshToken: string | null; accessToken: string | null };
const requestContexts = new WeakMap<InternalAxiosRequestConfig, SessionContext>();
const contextOf = (): SessionContext => {
  const state = useAuthStore.getState();
  return { workspaceId: state.currentWorkspace?.id, refreshToken: state.refreshToken, accessToken: state.accessToken };
};
function sameSession(context: SessionContext) {
  const current = contextOf();
  return current.workspaceId === context.workspaceId && current.refreshToken === context.refreshToken
    && current.accessToken === context.accessToken;
}
function clearWorkspaceContext() {
  useAuthStore.getState().clearCurrentWorkspace();
  window.dispatchEvent(new Event('aw:workspace-context-synchronized'));
}

/** Read the current persisted value, never the possibly delayed StorageEvent payload. */
function synchronizePersistedAuth() {
  try {
    const raw = localStorage.getItem('aw-auth');
    if (!raw) return;
    const persisted = migrateAuthState(JSON.parse(raw).state);
    const current = useAuthStore.getState();
    if (persisted.accessToken !== current.accessToken || persisted.refreshToken !== current.refreshToken
        || persisted.currentWorkspace?.id !== current.currentWorkspace?.id
        || persisted.user?.id !== current.user?.id || persisted.accessLevel !== current.accessLevel
        || JSON.stringify(persisted.readOnlyDomains) !== JSON.stringify(current.readOnlyDomains)) {
      useAuthStore.setState(persisted);
      if (persisted.currentWorkspace?.id !== current.currentWorkspace?.id || persisted.refreshToken !== current.refreshToken
          || persisted.user?.id !== current.user?.id) {
        window.dispatchEvent(new Event('aw:workspace-context-synchronized'));
      }
    }
  } catch { /* Storage may be unavailable; in-memory session guards remain active. */ }
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== 'aw-auth' && event.key !== null) return;
  try {
    if (!localStorage.getItem('aw-auth')) {
      useAuthStore.getState().clear();
      window.dispatchEvent(new Event('aw:workspace-context-synchronized'));
    }
    else synchronizePersistedAuth();
  } catch { /* Keep the current in-memory session when browser storage is unavailable. */ }
});

async function performRefresh(trigger: RefreshTrigger, detachRetry = false): Promise<string | null> {
  synchronizePersistedAuth();
  const context = contextOf();
  const { refreshToken: rt, currentWorkspace } = useAuthStore.getState();
  if (!rt) return null;
  const resp = await fetch('/api/auth/refresh', {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', 'Accept-Language': normalizeLocale(i18n.language) },
    // The workspace lives as a claim inside the access token, so it must be re-declared here.
    // Otherwise the refreshed token is detached from the workspace, the next workspace-scoped
    // call returns WORKSPACE_NOT_MEMBER, and RouteGuard bounces the user to /workspaces.
    body: JSON.stringify({
      refreshToken: rt,
      workspaceId: currentWorkspace?.id ?? null,
      userActivity: trigger === 'user',
    }),
  });
  // Only an explicit 401 proves the refresh session is gone; network errors and service
  // hiccups (5xx, 429, ...) must keep the session so the caller can retry.
  if (resp.status === 401) return null;
  const body = await resp.json();
  if (!body.success && body.code === ErrorCodes.ORG_DELETED_OR_DISABLED && !detachRetry) {
    synchronizePersistedAuth();
    if (!sameSession(context)) return useAuthStore.getState().accessToken;
    clearWorkspaceContext();
    redirectFromWorkspacePage();
    const previousKey = JSON.stringify([context.refreshToken, context.workspaceId]);
    if (refreshContext === previousKey) refreshContext = JSON.stringify([context.refreshToken, undefined]);
    const detached = contextOf();
    try {
      const token = await performRefresh('background', true);
      synchronizePersistedAuth();
      if (sameSession(detached)) {
        if (token) useAuthStore.getState().setAccessToken(token);
        else { useAuthStore.getState().clearSession(); redirectToLogin(); }
      }
      return token;
    } catch (error) {
      synchronizePersistedAuth();
      if (sameSession(detached)) showRecoveryFailure();
      throw error;
    }
  }
  if (!resp.ok) throw new Error('Token refresh temporarily unavailable');
  if (body.success && body.data?.accessToken) {
    return body.data.accessToken as string;
  }
  // A 200 envelope may still carry the authoritative 401 code (global200 mode).
  if (!body.success && body.code === ErrorCodes.UNAUTHORIZED) return null;
  throw new Error('Token refresh temporarily unavailable');
}

function startRefresh(context: string, trigger: RefreshTrigger): Promise<string | null> {
  refreshContext = context;
  refreshTrigger = trigger;
  const pending = performRefresh(trigger).finally(() => {
    if (refreshPromise === pending) {
      refreshPromise = null;
      refreshTrigger = 'background';
    }
  });
  refreshPromise = pending;
  return pending;
}

export function refreshAccessToken(trigger: RefreshTrigger): Promise<string | null> {
  synchronizePersistedAuth();
  const state = useAuthStore.getState();
  const context = JSON.stringify([state.refreshToken, state.currentWorkspace?.id]);
  if (!refreshPromise || context !== refreshContext) {
    return startRefresh(context, trigger);
  }
  if (trigger === 'background' || refreshTrigger === 'user') {
    return refreshPromise;
  }
  // 前台请求加入正在进行的后台续期：后台续期不会顺延，必须在前台合并请求上补一次前台续期，
  // 否则后台来源会吞掉本次本应发生的会话顺延机会。
  const inFlight = refreshPromise;
  const promoted = inFlight.then((token) => {
    if (token === null) return null;
    const current = useAuthStore.getState();
    if (current.refreshToken !== state.refreshToken
        || current.currentWorkspace?.id !== state.currentWorkspace?.id) {
      return current.accessToken;
    }
    return performRefresh('user');
  });
  refreshTrigger = 'user';
  const pending = promoted.finally(() => {
    if (refreshPromise === pending) {
      refreshPromise = null;
      refreshTrigger = 'background';
    }
  });
  refreshPromise = pending;
  return pending;
}

/** Reuse the HTTP refresh single-flight; JWT expiry is only a refresh hint, never authorization. */
export async function getRealtimeAccessToken(): Promise<string | null> {
  const snapshot = useAuthStore.getState();
  const token = snapshot.accessToken;
  if (!token || !snapshot.currentWorkspace) return null;
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 30_000) return token;
  } catch { /* Let the refresh endpoint validate the session. */ }
  // Realtime connect/auto-reconnect is background traffic: it may renew the access token but
  // must never roll the session expiry forward.
  const fresh = await refreshAccessToken('background');
  const current = useAuthStore.getState();
  if (current.accessToken !== token || current.refreshToken !== snapshot.refreshToken
      || current.currentWorkspace?.id !== snapshot.currentWorkspace.id) return null;
  if (fresh) current.setAccessToken(fresh);
  else current.clearSession();
  return fresh;
}

// A burst of concurrent 401s must clear and redirect once, not per request. Reset when a new
// session is established (login/SSO), so a later expiry can redirect again.
let loginRedirectIssued = false;
let lastObservedAccessToken: string | null = useAuthStore.getState().accessToken;
useAuthStore.subscribe((state) => {
  if (state.accessToken && !lastObservedAccessToken) loginRedirectIssued = false;
  if (state.currentWorkspace || !state.accessToken) notification.destroy(recoveryNotice);
  lastObservedAccessToken = state.accessToken;
});

/**
 * 续期来源：显式后台优先；否则只有「页面可见 + 最近有真实交互」才算前台。
 * 隐藏标签页或闲置页面上的定时轮询缺省按后台处理，不顺延会话。
 */
function refreshTriggerFor(config: InternalAxiosRequestConfig): RefreshTrigger {
  if (config.backgroundActivity === true) return 'background';
  return isUserActive() ? 'user' : 'background';
}

export function redirectToLogin(): void {
  if (loginRedirectIssued) return;
  loginRedirectIssued = true;
  if (typeof window !== 'undefined') {
    rememberReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }
  try {
    const loc = (typeof window !== 'undefined' ? window.location : null) as { href?: string } | null;
    if (loc) loc.href = '/login';
  } catch {
    // jsdom may throw "Not implemented: navigation" or "Invalid base URL"
    // when assigning a relative href — safe to ignore in tests.
  }
}

// 邮箱验证门禁：普通会话被服务端拒绝后必须重新登录取得 15 分钟受限凭证，
// 不能把受限凭证或旧会话当作可用会话继续调用业务接口。
function requireEmailVerification(): void {
  useAuthStore.getState().clearSession();
  if (typeof window === 'undefined') return;
  try {
    const loc = window.location as { pathname?: string; href?: string };
    if (loc.pathname !== '/login') loc.href = '/login';
  } catch {
    // Same jsdom navigation caveat as redirectToLogin.
  }
}

function redirectToWorkspaceSelect(): void {  try {
    const loc = (typeof window !== 'undefined' ? window.location : null) as
      | { pathname?: string; href?: string }
      | null;
    if (!loc || loc.pathname === '/workspaces') return;
    loc.href = '/workspaces';
  } catch {
    // Same jsdom navigation caveat as redirectToLogin.
  }
}

// Leave workspace pages after detachment; global pages retain their own permission boundary.
function redirectFromWorkspacePage() {
  const path = window.location.pathname;
  if (path === '/workspaces' || path.startsWith('/workspaces/') || path === '/notifications'
      || path.startsWith('/profile/') || path.startsWith('/login') || path.startsWith('/sso/')
      || path === '/platform/branding' || path === '/open-platform') return;
  redirectToWorkspaceSelect();
}

let recovery: { context: SessionContext; promise: Promise<void> } | null = null;
const recoveryNotice = 'workspace-session-recovery';
function showRecoveryFailure() {
  notification.error({ key: recoveryNotice, duration: 0,
    message: i18n.t('account.workspaceRecoveryFailed'),
    description: i18n.t('account.workspaceRecoveryHint'),
    actions: createElement(Button, { onClick: () => { void recoverWorkspaceSession(); } }, i18n.t('account.retryWorkspaceRecovery')),
  });
}

/** Detach the current session; never replay the request that discovered the lost workspace. */
export function recoverWorkspaceSession(): Promise<void> {
  synchronizePersistedAuth();
  if (recovery && sameSession(recovery.context)) return recovery.promise;
  clearWorkspaceContext();
  redirectFromWorkspacePage();
  if (!useAuthStore.getState().refreshToken) { showRecoveryFailure(); return Promise.resolve(); }
  const context = contextOf();
  const promise = (async () => {
    try {
      const token = await refreshAccessToken('background');
      synchronizePersistedAuth();
      if (!sameSession(context)) return;
      if (token) useAuthStore.getState().setAccessToken(token);
      else { useAuthStore.getState().clearSession(); redirectToLogin(); }
      notification.destroy(recoveryNotice);
    } catch {
      synchronizePersistedAuth();
      if (!sameSession(context)) return;
      showRecoveryFailure();
    } finally {
      if (recovery?.context === context) recovery = null;
    }
  })();
  recovery = { context, promise };
  return promise;
}

export function leaveDeletedWorkspace(workspaceId: number): Promise<void> {
  synchronizePersistedAuth();
  return useAuthStore.getState().currentWorkspace?.id === workspaceId ? recoverWorkspaceSession() : Promise.resolve();
}

async function handleUnauthorized(
  originalConfig: InternalAxiosRequestConfig,
): Promise<AxiosResponse> {
  synchronizePersistedAuth();
  const snapshot = useAuthStore.getState();
  const rt = snapshot.refreshToken;
  const sent = requestContexts.get(originalConfig);
  if (sent && (sent.workspaceId !== snapshot.currentWorkspace?.id || sent.refreshToken !== rt)) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, i18n.t('account.expired'), null);
  }
  // A concurrent HTTP/WS refresh may have finished before this older 401 arrived.
  if (snapshot.accessToken && originalConfig.headers.Authorization
      && originalConfig.headers.Authorization !== `Bearer ${snapshot.accessToken}`) {
    return apiClient(originalConfig);
  }
  if (!rt || originalConfig.url === '/api/auth/refresh') {
    useAuthStore.getState().clearSession();
    redirectToLogin();
    return Promise.reject(new ApiError(ErrorCodes.UNAUTHORIZED, i18n.t('account.expired'), null));
  }

  // Only a visible page with recent real interaction may roll the session; a hidden or idle
  // tab polling in the background renews the access token without extending the session.
  const newToken = await refreshAccessToken(refreshTriggerFor(originalConfig)).catch(() => {
    throw new ApiError('10000', i18n.t('account.networkError'), null);
  });
  synchronizePersistedAuth();
  const current = useAuthStore.getState();
  if (current.refreshToken !== rt || current.currentWorkspace?.id !== snapshot.currentWorkspace?.id) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, i18n.t('account.expired'), null);
  }
  if (newToken) {
    useAuthStore.getState().setAccessToken(newToken);
    originalConfig.headers.Authorization = `Bearer ${newToken}`;
    return apiClient(originalConfig);
  }

  useAuthStore.getState().clearSession();
  redirectToLogin();
  return Promise.reject(new ApiError(ErrorCodes.UNAUTHORIZED, i18n.t('account.expired'), null));
}

export const apiClient = axios.create({
  baseURL: '',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
  transformResponse: [(data) => {
    if (typeof data === 'string') {
      try {
        return safeParse(data);
      } catch {
        return data;
      }
    }
    return data;
  }],
});

apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  synchronizePersistedAuth();
  const expected = contextOf();
  if (recovery) {
    await recovery.promise;
    synchronizePersistedAuth();
    const current = contextOf();
    if (expected.workspaceId !== current.workspaceId || expected.refreshToken !== current.refreshToken) {
      throw new ApiError(ErrorCodes.ORG_DELETED_OR_DISABLED, i18n.t('workspaceSessionChanged'), null);
    }
  }
  config.headers['Accept-Language'] = normalizeLocale(i18n.language);
  const snapshot = useAuthStore.getState();
  requestContexts.set(config, { workspaceId: snapshot.currentWorkspace?.id, refreshToken: snapshot.refreshToken, accessToken: snapshot.accessToken });
  const token = snapshot.accessToken;
  // 显式 Authorization 仅在受限验证凭证（awev_）时优先保留；普通会话仍以当前令牌覆盖，
  // 否则 401 重试会带着旧令牌重放。
  const explicitAuth = config.headers.Authorization;
  const restrictedAuth = typeof explicitAuth === 'string' && explicitAuth.startsWith('Bearer awev');
  if (token && !restrictedAuth) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  async (response) => {
    const body = response.data as ApiResult<unknown>;
    if (!body.success) {
      if (body.code === ErrorCodes.EMAIL_VERIFICATION_REQUIRED) {
        requireEmailVerification();
      }
      if (body.code === ErrorCodes.UNAUTHORIZED
        && !isAuthEntryRequest(response.config)
        && !isPlatformAdminAddRequest(response.config)) {
        return handleUnauthorized(response.config);
      }
      const apiError = new ApiError(body.code, body.message, body.traceId, body.data);
      await synchronizeWorkspaceAfterFailure(body.code, response.config);
      throw apiError;
    }
    response.data = body.data;
    return response;
  },
  async (error) => {
    if (error.response?.data?.code) {
      const body = error.response.data;

      if (body.code === ErrorCodes.EMAIL_VERIFICATION_REQUIRED) {
        requireEmailVerification();
      }
      if (body.code === ErrorCodes.UNAUTHORIZED
        && !isAuthEntryRequest(error.config)
        && !isPlatformAdminAddRequest(error.config)) {
        return handleUnauthorized(error.config);
      }
      const apiErr = new ApiError(body.code, body.message, body.traceId, body.data);
      await synchronizeWorkspaceAfterFailure(body.code, error.config);
      throw apiErr;
    }
    throw new ApiError('10000', error.message || i18n.t('account.networkError'), null);
  },
);
