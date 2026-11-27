package com.aliyun.autowonder.dispatch;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DispatchRuntimeEventDaoContractTest {

    @Test
    void progressProjectionPreservesPlansHistoryAndIsolationInBothSchemas() throws Exception {
        for (String databaseId : java.util.List.of("autowonder-source-aware", "autowonder-legacy")) {
            org.apache.ibatis.session.Configuration config = new org.apache.ibatis.session.Configuration();
            config.setDatabaseId(databaseId);
            try (var input = getClass().getResourceAsStream("/mapping/DispatchRuntimeEventDao.xml")) {
                new org.apache.ibatis.builder.xml.XMLMapperBuilder(input, config,
                        "mapping/DispatchRuntimeEventDao.xml", config.getSqlFragments()).parse();
            }
            assertTrue(config.hasStatement(DispatchRuntimeEventDao.class.getName() + ".streamForProgress"));
            String sql = config.getMappedStatement(DispatchRuntimeEventDao.class.getName() + ".streamForProgress")
                    .getBoundSql(java.util.Map.of("tenantId", 7L, "workitemId", 100L)).getSql();
            assertTrue(sql.contains("CASE WHEN event_type IN ('workflow.plan_applied', 'step.timing', 'step.started') THEN detail_json ELSE NULL END"));
            assertTrue(sql.contains("e.tenant_id = ? AND e.workitem_id = ?"));
            assertTrue(sql.contains("d.id = e.dispatch_id"));
            assertTrue(sql.contains("d.is_deleted = 0"));
            assertTrue(sql.contains("ORDER BY id ASC"));
            assertFalse(sql.contains("LIMIT"));
            assertTrue(sql.contains("d.source_type = 'WORKITEM'") == databaseId.equals("autowonder-source-aware"));
            try (var db = java.sql.DriverManager.getConnection("jdbc:h2:mem:progress-" + databaseId);
                 var schema = db.createStatement()) {
                schema.execute("CREATE TABLE dispatch(id BIGINT, tenant_id BIGINT, workitem_id BIGINT, source_type VARCHAR, is_deleted INT)");
                schema.execute("INSERT INTO dispatch VALUES(10,7,100,'WORKITEM',0)");
                schema.execute("CREATE TABLE dispatch_runtime_event(id BIGINT, tenant_id BIGINT, workitem_id BIGINT, dispatch_id BIGINT, agent_id BIGINT, event_id VARCHAR, seq BIGINT, event_type VARCHAR, step_id BIGINT, step_key VARCHAR, step_order INT, step_name VARCHAR, message VARCHAR, error VARCHAR, detail_json VARCHAR, event_time TIMESTAMP, gmt_create TIMESTAMP)");
                schema.execute("INSERT INTO dispatch_runtime_event(id,tenant_id,workitem_id,dispatch_id,event_type,detail_json) VALUES(1,7,100,10,'step.timing','timing'),(2,7,100,10,'workflow.plan_applied','plan'),(3,7,100,10,'agent.message','private'),(4,7,100,10,'step.started','{\"stepAttempt\":2}')");
                try (var query = db.prepareStatement(sql)) {
                    query.setLong(1, 7); query.setLong(2, 100); query.setLong(3, 7); query.setLong(4, 100);
                    try (var rows = query.executeQuery()) {
                        assertTrue(rows.next()); org.junit.jupiter.api.Assertions.assertEquals("timing", rows.getString("detail_json"));
                        assertTrue(rows.next()); org.junit.jupiter.api.Assertions.assertEquals("plan", rows.getString("detail_json"));
                        assertTrue(rows.next()); org.junit.jupiter.api.Assertions.assertNull(rows.getString("detail_json"));
                        assertTrue(rows.next()); org.junit.jupiter.api.Assertions.assertEquals("{\"stepAttempt\":2}", rows.getString("detail_json"));
                    }
                }
            }
            String fullSql = config.getMappedStatement(DispatchRuntimeEventDao.class.getName() + ".listByWorkitem")
                    .getBoundSql(java.util.Map.of("tenantId", 7L, "workitemId", 100L)).getSql();
            assertFalse(fullSql.contains("CASE WHEN"));
        }
    }

    @Test
    void workitemTimelineRequiresMatchingWorkitemDispatchSource() throws Exception {
        String xml = new String(getClass().getResourceAsStream(
                "/mapping/DispatchRuntimeEventDao.xml").readAllBytes(), StandardCharsets.UTF_8);
        int start = xml.indexOf("id=\"listByWorkitem\"");
        int end = xml.indexOf("</select>", start);
        String sql = xml.substring(start, end);

        assertTrue(sql.contains("EXISTS"));
        assertTrue(sql.contains("d.tenant_id = #{tenantId}"));
        assertTrue(sql.contains("d.source_type = 'WORKITEM'"));
        assertTrue(sql.contains("d.workitem_id = #{workitemId}"));
        assertTrue(sql.contains("d.id = e.dispatch_id"));
    }

    @Test
    void traceProjectionExcludesAgentMessagesAndKeepsArrivalOrder() throws Exception {
        String xml = new String(getClass().getResourceAsStream(
                "/mapping/DispatchRuntimeEventDao.xml").readAllBytes(), StandardCharsets.UTF_8);
        int start = xml.indexOf("id=\"listByDispatchForTrace\"");
        assertTrue(start >= 0, "listByDispatchForTrace select must exist");
        int end = xml.indexOf("</select>", start);
        String sql = xml.substring(start, end).replace("&lt;", "<").replace("&gt;", ">");

        assertTrue(sql.contains("tenant_id = #{tenantId}"));
        assertTrue(sql.contains("dispatch_id = #{dispatchId}"));
        assertTrue(sql.contains("event_type <> 'agent.message'"));
        assertTrue(sql.contains("ORDER BY id ASC"));

        int latestStart = xml.indexOf("id=\"findLatestIdForTrace\"");
        assertTrue(latestStart >= 0, "findLatestIdForTrace select must exist");
        String latestSql = xml.substring(latestStart, xml.indexOf("</select>", latestStart))
                .replace("&lt;", "<").replace("&gt;", ">");
        assertTrue(latestSql.contains("MAX(id)"));
        assertTrue(latestSql.contains("event_type <> 'agent.message'"));
        assertTrue(latestSql.contains("tenant_id = #{tenantId}"));
        assertTrue(latestSql.contains("dispatch_id = #{dispatchId}"));
    }

    @Test
    void activityTimelineUsesPersistentArrivalOrderWithoutSequenceFallback() throws Exception {
        String xml = new String(getClass().getResourceAsStream(
                "/mapping/DispatchRuntimeEventDao.xml").readAllBytes(), StandardCharsets.UTF_8);
        int start = xml.indexOf("id=\"listByDispatchInArrivalOrder\"");
        int end = xml.indexOf("</select>", start);
        String sql = xml.substring(start, end);

        assertTrue(sql.contains("ORDER BY id ASC"));
        assertFalse(sql.contains("COALESCE(seq, id)"));
    }

    @Test
    void dispatchAfterIdCursorRequiresTenantIsolationAndStrictlyGreaterId() throws Exception {
        String xml = new String(getClass().getResourceAsStream(
                "/mapping/DispatchRuntimeEventDao.xml").readAllBytes(), StandardCharsets.UTF_8);
        int start = xml.indexOf("id=\"listByDispatchAfterId\"");
        assertTrue(start >= 0, "listByDispatchAfterId select must exist");
        int end = xml.indexOf("</select>", start);
        assertTrue(end > start, "listByDispatchAfterId select must be closed");
        String sql = xml.substring(start, end);
        String normalized = sql.replace("&gt;", ">").replace("&lt;", "<");

        assertTrue(normalized.contains("tenant_id = #{tenantId}"));
        assertTrue(normalized.contains("dispatch_id = #{dispatchId}"));
        assertTrue(normalized.contains("id > #{afterId}"));
        assertFalse(normalized.contains("id >= #{afterId}"),
                "afterId cursor must be strictly greater, otherwise reconnect re-delivers the cursor row");
        assertTrue(normalized.contains("ORDER BY id ASC"));
        assertFalse(normalized.contains("COALESCE(seq, id)"),
                "failover re-runs restart the runtime-numbered seq, so the cursor must follow arrival id");
        assertFalse(sql.contains("${"));
    }
}
