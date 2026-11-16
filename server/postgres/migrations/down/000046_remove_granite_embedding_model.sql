-- down/000046_remove_granite_embedding_model.sql
--
-- Reverses 000046_add_granite_embedding_model.sql: removes model_id 2 from
-- delphi_embedding_models. Never run automatically.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000046_remove_granite_embedding_model.sql
--
-- Refuses, changing nothing, while any embedding or embedding set is stored
-- under model_id 2 (pd_embedding_prune's model mode removes them first), or
-- when model_id 2 is not the row 000046 inserted. The row is immutable by
-- trigger (embedding_model_immutable, 000038), so the delete runs with that
-- trigger disabled inside this transaction, and it is enabled again before
-- COMMIT. Runner history is not edited here; the operator removes the 000046
-- history row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- Hold the tables that reference the row before checking, so a put that is
-- still in flight either commits first (and the check sees its rows) or waits
-- and then fails.
LOCK TABLE public.delphi_comment_embeddings,public.delphi_embedding_sets IN SHARE MODE;
LOCK TABLE public.delphi_embedding_models IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delphi_comment_embeddings WHERE model_id=2)
  OR EXISTS(SELECT 1 FROM public.delphi_embedding_sets WHERE model_id=2) THEN
  RAISE EXCEPTION 'embeddings are stored under model_id 2; prune that model first';
 END IF;
END $$;
ALTER TABLE public.delphi_embedding_models DISABLE TRIGGER embedding_model_immutable;
DO $$ DECLARE n integer; BEGIN
 DELETE FROM public.delphi_embedding_models WHERE model_id=2 AND dims=384
  AND name='ibm-granite/granite-embedding-311m-multilingual-r2@44399559930365213510b1ee2eb15ded83374f0e:384';
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'model_id 2 is not the row 000046 inserted'; END IF;
END $$;
ALTER TABLE public.delphi_embedding_models ENABLE TRIGGER embedding_model_immutable;
COMMIT;
