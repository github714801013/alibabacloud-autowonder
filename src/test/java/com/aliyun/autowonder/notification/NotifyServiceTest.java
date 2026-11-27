package com.aliyun.autowonder.notification;

import com.aliyun.autowonder.branding.PlatformBrandingService;
import com.aliyun.autowonder.common.error.BizException;
import com.aliyun.autowonder.common.error.ErrorCode;
import com.aliyun.autowonder.im.PlatformImChannelConfigService;
import com.aliyun.autowonder.im.UserImIdentityDO;
import com.aliyun.autowonder.im.UserImIdentityService;
import com.aliyun.autowonder.im.notification.ImNotificationQueue;
import com.aliyun.autowonder.im.notification.ImNotificationTask;
import com.aliyun.autowonder.im.notification.SystemNotificationImDispatcher;
import com.aliyun.autowonder.workspace.WorkspaceLivenessGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.concurrent.atomic.AtomicLong;

class NotifyServiceTest {

    private NotificationDao notificationDao;
    private NotifyPrefDao prefDao;
    private NotifyChannel inAppChannel;
    private NotifyChannel dingTalkChannel;
    private NotifyService service;

    @BeforeEach
    void setUp() {
        notificationDao = mock(NotificationDao.class);
        prefDao = mock(NotifyPrefDao.class);
        inAppChannel = mock(NotifyChannel.class);
        dingTalkChannel = mock(NotifyChannel.class);
        when(inAppChannel.name()).thenReturn("inApp");
        when(dingTalkChannel.name()).thenReturn("dingtalk");
        when(inAppChannel.deliver(any())).thenReturn(true);
        AtomicLong idSeq = new AtomicLong(1);
        doAnswer(inv -> { ((NotificationDO) inv.getArgument(0)).setId(idSeq.getAndIncrement()); return null; })
                .when(notificationDao).insert(any());
        service = new NotifyService(notificationDao, prefDao,
                List.of(inAppChannel, dingTalkChannel));
    }

    @Test
    void platformScopedNotificationAlsoReachesImWithoutWorkspacePreferences() {
        NotifyEvent event = new NotifyEvent();
        event.setScope(NotificationScope.PLATFORM);
        event.setTenantId(NotificationScope.PLATFORM_TENANT_ID);
        event.setType("USER_REGISTRATION_REVIEW");
        event.setTitle("有新用户注册，请审核");
        event.setContent("用户 A 提交了注册申请");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        ArgumentCaptor<NotificationDO> inserted = ArgumentCaptor.forClass(NotificationDO.class);
        verify(notificationDao).insert(inserted.capture());
        assertEquals(NotificationScope.PLATFORM, inserted.getValue().getScope());
        verify(inAppChannel).deliver(any());
        // 平台通知没有业务空间偏好可查，但仍默认同步 IM。
        verify(dingTalkChannel).deliverBatch(any());
        verify(prefDao, never()).findByUserAndType(anyLong(), anyLong(), anyString());
    }

    @Test
    void notifyCreatesNotificationAndDeliversToAllChannels() {
        when(prefDao.findByUserAndType(1L, 10L, "DISPATCH_ALERT")).thenReturn(null);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("DISPATCH_ALERT");
        event.setTitle("Dispatch failed");
        event.setContent("workitem 42 dispatch failed");
        event.setLink("/workitems/42");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(notificationDao).insert(any());
        verify(inAppChannel).deliver(any());
        verify(dingTalkChannel).deliverBatch(any());
        // IM 副本在行内先记入队态，真正入队由提交后动作完成。
        verify(notificationDao).updateChannels(eq(1L), eq(1L), contains(NotifyService.CHANNEL_QUEUED));
    }

    @Test
    void imEnqueueRunsOnlyAfterTheOuterTransactionCommits() {
        ImFixture fixture = imFixture();
        NotificationDao dao = fixture.dao();
        ImNotificationQueue queue = fixture.queue();

        h2Transaction().executeWithoutResult(status -> fixture.service().notify(imEvent()));

        ArgumentCaptor<ImNotificationTask> task = ArgumentCaptor.forClass(ImNotificationTask.class);
        verify(queue).enqueue(task.capture());
        assertEquals(10L, task.getValue().recipientUserId());
        InOrder order = inOrder(dao, queue);
        order.verify(dao).insert(any());
        order.verify(queue).enqueue(any());
    }

    @Test
    void rolledBackNotificationNeverEnqueuesIm() {
        ImFixture fixture = imFixture();

        assertThrows(IllegalStateException.class, () -> h2Transaction().executeWithoutResult(status -> {
            fixture.service().notify(imEvent());
            throw new IllegalStateException("rollback after notify");
        }));

        verify(fixture.dao()).insert(any());
        // 通知行随事务回滚，IM 任务绝不能已经进入队列。
        verify(fixture.queue(), never()).enqueue(any());
    }

    @Test
    void imEnqueueRunsInlineWhenThereIsNoTransaction() {
        ImFixture fixture = imFixture();

        fixture.service().notify(imEvent());

        verify(fixture.queue()).enqueue(any());
    }

    @Test
    void imEnqueueFailureAfterCommitDoesNotBreakNotify() {
        ImFixture fixture = imFixture();
        doThrow(new IllegalStateException("redis down")).when(fixture.queue()).enqueue(any());

        assertDoesNotThrow(() -> h2Transaction().executeWithoutResult(status -> fixture.service().notify(imEvent())));

        verify(fixture.queue()).enqueue(any());
    }

    @Test
    void legacyPersonalImPreferenceNoLongerBlocksImDelivery() {
        NotifyPrefDO pref = new NotifyPrefDO();
        pref.setInApp(1);
        pref.setDingtalk(0);
        when(prefDao.findByUserAndType(1L, 10L, "MEMORY_REVIEW")).thenReturn(pref);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("MEMORY_REVIEW");
        event.setTitle("New memory");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(inAppChannel).deliver(any());
        // 旧个人 IM 偏好不再阻断系统通知；是否可发由 IM 渠道按平台渠道与工号判定。
        verify(dingTalkChannel).deliverBatch(any());
    }

    @Test
    void notifySkipsInAppDeliveryWhenTheRecipientDisabledIt() {
        // 关闭某类 inApp 后既不进未读列表也不实时推送；持久化与钉钉偏好不受影响。
        NotifyPrefDO pref = new NotifyPrefDO();
        pref.setInApp(0);
        pref.setDingtalk(1);
        when(prefDao.findByUserAndType(1L, 10L, "AI_DONE")).thenReturn(pref);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("AI_DONE");
        event.setTitle("AI done");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(inAppChannel, never()).deliver(any());
        verify(dingTalkChannel).deliverBatch(any());
        verify(notificationDao).insert(any());
    }

    @Test
    void missingInAppPreferenceValueStillDeliversInApp() {
        // 偏好行存在但 inApp 未设置时按开启处理，与通知设置页默认值一致。
        NotifyPrefDO pref = new NotifyPrefDO();
        pref.setInApp(null);
        when(prefDao.findByUserAndType(1L, 10L, "AI_DONE")).thenReturn(pref);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("AI_DONE");
        event.setTitle("AI done");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(inAppChannel).deliver(any());
        verify(dingTalkChannel).deliverBatch(any());
    }

    @Test
    void notifyMultipleRecipients() {
        when(prefDao.findByUserAndType(anyLong(), anyLong(), anyString())).thenReturn(null);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("AI_DONE");
        event.setTitle("AI done");
        event.setRecipientIds(List.of(10L, 20L));

        service.notify(event);

        verify(notificationDao, times(2)).insert(any());
        // 一个事件的全部收件人只触发一次 IM 批量投递。
        verify(dingTalkChannel, times(1)).deliverBatch(argThat(notifications -> notifications.size() == 2));
    }

    @Test
    void notifyHandlesChannelExceptionGracefully() {
        when(prefDao.findByUserAndType(anyLong(), anyLong(), anyString())).thenReturn(null);
        when(inAppChannel.deliver(any())).thenThrow(new RuntimeException("network error"));

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("ALERT");
        event.setTitle("test");
        event.setRecipientIds(List.of(10L));

        assertDoesNotThrow(() -> service.notify(event));
        verify(notificationDao).insert(any());
        verify(notificationDao).updateChannels(eq(1L), eq(1L), contains("error:network error"));
    }

    @Test
    void inAppDeliveryFailureIsRecordedAsFailed() {
        when(prefDao.findByUserAndType(anyLong(), anyLong(), anyString())).thenReturn(null);
        when(inAppChannel.deliver(any())).thenReturn(false);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("ALERT");
        event.setTitle("test");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(notificationDao).updateChannels(eq(1L), eq(1L), contains("failed"));
    }

    @Test
    void deferredImChannelFailureDoesNotBreakNotify() {
        when(prefDao.findByUserAndType(anyLong(), anyLong(), anyString())).thenReturn(null);
        doThrow(new RuntimeException("redis error")).when(dingTalkChannel).deliverBatch(any());

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("ALERT");
        event.setTitle("test");
        event.setRecipientIds(List.of(10L));

        assertDoesNotThrow(() -> service.notify(event));
        verify(dingTalkChannel).deliverBatch(any());
        verify(notificationDao).updateChannels(eq(1L), eq(1L), contains(NotifyService.CHANNEL_QUEUED));
    }

    @Test
    void defaultChannelBatchDeliveryFallsBackToPerNotificationDelivery() {
        List<NotificationDO> delivered = new ArrayList<>();
        NotifyChannel plain = new NotifyChannel() {
            @Override
            public String name() { return "inApp"; }

            @Override
            public boolean deliver(NotificationDO notification) {
                delivered.add(notification);
                return true;
            }
        };
        NotificationDO first = new NotificationDO();
        NotificationDO second = new NotificationDO();

        plain.deliverBatch(List.of(first, second));

        assertEquals(List.of(first, second), delivered);
    }

    @Test
    void notifyNullRecipientsDoesNothing() {
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("TEST");
        event.setRecipientIds(null);

        assertDoesNotThrow(() -> service.notify(event));
        verify(notificationDao, never()).insert(any());
    }

    @Test
    void notifyEmptyRecipientsDoesNothing() {
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("TEST");
        event.setRecipientIds(List.of());

        assertDoesNotThrow(() -> service.notify(event));
        verify(notificationDao, never()).insert(any());
    }

    @Test
    void unreadCountDelegates() {
        when(notificationDao.countUnread(1L, 10L)).thenReturn(5);
        assertEquals(5, service.unreadCount(1L, 10L));
    }

    @Test
    void markReadDelegates() {
        service.markRead(1L, 1L, 10L);
        verify(notificationDao).markRead(1L, 1L, 10L);
    }

    @Test
    void markAllReadDelegates() {
        service.markAllRead(1L, 10L);
        verify(notificationDao).markAllRead(1L, 10L);
    }

    @Test
    void deletePassesTenantAndRecipientSoOwnershipIsCheckedInSql() {
        when(notificationDao.delete(5L, 1L, 10L)).thenReturn(1);

        service.delete(5L, 1L, 10L);

        verify(notificationDao).delete(5L, 1L, 10L);
    }

    @Test
    void deleteThrowsNotFoundWhenNoRowIsAffected() {
        // DAO 返回 0 行意味着通知不存在或属于他人，静默成功会掩盖越权删除。
        when(notificationDao.delete(5L, 1L, 10L)).thenReturn(0);

        BizException ex = assertThrows(BizException.class, () -> service.delete(5L, 1L, 10L));

        assertEquals(ErrorCode.NOT_FOUND.getCode(), ex.getCode());
    }

    @Test
    void notifyPersistsImmutableRelatedLinkSnapshot() {
        List<NotificationLink> source = new ArrayList<>();
        source.add(new NotificationLink("SUBMITTED", "新工单", "/workitems/55?workspaceId=1"));
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("DUPLICATE_INTENT");
        event.setTitle("重复提醒");
        event.setRecipientIds(List.of(10L));
        event.setRelatedLinks(source);

        service.notify(event);
        // 生产者拿到事件后继续改动原集合，不能影响已落库的快照。
        source.add(new NotificationLink("DUPLICATE", "迟到修改", "/workitems/2?workspaceId=1"));

        ArgumentCaptor<NotificationDO> row = ArgumentCaptor.forClass(NotificationDO.class);
        verify(notificationDao).insert(row.capture());
        assertEquals(List.of(new NotificationLink("SUBMITTED", "新工单", "/workitems/55?workspaceId=1")),
                NotificationLinkJson.decode(row.getValue().getRelatedLinksJson()));
        assertThrows(UnsupportedOperationException.class,
                () -> event.getRelatedLinks().add(new NotificationLink("DUPLICATE", "x", "/workitems/2")));
    }

    @Test
    void conversationDispatchFailureDeliversWecomWithoutPreferenceRow() {
        NotifyChannel wecomChannel = mock(NotifyChannel.class);
        when(wecomChannel.name()).thenReturn("wecom");
        NotifyService withWecom = new NotifyService(notificationDao, prefDao,
                List.of(inAppChannel, wecomChannel));
        when(prefDao.findByUserAndType(1L, 10L, "CONVERSATION_DISPATCH_FAILED")).thenReturn(null);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("CONVERSATION_DISPATCH_FAILED");
        event.setTitle("会话推送失败");
        event.setContent("「会话」\n失败原因");
        event.setRecipientIds(List.of(10L));

        withWecom.notify(event);

        verify(inAppChannel).deliver(any());
        verify(wecomChannel).deliverBatch(any());
    }

    @Test
    void conversationDispatchFailureHonorsExplicitWecomOff() {
        // 默认开启只兜底「没有偏好行」；用户显式关闭后不得再投递。
        NotifyChannel wecomChannel = mock(NotifyChannel.class);
        when(wecomChannel.name()).thenReturn("wecom");
        NotifyService withWecom = new NotifyService(notificationDao, prefDao,
                List.of(inAppChannel, wecomChannel));
        NotifyPrefDO pref = new NotifyPrefDO();
        pref.setInApp(1);
        pref.setWecom(0);
        when(prefDao.findByUserAndType(1L, 10L, "CONVERSATION_DISPATCH_FAILED")).thenReturn(pref);

        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("CONVERSATION_DISPATCH_FAILED");
        event.setTitle("会话推送失败");
        event.setRecipientIds(List.of(10L));

        withWecom.notify(event);

        verify(inAppChannel).deliver(any());
        verify(wecomChannel, never()).deliverBatch(any());
    }

    @Test
    void notifyWithoutRelatedLinksKeepsTheSnapshotColumnEmpty() {
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("DISPATCH_ALERT");
        event.setTitle("Dispatch failed");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        ArgumentCaptor<NotificationDO> row = ArgumentCaptor.forClass(NotificationDO.class);
        verify(notificationDao).insert(row.capture());
        assertNull(row.getValue().getRelatedLinksJson());
    }

    private static TransactionTemplate h2Transaction() {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:notify-commit-" + System.nanoTime() + ";DB_CLOSE_DELAY=-1", "sa", "");
        return new TransactionTemplate(new DataSourceTransactionManager(dataSource));
    }

    private static NotifyEvent imEvent() {
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("USER_REGISTRATION_REVIEW");
        event.setTitle("有新用户注册，请审核");
        event.setContent("用户 A 提交了注册申请");
        event.setRecipientIds(List.of(10L));
        return event;
    }

    private static ImFixture imFixture() {
        NotificationDao dao = mock(NotificationDao.class);
        AtomicLong idSeq = new AtomicLong(1);
        doAnswer(inv -> { ((NotificationDO) inv.getArgument(0)).setId(idSeq.getAndIncrement()); return null; })
                .when(dao).insert(any());
        NotifyChannel inApp = mock(NotifyChannel.class);
        when(inApp.name()).thenReturn("inApp");
        when(inApp.deliver(any())).thenReturn(true);
        PlatformImChannelConfigService configs = mock(PlatformImChannelConfigService.class);
        when(configs.selectedProvider()).thenReturn("DINGTALK");
        when(configs.isReady("DINGTALK")).thenReturn(true);
        UserImIdentityService identities = mock(UserImIdentityService.class);
        UserImIdentityDO identity = new UserImIdentityDO();
        identity.setExternalUserId("staff-001");
        when(identities.find(anyLong(), eq("DINGTALK"))).thenReturn(identity);
        PlatformBrandingService branding = mock(PlatformBrandingService.class);
        when(branding.effectivePublicBaseUrl()).thenReturn("https://auto.example.com");
        ImNotificationQueue queue = mock(ImNotificationQueue.class);
        NotifyChannel im = new PlatformImNotifyChannel(configs,
                new SystemNotificationImDispatcher(configs, identities, queue, branding));
        NotifyService imService = new NotifyService(dao, mock(NotifyPrefDao.class), List.of(inApp, im));
        return new ImFixture(imService, dao, queue);
    }

    @Test
    void workspaceScopedNotificationIsDroppedForADeletedWorkspace() {
        WorkspaceLivenessGuard liveness = mock(WorkspaceLivenessGuard.class);
        when(liveness.isActive(1L)).thenReturn(false);
        service.setWorkspaceLiveness(liveness);
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("EXTERNAL_COMMENT");
        event.setTitle("外部工单有新回复");
        event.setContent("外部用户：hello");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        // Neither the in-app row nor any IM copy may be produced for a workspace that is gone.
        verify(notificationDao, never()).insert(any());
        verify(inAppChannel, never()).deliver(any());
        verify(dingTalkChannel, never()).deliverBatch(any());
    }

    @Test
    void platformScopedNotificationStillDeliversWhenTheGuardIsPresent() {
        WorkspaceLivenessGuard liveness = mock(WorkspaceLivenessGuard.class);
        service.setWorkspaceLiveness(liveness);
        NotifyEvent event = new NotifyEvent();
        event.setScope(NotificationScope.PLATFORM);
        event.setTenantId(NotificationScope.PLATFORM_TENANT_ID);
        event.setType("USER_REGISTRATION_REVIEW");
        event.setTitle("有新用户注册，请审核");
        event.setContent("用户 A 提交了注册申请");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(notificationDao).insert(any());
        verify(inAppChannel).deliver(any());
        verify(liveness, never()).isActive(anyLong());
    }

    @Test
    void deferredImDeliveryIsRecheckedAtDeliveryTime() {
        // The workspace passed the first check but was deleted before the AFTER_COMMIT callback ran:
        // the in-app row exists, yet no IM message may leave.
        WorkspaceLivenessGuard liveness = mock(WorkspaceLivenessGuard.class);
        when(liveness.isActive(1L)).thenReturn(true, false);
        service.setWorkspaceLiveness(liveness);
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(1L);
        event.setType("DISPATCH_ALERT");
        event.setTitle("Dispatch failed");
        event.setContent("workitem 42 dispatch failed");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(notificationDao).insert(any());
        verify(inAppChannel).deliver(any());
        verify(dingTalkChannel, never()).deliverBatch(any());
    }

    @Test
    void workspaceScopeWithoutAUsableWorkspaceIdKeepsTheLegacyBehaviour() {
        service.setWorkspaceLiveness(mock(WorkspaceLivenessGuard.class));
        NotifyEvent event = new NotifyEvent();
        event.setTenantId(0L);
        event.setType("SYSTEM_ANNOUNCEMENT");
        event.setTitle("announcement");
        event.setContent("body");
        event.setRecipientIds(List.of(10L));

        service.notify(event);

        verify(notificationDao).insert(any());
    }

    private record ImFixture(NotifyService service, NotificationDao dao, ImNotificationQueue queue) {
    }
}
