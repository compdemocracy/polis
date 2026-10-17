use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
};

pub fn tutorial(topic: Option<&str>) -> Result<Value> {
    if topic.is_some_and(|s| !s.is_empty()) {
        return Err(Error::input(
            "Use polis help tutorial for the getting-started manual.",
        ));
    }
    Ok(json!({"help":include_str!("../../../docs/tutorial.txt")}))
}
fn unknown(message: &str) -> Error {
    let mut e = Error::new(
        "outcome_unknown",
        message,
        "Read polis conversation view <id> before retrying; no automatic retry was made.",
        7,
    );
    e.outcome = "unknown";
    e
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    no_interactive: bool,
) -> Result<Value> {
    if path.starts_with("plan ") {
        let url = polis_client::base_url(config.url(site)?)?
            .join("account")
            .map_err(|_| Error::input("Invalid account URL."))?;
        let opened = if m.get_flag("no-browser") || no_interactive {
            false
        } else {
            open_browser(url.as_str())?;
            true
        };
        return Ok(
            json!({"state":"unavailable","plan":null,"usage":null,"checkout":null,"url":url.as_str(),"browser_opened":opened,"reason":"Billing checkout is not implemented. This is the existing account page; no subscription or payment was created."}),
        );
    }
    // Inputs are validated before the client reads any credential.
    if path.starts_with("conversation ") {
        let id = str_arg(m, "id");
        public_id(id)?;
        let c = client(config, site, timeout, true)?;
        let active = path == "conversation reopen";
        let receipt = c.request(
            "POST",
            if active {
                "/api/v3/conversation/reopen"
            } else {
                "/api/v3/conversation/close"
            },
            &[],
            Some(json!({"conversation_id":id})),
            true,
        )?;
        let observed = c
            .request(
                "GET",
                "/api/v3/conversations",
                &[("conversation_id".into(), id.into())],
                None,
                false,
            )
            .map_err(|_| unknown("The write replied, but its readback could not be confirmed."))?;
        if observed["is_active"].as_bool() != Some(active) {
            return Err(unknown(
                "The write replied, but readback did not show the requested participation state.",
            ));
        }
        return Ok(
            json!({"state":if active {"reopened"} else {"closed"},"conversation_id":id,"is_active":active,"confirmed_by":"GET /api/v3/conversations","receipt":receipt}),
        );
    }
    let id = str_arg(m, "conversation");
    public_id(id)?;
    let output = Path::new(str_arg(m, "output"));
    check_output(output)?;
    let c = client(config, site, timeout, true)?;
    let bytes = c.participant_export(id)?;
    let bytes = if str_arg(m, "format") == "json" {
        csv_json(&bytes)?
    } else {
        bytes
    };
    save(output, &bytes)?;
    Ok(
        json!({"state":"downloaded","path":output,"bytes":bytes.len(),"format":str_arg(m,"format"),"scope":"participants_with_xids","roster_complete":false,"server_row_limit":1000000,"note":"Only participant XID mappings; participants without XIDs are absent. Server may cap the result; no complete-roster claim."}),
    )
}
fn open_browser(url: &str) -> Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        return Err(Error::new(
            "browser_unavailable",
            "Automatic browser opening is unavailable on this platform.",
            "Run with --no-browser to print the account URL.",
            6,
        ));
    } else {
        "xdg-open"
    };
    let mut launcher = std::process::Command::new(program);
    crate::profiles::strip_token_env(&mut launcher);
    let mut child = launcher
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| {
            Error::new(
                "browser_unavailable",
                "Cannot launch the browser.",
                "Run with --no-browser to print the account URL.",
                6,
            )
        })?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => {
                return Err(Error::new(
                    "browser_unavailable",
                    "Browser launcher did not succeed.",
                    "Run with --no-browser to print the account URL.",
                    6,
                ))
            }
            Ok(None) if start.elapsed().as_secs() >= 5 => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(
                    "browser_unavailable",
                    "Browser launcher did not finish.",
                    "Run with --no-browser to print the account URL.",
                    6,
                ));
            }
            _ => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}
pub fn check_output(path: &Path) -> Result<()> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(Error::input("Output already exists; choose a new path."));
    }
    Ok(())
}
pub fn save(path: &Path, bytes: &[u8]) -> Result<()> {
    check_output(path)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| Error::input("Cannot create export file."))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| Error::input("Cannot save export."))?;
    temp.persist_noclobber(path)
        .map_err(|_| Error::input("Cannot publish export; destination may already exist."))?;
    Ok(())
}
/// JSON keeps an ordered header and arrays of string cells: no numeric coercion,
/// duplicate-header loss, formula evaluation or vote-sign reinterpretation.
pub fn csv_json(bytes: &[u8]) -> Result<Vec<u8>> {
    let raw = std::str::from_utf8(bytes).map_err(|_| Error::input("Export is not UTF-8 CSV."))?;
    crate::seeds::strict_csv(raw)?;
    let mut reader = csv::Reader::from_reader(raw.as_bytes());
    let headers = reader
        .headers()
        .map_err(|_| Error::input("Invalid CSV header."))?
        .iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let rows = reader
        .records()
        .map(|r| r.map(|r| r.iter().map(str::to_owned).collect::<Vec<_>>()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| Error::input("Invalid CSV rows."))?;
    serde_json::to_vec_pretty(&json!({"schema":"polis-csv/1","headers":headers,"rows":rows,"cell_type":"string","vote_convention":"Unchanged source values; use report format.json."})).map_err(|_|Error::input("Cannot encode CSV JSON."))
}
/// Wire declaration only. The server's vote convention module owns conversion,
/// transaction and event/latest-cell verification.
pub fn votes(raw: &str, source_agree: &str, mapping: &[Value]) -> Result<(String, usize)> {
    let declaration = polis_contracts::votes::declaration(source_agree)
        .ok_or_else(|| Error::input(polis_contracts::votes::SOURCE_REQUIRED))?;
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    // Refuse competing declarations rather than silently replacing their meaning.
    let raw = if raw.starts_with('#') {
        let (first, rest) = raw
            .split_once('\n')
            .ok_or_else(|| Error::input("Vote CSV contains no data."))?;
        if first.trim_end_matches('\r') != declaration {
            return Err(Error::input("CSV declaration differs from --source-agree or supported format; resolve it explicitly."));
        }
        rest
    } else {
        raw
    };
    crate::seeds::strict_csv(raw)?;
    let mut reader = csv::Reader::from_reader(raw.as_bytes());
    let header = reader
        .headers()
        .map_err(|_| Error::input("Invalid vote CSV header."))?
        .clone();
    let expected = [
        "vote_id",
        "user_id",
        "vote_value",
        "timestamp",
        "comment_id",
    ];
    if header.len() != 5
        || expected
            .iter()
            .any(|key| header.iter().filter(|v| v == key).count() != 1)
    {
        return Err(Error::input(
            "Vote CSV requires exactly vote_id,user_id,vote_value,timestamp,comment_id.",
        ));
    }
    let positions: Vec<_> = expected
        .iter()
        .map(|k| header.iter().position(|h| h == *k).unwrap())
        .collect();
    let ids: HashMap<_, _> = mapping
        .iter()
        .map(|m| {
            (
                m["original_id"].as_str().unwrap(),
                m["submitted_original_id"].as_str().unwrap(),
            )
        })
        .collect();
    let mut seen = HashSet::new();
    let mut count = 0;
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(expected)
        .map_err(|_| Error::input("Cannot encode vote CSV."))?;
    for (i, row) in reader.records().enumerate() {
        let row = row.map_err(|_| Error::input(format!("Invalid vote CSV record {}.", i + 2)))?;
        let values: Vec<_> = positions.iter().map(|j| &row[*j]).collect();
        if values
            .iter()
            .any(|v| v.is_empty() || v.trim() != *v || v.chars().any(char::is_control))
            || !seen.insert(values[0].to_owned())
            || !matches!(values[2], "-1" | "0" | "1" | "+1")
            || values[1].len() > 200
            || values[0].len() > 200
        {
            return Err(Error::input(format!(
                "Invalid, duplicate, or ambiguous vote CSV record {}.",
                i + 2
            )));
        }
        // Require an ISO timestamp with explicit timezone; parsing stays in the server.
        let timestamp = values[3];
        if !valid_timestamp(timestamp) {
            return Err(Error::input(format!(
                "Vote record {} requires an ISO UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).",
                i + 2
            )));
        }
        let id = ids.get(values[4]).ok_or_else(|| {
            Error::input(format!(
                "Vote record {} references no original_id in the seed CSV.",
                i + 2
            ))
        })?;
        writer
            .write_record([values[0], values[1], values[2], timestamp, id])
            .map_err(|_| Error::input("Cannot encode vote CSV."))?;
        count += 1;
        if count > 10000 {
            return Err(Error::input("Import at most 10000 vote events per file."));
        }
    }
    if count == 0 {
        return Err(Error::input("Vote CSV contains no events."));
    }
    let csv = String::from_utf8(
        writer
            .into_inner()
            .map_err(|_| Error::input("Cannot encode vote CSV."))?,
    )
    .unwrap();
    let result = format!("{declaration}\n{csv}");
    if result.len() > 500000 {
        return Err(Error::input("Mapped vote CSV exceeds 500000 bytes."));
    }
    Ok((result, count))
}
fn valid_timestamp(s: &str) -> bool {
    if s.len() != 20 || !s.is_ascii() {
        return false;
    }
    let b = s.as_bytes();
    if [b[4], b[7], b[10], b[13], b[16], b[19]] != *b"--T::Z" {
        return false;
    }
    let fields = [
        &s[0..4],
        &s[5..7],
        &s[8..10],
        &s[11..13],
        &s[14..16],
        &s[17..19],
    ];
    if fields
        .iter()
        .any(|s| !s.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let n: Vec<u32> = fields.iter().map(|s| s.parse().unwrap()).collect();
    if !(1970..=9999).contains(&n[0])
        || !(1..=12).contains(&n[1])
        || n[3] > 23
        || n[4] > 59
        || n[5] > 59
    {
        return false;
    }
    let leap = n[0].is_multiple_of(4) && (!n[0].is_multiple_of(100) || n[0].is_multiple_of(400));
    let days = match n[1] {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&n[2])
}
