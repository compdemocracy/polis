use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

fn invalid() -> Error {
    Error::new(
        "invalid_response",
        "Site returned an incompatible resource shape.",
        "Check site compatibility; no automatic retry was made.",
        1,
    )
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let public = matches!(
        path,
        "report view"
            | "report export"
            | "delphi status"
            | "delphi results"
            | "delphi narrative view"
            | "delphi visualization view"
    );
    // Each branch validates its arguments before the client reads any credential.
    let connect = || client(config, site, timeout, !public);
    if path == "plan view" {
        connect()?.request("GET", "/api/v3/users", &[], None, false)?;
        return Ok(
            json!({"state":"unavailable","account_verified":true,"plan":null,"entitlements":null,"usage":null,"reason":"This API has no authoritative billing/plan/usage endpoint. Authentication is not a paid entitlement.","paid_runs_enabled":false}),
        );
    }
    if path.starts_with("delphi ") {
        let report = str_arg(m, "report");
        public_id(report)?;
        let mut query = vec![("report_id".into(), report.into())];
        if let Some(job) = m.get_one::<String>("job") {
            if job.is_empty()
                || job.len() > 300
                || !job
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(Error::input(
                    "Use an existing alphanumeric, hyphen or underscore job ID.",
                ));
            }
            query.push(("job_id".into(), job.clone()));
        }
        let endpoint = if matches!(path, "delphi results" | "delphi narrative view") {
            "/api/v3/delphi/reports"
        } else {
            "/api/v3/delphi/visualizations"
        };
        let data = connect()?.request("GET", endpoint, &query, None, false)?;
        if path == "delphi status" {
            let jobs = data
                .get("jobs")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?;
            let requested = m.get_one::<String>("job");
            let selected: Vec<_> = jobs
                .iter()
                .filter(|j| requested.is_none_or(|id| j["jobId"].as_str() == Some(id.as_str())))
                .collect();
            return Ok(
                json!({"state":if selected.is_empty(){"no_jobs_returned"}else{"observed"},"jobs":selected,"source":"stored visualization/job metadata","note":"Empty metadata does not prove no jobs exist; this legacy endpoint can mask backend failures. Terminal status alone does not imply workLive=false. No work submitted; no artifact URLs fetched."}),
            );
        }
        return Ok(data);
    }
    if matches!(path, "report view" | "report export") {
        let id = str_arg(m, "id");
        public_id(id)?;
        if path == "report view" {
            return connect()?.request(
                "GET",
                "/api/v3/reports",
                &[("report_id".into(), id.into())],
                None,
                false,
            );
        }
        let kind = str_arg(m, "type");
        let output = std::path::Path::new(str_arg(m, "output"));
        // Fail before download if the destination exists (including broken symlinks).
        if std::fs::symlink_metadata(output).is_ok() {
            return Err(Error::input("Output already exists; choose a new path."));
        }
        let bytes = connect()?.report_export(id, kind)?;
        let bytes = if str_arg(m, "format") == "json" && kind != "format.json" {
            crate::pass4::csv_json(&bytes)?
        } else {
            bytes
        };
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| Error::input("Cannot create export file."))?;
        use std::io::Write;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| Error::input("Cannot save export."))?;
        temp.persist_noclobber(output)
            .map_err(|_| Error::input("Cannot publish export; destination may already exist."))?;
        return Ok(
            json!({"state":"downloaded","path":output,"bytes":bytes.len(),"type":kind,"format":str_arg(m,"format"),"vote_convention":"Unmodified server bytes; read format.json for export signs."}),
        );
    }
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let c = connect()?;
    let mut query = vec![("conversation_id".into(), conversation.into())];
    match path {
        "moderate list" => {
            query.push(("moderation".into(), "true".into()));
            let status = str_arg(m, "status");
            let sign = match status {
                "accepted" => Some("1"),
                "rejected" => Some("-1"),
                "pending" => Some("0"),
                _ => None,
            };
            if let Some(mod_value) = sign {
                query.push(("mod".into(), mod_value.into()));
            }
            query.push((
                "limit".into(),
                m.get_one::<u16>("limit").unwrap().to_string(),
            ));
            query.push((
                "offset".into(),
                m.get_one::<u32>("offset").unwrap().to_string(),
            ));
            c.request("GET", "/api/v3/comments", &query, None, false)
        }
        "moderate accept" | "moderate reject" => {
            let tid = *m.get_one::<u32>("tid").unwrap();
            query.extend([
                ("moderation".into(), "true".into()),
                ("tids".into(), tid.to_string()),
            ]);
            let rows = c.request("GET", "/api/v3/comments", &query, None, false)?;
            let rows = rows.as_array().ok_or_else(invalid)?;
            let row = rows
                .iter()
                .find(|r| r["tid"].as_u64() == Some(tid as u64))
                .ok_or_else(|| {
                    Error::new(
                        "not_found",
                        "Statement not found in this moderation view.",
                        "Read the moderation list and check permissions.",
                        1,
                    )
                })?;
            let is_meta = row["is_meta"].as_bool().ok_or_else(invalid)?;
            let active = row["active"].as_bool().ok_or_else(invalid)?;
            let velocity = row["velocity"]
                .as_f64()
                .filter(|v| (0.0..=1.0).contains(v))
                .ok_or_else(invalid)?;
            let accept = path == "moderate accept";
            let receipt=c.request("PUT","/api/v3/comments",&[],Some(json!({"conversation_id":conversation,"tid":tid,"mod":if accept{1}else{-1},"active":accept || active,"is_meta":is_meta,"velocity":velocity})),true)?;
            Ok(
                json!({"state":"updated","tid":tid,"moderation":if accept{"accepted"}else{"rejected"},"receipt":receipt}),
            )
        }
        "participant list" | "participant status" => {
            let data = c.request("GET", "/api/v3/participants", &query, None, false)?;
            if !data.is_null() && !data.is_object() {
                return Err(invalid());
            }
            if path == "participant status" {
                Ok(
                    json!({"state":if data.is_null(){"not_joined"}else{"joined"},"participant":data}),
                )
            } else {
                let records = if data.is_null() { vec![] } else { vec![data] };
                Ok(
                    json!({"scope":"authenticated_account_only","participants":records,"roster_available":false}),
                )
            }
        }
        "participant xid list" => c.request("GET", "/api/v3/xids", &query, None, false),
        "vote list" => {
            let pid = if let Some(pid) = m.get_one::<u32>("pid") {
                Some(*pid as u64)
            } else {
                let p = c.request("GET", "/api/v3/participants", &query, None, false)?;
                if p.is_null() {
                    None
                } else {
                    Some(p["pid"].as_u64().ok_or_else(invalid)?)
                }
            };
            let Some(pid) = pid else {
                return Ok(
                    json!({"state":"not_joined","votes":[],"convention":polis_contracts::votes::wire_values()}),
                );
            };
            query.push(("pid".into(), pid.to_string()));
            let data = c.request("GET", "/api/v3/votes", &query, None, false)?;
            if !data.is_array() {
                return Err(invalid());
            }
            Ok(
                json!({"state":"observed","pid":pid,"votes":data,"convention":polis_contracts::votes::wire_values(),"source":"wire API; no sign conversion","pagination":{"continuation":null,"note":"Endpoint exposes no cursor; response limited to 8 MiB."}}),
            )
        }
        "report list" => c.request("GET", "/api/v3/reports", &query, None, false),
        _ => unreachable!(),
    }
}
