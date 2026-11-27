package com.aliyun.autowonder.im.notification;

import com.aliyun.autowonder.dispatch.ExecutionSourceType;
import com.aliyun.autowonder.notification.NotificationLink;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Locale;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

// Mirrors the queue mapper's FAIL_ON_UNKNOWN_PROPERTIES=false so any other ObjectMapper also
// survives producer-side field additions; this was the root cause class of the silent-drop incident.
@JsonIgnoreProperties(ignoreUnknown = true)
public record ImNotificationTask(
        String notificationKey,
        long workitemEventId,
        long tenantId,
        long workitemId,
        long recipientUserId,
        String actorType,
        long actorRef,
        String actorDisplayName,
        String requestId,
        String workitemTitle,
        String notificationType,
        String commentContentMd,
        String sourceType,
        @JsonInclude(JsonInclude.Include.NON_NULL) String recipientLocale,
        @JsonInclude(JsonInclude.Include.NON_NULL) String actorNameKind,
        @JsonInclude(JsonInclude.Include.NON_NULL) String workitemTitleKind,
        @JsonInclude(JsonInclude.Include.NON_NULL) List<NotificationLink> relatedLinks,
        // Generic system-notification snapshot fields. All optional so queued payloads written
        // before this change keep deserializing and rendering exactly as they did.
        @JsonInclude(JsonInclude.Include.NON_NULL) Long notificationId,
        @JsonInclude(JsonInclude.Include.NON_NULL) String notificationTitle,
        @JsonInclude(JsonInclude.Include.NON_NULL) String notificationContent,
        @JsonInclude(JsonInclude.Include.NON_NULL) String notificationLink,
        @JsonInclude(JsonInclude.Include.NON_NULL) Boolean systemNotification) {

    public static final String TYPE_WORKITEM_ASSIGNED = "WORKITEM_ASSIGNED";
    public static final String TYPE_COMMENT_MENTION = "COMMENT_MENTION";
    public static final String TYPE_APPROVAL_REQUIRED = "WORKITEM_APPROVAL_REQUIRED";
    public static final String TYPE_INPUT_REQUIRED = "WORKITEM_INPUT_REQUIRED";
    public static final String TYPE_CLARIFICATION_REPLY = "WORKITEM_CLARIFICATION_REPLY";
    public static final String TYPE_WORKSPACE_ACCESS_REQUEST = "WORKSPACE_ACCESS_REQUEST";
    public static final String TYPE_WORKSPACE_ACCESS_REVIEWED = "WORKSPACE_ACCESS_REVIEWED";
    public static final String TYPE_DUPLICATE_INTENT = "DUPLICATE_INTENT";
    public static final String TYPE_IM_TEST = "IM_TEST";
    public static final String WORKITEM_TITLE_KIND_PRE_RENDERED = "PRE_RENDERED";
    public static final String SOURCE_SCHEDULED_TASK_RUN = ExecutionSourceType.SCHEDULED_TASK_RUN.name();
    /** Marks a workspace-access task as the cancellation variant so the formatter picks its own copy. */
    public static final String SOURCE_ACCESS_CANCELLED = "CANCELLED";

    public ImNotificationTask(String notificationKey,
                              long workitemEventId,
                              long tenantId,
                              long workitemId,
                              long recipientUserId,
                              String actorType,
                              long actorRef,
                              String actorDisplayName,
                              String requestId,
                              String workitemTitle) {
        this(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId, actorType, actorRef,
                actorDisplayName, requestId, workitemTitle, TYPE_WORKITEM_ASSIGNED, null, null);
    }

    public ImNotificationTask(String notificationKey,
                              long workitemEventId,
                              long tenantId,
                              long workitemId,
                              long recipientUserId,
                              String actorType,
                              long actorRef,
                              String actorDisplayName,
                              String requestId,
                              String workitemTitle,
                              String notificationType,
                              String commentContentMd) {
        this(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId, actorType, actorRef,
                actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd, null);
    }

    public ImNotificationTask(String notificationKey, long workitemEventId, long tenantId, long workitemId,
            long recipientUserId, String actorType, long actorRef, String actorDisplayName, String requestId,
            String workitemTitle, String notificationType, String commentContentMd, String sourceType) {
        this(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId, actorType, actorRef,
                actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd, sourceType,
                null, null, null, null);
    }

    /** Pre-snapshot arity kept for the dedicated IM listeners that build work-item tasks. */
    public ImNotificationTask(String notificationKey, long workitemEventId, long tenantId, long workitemId,
            long recipientUserId, String actorType, long actorRef, String actorDisplayName, String requestId,
            String workitemTitle, String notificationType, String commentContentMd, String sourceType,
            String recipientLocale, String actorNameKind, String workitemTitleKind,
            List<NotificationLink> relatedLinks) {
        this(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId, actorType, actorRef,
                actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd, sourceType,
                recipientLocale, actorNameKind, workitemTitleKind, relatedLinks,
                null, null, null, null, null);
    }

    public ImNotificationTask(String notificationKey, long workitemEventId, long tenantId, long workitemId,
            long recipientUserId, String actorType, long actorRef, String actorDisplayName, String requestId,
            String workitemTitle, String notificationType, String commentContentMd, String sourceType,
            String recipientLocale, String actorNameKind, String workitemTitleKind) {
        this(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId, actorType, actorRef,
                actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd, sourceType,
                recipientLocale, actorNameKind, workitemTitleKind, null);
    }

    /**
     * A queued system notification: everything needed to render it without loading work item or
     * workspace. The provider stays encoded in the key as {@code system-notification:id:PROVIDER:recipient}.
     */
    public static ImNotificationTask systemNotification(String notificationKey, Long notificationId, long tenantId,
            long recipientUserId, String notificationType, String recipientLocale, String title, String content,
            String link, List<NotificationLink> relatedLinks) {
        return new ImNotificationTask(notificationKey, 0L, tenantId, 0L, recipientUserId, "SYSTEM", 0L,
                null, null, null, notificationType, null, null, recipientLocale, null, null, relatedLinks,
                notificationId, title, content, link, Boolean.TRUE);
    }

    public ImNotificationTask withRecipientLocale(String locale) {
        return new ImNotificationTask(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId,
                actorType, actorRef, actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd,
                sourceType, locale, actorNameKind, workitemTitleKind, relatedLinks,
                notificationId, notificationTitle, notificationContent, notificationLink, systemNotification);
    }

    public ImNotificationTask withRelatedLinks(List<NotificationLink> links) {
        return new ImNotificationTask(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId,
                actorType, actorRef, actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd,
                sourceType, recipientLocale, actorNameKind, workitemTitleKind, links,
                notificationId, notificationTitle, notificationContent, notificationLink, systemNotification);
    }

    public ImNotificationTask withSystemNotification(Boolean value) {
        return new ImNotificationTask(notificationKey, workitemEventId, tenantId, workitemId, recipientUserId,
                actorType, actorRef, actorDisplayName, requestId, workitemTitle, notificationType, commentContentMd,
                sourceType, recipientLocale, actorNameKind, workitemTitleKind, relatedLinks,
                notificationId, notificationTitle, notificationContent, notificationLink, value);
    }

    @JsonIgnore
    public Locale deliveryLocale() {
        return "en-US".equals(recipientLocale) ? Locale.US : Locale.CHINA;
    }

    public ImNotificationTask {
        if (notificationType == null || notificationType.isBlank()) {
            notificationType = TYPE_WORKITEM_ASSIGNED;
        }
        relatedLinks = relatedLinks == null ? null : List.copyOf(relatedLinks);
    }

    @JsonIgnore
    public String provider() {
        // Existing queue keys encode provider immediately before recipient id.
        String[] parts = notificationKey == null ? new String[0] : notificationKey.split(":");
        String candidate = parts.length >= 3 ? parts[parts.length - 2] : "";
        return "FEISHU".equals(candidate) || "WECOM".equals(candidate) ? candidate : "DINGTALK";
    }

    @JsonIgnore
    public boolean isImTest() {
        return TYPE_IM_TEST.equals(notificationType);
    }

    /** 入队时已按接收者语言渲染，格式化阶段直接使用快照内容。 */
    @JsonIgnore
    public boolean isPreRendered() {
        return isImTest() || WORKITEM_TITLE_KIND_PRE_RENDERED.equals(workitemTitleKind);
    }

    @JsonIgnore
    public boolean isScheduledTaskRun() {
        return SOURCE_SCHEDULED_TASK_RUN.equals(sourceType);
    }

    /**
     * Default-on system notifications bypass the legacy personal and workspace IM switches.
     * Deliberately not named {@code isSystemNotification}: that would shadow the record component's
     * JSON property, and Jackson would then drop the flag from the queue payload.
     */
    @JsonIgnore
    public boolean bypassesLegacyImPreference() {
        return Boolean.TRUE.equals(systemNotification);
    }

    /** True when the payload carries its own rendering snapshot instead of needing work-item lookups. */
    @JsonIgnore
    public boolean hasNotificationSnapshot() {
        return notificationTitle != null || notificationContent != null || notificationLink != null;
    }
}
