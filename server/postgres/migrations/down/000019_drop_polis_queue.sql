-- 000019_drop_polis_queue.sql  (reversal of 000019_create_polis_queue.sql)
--
-- P-024 Postgres queue substrate, contract polis-queue/1: the down script.
-- Colin's ruling: a written, tested down script is a precondition for ever
-- applying 000019 to production. This is that script. See the "Reversal"
-- section of docs/queue-substrate.md for the runbook.
--
-- WHAT IT REMOVES
-- ---------------
-- Exactly what 000019 created, and nothing else:
--   * the trigger pq_no_regression on public.polis_queue_heads
--   * the 21 public.pq_* functions
--   * the 9 explicitly-created indexes (the rest go with their tables)
--   * the 5 tables polis_queue_{runs,heads,jobs,attempts,requests}
--   * the GRANT on public.conversations to polis_queue_owner (via REVOKE)
--   * the schema-level grants to both roles and every grant either role made
--     (via DROP OWNED BY)
--   * the two NOLOGIN roles polis_queue_owner and polis_queue_executor
-- It does NOT touch public.conversations itself, the public schema, or any
-- object 000019 did not create.
--
-- HOW TO APPLY
-- ------------
-- Run THIS FILE ALONE, manually, as a superuser (postgres) or as a login that
-- can drop the queue owner's objects and DROP ROLE both roles. Exactly as
-- docs/migrations.md applies a migration, but with ON_ERROR_STOP and the down
-- file:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -U postgres -d polis-dev \
--     < server/postgres/migrations/down/000019_drop_polis_queue.sql
--
-- SAFETY: it REFUSES to run if any polis_queue_* table contains rows, so a live
-- queue is never dropped by accident. Override deliberately with -v force=1:
--
--   docker exec -i polis-dev-postgres-1 psql -v ON_ERROR_STOP=1 -v force=1 -U postgres \
--     -d polis-dev < server/postgres/migrations/down/000019_drop_polis_queue.sql
--
-- IDEMPOTENCE: safe to run when 000019 was never applied. It is a no-op that
-- emits a NOTICE. Every drop is guarded (IF EXISTS or an existence check), so
-- re-running after a successful down is also a clean no-op.

\set ON_ERROR_STOP on

-- Default force to 0 unless the operator passed -v force=1.
\if :{?force}
\else
  \set force 0
\endif

BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight: refuse to drop tables that still hold rows, unless force=1.
-- Counts only the queue tables that actually exist, so this is also correct
-- when 000019 was never applied (total = 0, nothing refused).
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE total bigint := 0; n bigint; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'polis_queue_runs','polis_queue_heads','polis_queue_jobs',
    'polis_queue_attempts','polis_queue_requests']
  LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      total := total + n;
    END IF;
  END LOOP;
  -- Transaction-local so it cannot leak into the session.
  PERFORM set_config('polis_queue.down_rowcount', total::text, true);
END $preflight$;

SELECT current_setting('polis_queue.down_rowcount')::bigint AS pq_rows \gset
SELECT CASE WHEN (:pq_rows > 0 AND :'force' <> '1') THEN 'true' ELSE 'false' END
  AS pq_refuse \gset

\if :pq_refuse
DO $refuse$
BEGIN
  RAISE EXCEPTION
    'polis_queue_* tables contain % row(s); refusing to drop a live queue. '
    'Re-run with  -v force=1  to override.',
    current_setting('polis_queue.down_rowcount');
END $refuse$;
\endif

-- ---------------------------------------------------------------------------
-- No-op notice: if 000019 was never applied there is nothing to remove.
-- ---------------------------------------------------------------------------
DO $noop$
BEGIN
  IF to_regclass('public.polis_queue_jobs') IS NULL
     AND to_regclass('public.polis_queue_runs') IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname IN ('polis_queue_owner','polis_queue_executor'))
  THEN
    RAISE NOTICE
      'polis_queue objects not present; 000019 was never applied. Nothing to drop.';
  END IF;
END $noop$;

-- ---------------------------------------------------------------------------
-- 1. Trigger (depends on pq_no_regression; guarded so an absent table is a
--    no-op rather than a "relation does not exist" error).
-- ---------------------------------------------------------------------------
DO $trg$
BEGIN
  IF to_regclass('public.polis_queue_heads') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS pq_no_regression ON public.polis_queue_heads;
  END IF;
END $trg$;

-- ---------------------------------------------------------------------------
-- 2. Functions. All 21 are dropped by bare name: 000019 guarantees exactly one
--    overload of each (its signature guard enforces this), so the name is
--    unambiguous, and a bare name never references the table row-types that
--    four of these take as arguments -- which keeps the no-op case (types
--    absent) from raising "type does not exist". Function bodies are string-
--    quoted, so there are no inter-function dependencies and order is free;
--    they are dropped before the tables because four depend on the table
--    row-types. If drift left a stale overload, a bare-name drop fails loudly
--    ("is not unique") -- a human decision, exactly as 000019 intends.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pq_enqueue;
DROP FUNCTION IF EXISTS public.pq_claim;
DROP FUNCTION IF EXISTS public.pq_heartbeat;
DROP FUNCTION IF EXISTS public.pq_finalize;
DROP FUNCTION IF EXISTS public.pq_fail;
DROP FUNCTION IF EXISTS public.pq_release;
DROP FUNCTION IF EXISTS public.pq_park;
DROP FUNCTION IF EXISTS public.pq_due;
DROP FUNCTION IF EXISTS public.pq_reap_one;
DROP FUNCTION IF EXISTS public.pq_reap;
DROP FUNCTION IF EXISTS public.pq_cancel;
DROP FUNCTION IF EXISTS public.pq_job_status;
DROP FUNCTION IF EXISTS public.pq_head_status;
DROP FUNCTION IF EXISTS public.pq_end_attempt;
DROP FUNCTION IF EXISTS public.pq_terminate_attempt;
DROP FUNCTION IF EXISTS public.pq_publish_allowed;
DROP FUNCTION IF EXISTS public.pq_lock;
DROP FUNCTION IF EXISTS public.pq_owns;
DROP FUNCTION IF EXISTS public.pq_backoff;
DROP FUNCTION IF EXISTS public.pq_result;
DROP FUNCTION IF EXISTS public.pq_no_regression;

-- ---------------------------------------------------------------------------
-- 3. Indexes. Only the 9 explicitly created by 000019; the primary-key and
--    unique-constraint indexes go with their tables in step 4. DROP INDEX
--    IF EXISTS on an absent name is a guarded no-op.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.polis_queue_ready;
DROP INDEX IF EXISTS public.polis_queue_running;
DROP INDEX IF EXISTS public.polis_queue_exhausted;
DROP INDEX IF EXISTS public.polis_queue_parked;
DROP INDEX IF EXISTS public.polis_queue_heads_zid;
DROP INDEX IF EXISTS public.polis_queue_runs_zid;
DROP INDEX IF EXISTS public.polis_queue_runs_history;
DROP INDEX IF EXISTS public.polis_queue_requests_run;
DROP INDEX IF EXISTS public.polis_queue_requests_job;

-- ---------------------------------------------------------------------------
-- 4. Tables. All five listed in one statement (no CASCADE), so the inter-table
--    foreign keys resolve because every referencing table is in the drop set.
--    None of these are referenced by anything 000019 did not create, and
--    public.conversations is a parent (referenced BY them), so it is untouched.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS
  public.polis_queue_requests,
  public.polis_queue_attempts,
  public.polis_queue_jobs,
  public.polis_queue_heads,
  public.polis_queue_runs;

-- ---------------------------------------------------------------------------
-- 5. The GRANT on public.conversations to polis_queue_owner, via REVOKE.
--    Mirror of line 99 of 000019. Guarded on role existence so the no-op case
--    does not raise "role does not exist".
-- ---------------------------------------------------------------------------
DO $revoke_conv$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner') THEN
    REVOKE SELECT, REFERENCES(zid), UPDATE(topic)
      ON public.conversations FROM polis_queue_owner;
  END IF;
END $revoke_conv$;

-- ---------------------------------------------------------------------------
-- 6. The roles. A role cannot be dropped while it owns objects or holds/made
--    any grant. Steps 1-5 removed the owner's objects and the conversations
--    grant, but both roles still hold schema-level grants (USAGE/CREATE on
--    public), and polis_queue_owner is the grantor of polis_queue_executor's
--    schema USAGE. DROP OWNED BY, applied to BOTH roles together, revokes every
--    privilege granted TO either role and every privilege either role GRANTED,
--    in this database -- which is the only database 000019 touched. It then
--    leaves nothing for DROP ROLE to trip over. Guarded so the no-op case skips.
-- ---------------------------------------------------------------------------
DO $roles$
DECLARE has_owner boolean; has_exec boolean;
BEGIN
  has_owner := EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_owner');
  has_exec  := EXISTS (SELECT 1 FROM pg_roles WHERE rolname='polis_queue_executor');
  IF has_owner AND has_exec THEN
    DROP OWNED BY polis_queue_owner, polis_queue_executor;
  ELSIF has_owner THEN
    DROP OWNED BY polis_queue_owner;
  ELSIF has_exec THEN
    DROP OWNED BY polis_queue_executor;
  END IF;
  IF has_exec THEN
    DROP ROLE polis_queue_executor;
  END IF;
  IF has_owner THEN
    DROP ROLE polis_queue_owner;
  END IF;
END $roles$;

COMMIT;
