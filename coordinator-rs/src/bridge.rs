//! Control-plane dispatch; Python alone calls the restricted publication API.
use crate::{
    engine::Source,
    lease::{LeaseState, Renewal},
    metrics::count,
    store::{Bundle, CommitLost, Payloads, PgStore, Publication, digest},
};
use anyhow::{Result, ensure};
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub const SQL_SHA256: &str = "d50f169ad7afe12d14582a6a746c622d402ecafd8131aae246812263bf2d5e82";
pub const ENGINE_SHA256: &str = "b295c3e7c649b38768c4eeb69c7cb3bf59d33c0077c22c84853a44d216aa0028";
const ENGINE_MANIFEST: &str = include_str!("../schemas/poller-engine-v1.json");
pub const PROTOCOL: &str = "polis-poller-bridge/1";
const SQL: &str =
    include_str!("../../server/postgres/migrations/000021_create_polis_coordinator.sql");
const RPC: &str =
    "public.pc_publish(text,integer,text,bigint,text,bytea,bigint,jsonb,bytea,bytea,bytea)";

pub fn admit_control(client: &mut Client, math_env: &str) -> Result<()> {
    ensure!(
        digest(SQL.as_bytes()) == SQL_SHA256,
        "COORDINATOR_SCHEMA_BYTE_PIN"
    );
    let row = client.query_one("SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user", &[])?;
    ensure!(
        !(0..5).any(|i| row.get::<_, bool>(i)),
        "BROAD_CONTROL_CREDENTIAL"
    );
    ensure!(
        client
            .query_one(
                "SELECT pg_has_role(current_user,'polis_coordinator_control','USAGE')",
                &[]
            )?
            .get::<_, bool>(0),
        "CONTROL_ROLE_REQUIRED"
    );
    ensure!(
        !client
            .query_one(
                "SELECT has_function_privilege(current_user,$1,'EXECUTE')",
                &[&RPC]
            )?
            .get::<_, bool>(0),
        "CONTROL_PUBLICATION_AUTHORITY_REFUSED"
    );
    for role in [
        "polis_coordinator_owner",
        "polis_coordinator_publication_owner",
        "polis_coordinator_publisher",
    ] {
        ensure!(!client.query_one("SELECT pg_has_role(current_user,$1,'USAGE') OR pg_has_role(current_user,$1,'SET')", &[&role])?.get::<_,bool>(0), "BROAD_CONTROL_ROLE_REACHABILITY");
    }
    let reachable=client.query("SELECT rolname,rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE pg_has_role(current_user,oid,'SET') OR pg_has_role(current_user,oid,'USAGE')",&[])?;
    for role in reachable {
        let name: String = role.get(0);
        ensure!(!role.get::<_, bool>(1), "BROAD_CONTROL_ROLE_REACHABILITY");
        ensure!(
            !client
                .query_one(
                    "SELECT has_function_privilege($1,$2,'EXECUTE')",
                    &[&name, &RPC]
                )?
                .get::<_, bool>(0),
            "CONTROL_PUBLICATION_AUTHORITY_REFUSED"
        );
        for table in [
            "math_main",
            "math_ticks",
            "math_bidtopid",
            "math_ptptstats",
            "polis_coordinator_generations",
            "polis_coordinator_payloads",
            "polis_coordinator_operations",
            "polis_coordinator_budgets",
            "polis_coordinator_references",
            "polis_coordinator_floors",
            "polis_coordinator_namespaces",
            "polis_coordinator_principals",
            "polis_coordinator_transitions",
            "polis_coordinator_writer_authority",
        ] {
            ensure!(!client.query_one("SELECT has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege($1,$2,'INSERT,UPDATE')", &[&name,&format!("public.{table}")])?.get::<_,bool>(0), "DIRECT_CONTROL_DML_REFUSED");
        }
    }
    let row=client.query_one("SELECT migration_id,catalog_fingerprint FROM public.polis_coordinator_install WHERE singleton", &[])?;
    ensure!(
        row.get::<_, String>(0) == "000021"
            && row.get::<_, String>(1) == "b497500ab5652f3d24775f4895736c01",
        "COORDINATOR_SCHEMA_MISMATCH"
    );
    ensure!(
        client
            .query_one("SELECT public.pc_namespace_allowed($1)", &[&math_env])?
            .get::<_, bool>(0),
        "NAMESPACE_AUTHORITY_REQUIRED"
    );
    Ok(())
}

pub fn dispatch_poller(
    store: &mut PgStore,
    zid: i32,
    expected: Option<i64>,
    epoch: i64,
    source: &Source,
    prior: Option<&Bundle>,
    renewal: &Renewal,
) -> Result<Publication> {
    let input = serde_json::to_string(
        &json!({"source":{"votes":source.votes,"moderation":source.moderation,
        "ordering":source.ordering,"fingerprint":source.fingerprint},
        "prior":prior.map(|p|json!({"data":p.payloads.main,"last_vote_timestamp":0,"snapshot_complete":true}))}),
    )?;
    ensure!(
        digest(ENGINE_MANIFEST.as_bytes()) == ENGINE_SHA256,
        "ENGINE_MANIFEST_BYTE_PIN"
    );
    let schedule = json!({"lifecycle":"poller-rebuild-prefix/1","seed":42,"pca_mode":"powerit",
        "storage_agree_value":store.config.storage_agree_value});
    let checkpoint = json!({"schema":"polis-coordinator/2","profile":"candidate-profile",
        "lifecycle":"poller-rebuild-prefix/1","engine":"python-math-poller/1","seed":42,"pca_mode":"powerit",
        "engine_sha256":ENGINE_SHA256,"schedule_sha256":digest(&serde_json::to_vec(&schedule)?),
        "source_fingerprint":source.fingerprint,"ordering":source.ordering,"input_sha256":digest(input.as_bytes()),
        "event_count":source.votes.len(),"storage_agree_value":store.config.storage_agree_value,
        "cursors":{"votes":source.votes.len(),"moderation":1}});
    dispatch(
        store,
        zid,
        expected,
        epoch,
        checkpoint,
        json!({"input_bytes":input,"engine_manifest":ENGINE_MANIFEST}),
        Some(renewal),
    )
}

pub fn publish_fixture(
    store: &mut PgStore,
    zid: i32,
    expected: Option<i64>,
    epoch: i64,
    checkpoint: Value,
    payload: &Payloads,
) -> Result<Publication> {
    ensure!(
        cfg!(feature = "fault-injection"),
        "DIAGNOSTIC-CONTROL-REFUSED"
    );
    payload.validate(zid)?;
    payload.validate_originals()?;
    dispatch(
        store,
        zid,
        expected,
        epoch,
        checkpoint,
        json!({"fixture_originals":{
        "main":String::from_utf8(payload.originals.main.clone())?,
        "bidtopid":String::from_utf8(payload.originals.bidtopid.clone())?,
        "ptptstats":String::from_utf8(payload.originals.ptptstats.clone())?}}),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn dispatch(
    store: &mut PgStore,
    zid: i32,
    expected: Option<i64>,
    epoch: i64,
    mut checkpoint: Value,
    mut frame: Value,
    renewal: Option<&Renewal>,
) -> Result<Publication> {
    store.poller_timings = None;
    admit_control(&mut store.client, &store.config.math_env)?;
    ensure!(
        store.config.reservation_bytes > 0,
        "RECEIPT_RESERVATION_REQUIRED"
    );
    let publisher_url = std::env::var("COORDINATOR_PUBLISHER_DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("PUBLISHER_CREDENTIAL_REQUIRED"))?;
    let operation = checkpoint["operation_id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Rev4 hashes the caller checkpoint before pc_publish adds receipt-owned
    // identity/digest fields. Keep operation identity in its dedicated column.
    checkpoint
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("CHECKPOINT_OBJECT_REQUIRED"))?
        .remove("operation_id");
    ensure!(
        ["publisher_epoch", "original_digests", "payload_digests"]
            .iter()
            .all(|k| checkpoint.get(k).is_none()),
        "RECEIPT_FIELDS_IN_CHECKPOINT"
    );
    let source_hash = if let Some(input) = frame["input_bytes"].as_str() {
        digest(input.as_bytes())
    } else {
        digest(&serde_json::to_vec(&frame)?)
    };
    // Independent UUIDs supply 244 random bits. No raw capability in argv/logs/DB.
    let capability = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let raw: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&capability[i..i + 2], 16))
        .collect::<std::result::Result<_, _>>()?;
    let cap_hash = digest(&raw);
    let margin = (store.config.commit_margin_seconds * 1000.0).ceil();
    ensure!(
        margin.is_finite() && (1.0..=60000.0).contains(&margin),
        "INVALID_DISPATCH_MARGIN"
    );
    let mut admission = store.client.transaction()?;
    if !admission
        .query_one(
            "SELECT public.pc_writer_allowed($1,$2)",
            &[&store.config.math_env, &zid],
        )?
        .get::<_, bool>(0)
    {
        admission.rollback()?;
        return Ok(Publication::Refused(LeaseState::Unavailable));
    }
    let changed=admission.execute("UPDATE public.polis_coordinator_leases SET dispatch_operation_id=$5,dispatch_capability_sha256=$6,dispatch_checkpoint_sha256=encode(sha256(convert_to($7::jsonb::text,'UTF8')),'hex'),dispatch_expected_tick=$8,dispatch_margin_ms=$9 WHERE math_env=$1 AND zid=$2 AND owner_id=$3 AND owner_epoch=$4 AND expires_at>clock_timestamp()",&[&store.config.math_env,&zid,&store.config.owner,&epoch,&operation,&cap_hash,&checkpoint,&expected,&(margin as i32)])?;
    if changed != 1 {
        admission.rollback()?;
        return Ok(Publication::Refused(
            store.lease_state(zid, epoch)?.unwrap_or(LeaseState::Fenced),
        ));
    }
    let admitted = admission.query_one(
        "SELECT public.pc_admit($1,$2,$3,$4,$5,$6,$7)",
        &[
            &store.config.math_env,
            &zid,
            &store.config.owner,
            &epoch,
            &operation,
            &source_hash,
            &store.config.reservation_bytes,
        ],
    );
    match admitted {
        Ok(row) => ensure!(
            matches!(
                row.get::<_, String>(0).as_str(),
                "admitted" | "already_admitted"
            ),
            "ADMISSION_REPLY"
        ),
        Err(error) => {
            admission.rollback()?;
            if error.as_db_error().is_some_and(|e| {
                e.code().code() == "P2020" && e.message() == "ADMISSION_TICK_CONFLICT"
            }) {
                return Ok(Publication::Conflict);
            }
            if error
                .as_db_error()
                .is_some_and(|e| e.code().code() == "P2005")
            {
                return Ok(Publication::Refused(LeaseState::Expired));
            }
            return Err(error.into());
        }
    }
    // A lost COMMIT reply cannot lead to a child launch. Durable pending state
    // remains charged and is reconciled by a replacement process.
    admission.commit()?;
    let fault = store.fault.bridge_control()?;
    for (key,value) in json!({"protocol":PROTOCOL,"schema_sha256":SQL_SHA256,"namespace":store.config.math_env,
        "zid":zid,"owner":store.config.owner,"epoch":epoch,"operation":operation,"capability":capability,
        "expected_tick":expected,"checkpoint":checkpoint,"fault":fault}).as_object().into_iter().flatten() {
        frame[key]=value.clone();
    }
    let bytes = serde_json::to_vec(&frame)?;
    ensure!(bytes.len() < 256 * 1024 * 1024, "BRIDGE_INPUT_LIMIT");
    let mut command = Command::new(&store.config.python);
    command
        .args(["-m", "polismath.poller.coordinator_bridge"])
        .env_clear()
        .env("COORDINATOR_PUBLISHER_DATABASE_URL", publisher_url)
        .env("OPENBLAS_NUM_THREADS", "1")
        .env("OMP_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
        .env("PYTHONHASHSEED", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for name in ["PATH", "PYTHONPATH", "VIRTUAL_ENV", "SYSTEMROOT", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let dispatch_started = Instant::now();
    let mut publication_started = None;
    let mut child = command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("BRIDGE_STDIN"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("BRIDGE_STDOUT"))?;
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let result = std::io::Read::take(&mut reader, 65537).read_line(&mut line);
            match result {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() <= 65536 && line.ends_with('\n') => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    let mut publishing = false;
    let result = (|| -> Result<Value> {
        stdin.write_all(&bytes)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        let started = Instant::now();
        loop {
            ensure!(
                started.elapsed() < Duration::from_secs(600),
                "BRIDGE_DEADLINE"
            );
            if !publishing && let Some(state) = renewal.and_then(Renewal::state) {
                return Err(state.into());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    let reply = crate::wire::parse(line.as_bytes())?;
                    ensure!(reply["protocol"] == PROTOCOL, "BRIDGE_REPLY_PROTOCOL");
                    if reply["phase"] == "publication" {
                        ensure!(!publishing, "DUPLICATE_PUBLICATION_PHASE");
                        publication_started = Some(Instant::now());
                        publishing = true;
                        continue;
                    }
                    if let Some(stage) = reply["stage"].as_str() {
                        ensure!(fault != Value::Null, "UNREQUESTED_BRIDGE_FAULT");
                        ensure!(
                            crate::fault::STAGES.contains(&stage),
                            "UNKNOWN_BRIDGE_STAGE"
                        );
                        store.fault.hit(stage,&json!({"zid":zid,"math_env":store.config.math_env,"epoch":epoch,
                            "checkpoint":checkpoint,"backend_pid":reply["backend_pid"],"worker_pid":child.id()}))?;
                        stdin.write_all(b"continue\n")?;
                        stdin.flush()?;
                        store.fault.bridge_resumed(stage, child.id())?;
                    } else {
                        return Ok(reply);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("BRIDGE_REPLY_LOST"),
            }
        }
    })();
    drop(stdin);
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait();
    let _ = reader.join();
    if let Some(at) = publication_started {
        store.poller_timings = Some((at.duration_since(dispatch_started), at.elapsed()));
    }
    // Verify even successful acknowledgements against the durable operation,
    // which remains identifiable after a later generation overwrites math rows.
    let refused = matches!(&result, Ok(r) if r["outcome"]=="conflict" || r["code"]=="FENCED" || r["code"]=="LEASE-EXPIRED" || r["code"]=="WRITER_AUTHORITY_REQUIRED");
    let ambiguous = publishing
        && !refused
        && (!matches!(&result,Ok(r) if r["outcome"]=="committed" || r["outcome"]=="already_committed")
            || !matches!(&status,Ok(s) if s.success()));
    let mut context = json!({"zid":zid,"epoch":epoch,"operation_id":operation,
        "math_tick":expected.map_or(0,|n|n+1)});
    if ambiguous {
        store.metrics.emit(
            "publication_ambiguous",
            &[count("PublishUncertain", 1u32)],
            context.clone(),
        );
    }
    // Reconcile every admitted dispatch, including pre-publication failures.
    // No receipt means durable unresolved capacity, never permission to free it.
    let receipt = (|| -> Result<Option<i64>> {
        let mut client = Client::connect(&store.config.database_url, NoTls)?;
        client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'")?;
        crate::operations::reconcile_one(&mut client, &store.config.math_env, zid, &operation)
    })();
    if let Ok(reply) = &result {
        if matches!(
            reply["outcome"].as_str(),
            Some("committed" | "already_committed")
        ) {
            let retries = reply["publish_retries"]
                .as_u64()
                .filter(|n| *n <= 2)
                .ok_or_else(|| anyhow::anyhow!("INVALID_PUBLICATION_RETRY_COUNT"))?;
            store.tally.publish_retried += retries as u32;
        }
        if reply["outcome"] == "conflict" {
            return Ok(receipt?.map_or(Publication::Conflict, Publication::Committed));
        }
        if reply["code"] == "FENCED" {
            return Ok(receipt?.map_or(
                Publication::Refused(LeaseState::Fenced),
                Publication::Committed,
            ));
        }
        if reply["code"] == "LEASE-EXPIRED" {
            return Ok(receipt?.map_or(
                Publication::Refused(LeaseState::Expired),
                Publication::Committed,
            ));
        }
        if reply["code"] == "WRITER_AUTHORITY_REQUIRED" {
            return Ok(receipt?.map_or(
                Publication::Refused(LeaseState::Unavailable),
                Publication::Committed,
            ));
        }
    }
    if !publishing {
        if let Some(tick) = receipt? {
            return Ok(Publication::Committed(tick));
        }
        if let Err(error) = result {
            return Err(error);
        }
        anyhow::bail!("BRIDGE_COMPUTE_OR_ADMISSION_FAILED");
    }
    if ambiguous {
        let own = matches!(receipt, Ok(Some(_)));
        context["outcome"] = json!(if own {
            "resolved-own"
        } else {
            "unresolved-lost"
        });
        context["readback"] = json!(match &receipt {
            Ok(Some(_)) => "own",
            Ok(None) => "identity-not-observed",
            Err(_) => "readback-failed",
        });
        store.metrics.emit(
            "publication_readback",
            &[
                count("PublishResolvedOwn", u32::from(own)),
                count("PublishUnresolvedLost", u32::from(!own)),
            ],
            context,
        );
    }
    if let Some(tick) = receipt? {
        return Ok(Publication::Committed(tick));
    }
    result?;
    Err(CommitLost.into())
}
