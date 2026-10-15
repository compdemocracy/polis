use crate::{client, pass4, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};
use std::path::Path;

const STATUSES: [&str; 4] = ["unused", "used", "revoked", "expired"];

fn invalid() -> Error {
    let mut e = Error::new(
        "invalid_response",
        "The site returned an incompatible invite response.",
        "Check site compatibility; no automatic retry was made.",
        1,
    );
    // Only reached after a response arrived and failed validation.
    e.outcome = "rejected";
    e
}
fn authority(mut e: Error) -> Error {
    if e.upstream["status"].as_u64() == Some(403) || e.exit == 4 {
        e.code = "forbidden";
        e.exit = 4;
        // A recognised upstream code already carries route-specific advice:
        // some invite reads are owner-only, others admit moderators.
        if e.upstream.get("code").is_none() {
            e.action = "Sign in as the conversation owner; some invite reads also admit a moderator on the owner's site.";
        }
    }
    e
}
fn get(c: &Client, path: &str, query: &[(String, String)]) -> Result<Value> {
    c.request("GET", path, query, None, false)
        .map_err(authority)
}
fn uint(v: &Value) -> Result<u64> {
    v.as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(invalid)
}
// Node pg returns BIGINT/BIGSERIAL as decimal strings by default. Normalize
// only exact JSON-safe integers; never round an identity or timestamp.
fn bigint(v: &Value) -> Result<u64> {
    if let Some(s) = v.as_str() {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        uint(&json!(s.parse::<u64>().map_err(|_| invalid())?))
    } else {
        uint(v)
    }
}
fn text(v: &Value) -> Result<&str> {
    v.as_str().ok_or_else(invalid)
}
fn nullable_uint(v: &Value) -> Result<()> {
    if !v.is_null() {
        uint(v)?;
    }
    Ok(())
}
fn nullable_text(v: &Value) -> Result<()> {
    if !v.is_null() {
        text(v)?;
    }
    Ok(())
}
fn fields(v: &Value, names: &[&str]) -> Result<()> {
    if !names.iter().all(|n| v.get(n).is_some()) {
        return Err(invalid());
    }
    Ok(())
}
fn query(id: &str) -> Vec<(String, String)> {
    vec![("conversation_id".into(), id.into())]
}
fn invite_only(c: &Client, id: &str) -> Result<bool> {
    // A conversation can have several codes and the read returns one of them,
    // so the echoed conversation_id need not equal the code typed here.
    let v = get(c, "/api/v3/conversations", &query(id))?;
    v["treevite_enabled"].as_bool().ok_or_else(invalid)
}
fn waves(c: &Client, q: &[(String, String)]) -> Result<Vec<Value>> {
    let v = get(c, "/api/v3/treevite/waves", q)?;
    v.as_array().ok_or_else(invalid)?.iter().map(|r| {
        fields(r, &["id", "zid", "wave", "parent_wave", "invites_per_user", "owner_invites", "size", "created_at", "updated_at"])?;
        let id = bigint(&r["id"])?;
        for k in ["zid", "wave", "invites_per_user", "owner_invites"] { uint(&r[k])?; }
        nullable_uint(&r["parent_wave"])?; nullable_uint(&r["size"])?;
        text(&r["created_at"])?; text(&r["updated_at"])?;
        // Project only documented columns; never echo additional upstream fields.
        Ok(json!({"id":id, "zid":r["zid"], "wave":r["wave"], "parent_wave":r["parent_wave"], "invites_per_user":r["invites_per_user"], "owner_invites":r["owner_invites"], "size":r["size"], "created_at":r["created_at"], "updated_at":r["updated_at"]}))
    }).collect()
}
fn page(c: &Client, q: &[(String, String)]) -> Result<Value> {
    let v = get(c, "/api/v3/treevite/invites", q)?;
    let rows = v["invites"].as_array().ok_or_else(invalid)?;
    let p = &v["pagination"];
    let limit = uint(&p["limit"])?;
    let offset = uint(&p["offset"])?;
    let total = uint(&p["total"])?;
    let more = p["hasMore"].as_bool().ok_or_else(invalid)?;
    if !(1..=500).contains(&limit)
        || rows.len() as u64 > limit
        || more != (offset.saturating_add(limit) < total)
    {
        return Err(invalid());
    }
    for (key, value) in q {
        if (key == "limit" && value != &limit.to_string())
            || (key == "offset" && value != &offset.to_string())
        {
            return Err(invalid());
        }
    }
    let invites = rows.iter().map(|r| {
        fields(r, &["id", "invite_code", "status", "wave", "invite_used_by_pid", "invite_used_at", "created_at"])?;
        let id = bigint(&r["id"])?;
        let code = text(&r["invite_code"])?;
        if code.is_empty() { return Err(invalid()); }
        let status = uint(&r["status"])?;
        let name = STATUSES.get(status as usize).ok_or_else(invalid)?;
        if q.iter().any(|(k,v)| k == "status" && v != &status.to_string()) { return Err(invalid()); }
        nullable_uint(&r["wave"])?; nullable_uint(&r["invite_used_by_pid"])?;
        nullable_text(&r["invite_used_at"])?; text(&r["created_at"])?;
        Ok(json!({"id":id, "code":code, "wave":r["wave"], "status":name, "used_by_pid":r["invite_used_by_pid"], "used_at":r["invite_used_at"], "created_at":r["created_at"]}))
    }).collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"invites":invites, "pagination":{"limit":limit,"offset":offset,"total":total,"hasMore":more}}),
    )
}

pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let id = str_arg(
        m,
        if path == "conversation uuid" {
            "id"
        } else {
            "conversation"
        },
    );
    public_id(id)?;
    if path == "invite export" {
        pass4::check_output(Path::new(str_arg(m, "output")))?;
    }
    let c = client(config, site, timeout, true)?;
    let mut q = query(id);
    match path {
        "invite code list" => {
            // The server resolves conversation_id and ignores the numeric path segment.
            let v = get(&c, "/api/v3/zinvites/0", &q)?;
            let codes = v["codes"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|r| {
                    let code = text(&r["zinvite"])?;
                    if public_id(code).is_err() {
                        return Err(invalid());
                    }
                    uint(&r["zid"])?;
                    let created = bigint(&r["created"])?;
                    Ok(json!({"code":code,"created":created}))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(
                json!({"conversation_id":id,"codes":codes,"note":"The server does not order codes; URLs it builds may use any of them."}),
            )
        }
        "invite wave list" => {
            if let Some(n) = m.get_one::<u32>("wave") {
                q.push(("wave".into(), n.to_string()));
            }
            Ok(json!(waves(&c, &q)?))
        }
        "invite list" => {
            let only = invite_only(&c, id)?;
            if let Some(n) = m.get_one::<u64>("wave-id") {
                q.push(("wave_id".into(), n.to_string()));
            }
            for name in ["limit", "offset"] {
                if let Some(n) = m.get_one::<u32>(name) {
                    q.push((name.replace('-', "_"), n.to_string()));
                }
            }
            if let Some(s) = m.get_one::<String>("status") {
                let n = STATUSES
                    .iter()
                    .position(|v| v == s)
                    .ok_or_else(|| Error::input("Invalid invite status."))?;
                q.push(("status".into(), n.to_string()));
            }
            let mut v = page(&c, &q)?;
            v["invite_only"] = json!(only);
            Ok(v)
        }
        "invite status" => {
            let only = invite_only(&c, id)?;
            let ws = waves(&c, &q)?.iter().map(|w| json!({"wave":w["wave"],"parent_wave":w["parent_wave"],"invites_per_user":w["invites_per_user"],"owner_invites":w["owner_invites"],"size":w["size"]})).collect::<Vec<_>>();
            let mut counts = serde_json::Map::new();
            for (i, name) in STATUSES.iter().enumerate() {
                let mut filter = query(id);
                filter.extend([
                    ("status".into(), i.to_string()),
                    ("limit".into(), "1".into()),
                    ("offset".into(), "0".into()),
                ]);
                let p = page(&c, &filter)?;
                counts.insert((*name).into(), p["pagination"]["total"].clone());
            }
            Ok(
                json!({"conversation_id":id,"invite_only":only,"waves":ws,"owner_invites":counts,"counted_by":"pagination.total of four status-filtered reads; participant-owned codes are not counted"}),
            )
        }
        "invite export" => {
            let (kind, bytes) = c.invite_export(id).map_err(authority)?;
            let output = Path::new(str_arg(m, "output"));
            pass4::save(output, &bytes)?;
            Ok(
                json!({"conversation_id":id,"path":output,"bytes":bytes.len(),"content_type":kind,"note":"Bytes preserved; codes are credentials, keep the file private."}),
            )
        }
        "conversation uuid" => {
            // Despite GET, this endpoint can mint a key. A lost response has an unknown outcome.
            let v = c
                .request("GET", "/api/v3/conversationUuid", &q, None, true)
                .map_err(authority)?;
            let key = v["conversation_uuid"]
                .as_str()
                .filter(|s| uuid::Uuid::parse_str(s).is_ok());
            let Some(key) = key else {
                let mut e = invalid();
                e.exit = 7;
                e.outcome = "unknown";
                e.code = "outcome_unknown";
                return Err(e);
            };
            Ok(json!({"conversation_uuid":key}))
        }
        _ => unreachable!(),
    }
}
