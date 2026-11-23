-- down/000049_remove_topic_map_document_family.sql
--
-- Reverses 000049_add_topic_map_document_family.sql: removes the
-- Delphi_TopicMapDocument row from delphi_result_catalog. Never run
-- automatically.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000049_remove_topic_map_document_family.sql
--
-- Refuses, changing nothing, while any result batch holds the family (stored
-- results are immutable, so a run that stored a map keeps it, and the family
-- with it), or when the row is not the one 000049 inserted. The family table
-- is held first, so a family insert still in flight either commits before the
-- check (and the check sees it) or waits and then fails on the missing row.
-- Runner history is not edited here; the operator removes the 000049 history
-- row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='200ms';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.delphi_result_families IN SHARE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delphi_result_families WHERE family='Delphi_TopicMapDocument') THEN
  RAISE EXCEPTION 'a result batch holds Delphi_TopicMapDocument; stored results are immutable';
 END IF;
END $$;
DO $$ DECLARE n integer; BEGIN
 DELETE FROM public.delphi_result_catalog WHERE family='Delphi_TopicMapDocument'
  AND key_spec='[["conversation_id", "S"], ["part", "S"]]'::jsonb;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'Delphi_TopicMapDocument is not the row 000049 inserted'; END IF;
END $$;
COMMIT;
