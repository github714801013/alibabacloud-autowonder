package com.aliyun.autowonder.notification;

import com.aliyun.autowonder.json.JSON;
import com.aliyun.autowonder.common.i18n.SystemMessages;
import com.aliyun.autowonder.user.UserSettingService;
import com.aliyun.autowonder.workspace.WorkspaceLivenessGuard;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.ArrayList;
import java.util.Locale;
import com.aliyun.autowonder.common.error.BizException;
import com.aliyun.autowonder.common.error.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class NotifyService {

    private static final Logger log = LoggerFactory.getLogger(NotifyService.class);

    private static final String IN_APP_CHANNEL = "inApp";
    /** Recorded with the row: the IM copy is accepted and will be enqueued once the transaction commits. */
    static final String CHANNEL_QUEUED = "queued";

    private final NotificationDao notificationDao;
    private final NotifyPrefDao prefDao;
    private final List<NotifyChannel> channels;
    private final UserSettingService userSettings;
    private final NotificationPersister persister;
    private WorkspaceLivenessGuard workspaceLiveness;

    /** Optional so manually built services keep working; Spring always injects it. */
    @Autowired(required = false)
    public void setWorkspaceLiveness(WorkspaceLivenessGuard workspaceLiveness) {
        this.workspaceLiveness = workspaceLiveness;
    }

    public NotifyService(NotificationDao notificationDao, NotifyPrefDao prefDao,
                         List<NotifyChannel> channels) {
        this(notificationDao, prefDao, channels, null, new NotificationPersister(notificationDao));
    }

    public NotifyService(NotificationDao notificationDao, NotifyPrefDao prefDao,
                         List<NotifyChannel> channels, UserSettingService userSettings) {
        this(notificationDao, prefDao, channels, userSettings, new NotificationPersister(notificationDao));
    }

    @Autowired
    public NotifyService(NotificationDao notificationDao, NotifyPrefDao prefDao,
                         List<NotifyChannel> channels, UserSettingService userSettings,
                         NotificationPersister persister) {
        this.userSettings = userSettings;
        this.notificationDao = notificationDao;
        this.prefDao = prefDao;
        this.channels = channels;
        this.persister = persister;
    }

    public void notify(NotifyEvent event) {
        if (event.getRecipientIds() == null || event.getRecipientIds().isEmpty()) {
            return;
        }
        // A deleted workspace gets no new notification at all: neither the in-app row nor the IM copy.
        if (!workspaceActive(event.getTenantId(), event.getScope(), event.getType())) {
            return;
        }
        // IM 渠道名取自平台当前选定 provider，同一事件内只解析一次，避免逐收件人重复读配置。
        List<NamedChannel> namedChannels = new ArrayList<>(channels.size());
        for (NotifyChannel channel : channels) {
            namedChannels.add(new NamedChannel(channel.name(), channel));
        }
        Map<String, DeferredBatch> deferred = new LinkedHashMap<>();
        for (Long recipientId : event.getRecipientIds()) {
            Locale locale = userSettings == null ? Locale.CHINA : userSettings.recipientLocale(recipientId);
            String scope = event.getScope() == null ? NotificationScope.WORKSPACE : event.getScope();
            boolean platformScope = NotificationScope.PLATFORM.equals(scope);
            NotificationDO n = new NotificationDO();
            n.setRecipientLocale(locale.toLanguageTag());
            n.setTenantId(event.getTenantId());
            n.setScope(scope);
            n.setRecipientId(recipientId);
            n.setType(event.getType());
            n.setTitle(SystemMessages.render(event.getTitleKey(), event.getTitleArgs(), event.getTitle(), locale));
            Object[] contentArgs = event.getContentKey() != null && event.getContentArgsResolver() != null
                    ? event.getContentArgsResolver().apply(locale) : event.getContentArgs();
            n.setContent(SystemMessages.render(event.getContentKey(), contentArgs, event.getContent(), locale));
            n.setLink(event.getLink());
            n.setRefType(event.getRefType());
            n.setRefId(event.getRefId());
            n.setRelatedLinksJson(NotificationLinkJson.encode(event.getRelatedLinks()));
            n.setStatus("UNREAD");
            persister.persist(n);

            Map<String, String> channelResults = new HashMap<>();
            // 平台级通知没有业务空间偏好可查；旧个人 IM 偏好也不再阻断系统通知的 IM 同步。
            NotifyPrefDO pref = platformScope
                    ? null
                    : prefDao.findByUserAndType(event.getTenantId(), recipientId, event.getType());

            for (NamedChannel channel : namedChannels) {
                if (!shouldDeliver(channel.name(), pref, event.getType())) {
                    continue;
                }
                if (IN_APP_CHANNEL.equals(channel.name())) {
                    deliverNow(channel, n, channelResults);
                    continue;
                }
                deferred.computeIfAbsent(channel.name(),
                                key -> new DeferredBatch(channel.name(), channel.target(), new ArrayList<>()))
                        .notifications().add(n);
                channelResults.put(channel.name(), CHANNEL_QUEUED);
            }
            notificationDao.updateChannels(n.getId(), event.getTenantId(), JSON.toJSONString(channelResults));
        }
        if (!deferred.isEmpty()) {
            List<DeferredBatch> batches = List.copyOf(deferred.values());
            runAfterCommit(() -> batches.forEach(this::deliverDeferred));
        }
    }

    private void deliverNow(NamedChannel channel, NotificationDO notification, Map<String, String> results) {
        try {
            boolean ok = channel.target().deliver(notification);
            results.put(channel.name(), ok ? "ok" : "failed");
        } catch (Exception e) {
            log.warn("channel {} delivery failed for notification {}", channel.name(), notification.getId(), e);
            results.put(channel.name(), "error:" + e.getMessage());
        }
    }

    /**
     * IM 副本只在通知事务提交后入队：回滚的通知不应发出。AFTER_COMMIT 监听器内注册的
     * afterCompletion 仍会执行（与 NotificationRealtimePublisher 同范式）；入队失败只记录，
     * 既不影响已提交的业务，也不冒充投递成功。
     */
    private void deliverDeferred(DeferredBatch batch) {
        NotificationDO first = batch.notifications().get(0);
        // Re-checked at delivery time: the workspace may have been deleted between the business
        // commit and this AFTER_COMMIT callback. The in-app row is already committed, but no IM
        // message may leave for a workspace that is gone.
        if (!workspaceActive(first.getTenantId(), first.getScope(), first.getType())) {
            log.info("channel {} post-commit delivery skipped: workspace deleted tenantId={} count={}",
                    batch.name(), first.getTenantId(), batch.notifications().size());
            return;
        }
        try {
            batch.target().deliverBatch(batch.notifications());
        } catch (Exception e) {
            log.warn("channel {} post-commit delivery failed for {} notifications",
                    batch.name(), batch.notifications().size(), e);
        }
    }

    private void runAfterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCompletion(int status) {
                    if (status == STATUS_COMMITTED) {
                        action.run();
                    }
                }
            });
            return;
        }
        action.run();
    }

    public int unreadCount(Long tenantId, long userId) {
        return notificationDao.countUnread(tenantId, userId);
    }

    public void markRead(long notificationId, Long tenantId, long userId) {
        notificationDao.markRead(notificationId, tenantId, userId);
    }

    public void markAllRead(Long tenantId, long userId) {
        notificationDao.markAllRead(tenantId, userId);
    }

    public void delete(long notificationId, Long tenantId, long userId) {
        // 归属校验在 SQL 的 WHERE 上，0 行说明通知不存在或不属于当前用户，不能静默成功。
        if (notificationDao.delete(notificationId, tenantId, userId) == 0) {
            throw BizException.keyed(ErrorCode.NOT_FOUND, "error.notification_not_found", null, "通知不存在");
        }
    }

    /**
     * 已删除空间不再产生任何空间级通知；平台级通知（tenantId = 0）与没有注入守卫的单测保持旧行为。
     */
    private boolean workspaceActive(long tenantId, String scope, String type) {
        if (workspaceLiveness == null) {
            return true;
        }
        String effectiveScope = scope == null ? NotificationScope.WORKSPACE : scope;
        if (NotificationScope.PLATFORM.equals(effectiveScope) || tenantId <= 0L) {
            return true;
        }
        if (workspaceLiveness.isActive(tenantId)) {
            return true;
        }
        log.info("notification dropped: workspace deleted tenantId={} type={}", tenantId, type);
        return false;
    }

    /** 企业微信按默认开关与显式偏好判定；站内按个人开关；其余 IM 渠道由渠道按平台配置判定。 */
    private boolean shouldDeliver(String channelName, NotifyPrefDO pref, String type) {
        if ("wecom".equals(channelName)) {
            // 企业微信默认关闭，会话推送失败类型例外；显式偏好行始终优先。
            if (pref == null) {
                return NotifyTypeDefaults.wecomDefaultOn(type);
            }
            return pref.getWecom() != null && pref.getWecom() == 1;
        }
        if (!IN_APP_CHANNEL.equals(channelName)) {
            return true;
        }
        return pref == null || pref.getInApp() == null || pref.getInApp() == 1;
    }

    private record NamedChannel(String name, NotifyChannel target) {
    }

    private record DeferredBatch(String name, NotifyChannel target, List<NotificationDO> notifications) {
    }
}
