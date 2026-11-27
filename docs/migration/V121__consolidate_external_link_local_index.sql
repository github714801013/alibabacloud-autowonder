-- Consolidate the V119 lookup index and the local identity constraint.
-- Existing installations with a different equivalent index keep their original definition.
-- Some managed MySQL services reject DROP INDEX and ADD INDEX in the same ALTER, so the
-- swap runs as two statements: drop first, then rebuild the unique index. Run both in one go:
-- between them the table has no local unique key. If the rebuild fails, run its ALTER manually.
SELECT
  MAX(CASE WHEN index_name = 'uk_local_workitem' AND non_unique = 0 THEN indexed_columns END),
  MAX(CASE WHEN index_name = 'idx_external_link_tenant_workitem' AND non_unique = 1 THEN indexed_columns END)
INTO @local_unique_columns, @v084_lookup_columns
FROM (
  SELECT index_name, non_unique,
         GROUP_CONCAT(COALESCE(column_name, '<expression>') ORDER BY seq_in_index) AS indexed_columns
  FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'external_workitem_link'
    AND index_name IN ('uk_local_workitem', 'idx_external_link_tenant_workitem')
    AND index_type = 'BTREE' AND is_visible = 'YES'
  GROUP BY index_name, non_unique
  HAVING COUNT(sub_part) = 0 AND COUNT(*) = SUM(collation = 'A')
) AS local_indexes;

SET @external_link_consolidation_drop = CASE
  WHEN @v084_lookup_columns = 'tenant_id,workitem_id' AND @local_unique_columns = 'tenant_id,provider,workitem_id'
    THEN 'ALTER TABLE external_workitem_link DROP INDEX uk_local_workitem, DROP INDEX idx_external_link_tenant_workitem, ALGORITHM=INPLACE, LOCK=NONE'
  WHEN @v084_lookup_columns = 'tenant_id,workitem_id' AND @local_unique_columns = 'tenant_id,workitem_id,provider'
    THEN 'ALTER TABLE external_workitem_link DROP INDEX idx_external_link_tenant_workitem, ALGORITHM=INPLACE, LOCK=NONE'
  ELSE 'SELECT 1'
END;
PREPARE external_link_consolidation_drop_stmt FROM @external_link_consolidation_drop;
EXECUTE external_link_consolidation_drop_stmt;
DEALLOCATE PREPARE external_link_consolidation_drop_stmt;

SET @external_link_consolidation_add = CASE
  WHEN @v084_lookup_columns = 'tenant_id,workitem_id' AND @local_unique_columns = 'tenant_id,provider,workitem_id'
    THEN 'ALTER TABLE external_workitem_link ADD UNIQUE INDEX uk_local_workitem (tenant_id, workitem_id, provider), ALGORITHM=INPLACE, LOCK=NONE'
  ELSE 'SELECT 1'
END;
PREPARE external_link_consolidation_add_stmt FROM @external_link_consolidation_add;
EXECUTE external_link_consolidation_add_stmt;
DEALLOCATE PREPARE external_link_consolidation_add_stmt;
