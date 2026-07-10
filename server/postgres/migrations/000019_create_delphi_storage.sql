-- Delphi Storage V2 (design: delphi/docs/STORAGE_V2_DESIGN.md §4.2)
-- Immutable runs + append-only artifacts + first-class latest pointers,
-- schema-scoped so a PG-only deployment carries all six logical entities.
--
-- This file mirrors delphi_storage.backends.postgres.schema_ddl("delphi")
-- statement for statement — delphi/tests/test_delphi_storage_ddl.py fails
-- if the two drift. The Python/TS backends are the source of truth.

CREATE SCHEMA IF NOT EXISTS delphi;

CREATE TABLE IF NOT EXISTS delphi.runs (
    job_id text PRIMARY KEY,
    status text NOT NULL,
    claim_order text COLLATE "C",
    zid bigint,
    rid bigint,
    enqueued_at text NOT NULL,
    version bigint NOT NULL,
    manifest jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_claim_idx
    ON delphi.runs (claim_order) WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS runs_zid_idx ON delphi.runs (zid, enqueued_at);

CREATE INDEX IF NOT EXISTS runs_rid_idx ON delphi.runs (rid, enqueued_at);

CREATE TABLE IF NOT EXISTS delphi.latest (
    scope text PRIMARY KEY,
    job_id text NOT NULL,
    seq bigint NOT NULL,
    job_type text NOT NULL,
    updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS delphi.run_inputs (
    pk text NOT NULL,
    sk text COLLATE "C" NOT NULL,
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob bytea,
    PRIMARY KEY (pk, sk)
);

CREATE TABLE IF NOT EXISTS delphi.artifacts (
    pk text NOT NULL,
    sk text COLLATE "C" NOT NULL,
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob bytea,
    PRIMARY KEY (pk, sk)
);

CREATE TABLE IF NOT EXISTS delphi.topic_moderation (
    pk text NOT NULL,
    sk text COLLATE "C" NOT NULL,
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob bytea,
    PRIMARY KEY (pk, sk)
);

CREATE TABLE IF NOT EXISTS delphi.collective_statements (
    pk text NOT NULL,
    sk text COLLATE "C" NOT NULL,
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob bytea,
    PRIMARY KEY (pk, sk)
);
