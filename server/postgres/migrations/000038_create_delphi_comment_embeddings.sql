-- Comment embeddings as one row per (conversation, model, comment). Additive
-- only: no existing table, row, function, view or grant changes meaning, and no
-- current writer or reader calls anything defined here.
--
-- Today Delphi_CommentEmbeddings is one codec_wire text value per run (000028),
-- bounded at 64 MiB, which about 5,950 comments of 384 floats already exceed.
-- Here each embedding is stored once as a real[] row. A comment's text does not
-- change, so a run only adds the comments it has not seen; what a run publishes
-- is an embedding set: every row for (env, zid, model) whose seq is at or below
-- the set's seq_mark. A set belongs to the run's result batch and is closed
-- before the batch is sealed, so the existing served pointer (delphi_graph_served)
-- publishes it with the run's families. Later runs only add rows with a higher
-- seq, so a closed set never changes. Rows and sets are never updated, and are
-- deleted only through pd_embedding_prune (superseded sets, orphaned rows, a
-- whole conversation, or a retired model).
--
-- real[] rather than pgvector's vector(384): the dev, CI and fresh-database
-- images (postgres:17-alpine, postgres:17.11) have no vector extension. The
-- same bytes convert later with
--   ALTER TABLE public.delphi_comment_embeddings
--    ALTER COLUMN embedding TYPE vector USING embedding::vector;
-- once the extension exists everywhere this chain runs.
--
-- Locks. New objects only, plus foreign keys that take SHARE ROW EXCLUSIVE on
-- public.conversations and public.delphi_result_batches until COMMIT (writes
-- to those tables wait; reads do not). The migration does no data work and
-- completes in milliseconds; an open writer transaction makes it wait
-- lock_timeout (5 s) and fail with no history row, and the deploy can be retried.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;

-- Rows and sets refuse UPDATE always, and DELETE unless the session is inside
-- pd_embedding_prune, which turns this setting on for its own deletes and off
-- again before it returns (an error inside it rolls the setting back with the
-- deletes; a function SET clause cannot carry a custom setting for a
-- non-superuser owner). Only the owner holds DELETE on these tables, so this guards
-- against a stray DELETE; it is not a privilege boundary.
CREATE FUNCTION public.pd_embedding_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('polis.pd_embedding_prune',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'immutable graph result';
END $$;

-- A new model, or new weights under an old name, is a new row and a new set of
-- embeddings beside the old ones; the served set changes by pointer.
CREATE TABLE public.delphi_embedding_models(
 model_id smallint PRIMARY KEY CHECK(model_id>0),
 name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 200),
 dims smallint NOT NULL CHECK(dims BETWEEN 1 AND 2000)
);
INSERT INTO public.delphi_embedding_models VALUES(1,'sentence-transformers/all-MiniLM-L6-v2',384);
CREATE TRIGGER embedding_model_immutable BEFORE UPDATE OR DELETE ON public.delphi_embedding_models
 FOR EACH ROW EXECUTE FUNCTION public.pd_graph_immutable();

-- text_sha is SHA-256 of the UTF-8 comment text that was embedded. batch_id
-- records the attempt that first wrote the row, as provenance only: it has no
-- foreign key, because a row outlives that run and must not keep its result
-- batch from being pruned. seq orders rows within (env, zid, model)
-- in commit order, because every write to one (env, zid, model) is serialized.
CREATE TABLE public.delphi_comment_embeddings(
 env text NOT NULL,
 zid integer NOT NULL REFERENCES public.conversations(zid),
 model_id smallint NOT NULL REFERENCES public.delphi_embedding_models,
 tid integer NOT NULL CHECK(tid>=0),
 seq bigint GENERATED ALWAYS AS IDENTITY,
 text_sha bytea NOT NULL CHECK(octet_length(text_sha)=32),
 embedding real[] NOT NULL CHECK(array_ndims(embedding)=1 AND array_lower(embedding,1)=1
  AND cardinality(embedding) BETWEEN 1 AND 2000 AND array_position(embedding,NULL) IS NULL
  AND NOT embedding && ARRAY['NaN','Infinity','-Infinity']::real[]),
 batch_id uuid NOT NULL,
 PRIMARY KEY(env,zid,model_id,tid),
 UNIQUE(env,zid,model_id,seq)
);
CREATE TRIGGER comment_embedding_immutable BEFORE UPDATE OR DELETE ON public.delphi_comment_embeddings
 FOR EACH ROW EXECUTE FUNCTION public.pd_embedding_immutable();

-- One closed set per (batch, model). The set keeps its foreign key to the
-- batch: a set describes that run's publication and must never outlive it, so
-- a result-batch prune deletes the batch's sets (pd_embedding_prune) first, and
-- an out-of-order delete fails instead of leaving a set without its batch. content_sha is SHA-256 over one line per
-- row in tid order, tid:hex(text_sha):hex(sha256(array_send(embedding))),
-- joined by newlines, so a reader can check what it streamed.
CREATE TABLE public.delphi_embedding_sets(
 env text NOT NULL, batch_id uuid NOT NULL,
 model_id smallint NOT NULL REFERENCES public.delphi_embedding_models,
 zid integer NOT NULL REFERENCES public.conversations(zid),
 seq_mark bigint NOT NULL CHECK(seq_mark>=0),
 row_count integer NOT NULL CHECK(row_count>=0),
 max_tid integer CHECK(max_tid>=0),
 content_sha text NOT NULL CHECK(content_sha ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(env,batch_id,model_id),
 FOREIGN KEY(env,batch_id) REFERENCES public.delphi_result_batches,
 CHECK((row_count=0)=(max_tid IS NULL))
);
CREATE TRIGGER embedding_set_immutable BEFORE UPDATE OR DELETE ON public.delphi_embedding_sets
 FOR EACH ROW EXECUTE FUNCTION public.pd_embedding_immutable();

-- Internal: the fenced writer's open result batch, created as
-- pd_result_insert_family creates it. Caller holds the queue row lock and fence.
CREATE FUNCTION public.pd_embedding_batch(p_env text,p_job uuid,p_attempt uuid,p_model text,
 OUT n public.delphi_graph_nodes,OUT m public.delphi_embedding_models,OUT s public.delphi_embedding_sets)
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public.delphi_result_batches;
BEGIN
 SELECT * INTO STRICT n FROM public.delphi_graph_nodes WHERE env=p_env AND job_id=p_job;
 SELECT * INTO m FROM public.delphi_embedding_models WHERE name=p_model;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown embedding model'; END IF;
 INSERT INTO public.delphi_result_batches(env,batch_id,job_id,run_id) VALUES(p_env,p_attempt,p_job,n.run_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT b FROM public.delphi_result_batches WHERE env=p_env AND batch_id=p_attempt FOR UPDATE;
 IF b.job_id<>p_job OR b.run_id<>n.run_id THEN RAISE EXCEPTION 'result run binding'; END IF;
 SELECT * INTO s FROM public.delphi_embedding_sets WHERE env=p_env AND batch_id=p_attempt AND model_id=m.model_id;
 IF s.batch_id IS NULL AND b.sealed_sha IS NOT NULL THEN RAISE EXCEPTION 'result batch sealed'; END IF;
 -- Serializes every write and close for one conversation and model, so seq
 -- order is commit order and a closed mark never gains an earlier row.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:embeddings',p_env,n.zid,m.model_id)::text,0));
END $$;

-- The writer and reader functions run with enable_seqscan=off: plpgsql caches
-- its plans, and a plan made while a conversation's rows were few (or before
-- the table was first analyzed) would otherwise scan every stored row of the
-- conversation on each later call. Each statement here has an index to use.
--
-- Add up to 4,096 embeddings. p_embeddings is a two-dimensional array, one row
-- per p_tids entry, each the model's dims long. Rows already stored for the
-- same comment and text are kept as they are (a retry, or a comment an earlier
-- run embedded); the same comment with different text refuses the whole call.
CREATE FUNCTION public.pd_embedding_put(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,
 p_model text,p_tids integer[],p_text_sha bytea[],p_embeddings real[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET enable_seqscan=off AS $$
DECLARE j public.polis_queue_jobs; n public.delphi_graph_nodes; m public.delphi_embedding_models;
 s public.delphi_embedding_sets; r record; total integer=cardinality(p_tids); added integer; k record; prior bytea;
BEGIN
 j=public.pd_lock(p_env,p_job);
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RAISE EXCEPTION 'embedding writer fenced'; END IF;
 SELECT * INTO r FROM public.pd_embedding_batch(p_env,p_job,p_attempt,p_model);
 n=r.n; m=r.m; s=r.s;
 IF s.batch_id IS NOT NULL THEN RAISE EXCEPTION 'embedding set closed'; END IF;
 IF total IS NULL OR total NOT BETWEEN 1 AND 4096
  OR array_ndims(p_tids)<>1 OR array_lower(p_tids,1)<>1
  OR array_ndims(p_text_sha)<>1 OR array_lower(p_text_sha,1)<>1 OR cardinality(p_text_sha)<>total
  OR array_ndims(p_embeddings) IS DISTINCT FROM 2 OR array_lower(p_embeddings,1)<>1 OR array_lower(p_embeddings,2)<>1
  OR array_length(p_embeddings,1)<>total OR array_length(p_embeddings,2)<>m.dims
  OR EXISTS(SELECT 1 FROM unnest(p_tids,p_text_sha) i(tid,sha) WHERE i.tid IS NULL OR i.tid<0 OR i.sha IS NULL OR octet_length(i.sha)<>32)
  OR (SELECT count(DISTINCT t) FROM unnest(p_tids) t)<>total
  OR EXISTS(SELECT 1 FROM unnest(p_embeddings) v WHERE v IS NULL OR v IN ('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'invalid embedding rows'; END IF;
 -- One primary-key lookup per row: a set-wise check can plan as a scan of
 -- the whole conversation before the table is first analyzed.
 FOR k IN SELECT * FROM unnest(p_tids,p_text_sha) i(tid,sha) LOOP
  SELECT e.text_sha INTO prior FROM public.delphi_comment_embeddings e
  WHERE e.env=p_env AND e.zid=n.zid AND e.model_id=m.model_id AND e.tid=k.tid;
  IF FOUND AND prior<>k.sha THEN RAISE EXCEPTION 'embedding text conflict'; END IF;
 END LOOP;
 -- One pass over the matrix (row-major): slicing it per row copies all of it
 -- per row when the caller passes an expanded array.
 INSERT INTO public.delphi_comment_embeddings(env,zid,model_id,tid,text_sha,embedding,batch_id)
 SELECT p_env,n.zid,m.model_id,i.tid,i.sha,v.vec,p_attempt
 FROM unnest(p_tids,p_text_sha) WITH ORDINALITY i(tid,sha,o)
 JOIN (SELECT (x.pos-1)/m.dims+1 AS o,array_agg(x.v ORDER BY x.pos) AS vec
  FROM unnest(p_embeddings) WITH ORDINALITY x(v,pos) GROUP BY 1) v ON v.o=i.o
 ORDER BY i.tid
 ON CONFLICT(env,zid,model_id,tid) DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 RETURN jsonb_build_object('rows',total,'added',added,'existing',total-added);
END $$;

-- Close the run's set: everything stored for (env, zid, model) now. Repeating a
-- close returns the same receipt. Must precede pd_result_seal for the batch.
CREATE FUNCTION public.pd_embedding_close(p_env text,p_job uuid,p_owner uuid,p_attempt uuid,p_epoch bigint,p_model text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET enable_seqscan=off AS $$
DECLARE j public.polis_queue_jobs; n public.delphi_graph_nodes; m public.delphi_embedding_models; s public.delphi_embedding_sets; r record;
BEGIN
 -- A snapshot older than the lock below could miss a committed row under the mark.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'embedding close requires read committed'; END IF;
 j=public.pd_lock(p_env,p_job);
 IF NOT public.pq_owns(j,p_owner,p_attempt,p_epoch) THEN RAISE EXCEPTION 'embedding writer fenced'; END IF;
 SELECT * INTO r FROM public.pd_embedding_batch(p_env,p_job,p_attempt,p_model);
 n=r.n; m=r.m; s=r.s;
 IF s.batch_id IS NULL THEN
  INSERT INTO public.delphi_embedding_sets(env,batch_id,model_id,zid,seq_mark,row_count,max_tid,content_sha)
  SELECT p_env,p_attempt,m.model_id,n.zid,COALESCE(max(e.seq),0),count(*),max(e.tid),
   encode(sha256(convert_to(COALESCE(string_agg(e.tid::text||':'||encode(e.text_sha,'hex')||':'
    ||encode(sha256(array_send(e.embedding)),'hex'),chr(10) ORDER BY e.tid),''),'UTF8')),'hex')
  FROM public.delphi_comment_embeddings e WHERE e.env=p_env AND e.zid=n.zid AND e.model_id=m.model_id
  RETURNING * INTO s;
 END IF;
 RETURN public.pd_embedding_receipt(s);
END $$;

CREATE FUNCTION public.pd_embedding_receipt(s public.delphi_embedding_sets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN s.batch_id IS NOT NULL THEN jsonb_build_object('schema','delphi-embedding-set/1',
  'batch_id',s.batch_id,'zid',s.zid,'model',m.name,'dims',m.dims,'seq_mark',s.seq_mark,
  'row_count',s.row_count,'max_tid',s.max_tid,'sha256',s.content_sha) END
 FROM public.delphi_embedding_models m WHERE m.model_id=s.model_id
$$;

-- The set an artifact reads: its own batch's, else the closest upstream batch
-- with one, walking the same edges as pd_result_family_batches. NULL if none.
CREATE FUNCTION public.pd_embedding_set(p_env text,p_artifact uuid,p_model text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH RECURSIVE upstream(id,depth,path) AS (
  SELECT p_artifact,0,ARRAY[p_artifact] UNION ALL
  SELECT e.artifact_id,u.depth+1,u.path||e.artifact_id FROM upstream u
  JOIN public.delphi_artifacts a ON a.env=p_env AND a.artifact_id=u.id
  JOIN public.delphi_graph_edges e ON e.env=a.env AND e.consumer=a.job_id
  WHERE e.artifact_id IS NOT NULL AND NOT e.artifact_id=ANY(u.path)
 ) SELECT public.pd_embedding_receipt(s) FROM upstream u
 JOIN public.delphi_result_batches b ON b.env=p_env AND b.artifact_id=u.id
 JOIN public.delphi_embedding_models m ON m.name=p_model
 JOIN public.delphi_embedding_sets s ON s.env=b.env AND s.batch_id=b.batch_id AND s.model_id=m.model_id
 ORDER BY u.depth,u.id LIMIT 1
$$;

-- The set served for a conversation and scope, with the served artifact.
CREATE FUNCTION public.pd_embedding_served(p_env text,p_zid integer,p_scope text,p_model text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT public.pd_embedding_set(p_env,s.artifact_id,p_model)||jsonb_build_object('generation',s.generation,'artifact_id',s.artifact_id)
 FROM public.delphi_graph_served s WHERE s.env=p_env AND s.zid=p_zid AND s.scope_key=p_scope
$$;

-- A closed set's rows in tid order, for COPY (SELECT ...) TO STDOUT (FORMAT binary).
CREATE FUNCTION public.pd_embedding_rows(p_env text,p_batch uuid,p_model text)
RETURNS TABLE(tid integer,text_sha bytea,embedding real[]) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET enable_seqscan=off AS $$
 SELECT e.tid,e.text_sha,e.embedding FROM public.delphi_embedding_models m
 JOIN public.delphi_embedding_sets s ON s.env=p_env AND s.batch_id=p_batch AND s.model_id=m.model_id
 JOIN public.delphi_comment_embeddings e ON e.env=s.env AND e.zid=s.zid AND e.model_id=s.model_id AND e.seq<=s.seq_mark
 WHERE m.name=p_model ORDER BY e.tid
$$;

-- The only delete path. Modes:
--  superseded (p_zid): per model, keep every set the conversation's served
--   pointers resolve to, every set newer than the oldest of those, the p_keep
--   newest older sets (rollback by pointer), and any set still consumed by an
--   unfinished job or whose run has neither published nor finished; delete the
--   other sets. Then, if no job for the conversation is unfinished, delete rows
--   above every remaining set's mark (rows of runs that never closed a set).
--   Sets are cumulative, so rows at or below the newest remaining mark are
--   always still covered and are never deleted here.
--  conversation (p_zid, optional p_model): every row and set of the
--   conversation, e.g. once its reports are baked or before an operator
--   deletes the conversation. Refused while a job for it is unfinished.
--  model (p_model): every row and set of a retired model in the environment.
--   Refused while a job for any affected conversation is unfinished.
-- Owner only: nothing calls it yet. Serializes with put and close on the same
-- per-(conversation, model) lock, taken in (zid, model) order.
CREATE FUNCTION public.pd_embedding_prune(p_env text,p_mode text,p_zid integer DEFAULT NULL,p_model text DEFAULT NULL,p_keep integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET enable_seqscan=off AS $$
DECLARE mid smallint; z record; oldest public.delphi_embedding_sets; mark bigint; busy boolean;
 n integer; sets_deleted integer=0; rows_deleted integer=0;
BEGIN
 IF p_env IS NULL OR p_mode IS NULL OR p_mode NOT IN ('superseded','conversation','model') OR p_keep IS NULL OR p_keep<0
  OR (p_mode IN ('superseded','conversation') AND p_zid IS NULL)
  OR (p_mode='model' AND (p_model IS NULL OR p_zid IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid embedding prune'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'embedding prune requires read committed'; END IF;
 IF p_model IS NOT NULL THEN
  SELECT model_id INTO mid FROM public.delphi_embedding_models WHERE name=p_model;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown embedding model'; END IF;
 END IF;
 PERFORM set_config('polis.pd_embedding_prune','on',true);
 FOR z IN SELECT DISTINCT x.zid,x.model_id FROM (
   SELECT s.zid,s.model_id FROM public.delphi_embedding_sets s WHERE s.env=p_env AND (p_zid IS NULL OR s.zid=p_zid) AND (mid IS NULL OR s.model_id=mid)
   UNION SELECT DISTINCT e.zid,e.model_id FROM public.delphi_comment_embeddings e WHERE e.env=p_env AND (p_zid IS NULL OR e.zid=p_zid) AND (mid IS NULL OR e.model_id=mid)
  ) x ORDER BY x.zid,x.model_id
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pd:embeddings',p_env,z.zid,z.model_id)::text,0));
  busy=EXISTS(SELECT 1 FROM public.polis_queue_jobs j JOIN public.polis_queue_runs r ON r.env=j.env AND r.run_id=j.run_id
   WHERE j.env=p_env AND r.zid=z.zid AND j.state NOT IN ('succeeded','dead','cancelled'));
  IF p_mode<>'superseded' THEN
   IF busy THEN RAISE EXCEPTION 'embedding prune: conversation has unfinished jobs'; END IF;
   DELETE FROM public.delphi_embedding_sets s WHERE s.env=p_env AND s.zid=z.zid AND s.model_id=z.model_id;
   GET DIAGNOSTICS n=ROW_COUNT; sets_deleted=sets_deleted+n;
   DELETE FROM public.delphi_comment_embeddings e WHERE e.env=p_env AND e.zid=z.zid AND e.model_id=z.model_id;
   GET DIAGNOSTICS n=ROW_COUNT; rows_deleted=rows_deleted+n;
   CONTINUE;
  END IF;
  -- The oldest set any served pointer of this conversation resolves to.
  SELECT s.* INTO oldest FROM public.delphi_graph_served g
  JOIN public.delphi_embedding_models m ON m.model_id=z.model_id
  JOIN public.delphi_embedding_sets s ON s.env=p_env AND s.model_id=z.model_id
   AND s.batch_id=(public.pd_embedding_set(p_env,g.artifact_id,m.name)->>'batch_id')::uuid
  WHERE g.env=p_env AND g.zid=z.zid ORDER BY s.seq_mark,s.created_at LIMIT 1;
  IF oldest.batch_id IS NULL THEN CONTINUE; END IF; -- nothing served: delete nothing
  DELETE FROM public.delphi_embedding_sets d USING (
   SELECT s.batch_id FROM public.delphi_embedding_sets s
   JOIN public.delphi_result_batches b ON b.env=s.env AND b.batch_id=s.batch_id
   WHERE s.env=p_env AND s.zid=z.zid AND s.model_id=z.model_id
    AND (s.seq_mark,s.created_at)<(oldest.seq_mark,oldest.created_at)
    AND (b.artifact_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.polis_queue_jobs j
     WHERE j.env=b.env AND j.job_id=b.job_id AND j.state IN ('succeeded','dead','cancelled')))
    AND NOT EXISTS(SELECT 1 FROM public.delphi_graph_edges e JOIN public.polis_queue_jobs j ON j.env=e.env AND j.job_id=e.consumer
     WHERE e.env=p_env AND e.artifact_id=b.artifact_id AND j.state NOT IN ('succeeded','dead','cancelled'))
   ORDER BY s.seq_mark DESC,s.created_at DESC OFFSET p_keep
  ) x WHERE d.env=p_env AND d.batch_id=x.batch_id AND d.model_id=z.model_id;
  GET DIAGNOSTICS n=ROW_COUNT; sets_deleted=sets_deleted+n;
  IF NOT busy THEN
   SELECT max(s.seq_mark) INTO mark FROM public.delphi_embedding_sets s WHERE s.env=p_env AND s.zid=z.zid AND s.model_id=z.model_id;
   DELETE FROM public.delphi_comment_embeddings e WHERE e.env=p_env AND e.zid=z.zid AND e.model_id=z.model_id AND e.seq>mark;
   GET DIAGNOSTICS n=ROW_COUNT; rows_deleted=rows_deleted+n;
  END IF;
 END LOOP;
 PERFORM set_config('polis.pd_embedding_prune','off',true);
 RETURN jsonb_build_object('mode',p_mode,'sets_deleted',sets_deleted,'rows_deleted',rows_deleted);
END $$;

REVOKE ALL ON public.delphi_embedding_models,public.delphi_comment_embeddings,public.delphi_embedding_sets FROM PUBLIC,polis_queue_executor;
REVOKE ALL ON FUNCTION public.pd_embedding_batch(text,uuid,uuid,text),
 public.pd_embedding_put(text,uuid,uuid,uuid,bigint,text,integer[],bytea[],real[]),
 public.pd_embedding_close(text,uuid,uuid,uuid,bigint,text),
 public.pd_embedding_receipt(public.delphi_embedding_sets),
 public.pd_embedding_set(text,uuid,text),public.pd_embedding_served(text,integer,text,text),
 public.pd_embedding_rows(text,uuid,text),public.pd_embedding_immutable(),
 public.pd_embedding_prune(text,text,integer,text,integer) FROM PUBLIC,polis_queue_executor;
GRANT EXECUTE ON FUNCTION public.pd_embedding_put(text,uuid,uuid,uuid,bigint,text,integer[],bytea[],real[]),
 public.pd_embedding_close(text,uuid,uuid,uuid,bigint,text),
 public.pd_embedding_set(text,uuid,text),public.pd_embedding_served(text,integer,text,text),
 public.pd_embedding_rows(text,uuid,text) TO polis_queue_executor;
COMMIT;
