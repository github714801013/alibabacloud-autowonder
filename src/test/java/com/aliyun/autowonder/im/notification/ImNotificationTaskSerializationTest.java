package com.aliyun.autowonder.im.notification;

import com.aliyun.autowonder.notification.NotificationLink;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Regression tests for ImNotificationTask JSON round-trip through the ObjectMapper
 * used by RedisImNotificationQueue. A plain {@code new ObjectMapper()} must correctly
 * serialize and deserialize all ImNotificationTask variants without data loss.
 */
class ImNotificationTaskSerializationTest {

    private final ObjectMapper objectMapper = RedisImNotificationQueue.objectMapper();

    @Test
    void roundTripAssignedTask() throws JsonProcessingException {
        ImNotificationTask original = new ImNotificationTask(
                "92860:DINGTALK:10002",
                92860L,
                10002L,
                50460L,
                10002L,
                "HUMAN",
                10001L,
                "张三",
                "rid-1",
                "生产环境发布审批");

        String json = objectMapper.writeValueAsString(original);
        ImNotificationTask deserialized = objectMapper.readValue(json, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals(original.notificationKey(), deserialized.notificationKey());
        assertEquals(original.workitemEventId(), deserialized.workitemEventId());
        assertEquals(original.tenantId(), deserialized.tenantId());
        assertEquals(original.workitemId(), deserialized.workitemId());
        assertEquals(original.recipientUserId(), deserialized.recipientUserId());
        assertEquals(original.actorType(), deserialized.actorType());
        assertEquals(original.actorRef(), deserialized.actorRef());
        assertEquals(original.actorDisplayName(), deserialized.actorDisplayName());
        assertEquals(original.requestId(), deserialized.requestId());
        assertEquals(original.workitemTitle(), deserialized.workitemTitle());
        assertEquals("WORKITEM_ASSIGNED", deserialized.notificationType());
        assertNull(deserialized.commentContentMd());
        assertNull(deserialized.sourceType());
    }

    @Test
    void roundTripCommentMentionTask() throws JsonProcessingException {
        ImNotificationTask original = new ImNotificationTask(
                "COMMENT_MENTION:7001:DINGTALK:9",
                7001L,
                7L,
                42L,
                9L,
                "AGENT",
                40013L,
                "AW项目管理员",
                "rid-2",
                "生产环境发布审批",
                ImNotificationTask.TYPE_COMMENT_MENTION,
                "@李四 请确认");

        String json = objectMapper.writeValueAsString(original);
        ImNotificationTask deserialized = objectMapper.readValue(json, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals(original.notificationKey(), deserialized.notificationKey());
        assertEquals(ImNotificationTask.TYPE_COMMENT_MENTION, deserialized.notificationType());
        assertEquals("@李四 请确认", deserialized.commentContentMd());
        assertNull(deserialized.sourceType());
    }

    @Test
    void roundTripScheduledTaskRunMentionTask() throws JsonProcessingException {
        ImNotificationTask original = new ImNotificationTask(
                "COMMENT_MENTION:8001:DINGTALK:10",
                8001L,
                10002L,
                300L,
                10L,
                "AGENT",
                40013L,
                "定时执行者",
                null,
                "每日巡检",
                ImNotificationTask.TYPE_COMMENT_MENTION,
                "@运维 请确认",
                ImNotificationTask.SOURCE_SCHEDULED_TASK_RUN);

        String json = objectMapper.writeValueAsString(original);
        ImNotificationTask deserialized = objectMapper.readValue(json, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals(original.notificationKey(), deserialized.notificationKey());
        assertEquals(ImNotificationTask.TYPE_COMMENT_MENTION, deserialized.notificationType());
        assertEquals("@运维 请确认", deserialized.commentContentMd());
        assertEquals(ImNotificationTask.SOURCE_SCHEDULED_TASK_RUN, deserialized.sourceType());
        assertEquals(300L, deserialized.workitemId());
        assertNull(deserialized.requestId());
    }

    @Test
    void wecomTestTaskKeepsProviderTypeAndRecipientLocaleSnapshot() throws JsonProcessingException {
        ImNotificationTask original = new ImNotificationTask(
                "IM_TEST:abc:WECOM:9", 0L, 7L, 0L, 9L, "SYSTEM", 0L, null, null,
                "AutoWonder collaboration notification test succeeded",
                ImNotificationTask.TYPE_IM_TEST, "## body", null, "en-US", null, null);

        ImNotificationTask deserialized = objectMapper.readValue(
                objectMapper.writeValueAsString(original), ImNotificationTask.class);

        assertEquals("WECOM", deserialized.provider());
        org.junit.jupiter.api.Assertions.assertTrue(deserialized.isImTest());
        assertEquals(java.util.Locale.US, deserialized.deliveryLocale());
    }

    @Test
    void deserializesLegacyPayloadMissingSourceType() throws JsonProcessingException {
        String legacyJson = """
                {"notificationKey":"92860:DINGTALK:10002","workitemEventId":92860,\
                "tenantId":10002,"workitemId":50460,"recipientUserId":10002,\
                "actorType":"HUMAN","actorRef":10001,"actorDisplayName":"张三",\
                "requestId":"rid-1","workitemTitle":"生产环境发布审批",\
                "notificationType":"WORKITEM_ASSIGNED","commentContentMd":null}""";

        ImNotificationTask deserialized = objectMapper.readValue(legacyJson, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals("92860:DINGTALK:10002", deserialized.notificationKey());
        assertEquals("WORKITEM_ASSIGNED", deserialized.notificationType());
        assertNull(deserialized.sourceType());
    }

    @Test
    void deserializesMinimalPayloadWithOnlyOriginalFields() throws JsonProcessingException {
        String minimalJson = """
                {"notificationKey":"key-1","workitemEventId":100,"tenantId":7,\
                "workitemId":42,"recipientUserId":9,"actorType":"USER","actorRef":3,\
                "actorDisplayName":"张三","requestId":"rid-1","workitemTitle":"审批"}""";

        ImNotificationTask deserialized = objectMapper.readValue(minimalJson, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals("key-1", deserialized.notificationKey());
        assertEquals("WORKITEM_ASSIGNED", deserialized.notificationType());
        assertNull(deserialized.commentContentMd());
        assertNull(deserialized.sourceType());
    }

    @Test
    void unknownFieldsAreIgnoredEvenByStrictDefaultObjectMapper() throws JsonProcessingException {
        // A default ObjectMapper fails on unknown properties; only the @JsonIgnoreProperties
        // annotation on the record keeps this payload parseable.
        String futurePayload = """
                {"notificationKey":"key-1","workitemEventId":100,"tenantId":7,\
                "workitemId":42,"recipientUserId":9,"actorType":"USER","actorRef":3,\
                "actorDisplayName":"张三","requestId":"rid-1","workitemTitle":"审批",\
                "futureField":{"nested":true},"anotherNewField":"x"}""";

        ImNotificationTask deserialized =
                new ObjectMapper().readValue(futurePayload, ImNotificationTask.class);

        assertNotNull(deserialized);
        assertEquals("key-1", deserialized.notificationKey());
        assertEquals("WORKITEM_ASSIGNED", deserialized.notificationType());
        assertNull(deserialized.sourceType());
    }
    @Test
    void duplicateLinksRoundTripAndLegacyPayloadRemainsNull() throws Exception {
        ImNotificationTask original = new ImNotificationTask(
                "duplicate-intent:88:DINGTALK:2", 88L, 1L, 55L, 2L,
                "SYSTEM", 0L, "数字员工", null, "重复提醒",
                ImNotificationTask.TYPE_DUPLICATE_INTENT, "新旧标题")
                .withRelatedLinks(List.of(
                        new NotificationLink("SUBMITTED", "new", "/workitems/55?workspaceId=1"),
                        new NotificationLink("DUPLICATE", "old", "/workitems/2?workspaceId=1")))
                .withRecipientLocale("en-US");

        String json = objectMapper.writeValueAsString(original);
        ImNotificationTask deserialized = objectMapper.readValue(json, ImNotificationTask.class);

        assertEquals("en-US", deserialized.recipientLocale());
        assertEquals(original.relatedLinks(), deserialized.relatedLinks());
        assertEquals(2, deserialized.relatedLinks().size());
        assertEquals("old", deserialized.relatedLinks().get(1).title());

        String legacy = "{\"notificationKey\":\"1:FEISHU:9\",\"workitemEventId\":1,\"tenantId\":7,"
                + "\"workitemId\":42,\"recipientUserId\":9,\"actorType\":\"AGENT\",\"actorRef\":3,"
                + "\"actorDisplayName\":\"数字人\",\"requestId\":null,\"workitemTitle\":\"raw\","
                + "\"notificationType\":\"DUPLICATE_INTENT\",\"commentContentMd\":null,\"sourceType\":null}";
        ImNotificationTask oldTask = objectMapper.readValue(legacy, ImNotificationTask.class);
        assertNull(oldTask.relatedLinks());
        // 旧载荷重新序列化时不能凭空新增字段，否则滚动升级中的旧消费者会看到不同载荷。
        assertFalse(objectMapper.writeValueAsString(oldTask).contains("relatedLinks"));
    }

    @Test
    void optionalSnapshotAndOriginsRoundTripButOldJsonAndHelpersRemainExact() throws Exception {
        String literal = "{\"notificationKey\":\"1:FEISHU:9\",\"workitemEventId\":1,\"tenantId\":7,\"workitemId\":42,\"recipientUserId\":9,\"actorType\":\"AGENT\",\"actorRef\":3,\"actorDisplayName\":\"数字人\",\"requestId\":null,\"workitemTitle\":\"raw\",\"notificationType\":\"COMMENT_MENTION\",\"commentContentMd\":null,\"sourceType\":\"SCHEDULED_TASK_RUN\"}";
        for (ObjectMapper mapper : java.util.List.of(new ObjectMapper(), objectMapper)) {
            var legacy = mapper.readValue(literal, ImNotificationTask.class);
            assertEquals(literal, mapper.writeValueAsString(legacy));
            org.junit.jupiter.api.Assertions.assertEquals(java.util.Locale.CHINA, legacy.deliveryLocale());
            var tree = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(literal);
            tree.put("recipientLocale", "en-US").put("actorNameKind", "AGENT_NAME_FALLBACK").put("workitemTitleKind", "SCHEDULED_RUN_ID_FALLBACK");
            var task = mapper.treeToValue(tree, ImNotificationTask.class);
            assertEquals(tree, mapper.readTree(mapper.writeValueAsString(task)));
            assertEquals("FEISHU", task.provider()); org.junit.jupiter.api.Assertions.assertTrue(task.isScheduledTaskRun());
            assertEquals(java.util.Locale.US, task.deliveryLocale());
            org.junit.jupiter.api.Assertions.assertFalse(mapper.valueToTree(task).has("deliveryLocale"));
            tree.putObject("futureField").put("nested", true);
            assertEquals(task, mapper.treeToValue(tree, ImNotificationTask.class));
        }
    }

    @Test
    void roundTripsOptionalLinksAndKeepsLegacyPayloadExact() throws Exception {
        ImNotificationTask original = new ImNotificationTask(
                "dispatch-request:1:WECOM:9", 1L, 7L, 42L, 9L,
                "SYSTEM", 0L, "数字员工", null, "验收工单",
                ImNotificationTask.TYPE_INPUT_REQUIRED, "请确认以下范围")
                .withRelatedLinks(List.of(new NotificationLink("DETAIL", "验收工单",
                        "/workitems/42?workspaceId=7&panel=clarify&fullscreen=1&agent=10035&conversation=99")));

        ImNotificationTask deserialized = objectMapper.readValue(
                objectMapper.writeValueAsString(original), ImNotificationTask.class);

        assertEquals(original.relatedLinks(), deserialized.relatedLinks());
        assertEquals(original.relatedLinks(), original.withRecipientLocale("en-US").relatedLinks());
        ImNotificationTask legacy = objectMapper.readValue("""
                {"notificationKey":"92860:DINGTALK:10002","workitemEventId":92860,\
                "tenantId":10002,"workitemId":50460,"recipientUserId":10002,\
                "actorType":"HUMAN","actorRef":10001,"actorDisplayName":"张三",\
                "requestId":"rid-1","workitemTitle":"生产环境发布审批",\
                "notificationType":"WORKITEM_ASSIGNED","commentContentMd":null}""",
                ImNotificationTask.class);
        assertNull(legacy.relatedLinks());
        assertFalse(objectMapper.writeValueAsString(legacy).contains("\"relatedLinks\""));
    }

    @Test
    void systemNotificationSnapshotRoundTripsWithoutChangingItsProviderKey() throws Exception {
        ImNotificationTask original = ImNotificationTask.systemNotification("system-notification:88:FEISHU:9", 88L, 0L,
                9L, "USER_REGISTRATION_REVIEW", "en-US", "有新用户注册，请审核", "用户 A 提交了注册申请",
                "https://auto.example.com/workspaces/branding",
                List.of(new NotificationLink("SUBMITTED", "new", "https://auto.example.com/workitems/55")));

        ImNotificationTask deserialized = objectMapper.readValue(
                objectMapper.writeValueAsString(original), ImNotificationTask.class);

        assertEquals(original, deserialized);
        assertEquals(88L, deserialized.notificationId());
        assertEquals("有新用户注册，请审核", deserialized.notificationTitle());
        assertEquals("用户 A 提交了注册申请", deserialized.notificationContent());
        assertEquals("https://auto.example.com/workspaces/branding", deserialized.notificationLink());
        assertEquals("FEISHU", deserialized.provider());
        assertEquals("en-US", deserialized.recipientLocale());
        org.junit.jupiter.api.Assertions.assertTrue(deserialized.bypassesLegacyImPreference());
        org.junit.jupiter.api.Assertions.assertTrue(deserialized.hasNotificationSnapshot());
    }

    @Test
    void legacyPayloadKeepsCompatibleDefaultsAndTheFlagSurvivesWithers() {
        String legacy = "{\"notificationKey\":\"COMMENT_MENTION:7001:DINGTALK:9\",\"workitemEventId\":7001,"
                + "\"tenantId\":7,\"workitemId\":42,\"recipientUserId\":9,\"actorType\":\"AGENT\","
                + "\"actorRef\":40013,\"actorDisplayName\":\"AW项目管理员\",\"workitemTitle\":\"发布审批\","
                + "\"notificationType\":\"COMMENT_MENTION\",\"commentContentMd\":\"@李四 请确认\"}";
        ImNotificationTask task;
        try {
            task = objectMapper.readValue(legacy, ImNotificationTask.class);
        } catch (JsonProcessingException e) {
            throw new AssertionError(e);
        }

        assertNull(task.notificationId());
        assertNull(task.notificationTitle());
        // 旧载荷不带快照字段，provider 仍由队列键解析，行为与旧消费者一致。
        assertEquals("DINGTALK", task.provider());
        assertFalse(task.bypassesLegacyImPreference());
        assertFalse(task.hasNotificationSnapshot());

        ImNotificationTask flagged = task.withRecipientLocale("en-US")
                .withRelatedLinks(List.of(new NotificationLink("SUBMITTED", "new", "/workitems/42")))
                .withSystemNotification(true);
        org.junit.jupiter.api.Assertions.assertTrue(flagged.bypassesLegacyImPreference());
        assertEquals("en-US", flagged.recipientLocale());
        assertEquals(1, flagged.relatedLinks().size());
        // 旧链路任务保留原有富内容，只增加“默认同步”标记。
        assertEquals("@李四 请确认", flagged.commentContentMd());
        assertEquals("DINGTALK", flagged.provider());
        assertFalse(flagged.hasNotificationSnapshot());
        assertFalse(task.withSystemNotification(null).bypassesLegacyImPreference());

        org.junit.jupiter.api.Assertions.assertTrue(ImNotificationTask.systemNotification(
                "system-notification:88:FEISHU:9", 88L, 7L, 9L, "USER_REGISTRATION_REVIEW", null,
                null, "仅正文", null, null).hasNotificationSnapshot());
        org.junit.jupiter.api.Assertions.assertTrue(ImNotificationTask.systemNotification(
                "system-notification:88:FEISHU:9", 88L, 7L, 9L, "USER_REGISTRATION_REVIEW", null,
                null, null, "/workspaces", null).hasNotificationSnapshot());
    }
}
