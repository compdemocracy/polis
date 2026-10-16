//! Direct participation over Node; no pre-enrollment or account sign-in.
use crate::{participation, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{votes::VoteChoice, Error, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, IsTerminal, Read, Write};

fn invalid(effect: bool) -> Error {
    let mut e = Error::new(
        "invalid_vote_response",
        "The site returned an incompatible voting response.",
        "No retry was made. Check your votes before submitting again.",
        if effect { 7 } else { 1 },
    );
    e.outcome = if effect { "unknown" } else { "rejected" };
    e
}
fn safe_error(mut e: Error) -> Error {
    e.upstream["request_id"] = Value::Null;
    if e.exit == 3 || e.exit == 4 {
        e.action = "Check this conversation's participation requirements; an invite may require polis join. No anonymous fallback or retry was made.";
    }
    e
}
fn client(
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    token: Option<String>,
) -> Result<Client> {
    Client::with_ca(
        config.url(site)?,
        token,
        timeout,
        config.auth(site)?.ca_file.as_deref(),
    )
}
#[derive(Debug)]
struct Statement {
    tid: u32,
    text: String,
}
fn statement(data: &Value, effect: bool) -> Result<Option<Statement>> {
    if !data.is_object() {
        return Err(invalid(effect));
    }
    if data.get("tid").is_none() && data.get("txt").is_none() {
        return Ok(None);
    }
    let tid = data["tid"]
        .as_u64()
        .filter(|n| *n <= i32::MAX as u64)
        .ok_or_else(|| invalid(effect))?;
    let text = data["txt"].as_str().ok_or_else(|| invalid(effect))?;
    Ok(Some(Statement {
        tid: tid as u32,
        text: text.into(),
    }))
}
fn next(
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    conversation: &str,
) -> Result<Option<Statement>> {
    let scope = profiles::participant_scope(config.url(site)?, conversation)?;
    let _lock = profiles::credential_lock(site, &scope)?;
    let saved = profiles::participant_load(site, &scope)?;
    let data = client(config, site, timeout, saved.map(|s| s.token))?
        .request(
            "GET",
            "/api/v3/nextComment",
            &[("conversation_id".into(), conversation.into())],
            None,
            false,
        )
        .map_err(safe_error)?;
    statement(&data, false)
}
fn cast(
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    conversation: &str,
    tid: u32,
    choice: VoteChoice,
) -> Result<Value> {
    let scope = profiles::participant_scope(config.url(site)?, conversation)?;
    // Never hold this local credential lock while waiting for a person's answer.
    // Serialize first votes so concurrent CLI processes reuse the issued identity.
    let _lock = profiles::credential_lock(site, &scope)?;
    let saved = profiles::participant_load(site, &scope)?;
    let data = client(
        config,
        site,
        timeout,
        saved.as_ref().map(|s| s.token.clone()),
    )?
    .request(
        "POST",
        "/api/v3/votes",
        &[],
        Some(json!({"conversation_id":conversation,"tid":tid,"vote":choice.wire()})),
        true,
    )
    .map_err(safe_error)?;
    let issued = participation::issued_token(&data, true).map_err(|_| invalid(true))?;
    // Retain a valid issued credential even if another receipt field is malformed:
    // the requested vote might already have been stored by Node.
    if let Some(token) = &issued {
        profiles::participant_store(site, &scope, token, saved.as_ref().and_then(|s| s.login_code.clone())).map_err(|_| {
            let mut e = Error::new("participant_credentials_not_saved", "The vote response arrived, but participant credentials could not be saved.",
                "Do not vote again blindly. Check the owner-only credential directory and ask the site operator to recover access.", 7);
            e.outcome = "unknown";
            e
        })?;
    }
    let pid = data["currentPid"]
        .as_u64()
        .filter(|n| *n <= i32::MAX as u64)
        .ok_or_else(|| invalid(true))?;
    if saved.is_none() && issued.is_none() {
        return Err(invalid(true));
    }
    Ok(
        json!({"conversation_id":conversation,"state":"recorded","statement":tid,"choice":choice,"participant_id":pid,"credentials_saved":true}),
    )
}

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    noninteractive: bool,
    json_mode: bool,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let choice = if m.get_flag("agree") {
        Some(VoteChoice::Agree)
    } else if m.get_flag("disagree") {
        Some(VoteChoice::Disagree)
    } else if m.get_flag("pass") {
        Some(VoteChoice::Pass)
    } else {
        None
    };
    match (m.get_one::<u32>("statement"), choice) {
        (Some(tid), Some(choice)) => {
            return cast(config, site, timeout, conversation, *tid, choice)
        }
        (None, None) => {}
        _ => {
            return Err(Error::input(
                "Use --statement with exactly one of --agree, --disagree or --pass.",
            ))
        }
    }
    if noninteractive || json_mode || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(Error::input("Interactive voting requires a terminal. Use --statement N and one of --agree, --disagree or --pass for non-interactive voting."));
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut recorded = 0u64;
    loop {
        let Some(stmt) = next(config, site, timeout, conversation)? else {
            writeln!(output, "No more statements available.").map_err(io_error)?;
            break;
        };
        let Some(choice) = prompt(&mut input, &mut output, &stmt)? else {
            break;
        };
        cast(config, site, timeout, conversation, stmt.tid, choice)?;
        recorded += 1;
        writeln!(output, "Recorded {}.", choice.name()).map_err(io_error)?;
    }
    Ok(json!({"conversation_id":conversation,"state":"finished","recorded":recorded}))
}
fn io_error(_: io::Error) -> Error {
    Error::input("Cannot read or write the voting terminal; no automatic retry was made.")
}
fn prompt(
    input: &mut impl BufRead,
    output: &mut impl Write,
    stmt: &Statement,
) -> Result<Option<VoteChoice>> {
    // Statements are untrusted; do not let terminal escape/control sequences run.
    let text: String = stmt
        .text
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    writeln!(output, "\nStatement {}: {text}", stmt.tid).map_err(io_error)?;
    loop {
        write!(output, "[a]gree / [d]isagree / [p]ass / [q]uit: ").map_err(io_error)?;
        output.flush().map_err(io_error)?;
        let mut line = String::new();
        let n = input.take(129).read_line(&mut line).map_err(io_error)?;
        if n > 128 {
            return Err(Error::input("Voting answer is too long; no vote was sent."));
        }
        if n == 0 {
            return Ok(None);
        }
        match line.trim().to_ascii_lowercase().as_str() {
            "a" | "agree" => return Ok(Some(VoteChoice::Agree)),
            "d" | "disagree" => return Ok(Some(VoteChoice::Disagree)),
            "p" | "pass" => return Ok(Some(VoteChoice::Pass)),
            "q" | "quit" => return Ok(None),
            _ => writeln!(
                output,
                "Choose agree, disagree, pass, or quit; nothing was submitted."
            )
            .map_err(io_error)?,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_requires_an_explicit_choice_and_strips_terminal_controls() {
        let stmt = Statement {
            tid: 2,
            text: "Text\x1b[31m\u{202e}".into(),
        };
        for (input, want) in [
            ("\na\n", Some(VoteChoice::Agree)),
            ("D\n", Some(VoteChoice::Disagree)),
            ("pass\n", Some(VoteChoice::Pass)),
            ("quit\n", None),
            ("", None),
        ] {
            let mut output = Vec::new();
            assert_eq!(
                prompt(&mut io::Cursor::new(input), &mut output, &stmt).unwrap(),
                want
            );
            assert!(!output.contains(&0x1b));
            assert!(!String::from_utf8(output).unwrap().contains('\u{202e}'));
        }
        assert!(prompt(
            &mut io::Cursor::new("a".repeat(130)),
            &mut Vec::new(),
            &stmt
        )
        .is_err());
    }
    #[test]
    fn next_statement_checks_shape_and_accepts_exhaustion() {
        assert!(statement(&json!({}), false).unwrap().is_none());
        assert!(statement(&json!({"currentPid":0}), false)
            .unwrap()
            .is_none());
        assert_eq!(
            statement(&json!({"tid":0,"txt":"test"}), false)
                .unwrap()
                .unwrap()
                .tid,
            0
        );
        for bad in [
            json!(null),
            json!({"tid":0}),
            json!({"txt":"test"}),
            json!({"tid":2147483648u64,"txt":"test"}),
        ] {
            assert!(statement(&bad, false).is_err());
        }
    }
}
