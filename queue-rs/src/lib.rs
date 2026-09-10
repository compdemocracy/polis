//! Local, opt-in polis-queue/1 transport. No daemon, science or provider work.
//! Each RPC gets a fresh restricted connection and an explicit transaction.
//! A lost COMMIT returns its provisional reply as uncertainty, never success.
//! In particular the caller must not repeat an uncertain claim: renew the exact
//! token or leave it unresolved. This adapter performs no automatic retries.
use anyhow::{Result, ensure};
use postgres::{Client, Config, NoTls, config::Host, types::ToSql};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};
use uuid::Uuid;

pub const QUEUE_SQL_SHA256: &str =
    "2d8e205f1d36e0e2e6a4fc63d1d03cbf8837ca57ccaac503c88238fa2a14a055";
pub const LANES: [i16; 6] = [0, 0, 0, 1, 1, 2];
const TABLES: [&str; 5] = [
    "public.polis_queue_runs",
    "public.polis_queue_heads",
    "public.polis_queue_jobs",
    "public.polis_queue_attempts",
    "public.polis_queue_requests",
];
const FIELDS: &str = "schema_version outcome env job_id run_id attempt_id owner_id lease_epoch version mgmt_version locked_until state output_sha256 published stage stage_instance attempt_count max_attempts parked_attempt_count eligible_at first_parked_at last_error_code input";
const HEAD: &str = "schema_version outcome env product_key found desired_run_id desired_state published_run_id published_generation published_sha256";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub name: String,
    pub args: Vec<Value>,
}

#[derive(Debug)]
pub enum Completion {
    Committed(Value),
    Unknown(Value),
}

fn signature(name: &str) -> Result<&'static [&'static str]> {
    Ok(match name {
        "pq_enqueue" => &[
            "text", "integer", "text", "text", "text", "text", "uuid", "uuid", "text", "text",
            "text", "text", "smallint", "integer",
        ],
        "pq_claim" => &["text", "smallint", "uuid", "uuid", "integer"],
        "pq_heartbeat" => &["text", "uuid", "uuid", "uuid", "bigint", "integer"],
        "pq_finalize" => &["text", "uuid", "uuid", "uuid", "bigint", "text", "text"],
        "pq_fail" => &["text", "uuid", "uuid", "uuid", "bigint", "boolean", "text"],
        "pq_release" => &["text", "uuid", "uuid", "uuid", "bigint"],
        "pq_park" => &["text", "uuid", "uuid", "uuid", "bigint", "text"],
        "pq_due" => &["text", "uuid", "integer"],
        "pq_reap_one" | "pq_job_status" => &["text", "uuid"],
        "pq_head_status" => &["text", "text"],
        "pq_cancel" => &["text", "uuid", "bigint"],
        _ => anyhow::bail!("queue_rpc_name"),
    })
}

fn fields(value: &Value, expected: &str) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("queue_wire_object"))?;
    ensure!(
        object.keys().map(String::as_str).collect::<BTreeSet<_>>()
            == expected.split_whitespace().collect(),
        "queue_wire_fields"
    );
    Ok(())
}

fn decimal(value: &Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

pub fn validate(name: &str, value: &Value) -> Result<()> {
    if name == "pq_due" {
        let ids = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("queue_wire_due"))?;
        ensure!(ids.len() <= 100, "queue_wire_due_bound");
        for id in ids {
            Uuid::parse_str(
                id.as_str()
                    .ok_or_else(|| anyhow::anyhow!("queue_wire_uuid"))?,
            )?;
        }
        return Ok(());
    }
    if value.is_null() && name == "pq_reap_one" {
        return Ok(());
    }
    ensure!(
        value["schema_version"] == "polis-queue/1",
        "queue_wire_version"
    );
    if name == "pq_head_status" {
        fields(value, HEAD)?;
        ensure!(
            value["outcome"] == "head_status"
                && value["found"].is_boolean()
                && decimal(&value["published_generation"]),
            "queue_wire_head"
        );
        for key in [
            "env",
            "product_key",
            "desired_run_id",
            "desired_state",
            "published_run_id",
            "published_sha256",
        ] {
            ensure!(
                value[key].is_null() || value[key].is_string(),
                "queue_wire_text"
            );
        }
        return Ok(());
    }
    fields(value, FIELDS)?;
    ensure!(value["published"].is_boolean(), "queue_wire_published");
    for key in ["lease_epoch", "version", "mgmt_version"] {
        ensure!(decimal(&value[key]), "queue_wire_counter");
    }
    for key in ["attempt_count", "max_attempts", "parked_attempt_count"] {
        ensure!(
            value[key].is_null() || value[key].as_u64().is_some_and(|n| n <= i32::MAX as u64),
            "queue_wire_count"
        );
    }
    for key in ["locked_until", "eligible_at", "first_parked_at"] {
        ensure!(
            value[key].is_null() || value[key].as_str().is_some_and(|s| s.ends_with("+00:00")),
            "queue_wire_timestamp"
        );
    }
    for key in [
        "env",
        "job_id",
        "run_id",
        "attempt_id",
        "owner_id",
        "state",
        "output_sha256",
        "stage",
        "stage_instance",
        "last_error_code",
        "outcome",
    ] {
        ensure!(
            value[key].is_null() || value[key].is_string(),
            "queue_wire_text"
        );
    }
    if !value["input"].is_null() {
        fields(
            &value["input"],
            "uri sha256 config_sha256 code_image_digest",
        )?;
        for key in ["uri", "sha256", "config_sha256", "code_image_digest"] {
            ensure!(value["input"][key].is_string(), "queue_wire_descriptor");
        }
    }
    Ok(())
}

pub struct Database {
    config: Config,
    env: String,
}

impl Database {
    pub fn new(dsn: &str, env: &str, enabled: bool, production: bool) -> Result<Self> {
        ensure!(enabled && !production, "queue_noop_disabled");
        let suffix = env.strip_prefix("dev").or_else(|| env.strip_prefix("test"));
        ensure!(
            suffix.is_some_and(|s| s.is_empty()
                || (s.starts_with('-')
                    && (2..=50).contains(&s.len())
                    && (s.as_bytes()[1].is_ascii_lowercase() || s.as_bytes()[1].is_ascii_digit())
                    && s[1..]
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))),
            "queue_noop_environment"
        );
        let mut config: Config = dsn.parse()?;
        // NoTls is permitted only for the isolated loopback campaign.
        ensure!(
            !config.get_hosts().is_empty()
                && config.get_hosts().iter().all(|h| match h {
                    Host::Tcp(s) => s.parse::<std::net::IpAddr>().is_ok_and(|a| a.is_loopback()),
                    _ => false,
                }),
            "queue_loopback_only"
        );
        config
            .connect_timeout(Duration::from_secs(5))
            .application_name("polis-queue-rust/1");
        Ok(Self {
            config,
            env: env.to_owned(),
        })
    }

    pub fn call(&self, request: &Request) -> Result<Completion> {
        let casts = signature(&request.name)?;
        ensure!(casts.len() == request.args.len(), "queue_rpc_arity");
        ensure!(
            request.args.first().and_then(Value::as_str) == Some(&self.env),
            "queue_rpc_environment"
        );
        let mut values: Vec<Box<dyn ToSql + Sync>> = Vec::new();
        for (kind, value) in casts.iter().zip(&request.args) {
            let invalid = || anyhow::anyhow!("queue_rpc_type");
            values.push(match *kind {
                "text" => Box::new(if value.is_null() {
                    None
                } else {
                    Some(value.as_str().ok_or_else(invalid)?.to_owned())
                }),
                "uuid" => Box::new(if value.is_null() {
                    None
                } else {
                    Some(Uuid::parse_str(value.as_str().ok_or_else(invalid)?)?)
                }),
                "boolean" => Box::new(value.as_bool().ok_or_else(invalid)?),
                "smallint" => Box::new(i16::try_from(value.as_i64().ok_or_else(invalid)?)?),
                "integer" => Box::new(i32::try_from(value.as_i64().ok_or_else(invalid)?)?),
                "bigint" => Box::new(value.as_str().ok_or_else(invalid)?.parse::<i64>()?),
                _ => anyhow::bail!("queue_rpc_type"),
            });
        }
        let placeholders = casts
            .iter()
            .enumerate()
            .map(|(i, cast)| format!("${}::{cast}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "SELECT {}public.{}({})",
            if request.name == "pq_due" {
                "job_id FROM "
            } else {
                ""
            },
            request.name,
            placeholders
        );
        let mut client: Client = self.config.connect(NoTls)?;
        let mut tx = client
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::ReadCommitted)
            .start()?;
        tx.batch_execute("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL TimeZone='UTC'")?;
        let boundary = tx.query_one("SELECT pg_has_role(current_user,'polis_queue_executor','MEMBER'),
            (SELECT bool_or(has_table_privilege(current_user,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(current_user,t,'SELECT,INSERT,UPDATE,REFERENCES')) FROM unnest($1::text[]) t),
            pg_has_role(current_user,'polis_queue_owner','USAGE') OR pg_has_role(current_user,'polis_queue_owner','MEMBER')", &[&&TABLES[..]])?;
        ensure!(
            boundary.get::<_, bool>(0)
                && !boundary.get::<_, bool>(1)
                && !boundary.get::<_, bool>(2),
            "queue_login_boundary"
        );
        let params: Vec<&(dyn ToSql + Sync)> = values.iter().map(|v| v.as_ref()).collect();
        let rows = tx.query(&query, &params)?;
        let reply = if request.name == "pq_due" {
            Value::Array(
                rows.iter()
                    .map(|r| json!(r.get::<_, Uuid>(0).to_string()))
                    .collect(),
            )
        } else {
            ensure!(rows.len() == 1, "queue_rpc_rows");
            rows[0]
                .try_get::<_, Option<Value>>(0)?
                .unwrap_or(Value::Null)
        };
        validate(&request.name, &reply)?;
        Ok(match tx.commit() {
            Ok(()) => Completion::Committed(reply),
            Err(_) => Completion::Unknown(reply),
        })
    }
}
