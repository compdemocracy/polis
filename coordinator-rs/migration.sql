-- Prototype-only controlled transition, with all writers stopped. The Python
-- comparator uses a distinct namespace; never mix MAX+1 and sequence in one env.
BEGIN;
ALTER TABLE math_ticks ADD COLUMN IF NOT EXISTS publisher_epoch bigint;
ALTER TABLE math_ticks ADD COLUMN IF NOT EXISTS input_checkpoint jsonb;
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
CREATE SEQUENCE IF NOT EXISTS coordinator_caching_tick;
SELECT setval('coordinator_caching_tick', GREATEST(
 (SELECT COALESCE(MAX(caching_tick),0)+1 FROM math_main),
 (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM coordinator_caching_tick)), false);
COMMIT;
