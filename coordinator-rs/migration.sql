-- Prototype-only controlled transition, with all writers stopped. The Python
-- comparator uses a distinct namespace; never mix MAX+1 and sequence in one env.
BEGIN;
ALTER TABLE math_ticks ADD COLUMN IF NOT EXISTS publisher_epoch bigint;
ALTER TABLE math_ticks ADD COLUMN IF NOT EXISTS input_checkpoint jsonb;
ALTER TABLE math_ticks ADD COLUMN IF NOT EXISTS operation_id text;
-- Nullable for legacy rows. Rust requires all originals and digests on admission;
-- a controlled migration never invents the bytes that JSONB has already lost.
ALTER TABLE math_main ADD COLUMN IF NOT EXISTS original_bytes bytea;
ALTER TABLE math_main ADD COLUMN IF NOT EXISTS original_sha256 text;
ALTER TABLE math_bidtopid ADD COLUMN IF NOT EXISTS original_bytes bytea;
ALTER TABLE math_bidtopid ADD COLUMN IF NOT EXISTS original_sha256 text;
ALTER TABLE math_ptptstats ADD COLUMN IF NOT EXISTS original_bytes bytea;
ALTER TABLE math_ptptstats ADD COLUMN IF NOT EXISTS original_sha256 text;
CREATE TABLE IF NOT EXISTS coordinator_leases (
 math_env varchar(999) NOT NULL, zid integer NOT NULL REFERENCES conversations(zid),
 owner_id text NOT NULL, owner_epoch bigint NOT NULL CHECK(owner_epoch>0),
 expires_at timestamptz NOT NULL, PRIMARY KEY(math_env,zid)
);
CREATE TABLE IF NOT EXISTS coordinator_cursors (
 math_env varchar(999) NOT NULL, consumer text NOT NULL, position jsonb NOT NULL,
 PRIMARY KEY(math_env,consumer)
);
CREATE TABLE IF NOT EXISTS coordinator_failures (
 math_env varchar(999) NOT NULL, zid integer NOT NULL REFERENCES conversations(zid),
 attempts integer NOT NULL, first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_attempt timestamptz NOT NULL, PRIMARY KEY(math_env,zid)
);
-- CO01 incremental discovery cursor: when the authoritative full snapshot was
-- last taken for this conversation, and the cheap probe observed immediately
-- before it. The probe is a hint that may skip a full read; `reconciled_at` is
-- what bounds how long it may be trusted, and it is the source of the
-- OldestReconciliationAgeSeconds scan-age metric.
CREATE TABLE IF NOT EXISTS coordinator_reconciliation (
 math_env varchar(999) NOT NULL, zid integer NOT NULL REFERENCES conversations(zid),
 reconciled_at timestamptz NOT NULL, source_probe jsonb NOT NULL,
 PRIMARY KEY(math_env,zid)
);
CREATE SEQUENCE IF NOT EXISTS coordinator_caching_tick;
SELECT setval('coordinator_caching_tick', GREATEST(
 (SELECT COALESCE(MAX(caching_tick),0)+1 FROM math_main),
 (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM coordinator_caching_tick)), false);
COMMIT;
