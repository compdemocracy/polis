//! Opt-in captured-source replay using the unchanged coordinator publication bridge.
//! This process is a shadow writer, never the read-only route collector.
use anyhow::{Result, bail, ensure};
use polis_coordinator::{
    bridge,
    config::Config,
    engine::Source,
    fault::Fault,
    lease::{LeaseState, Renewal},
    ordering,
    store::{Bundle, Current, PgStore, Publication, ResultsStore, digest},
    wire,
};
use serde_json::{Value, json};
use std::io::{Read, Write};

const LIMIT: u64 = 64 * 1024 * 1024;
fn closed(v: &Value, fields: &[&str]) -> Result<()> {
    ensure!(
        v.as_object()
            .is_some_and(|o| o.len() == fields.len() && fields.iter().all(|k| o.contains_key(*k))),
        "SHADOW_SCHEMA"
    );
    Ok(())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 999)
        .ok_or_else(|| anyhow::anyhow!("SHADOW_TEXT"))
}
fn hash(v: &Value, key: &str) -> Result<()> {
    let h = text(v, key)?;
    ensure!(
        h.len() == 64
            && h.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "SHADOW_HASH"
    );
    Ok(())
}
fn integer(v: &Value, key: &str) -> Result<i64> {
    v[key]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("SHADOW_INTEGER"))
}
fn nonnegative(v: &Value, key: &str) -> Result<i64> {
    let n = integer(v, key)?;
    ensure!(n >= 0, "SHADOW_INTEGER");
    Ok(n)
}
fn source(request: &Value) -> Result<Source> {
    closed(
        request,
        &[
            "schema",
            "host",
            "legacy_namespace",
            "namespace",
            "zid",
            "cut_bytes",
            "cut_sha256",
            "history_sha256",
            "expected_tick",
            "prior_bundle_sha256",
            "storage_agree_value",
            "reference",
        ],
    )?;
    ensure!(
        request["schema"] == "polis-shadow-replay-input/1",
        "SHADOW_SCHEMA"
    );
    for k in ["host", "legacy_namespace", "namespace", "reference"] {
        text(request, k)?;
    }
    for k in ["cut_sha256", "history_sha256"] {
        hash(request, k)?;
    }
    ensure!(text(request, "reference")?.len() <= 128, "SHADOW_REFERENCE");
    let namespace = text(request, "namespace")?;
    ensure!(
        namespace != text(request, "legacy_namespace")?
            && !matches!(namespace, "prod" | "preprod" | "dev"),
        "SHADOW_NAMESPACE"
    );
    ensure!(
        (1..=i32::MAX as i64).contains(&integer(request, "zid")?),
        "SHADOW_ZID"
    );
    let agree = integer(request, "storage_agree_value")?;
    ensure!(matches!(agree, -1 | 1), "SHADOW_POLARITY");
    if !request["expected_tick"].is_null() {
        ensure!(
            (0..=9_007_199_254_740_990).contains(&integer(request, "expected_tick")?),
            "SHADOW_TICK"
        );
        hash(request, "prior_bundle_sha256")?;
    } else {
        ensure!(request["prior_bundle_sha256"].is_null(), "SHADOW_PRIOR");
    }
    let raw = request["cut_bytes"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("SHADOW_CUT"))?;
    ensure!(
        !raw.is_empty()
            && raw.len() as u64 <= LIMIT
            && digest(raw.as_bytes()) == request["cut_sha256"],
        "SHADOW_CUT"
    );
    let rows = wire::parse(raw.as_bytes())?;
    closed(&rows, &["votes", "comments", "participants", "ordering"])?;
    // Require the exact captured canonical serialization, never silently sort/rewrite input.
    ensure!(
        serde_json::to_vec(&rows)? == raw.as_bytes(),
        "SHADOW_CUT_ENCODING"
    );
    let array = |key: &str| -> Result<&Vec<Value>> {
        rows[key]
            .as_array()
            .filter(|a| a.len() <= 1_000_000)
            .ok_or_else(|| anyhow::anyhow!("SHADOW_SOURCE_LIMIT"))
    };
    let votes = array("votes")?;
    let comments = array("comments")?;
    let participants = array("participants")?;
    let mut last = None;
    for v in votes {
        closed(v, &["pid", "tid", "vote", "created", "weight_x_32767"])?;
        let sign = integer(v, "vote")?;
        ensure!(matches!(sign, -1..=1), "SHADOW_VOTE");
        let weight = if v["weight_x_32767"].is_null() {
            None
        } else {
            Some(integer(v, "weight_x_32767")?)
        };
        let key = (
            nonnegative(v, "tid")?,
            nonnegative(v, "pid")?,
            nonnegative(v, "created")?,
            sign * agree,
            weight,
        );
        ensure!(last.is_none_or(|prior| prior <= key), "SHADOW_ORDER");
        last = Some(key);
    }
    let mut previous = None;
    for c in comments {
        closed(c, &["tid", "mod", "is_meta", "modified"])?;
        let id = nonnegative(c, "tid")?;
        ensure!(previous.is_none_or(|p| p < id), "SHADOW_COMMENT_ORDER");
        previous = Some(id);
        ensure!(
            c["mod"].is_null() || matches!(c["mod"].as_i64(), Some(-1..=1)),
            "SHADOW_MODERATION"
        );
        ensure!(
            c["is_meta"].is_null() || c["is_meta"].is_boolean(),
            "SHADOW_MODERATION"
        );
        ensure!(
            c["modified"].is_null() || c["modified"].as_i64().is_some(),
            "SHADOW_MODERATION"
        );
    }
    previous = None;
    for p in participants {
        closed(p, &["pid", "mod"])?;
        let id = nonnegative(p, "pid")?;
        ensure!(previous.is_none_or(|p| p < id), "SHADOW_PARTICIPANT_ORDER");
        previous = Some(id);
        ensure!(
            p["mod"].is_null() || matches!(p["mod"].as_i64(), Some(-1..=1)),
            "SHADOW_MODERATION"
        );
    }
    ensure!(
        rows["ordering"] == ordering::manifest(agree, ordering::census(votes))?,
        "SHADOW_ORDER_MANIFEST"
    );
    let tids = |m: i64| {
        comments
            .iter()
            .filter(|r| r["mod"] == m)
            .map(|r| r["tid"].clone())
            .collect::<Vec<_>>()
    };
    let moderation = json!({"mod_in_tids":tids(1),"mod_out_tids":tids(-1),
        "meta_tids":comments.iter().filter(|r|r["is_meta"]==true).map(|r|r["tid"].clone()).collect::<Vec<_>>(),
        "mod_out_ptpts":participants.iter().filter(|r|r["mod"] == -1).map(|r|r["pid"].clone()).collect::<Vec<_>>(),"lastModTimestamp":null});
    Ok(Source {
        votes: votes.clone(),
        moderation,
        ordering: rows["ordering"].clone(),
        fingerprint: digest(raw.as_bytes()),
    })
}
fn expected_input(source: &Source, prior: Option<&Bundle>) -> Result<String> {
    Ok(serde_json::to_string(
        &json!({"source":{"votes":source.votes,"moderation":source.moderation,"ordering":source.ordering,"fingerprint":source.fingerprint},
        "prior":prior.map(|p|json!({"data":p.payloads.main,"last_vote_timestamp":0,"snapshot_complete":true}))}),
    )?)
}
fn execute(request: &Value, source: &Source) -> Result<Value> {
    Fault::reject_release_control()?;
    ensure!(
        !cfg!(feature = "fault-injection"),
        "SHADOW_FAULT_BUILD_REFUSED"
    );
    ensure!(
        std::env::var("SHADOW_REPLAY_ENABLE").as_deref() == Ok("captured-input/1"),
        "SHADOW_DISABLED"
    );
    for (key, name) in [
        ("cut_sha256", "SHADOW_REPLAY_CUT_SHA256"),
        ("history_sha256", "SHADOW_REPLAY_HISTORY_SHA256"),
        ("host", "SHADOW_REPLAY_HOST"),
    ] {
        ensure!(
            std::env::var(name).ok().as_deref() == request[key].as_str(),
            "SHADOW_ADMISSION_BINDING"
        );
    }
    let config = Config::from_env()?;
    let zid = i32::try_from(integer(request, "zid")?)?;
    ensure!(
        !config.allowlist.is_empty() && config.accepts(zid),
        "SHADOW_ALLOWLIST"
    );
    ensure!(
        config.math_env == text(request, "namespace")?
            && config.storage_agree_value == integer(request, "storage_agree_value")?,
        "SHADOW_CONFIG"
    );
    ensure!(config.metrics_sink == "off", "SHADOW_PRIVATE_LOG_ONLY");
    let mut store = PgStore::connect(config)?;
    bridge::admit_control(&mut store.client, &store.config.math_env)?;
    let epoch = store.acquire(zid)?.ok_or(LeaseState::Unavailable)?;
    let result = (|| -> Result<Value> {
        let mut renewal = Renewal::start(&store.config, zid, epoch)?;
        let expected = request["expected_tick"].as_i64();
        ensure!(store.current_tick(zid)? == expected, "SHADOW_PRIOR_TICK");
        let prior = store.load_current(zid)?;
        let old = match &prior {
            Current::Absent if expected.is_none() => None,
            Current::Coherent(b) if Some(b.math_tick) == expected => {
                ensure!(
                    digest(&serde_json::to_vec(b)?) == request["prior_bundle_sha256"],
                    "SHADOW_PRIOR_BYTES"
                );
                Some(b.as_ref())
            }
            _ => bail!("SHADOW_PRIOR_INCOMPLETE"),
        };
        let input = expected_input(source, old)?;
        let tick =
            match bridge::dispatch_poller(&mut store, zid, expected, epoch, source, old, &renewal)?
            {
                Publication::Committed(t) => t,
                Publication::Refused(s) => return Err(s.into()),
                Publication::Conflict => bail!("SHADOW_PUBLICATION_CONFLICT"),
            };
        // Live lease plus current/floor protection covers the handoff to explicit retention.
        // A loss/current replacement refuses rather than falling back to a newer generation.
        let bundle = match store.load_current(zid)? {
            Current::Coherent(b) => b,
            _ => bail!("SHADOW_GENERATION_INCOMPLETE"),
        };
        ensure!(
            bundle.math_tick == tick
                && bundle.publisher_epoch == epoch
                && bundle.checkpoint["input_sha256"] == digest(input.as_bytes())
                && bundle.checkpoint["source_fingerprint"] == source.fingerprint,
            "SHADOW_GENERATION_BINDING"
        );
        store.client.query_one(
            "SELECT public.pc_reference($1,$2,$3,$4,true)",
            &[
                &store.config.math_env,
                &zid,
                &bundle.operation_id,
                &text(request, "reference")?,
            ],
        )?;
        let retained:bool=store.client.query_one("SELECT EXISTS(SELECT 1 FROM public.polis_coordinator_references WHERE math_env=$1 AND zid=$2 AND operation_id=$3 AND reference_name=$4)",&[&store.config.math_env,&zid,&bundle.operation_id,&text(request,"reference")?])?.get(0);
        ensure!(retained, "SHADOW_RETENTION_REQUIRED");
        renewal.stop();
        Ok(
            json!({"schema":"polis-shadow-replay-result/1","host":request["host"],"namespace":request["namespace"],"zid":zid,
            "cut_sha256":request["cut_sha256"],"history_sha256":request["history_sha256"],"lifecycle":"poller-rebuild-prefix/1",
            "input_sha256":digest(input.as_bytes()),"bundle_sha256":digest(&serde_json::to_vec(&bundle)?),"bundle_bytes":serde_json::to_string(&bundle)?,
            "reference":request["reference"],"retained":true,"parent_pid":std::process::id()}),
        )
    })();
    let release = store
        .reconnect_if_closed()
        .and_then(|()| store.release(zid, epoch));
    // Never retry a potentially committed operation here. Retained state survives output failure.
    let value = result?;
    release?;
    Ok(value)
}
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 2 && matches!(args[1].as_str(), "--validate-only" | "--execute"),
        "SHADOW_MODE_REQUIRED"
    );
    let mut raw = Vec::new();
    std::io::stdin().take(LIMIT + 1).read_to_end(&mut raw)?;
    ensure!(raw.len() as u64 <= LIMIT, "SHADOW_INPUT_LIMIT");
    let request = wire::parse(&raw)?;
    let source = source(&request)?;
    let result = if args[1] == "--validate-only" {
        json!({"schema":"polis-shadow-replay-validation/1","input_admitted":true,"executed":false})
    } else {
        execute(&request, &source)?
    };
    serde_json::to_writer(std::io::stdout(), &result)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .init();
    if run().is_err() {
        eprintln!("SHADOW_REPLAY_REFUSED");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Result<Value> {
        let votes = vec![json!({"pid":0,"tid":0,"vote":-1,"created":10,"weight_x_32767":null})];
        let rows = json!({"votes":votes,"comments":[{"tid":0,"mod":0,"is_meta":false,"modified":10}],"participants":[{"pid":0,"mod":0}],"ordering":ordering::manifest(-1,ordering::census(&votes))?});
        let bytes = serde_json::to_string(&rows)?;
        Ok(
            json!({"schema":"polis-shadow-replay-input/1","host":"fixture-host","legacy_namespace":"legacy","namespace":"shadow-test","zid":1,"cut_sha256":digest(bytes.as_bytes()),"cut_bytes":bytes,"history_sha256":"2".repeat(64),"expected_tick":null,"prior_bundle_sha256":null,"storage_agree_value":-1,"reference":"daily-1"}),
        )
    }
    fn rows(request: &mut Value, transform: impl FnOnce(&mut Value)) -> Result<()> {
        let mut value = wire::parse(
            request["cut_bytes"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("test cut"))?
                .as_bytes(),
        )?;
        transform(&mut value);
        let raw = serde_json::to_string(&value)?;
        request["cut_sha256"] = json!(digest(raw.as_bytes()));
        request["cut_bytes"] = json!(raw);
        Ok(())
    }
    #[test]
    fn admitted_source_uses_actual_profile() -> Result<()> {
        let r = request()?;
        let s = source(&r)?;
        assert_eq!(s.votes.len(), 1);
        assert_eq!(s.fingerprint, r["cut_sha256"]);
        assert_eq!(
            s.moderation,
            json!({"mod_in_tids":[],"mod_out_tids":[],"meta_tids":[],"mod_out_ptpts":[],"lastModTimestamp":null})
        );
        Ok(())
    }
    #[test]
    fn legacy_and_serving_namespaces_refused() -> Result<()> {
        for namespace in ["legacy", "prod", "preprod", "dev"] {
            let mut r = request()?;
            r["namespace"] = json!(namespace);
            assert!(source(&r).is_err());
        }
        Ok(())
    }
    #[test]
    fn changed_cut_and_unknown_fields_refused() -> Result<()> {
        let mut r = request()?;
        r["cut_sha256"] = json!("0".repeat(64));
        assert!(source(&r).is_err());
        let mut r = request()?;
        r["fault"] = json!({});
        assert!(source(&r).is_err());
        Ok(())
    }
    #[test]
    fn prior_tick_requires_exact_bundle_binding() -> Result<()> {
        let mut r = request()?;
        r["expected_tick"] = json!(0);
        assert!(source(&r).is_err());
        r["prior_bundle_sha256"] = json!("3".repeat(64));
        assert!(source(&r).is_ok());
        r["expected_tick"] = json!(true);
        assert!(source(&r).is_err());
        Ok(())
    }
    #[test]
    fn ordering_declaration_cannot_be_substituted() -> Result<()> {
        let mut r = request()?;
        rows(&mut r, |v| v["ordering"]["storage_agree_value"] = json!(1))?;
        assert!(source(&r).is_err());
        Ok(())
    }
    #[test]
    fn votes_are_not_silently_sorted() -> Result<()> {
        let mut r = request()?;
        rows(&mut r, |v| {
            v["votes"] = json!([
            {"pid":1,"tid":0,"vote":-1,"created":10,"weight_x_32767":null},
            {"pid":0,"tid":0,"vote":-1,"created":10,"weight_x_32767":null}])
        })?;
        assert!(source(&r).is_err());
        Ok(())
    }
    #[test]
    fn moderation_and_duplicate_comment_identity_refused() -> Result<()> {
        let mut r = request()?;
        rows(&mut r, |v| v["comments"][0]["is_meta"] = json!("true"))?;
        assert!(source(&r).is_err());
        let mut r = request()?;
        rows(&mut r, |v| {
            v["comments"] = json!([v["comments"][0], v["comments"][0]])
        })?;
        assert!(source(&r).is_err());
        Ok(())
    }
    #[test]
    fn duplicate_json_never_enters_admission() {
        assert!(wire::parse(br#"{"zid":1,"zid":2}"#).is_err());
    }
    #[test]
    fn unsupported_vote_and_null_pid_refused() -> Result<()> {
        let mut r = request()?;
        rows(&mut r, |v| v["votes"][0]["vote"] = json!(2))?;
        assert!(source(&r).is_err());
        let mut r = request()?;
        rows(&mut r, |v| v["votes"][0]["pid"] = Value::Null)?;
        assert!(source(&r).is_err());
        Ok(())
    }
}
