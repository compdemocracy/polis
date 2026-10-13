//! The daemon's `/2` RPC client. It reuses the crate's typed transport rules
//! (`signature_v2`, `bind_args`): every call is validated by name, arity and
//! type before it reaches SQL, runs in its own READ COMMITTED transaction with
//! bounded timeouts, and reports an uncertain COMMIT as `Unknown`, never as
//! success. One `Rpc` holds one connection and reconnects after an error.
use super::transport::Connector;
use crate::{Completion, bind_args, placeholders, signature_v2};
use anyhow::{Result, ensure};
use bytes::BytesMut;
use postgres::types::{IsNull, ToSql, Type, to_sql_checked};
use postgres::{Client, IsolationLevel};
use postgres_protocol::types::{ArrayDimension, array_to_sql, float4_to_sql};
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

/// A row-major `real[rows][cols]` bound as one two-dimensional float4 array.
/// `Vec<Vec<f32>>` cannot do this — the postgres crate only ever emits a single
/// array dimension — so `pd_embedding_put`'s matrix argument binds through here,
/// never through JSON (no float is reserialized). Lower bound 1 on both axes,
/// to match the migration's `array_lower(...)=1` checks.
#[derive(Debug)]
pub struct Matrix<'a> {
    pub rows: usize,
    pub cols: usize,
    /// Exactly `rows * cols` values, row 0 first.
    pub data: &'a [f32],
}

impl ToSql for Matrix<'_> {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        let dimensions = [
            ArrayDimension {
                len: i32::try_from(self.rows)?,
                lower_bound: 1,
            },
            ArrayDimension {
                len: i32::try_from(self.cols)?,
                lower_bound: 1,
            },
        ];
        array_to_sql(
            dimensions,
            Type::FLOAT4.oid(),
            self.data.iter().copied(),
            |value, buf| {
                float4_to_sql(value, buf);
                // array_to_sql's serializer reports nullness in postgres-protocol's
                // own IsNull, distinct from the ToSql trait's.
                Ok(postgres_protocol::IsNull::No)
            },
            out,
        )?;
        Ok(IsNull::No)
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::FLOAT4_ARRAY
    }
    to_sql_checked!();
}

/// The executor tables that must stay unreadable to the daemon's login.
const TABLES: [&str; 5] = [
    "public.polis_queue_runs",
    "public.polis_queue_heads",
    "public.polis_queue_jobs",
    "public.polis_queue_attempts",
    "public.polis_queue_requests",
];

/// The installed contracts the daemon knows: `polis-queue/2` (000023) and
/// `polis-queue/3` (000024, the large class). Which one a worker may start
/// on is the class's say (`WorkerClass::contracts`).
pub const CONTRACTS: [&str; 3] = ["polis-queue/2", "polis-queue/3", "polis-queue/5"];

pub struct Rpc {
    connector: Arc<Connector>,
    client: Option<Client>,
    env: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(code: &str) -> anyhow::Error {
        DbError {
            sqlstate: Some(code.into()),
            message: "m".into(),
        }
        .into()
    }

    #[test]
    fn transient_classes() {
        for code in [
            "08006", "40001", "40P01", "53300", "55P03", "57014", "57P01", "57P03",
        ] {
            assert!(is_transient(&db(code)), "{code}");
        }
        for code in ["P0001", "22023", "42501", "23503"] {
            assert!(!is_transient(&db(code)), "{code}");
        }
        assert!(is_transient(&anyhow::anyhow!("connection reset")));
    }
}

#[derive(Debug)]
pub struct DbError {
    pub sqlstate: Option<String>,
    pub message: String,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "database refused ({}): {}",
            self.sqlstate.as_deref().unwrap_or("-"),
            self.message
        )
    }
}
impl std::error::Error for DbError {}

/// SQLSTATEs that say "try again", not "no": connection exceptions (08),
/// transaction rollbacks (40), insufficient resources (53), lock timeout,
/// statement timeout and server shutdown/failover (57P0x). A non-SQL error
/// (lost connection, TLS) is transient too.
pub fn is_transient(error: &anyhow::Error) -> bool {
    match error.downcast_ref::<DbError>() {
        None => true,
        Some(DbError {
            sqlstate: Some(s), ..
        }) => {
            s.starts_with("08")
                || s.starts_with("40")
                || s.starts_with("53")
                || s.starts_with("57P0")
                || s == "55P03"
                || s == "57014"
        }
        Some(_) => false,
    }
}

/// The server's own exception text, when the error came from SQL (`RAISE`).
pub fn db_message(error: &anyhow::Error) -> Option<String> {
    error.downcast_ref::<DbError>().map(|e| e.message.clone())
}

/// A single-quoted SQL string literal (quotes doubled). COPY takes no bind
/// parameters, so the embeddings reader interpolates its three controlled
/// values; this keeps that interpolation injection-proof even so.
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn classify(error: postgres::Error) -> anyhow::Error {
    match error.as_db_error() {
        Some(db) => DbError {
            sqlstate: Some(db.code().code().to_owned()),
            message: db.message().to_owned(),
        }
        .into(),
        None => anyhow::Error::from(error),
    }
}

impl Rpc {
    pub fn new(connector: Arc<Connector>, env: &str) -> Self {
        Self {
            connector,
            client: None,
            env: env.to_owned(),
        }
    }

    pub fn env(&self) -> &str {
        &self.env
    }

    fn client(&mut self) -> Result<&mut Client> {
        if self.client.as_ref().is_none_or(Client::is_closed) {
            self.client = Some(self.connector.connect()?);
        }
        self.client
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("no connection"))
    }

    fn drop_on_transport_error(&mut self, error: &anyhow::Error) {
        if error.downcast_ref::<DbError>().is_none() {
            self.client = None;
        }
    }

    /// Call one `/2` RPC. Arguments are JSON values bound by `signature_v2`.
    pub fn call(&mut self, name: &str, args: &[Value]) -> Result<Completion> {
        let casts = signature_v2(name)?;
        ensure!(casts.len() == args.len(), "queue_rpc_arity");
        ensure!(
            args.first().and_then(Value::as_str) == Some(self.env.as_str()),
            "queue_rpc_environment"
        );
        let values = bind_args(casts, args)?;
        let query = format!("SELECT public.{name}({})", placeholders(casts));
        let result = (|| -> Result<Completion> {
            let client = self.client()?;
            let mut tx = client
                .build_transaction()
                .isolation_level(IsolationLevel::ReadCommitted)
                .start()?;
            tx.batch_execute(
                "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s'; \
                 SET LOCAL idle_in_transaction_session_timeout='30s'; SET LOCAL TimeZone='UTC'",
            )?;
            let params: Vec<&(dyn ToSql + Sync)> = values.iter().map(|v| v.as_ref()).collect();
            let row = tx.query_one(&query, &params).map_err(classify)?;
            let reply = row
                .try_get::<_, Option<Value>>(0)
                .or_else(|_| {
                    row.try_get::<_, Option<bool>>(0)
                        .map(|b| b.map(Value::Bool))
                })?
                .unwrap_or(Value::Null);
            Ok(match tx.commit() {
                Ok(()) => Completion::Committed(reply),
                Err(_) => Completion::Unknown(reply),
            })
        })();
        if let Err(error) = &result {
            self.drop_on_transport_error(error);
        }
        result
    }

    /// `call`, accepting only a committed reply.
    pub fn committed(&mut self, name: &str, args: &[Value]) -> Result<Value> {
        match self.call(name, args)? {
            Completion::Committed(v) => Ok(v),
            Completion::Unknown(_) => anyhow::bail!("uncertain commit for {name}"),
        }
    }

    /// One `pd_embedding_put`: add up to 4,096 embeddings under one fenced
    /// attempt. The tids and digests bind as one-dimensional arrays; the matrix
    /// binds through `Matrix`, so no float makes a JSON round trip. `identity`
    /// is `task::identity(claim)` — `[env, job, owner, attempt, lease_epoch]`.
    /// A committed reply is `{rows, added, existing}`; an uncertain commit is an
    /// error, and a retry re-runs this idempotent call (`ON CONFLICT DO NOTHING`).
    pub fn embedding_put(
        &mut self,
        identity: &[Value],
        model: &str,
        tids: &[i32],
        text_shas: &[&[u8]],
        cols: usize,
        matrix: &[f32],
    ) -> Result<Value> {
        ensure!(identity.len() == 5, "embedding_put_identity");
        ensure!(
            !tids.is_empty() && tids.len() <= super::embedding::PUT_CHUNK,
            "embedding_put_chunk"
        );
        ensure!(
            tids.len() == text_shas.len() && matrix.len() == tids.len() * cols,
            "embedding_put_shape"
        );
        // The six scalar arguments bind exactly as every other /2 call does.
        let scalars = ["text", "uuid", "uuid", "uuid", "bigint", "text"];
        let mut head: Vec<Value> = identity.to_vec();
        head.push(Value::from(model));
        let mut values = bind_args(&scalars, &head)?;
        values.push(Box::new(tids.to_vec()));
        values.push(Box::new(
            text_shas
                .iter()
                .map(|s| s.to_vec())
                .collect::<Vec<Vec<u8>>>(),
        ));
        values.push(Box::new(Matrix {
            rows: tids.len(),
            cols,
            data: matrix,
        }));
        let query = "SELECT public.pd_embedding_put($1::text,$2::uuid,$3::uuid,$4::uuid,\
             $5::bigint,$6::text,$7::integer[],$8::bytea[],$9::real[])";
        let result = (|| -> Result<Value> {
            let client = self.client()?;
            let mut tx = client
                .build_transaction()
                .isolation_level(IsolationLevel::ReadCommitted)
                .start()?;
            tx.batch_execute(
                "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s'; \
                 SET LOCAL idle_in_transaction_session_timeout='30s'; SET LOCAL TimeZone='UTC'",
            )?;
            let params: Vec<&(dyn ToSql + Sync)> = values.iter().map(|v| v.as_ref()).collect();
            let reply = tx
                .query_one(query, &params)
                .map_err(classify)?
                .try_get::<_, Option<Value>>(0)?
                .unwrap_or(Value::Null);
            match tx.commit() {
                Ok(()) => Ok(reply),
                Err(_) => anyhow::bail!("uncertain commit for pd_embedding_put"),
            }
        })();
        if let Err(error) = &result {
            self.drop_on_transport_error(error);
        }
        result
    }

    /// Stream a closed set's rows out by binary COPY and return the raw bytes
    /// (bounded). `pd_embedding_rows` is a SRF, so this cannot go through the
    /// scalar-reply `call` path; COPY carries no bind parameters, so the three
    /// controlled values are quoted as literals (the env is already `[a-z0-9_-]`,
    /// the batch is a parsed UUID, the model a short identifier). The caller
    /// checks the decoded rows against the set receipt's digest.
    pub fn embedding_copy(&mut self, batch: &str, model: &str) -> Result<Vec<u8>> {
        use std::io::Read;
        let batch = Uuid::parse_str(batch)?;
        let query = format!(
            "COPY (SELECT tid, text_sha, embedding FROM public.pd_embedding_rows(\
             {},'{batch}'::uuid,{})) TO STDOUT (FORMAT binary)",
            sql_literal(&self.env),
            sql_literal(model),
        );
        let result = (|| -> Result<Vec<u8>> {
            let client = self.client()?;
            let mut tx = client
                .build_transaction()
                .isolation_level(IsolationLevel::ReadCommitted)
                .start()?;
            tx.batch_execute(
                "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s'; \
                 SET LOCAL idle_in_transaction_session_timeout='30s'; SET LOCAL TimeZone='UTC'",
            )?;
            let mut buf = Vec::new();
            {
                let mut reader = tx.copy_out(&query).map_err(classify)?;
                reader
                    .by_ref()
                    .take(super::embedding::MAX_SPOOL_BYTES as u64 + 1)
                    .read_to_end(&mut buf)?;
            }
            ensure!(
                buf.len() <= super::embedding::MAX_SPOOL_BYTES,
                "embedding_copy_bound"
            );
            tx.commit()?;
            Ok(buf)
        })();
        if let Err(error) = &result {
            self.drop_on_transport_error(error);
        }
        result
    }

    /// `SELECT contract_version FROM polis_queue_install` (the column the
    /// executor can read) plus the restricted-login boundary of `queue-rs`.
    pub fn contract(&mut self) -> Result<Option<String>> {
        let result = (|| -> Result<Option<String>> {
            let client = self.client()?;
            let boundary = client.query_one(
                "SELECT pg_has_role(current_user,'polis_queue_executor','MEMBER'),
                 (SELECT bool_or(has_table_privilege(current_user,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                  OR has_any_column_privilege(current_user,t,'SELECT,INSERT,UPDATE,REFERENCES')) FROM unnest($1::text[]) t),
                 pg_has_role(current_user,'polis_queue_owner','USAGE') OR pg_has_role(current_user,'polis_queue_owner','MEMBER'),
                 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.polis_queue_install')
                  AND attname='contract_version' AND NOT attisdropped)",
                &[&&TABLES[..]],
            ).map_err(classify)?;
            ensure!(
                boundary.get::<_, bool>(0)
                    && !boundary.get::<_, Option<bool>>(1).unwrap_or(false)
                    && !boundary.get::<_, bool>(2),
                "queue_login_boundary: the login must be a plain member of polis_queue_executor"
            );
            if !boundary.get::<_, Option<bool>>(3).unwrap_or(false) {
                return Ok(None);
            }
            let row = client
                .query_opt(
                    "SELECT contract_version FROM public.polis_queue_install",
                    &[],
                )
                .map_err(classify)?;
            Ok(row.map(|r| r.get::<_, String>(0)))
        })();
        if let Err(error) = &result {
            self.drop_on_transport_error(error);
        }
        result
    }

    /// Insert log rows; a replayed batch is harmless (`ON CONFLICT DO NOTHING`
    /// without a target needs only the executor's INSERT grant).
    pub fn insert_logs(&mut self, attempt: Uuid, rows: &[(i64, &str, &str)]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let seqs: Vec<i64> = rows.iter().map(|r| r.0).collect();
        let streams: Vec<&str> = rows.iter().map(|r| r.1).collect();
        let lines: Vec<&str> = rows.iter().map(|r| r.2).collect();
        let env = self.env.clone();
        let result = (|| -> Result<()> {
            let client = self.client()?;
            client
                .execute(
                    "INSERT INTO public.polis_queue_logs(env,attempt_id,seq,stream,line)
                     SELECT $1,$2,s,st,l FROM unnest($3::bigint[],$4::text[],$5::text[]) AS u(s,st,l)
                     ON CONFLICT DO NOTHING",
                    &[&env, &attempt, &seqs, &streams, &lines],
                )
                .map_err(classify)?;
            Ok(())
        })();
        if let Err(error) = &result {
            self.drop_on_transport_error(error);
        }
        result
    }

    /// A dedicated LISTEN connection for `polis_queue_wakeup_v1` (000019:429).
    pub fn listener(&self) -> Result<Client> {
        let mut client = self.connector.connect()?;
        client.batch_execute("LISTEN polis_queue_wakeup_v1")?;
        Ok(client)
    }
}
