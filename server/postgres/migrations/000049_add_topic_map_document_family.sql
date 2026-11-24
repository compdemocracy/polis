-- 000049_add_topic_map_document_family.sql
--
-- One data row in an existing table: the result family Delphi_TopicMapDocument
-- in public.delphi_result_catalog (000028), keyed (conversation_id S, part S).
-- A Delphi run that is told to (DELPHI_TOPIC_MAP_DOCUMENT=1) stores its topic
-- map in its own result batch under this family, so the batch publishes the
-- map with the rest of the run or not at all. Without the row,
-- pd_result_put_family refuses the family and such a run fails. No table,
-- column, index, constraint, function, trigger or grant changes; every
-- existing catalog row and every stored result stays as it is.
--
-- Compatibility: additive. No earlier release writes or reads the family, so
-- each one runs as before beside the row.
--
-- Locks. The INSERT takes ROW EXCLUSIVE on delphi_result_catalog until COMMIT,
-- milliseconds. That conflicts only with SHARE and stronger locks, which no
-- reader or writer of the table takes: pd_result_insert_family and
-- pd_result_mutate read it (ACCESS SHARE), and a family insert's foreign key
-- locks the catalog row it names (FOR KEY SHARE), never this new one. Nothing
-- on the vote, comment or next-comment path reads the table. lock_timeout is
-- 200 ms: if anything ever holds a conflicting lock, this file gives up with
-- nothing changed (no row, no history row) and the deploy is run again.
BEGIN;
SET LOCAL lock_timeout='200ms';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
INSERT INTO public.delphi_result_catalog VALUES('Delphi_TopicMapDocument','[["conversation_id", "S"], ["part", "S"]]'::jsonb);
COMMIT;
