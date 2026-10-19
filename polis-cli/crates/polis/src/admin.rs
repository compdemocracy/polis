//! Dedicated operations over existing site routes. The compiled declaration is
//! the shared parser/schema/request map; it cannot select arbitrary endpoints.
use crate::{client, participation, pass4, profiles, public_id};
use clap::{Arg, ArgAction, ArgMatches, Command};
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{path::Path, sync::OnceLock};

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Auth {
    Account,
    Participant,
    Public,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Response {
    Json,
    Download,
    Document,
    PublicJson,
    Receipt,
    Capability,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Text,
    Id,
    Opaque,
    Uint,
    Int,
    Bool,
    Mapped,
    Strings,
    Uints,
    StringsFile,
    JsonFile,
    ArrayFile,
    SecretFile,
    UuidFile,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parameter {
    name: String,
    wire: String,
    kind: Kind,
    required: bool,
    #[serde(default)]
    max: Option<u64>,
    #[serde(default)]
    choices: Vec<String>,
    #[serde(default)]
    mapping: Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Operation {
    pub command: String,
    method: String,
    path: String,
    parameters: Vec<Parameter>,
    auth: Auth,
    effect: bool,
    response: Response,
    about: String,
    #[serde(default)]
    resolve_report: bool,
    #[serde(default)]
    wire_votes: bool,
}
pub(crate) fn operations() -> &'static [Operation] {
    static OPS: OnceLock<Vec<Operation>> = OnceLock::new();
    OPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../admin-operations.json"))
            .expect("compiled operation declarations")
    })
}
pub fn available(path: &str) -> bool {
    operations().iter().any(|o| o.command == path)
}
pub fn command(path: &str) -> Option<Command> {
    let o = operations().iter().find(|o| o.command == path)?;
    let mut c=Command::new(path.split(' ').next_back().unwrap().to_owned())
        .about(o.about.clone())
        .long_about(format!("{}.\n\nUses the selected site's existing route and permission checks. No automatic retries. A response receipt is not proof of completion or a readback. Errors never echo submitted values. Uncertain writes exit 7. Server policy and legacy limitations are documented in docs/admin-operations.md.",o.about));
    for p in &o.parameters {
        let kind = match p.kind {
            Kind::Text => "text",
            Kind::Id => "public ID",
            Kind::Opaque => "opaque ID (letters, digits, underscore, hyphen)",
            Kind::Uint => "nonnegative integer",
            Kind::Int => "signed integer",
            Kind::Bool => "true or false",
            Kind::Mapped => "named choice",
            Kind::Strings => "comma-separated strings",
            Kind::Uints => "comma-separated nonnegative integers",
            Kind::StringsFile => "JSON string-array file",
            Kind::JsonFile => "JSON file",
            Kind::ArrayFile => "JSON array file",
            Kind::SecretFile => "secret capability file",
            Kind::UuidFile => "secret UUID file",
        };
        let choices = if p.mapping.is_empty() {
            p.choices.clone()
        } else {
            p.mapping.keys().cloned().collect()
        };
        let suffix = if choices.is_empty() {
            String::new()
        } else {
            format!("; choices: {}", choices.join(", "))
        };
        c = c.arg(
            Arg::new(p.name.clone())
                .long(p.name.clone())
                .required(p.required)
                .allow_hyphen_values(matches!(p.kind, Kind::Int))
                .value_name(p.name.to_uppercase())
                .help(format!("{kind}{suffix}; site field {}", p.wire)),
        );
    }
    if o.effect {
        c = c.arg(
            Arg::new("yes")
                .long("yes")
                .action(ArgAction::SetTrue)
                .help("Confirm this explicitly requested operation"),
        );
    }
    if o.auth == Auth::Participant {
        c = c.arg(
            Arg::new("account")
                .long("account")
                .action(ArgAction::SetTrue)
                .help(
                    "Use the signed-in account instead of this conversation's participant identity",
                ),
        );
    }
    if matches!(
        o.response,
        Response::Download | Response::Document | Response::Capability
    ) {
        c = c.arg(
            Arg::new("output")
                .long("output")
                .required(true)
                .help("New private destination file; never overwrite"),
        );
    }
    Some(c)
}
fn invalid(name: &str) -> Error {
    Error::input(format!(
        "Invalid --{name}; inspect this command's help and the documented parameter type."
    ))
}
fn convert(p: &Parameter, raw: &str) -> Result<Value> {
    let text = || -> Result<Value> {
        if raw.contains('\0') || raw.encode_utf16().count() as u64 > p.max.unwrap_or(9999) {
            return Err(invalid(&p.name));
        }
        Ok(json!(raw))
    };
    if !p.choices.is_empty() && !p.choices.iter().any(|s| s == raw) {
        return Err(invalid(&p.name));
    }
    match p.kind {
        Kind::Text => text(),
        Kind::Id => {
            public_id(raw).map_err(|_| invalid(&p.name))?;
            Ok(json!(raw))
        }
        Kind::Opaque => {
            if raw.is_empty()
                || raw.len() as u64 > p.max.unwrap_or(300)
                || !raw
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err(invalid(&p.name));
            }
            Ok(json!(raw))
        }
        Kind::Uint => {
            let n = raw.parse::<u64>().map_err(|_| invalid(&p.name))?;
            if n > p.max.unwrap_or(i32::MAX as u64) {
                return Err(invalid(&p.name));
            }
            Ok(json!(n))
        }
        Kind::Int => Ok(json!(raw.parse::<i32>().map_err(|_| invalid(&p.name))?)),
        Kind::Bool => match raw {
            "true" => Ok(json!(true)),
            "false" => Ok(json!(false)),
            _ => Err(invalid(&p.name)),
        },
        Kind::Mapped => p.mapping.get(raw).cloned().ok_or_else(|| invalid(&p.name)),
        Kind::Strings | Kind::Uints => {
            let entries = raw.split(',').collect::<Vec<_>>();
            if entries.len() > 1000
                || entries
                    .iter()
                    .any(|v| v.is_empty() || v.len() > 999 || v.chars().any(char::is_control))
            {
                return Err(invalid(&p.name));
            }
            if matches!(p.kind, Kind::Uints) {
                let ids = entries
                    .iter()
                    .map(|s| s.parse::<u32>().ok().filter(|n| *n <= i32::MAX as u32))
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| invalid(&p.name))?;
                Ok(json!(ids))
            } else {
                Ok(json!(entries))
            }
        }
        Kind::StringsFile | Kind::JsonFile | Kind::ArrayFile => {
            let input = crate::read(raw, 500_000).map_err(|_| invalid(&p.name))?;
            let value: Value = serde_json::from_str(&input).map_err(|_| invalid(&p.name))?;
            if matches!(p.kind, Kind::ArrayFile | Kind::StringsFile) {
                let rows = value
                    .as_array()
                    .filter(|v| v.len() <= 1000)
                    .ok_or_else(|| invalid(&p.name))?;
                if matches!(p.kind, Kind::StringsFile)
                    && (rows.is_empty()
                        || rows.iter().any(|v| {
                            v.as_str().is_none_or(|s| {
                                s.is_empty() || s.len() > 999 || s.chars().any(char::is_control)
                            })
                        }))
                {
                    return Err(invalid(&p.name));
                }
            }
            Ok(value)
        }
        Kind::SecretFile | Kind::UuidFile => {
            let input = crate::read(raw, 4096).map_err(|_| invalid(&p.name))?;
            let value = input.trim_end_matches(['\r', '\n']);
            profiles::validate_token(value).map_err(|_| invalid(&p.name))?;
            if matches!(p.kind, Kind::UuidFile) {
                uuid::Uuid::parse_str(value).map_err(|_| invalid(&p.name))?;
            }
            Ok(json!(value))
        }
    }
}
fn response_error(effect: bool) -> Error {
    let mut e = Error::new(
        "invalid_admin_response",
        "The site returned an incompatible operation response.",
        "Inspect the resource before retrying; no automatic retry was made.",
        if effect { 7 } else { 1 },
    );
    e.outcome = if effect { "unknown" } else { "rejected" };
    e
}
fn report_conversation(c: &Client, report: &str) -> Result<String> {
    let data = c.request(
        "GET",
        "/api/v3/reports",
        &[("report_id".into(), report.into())],
        None,
        false,
    )?;
    let rows = data
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or_else(|| response_error(false))?;
    if rows[0]["report_id"] != report {
        return Err(response_error(false));
    }
    let conversation = rows[0]["conversation_id"]
        .as_str()
        .ok_or_else(|| response_error(false))?;
    public_id(conversation).map_err(|_| response_error(false))?;
    Ok(conversation.into())
}

pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let o = operations()
        .iter()
        .find(|o| o.command == path)
        .expect("known operation");
    if o.effect && !m.get_flag("yes") {
        return Err(Error::input(
            "This operation requires --yes. No request was sent.",
        ));
    }
    let mut fields = Map::new();
    for p in &o.parameters {
        if let Some(raw) = m.get_one::<String>(&p.name) {
            fields.insert(p.wire.clone(), convert(p, raw)?);
        }
    }
    if (path == "account edit" && fields.is_empty())
        || (path == "report edit" && fields.len() == 1)
        || (path == "topic moderate"
            && !fields.contains_key("topic_key")
            && !fields.contains_key("comment_ids"))
        || (path == "comment flag" && fields.len() == 2)
    {
        return Err(Error::input(
            "Choose at least one setting or target. No request was sent.",
        ));
    }
    let output = m
        .try_get_one::<String>("output")
        .ok()
        .flatten()
        .map(Path::new);
    if let Some(output) = output {
        pass4::check_output(output)?;
    }
    let mut endpoint = o.path.clone();
    for (key, value) in fields.clone() {
        let placeholder = format!("{{{key}}}");
        if endpoint.contains(&placeholder) {
            let raw = value.as_str().ok_or_else(|| invalid(&key))?;
            if raw.contains(['/', '\\']) || matches!(raw, "." | "..") {
                return Err(invalid(&key));
            }
            endpoint = endpoint.replace(
                &placeholder,
                &url::form_urlencoded::byte_serialize(raw.as_bytes()).collect::<String>(),
            );
            fields.remove(&key);
        }
    }
    let origin = config.url(site)?;
    let participant = o.auth == Auth::Participant && !m.get_flag("account");
    let scope = if participant {
        Some(profiles::participant_scope(
            origin,
            fields["conversation_id"]
                .as_str()
                .ok_or_else(|| invalid("conversation"))?,
        )?)
    } else {
        None
    };
    // A local credential lock spans only this bounded request, never human
    // input, report computation, or another process's server/database resources.
    let _lock = scope
        .as_ref()
        .filter(|_| o.effect)
        .map(|s| profiles::credential_lock(site, s))
        .transpose()?;
    let saved = scope
        .as_ref()
        .map(|s| profiles::participant_load(site, s))
        .transpose()?
        .flatten();
    let c = if participant || o.auth == Auth::Public {
        Client::with_ca(
            origin,
            if participant {
                saved.as_ref().map(|s| s.token.clone())
            } else {
                None
            },
            timeout,
            config.auth(site)?.ca_file.as_deref(),
        )?
    } else {
        client(config, site, timeout, true)?
    };
    if o.resolve_report {
        let report = fields["report_id"]
            .as_str()
            .ok_or_else(|| invalid("report"))?;
        let conversation = report_conversation(&c, report)?;
        fields.insert("conversation_id".into(), json!(conversation));
    }
    let query = if o.method == "GET" {
        fields
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string()),
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    let body = if o.method == "GET" {
        None
    } else {
        Some(Value::Object(fields))
    };
    let result = (|| -> Result<Value> {
        if o.response == Response::Capability {
            let url = c.export_capability(&query)?;
            let bytes = json!({"url":url,"artifact_verified":false})
                .to_string()
                .into_bytes();
            pass4::save(output.expect("required output"), &bytes)?;
            return Ok(json!({"state":"capability_saved","path":output,"artifact_verified":false}));
        }
        if matches!(o.response, Response::Document | Response::PublicJson) {
            let bytes = c.public_document(&endpoint)?;
            if o.response == Response::PublicJson {
                return serde_json::from_slice(&bytes).map_err(|_| response_error(false));
            }
            pass4::save(output.expect("required output"), &bytes)?;
            return Ok(json!({"state":"downloaded","path":output,"bytes":bytes.len()}));
        }
        if matches!(o.response, Response::Download | Response::Receipt) {
            let bytes = if o.response == Response::Download {
                c.operation_csv(&endpoint, &query)?
            } else {
                c.operation_bytes(&o.method, &endpoint, &query, body, o.effect)?
            };
            if o.response == Response::Receipt {
                return Ok(json!({"state":"response_received","confirmed_by_readback":false}));
            }
            pass4::save(output.expect("required output"), &bytes)?;
            return Ok(json!({"state":"downloaded","path":output,"bytes":bytes.len()}));
        }
        let mut data = c.request(&o.method, &endpoint, &query, body, o.effect)?;
        if participant {
            if let Some(token) = participation::issued_token(&data, o.effect)? {
                profiles::participant_store(
                    site,
                    scope.as_ref().unwrap(),
                    &token,
                    saved.as_ref().and_then(|s| s.login_code.clone()),
                )
                .map_err(|_| response_error(true))?;
            }
        }
        // Account-backed participation can also issue an anonymous capability;
        // never return authentication material in an operation receipt.
        if let Some(object) = data.as_object_mut() {
            object.remove("auth");
            if path == "invite email lookup" {
                object.remove("einvite");
            }
        }
        if o.wire_votes {
            return Ok(
                json!({"data":data,"convention":polis_contracts::votes::wire_values(),"source":"wire API; no storage sign inferred"}),
            );
        }
        if o.effect {
            Ok(json!({"state":"response_received","confirmed_by_readback":false,"receipt":data}))
        } else {
            Ok(data)
        }
    })();
    result.map_err(|mut e| {
        e.upstream["request_id"] = Value::Null;
        e
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn declarations_are_unique_and_scoped() {
        let mut seen = HashSet::new();
        for o in operations() {
            assert!(seen.insert(&o.command));
            assert!(
                o.path.starts_with("/api/v3/")
                    || matches!(o.response, Response::Document | Response::PublicJson)
            );
            let mut names = HashSet::new();
            for p in &o.parameters {
                assert!(names.insert(&p.name));
            }
            if o.resolve_report {
                assert!(o.parameters.iter().any(|p| p.wire == "report_id"));
                assert!(!o.parameters.iter().any(|p| p.wire == "conversation_id"));
            }
        }
    }
    #[test]
    fn typed_values_do_not_echo_bad_input() {
        let o = operations()
            .iter()
            .find(|o| o.command == "comment star")
            .unwrap();
        let p = o.parameters.iter().find(|p| p.name == "state").unwrap();
        let e = convert(p, "private-invalid-value").unwrap_err();
        assert!(!e.message.contains("private-invalid-value"));
        assert!(convert(p, "on").unwrap().is_number());
        let p = o.parameters.iter().find(|p| p.name == "statement").unwrap();
        assert!(convert(p, "2147483648").is_err());
        assert!(convert(p, "3").is_ok());
    }
}
