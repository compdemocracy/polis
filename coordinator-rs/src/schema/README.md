# Descriptive schema layer

These unused storage types describe the schema; they grant no authority and do
not change runtime queries. `store`, `bridge`, `lease`, migrations, engine
manifests and replay expectations retain their existing behavior.

`rows.rs` has 84 relation types and all 603 current public columns. `catalog.json`
is the PostgreSQL 17.11 result after applying the current numbered migrations to
a fresh disposable database. Its column declaration pointers also account for
the password-reset relation/column rename. The tests require the exact migration
file inventory and bytes, compare every column/type/nullability to compiled row
metadata, and reject unreviewed extra serialized columns. A new migration,
including an ADD COLUMN inside a DO block, fails until the catalog and types are
reviewed together. This is a strict byte-bound census, not a handwritten SQL parser.

To review a schema change, apply the entire current migration chain only to a
fresh local fixture (never replay it as an upgrade), query public pg_attribute /
information_schema.columns, pg_indexes and pg_constraint, and compare the new
catalog to this file. Review each changed declaration pointer, nullability,
column default, index and constraint. Update row declarations and the measured
catalog together. Run the locked tests and the local mapping example against
that same fixture:

```sh
cargo test --locked --test schema
cargo run --locked --example schema_rows -- 55553
```

The example connects only to 127.0.0.1, an explicit high port, database probe_test,
and PostgreSQL 17. It uses a read-only transaction, checks actual catalog types
and nullability, maps two actual PostgreSQL composite rows per table (populated
and nullable), and rolls back. The caller must own the disposable database.
It is a mapping test, not a write-constraint or migration-reversal test.

Storage representations are deliberately lossless:

- Nullable columns use Option. Text-array elements independently use Option.
- Timestamptz retains PostgreSQL microseconds since 2000, including infinities.
- UUID retains 16 bytes. Floats retain IEEE bits, including signed zero and NaN.
- PgJson retains PostgreSQL JSON text, including large decimal tokens; its
  wrapper distinguishes JSON null from SQL NULL. JSONB is server-normalized
  text and is not a substitute for original payload-byte custody.
- Dynamo decimals retain text. Missing attributes and explicit Dynamo NULL are
  distinct. Named item views retain legacy extension attributes; table keys
  come from create_dynamodb_tables.py, while non-key presence is not assumed.
- Job types preserve JSON-string payloads, the hyphenated at-date key, optional
  import email, and unvalidated legacy fields. The new closed DelphiJob enum
  is unused; it does not change today's unknown-kind full-pipeline fallthrough.

The layer has 19 declared Dynamo table views and four separately named legacy
consumer views; the latter do not assert that a table has been provisioned.
It describes nine work categories. There is no SDK client, socket, write API,
activation flag, migration application or new dependency in this module.

Source scope and proposed later phases: P-063-rust-typed-db-interface in the
program notes. Every row/field carries its migration declaration pointer;
Dynamo and job types cite their defining producer/key declaration.
