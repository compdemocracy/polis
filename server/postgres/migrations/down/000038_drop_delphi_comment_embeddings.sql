-- down/000038_drop_delphi_comment_embeddings.sql
--
-- Reverses 000038_create_delphi_comment_embeddings.sql: drops its three tables
-- and nine functions. Nothing that existed before 000038 is touched.
--
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/postgres/migrations/down/000038_drop_delphi_comment_embeddings.sql
--
-- Refuses, changing nothing, while any embedding or embedding set is stored:
-- rolling back what is served is a pointer change (an earlier set or
-- generation), never a drop. Runner history is not edited here; the operator
-- removes the 000038 history row in the same sitting, after this succeeds.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
-- Hold both tables before checking, so a put that is still in flight either
-- commits first (and the check sees its rows) or waits and then fails.
LOCK TABLE public.delphi_comment_embeddings,public.delphi_embedding_sets IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delphi_comment_embeddings) OR EXISTS(SELECT 1 FROM public.delphi_embedding_sets) THEN
  RAISE EXCEPTION 'embeddings are stored; roll back by pointer, not by drop';
 END IF;
END $$;
DROP FUNCTION public.pd_embedding_rows(text,uuid,text),public.pd_embedding_served(text,integer,text,text),
 public.pd_embedding_set(text,uuid,text),public.pd_embedding_close(text,uuid,uuid,uuid,bigint,text),
 public.pd_embedding_put(text,uuid,uuid,uuid,bigint,text,integer[],bytea[],real[]),
 public.pd_embedding_receipt(public.delphi_embedding_sets),public.pd_embedding_batch(text,uuid,uuid,text),
 public.pd_embedding_prune(text,text,integer,text,integer);
DROP TABLE public.delphi_embedding_sets,public.delphi_comment_embeddings,public.delphi_embedding_models;
DROP FUNCTION public.pd_embedding_immutable();
COMMIT;
