-- 000046_add_granite_embedding_model.sql
--
-- One data row in an existing table: the embedding model Delphi uses from
-- this release, ibm-granite/granite-embedding-311m-multilingual-r2 at revision
-- 44399559930365213510b1ee2eb15ded83374f0e, kept to its first 384 dimensions,
-- as model_id 2 of public.delphi_embedding_models (000038). The name is the
-- one a Delphi run records for its embeddings (repository@revision:384), so a
-- run's vectors are stored under it, beside model_id 1's and never mixed with
-- them: rows, sets and every read are keyed by model. No table, column, index,
-- constraint, function, trigger or grant changes; model_id 1 and every stored
-- row stay as they are.
--
-- Compatibility: additive. No earlier release names this model, so each one
-- reads and writes as before beside the row.
--
-- Locks. The INSERT takes ROW EXCLUSIVE on delphi_embedding_models until
-- COMMIT, milliseconds. That conflicts only with SHARE and stronger locks,
-- which no reader or writer of the table takes (pd_embedding_put's foreign-key
-- check locks the row of the model it writes under, FOR KEY SHARE, not this
-- one). Nothing on the vote, comment or next-comment path reads the table.
-- lock_timeout (5 s) bounds any wait; on timeout nothing changes and the
-- deploy can be retried.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE polis_queue_owner;
SET LOCAL search_path=pg_catalog,pg_temp;
INSERT INTO public.delphi_embedding_models VALUES(2,'ibm-granite/granite-embedding-311m-multilingual-r2@44399559930365213510b1ee2eb15ded83374f0e:384',384);
COMMIT;
