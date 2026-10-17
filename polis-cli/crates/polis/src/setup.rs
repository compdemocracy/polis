use crate::{client, profiles, public_id, read, seeds};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{setup::*, Error, Result};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, IsTerminal, Write},
    path::Path,
};

fn incompatible() -> Error {
    Error::new(
        "setup_readback_failed",
        "The setup change could not be confirmed.",
        "Inspect the completed steps before retrying; no automatic retry was made.",
        7,
    )
}
fn safe(mut e: Error) -> Error {
    e.upstream["request_id"] = Value::Null;
    e
}
fn get(c: &Client, path: &str, id: &str, extra: &[(&str, String)]) -> Result<Value> {
    let mut query = vec![("conversation_id".into(), id.into())];
    query.extend(extra.iter().map(|(k, v)| (k.to_string(), v.clone())));
    c.request("GET", path, &query, None, false).map_err(safe)
}
fn post(c: &Client, path: &str, body: Value) -> Result<Value> {
    c.request("POST", path, &[], Some(body), true).map_err(safe)
}
fn check_flags(actual: &Value, expected: &Value) -> Result<()> {
    for (k, v) in expected.as_object().ok_or_else(incompatible)? {
        if matches!(k.as_str(), "short_url" | "conversation_id") {
            continue;
        }
        if k == "context" && v == "" && actual[k].is_null() {
            continue;
        }
        if actual.get(k) != Some(v) {
            return Err(incompatible());
        }
    }
    Ok(())
}
fn save(path: &Path, setup: &ConversationSetup) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let bytes =
        serde_json::to_vec_pretty(setup).map_err(|_| Error::input("Cannot encode setup."))?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| {
            Error::input("Cannot create setup file; choose a new path in an existing directory.")
        })?;
    f.write_all(&bytes)
        .and_then(|_| f.write_all(b"\n"))
        .and_then(|_| f.sync_all())
        .map_err(|_| Error::input("Setup file could not be fully saved; inspect it before use."))
}
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
        .collect()
}
fn line(input: &mut impl BufRead, output: &mut impl Write, prompt: &str) -> Result<String> {
    use std::io::Read;
    write!(output, "{prompt} ")
        .and_then(|_| output.flush())
        .map_err(|_| Error::input("Cannot write setup terminal."))?;
    let mut s = String::new();
    let n = input
        .take(100_002)
        .read_line(&mut s)
        .map_err(|_| Error::input("Cannot read setup terminal."))?;
    if n == 0 {
        return Err(Error::input(
            "Setup cancelled at end of input; nothing was sent.",
        ));
    }
    if n > 100_000 {
        return Err(Error::input("Setup answer is too long; nothing was sent."));
    }
    Ok(s.trim_end_matches(['\r', '\n']).to_owned())
}
fn choice<T: Clone>(
    input: &mut impl BufRead,
    output: &mut impl Write,
    prompt: &str,
    options: &[(&str, T)],
) -> Result<T> {
    writeln!(output, "{prompt}").map_err(|_| Error::input("Cannot write setup terminal."))?;
    for (i, (label, _)) in options.iter().enumerate() {
        writeln!(output, "  {}. {label}", i + 1)
            .map_err(|_| Error::input("Cannot write setup terminal."))?;
    }
    loop {
        let s = line(input, output, "Choose a number:")?;
        if let Ok(n) = s.trim().parse::<usize>() {
            if let Some((_, v)) = n.checked_sub(1).and_then(|i| options.get(i)) {
                return Ok(v.clone());
            }
        }
        writeln!(output, "Choose one of the listed numbers.")
            .map_err(|_| Error::input("Cannot write setup terminal."))?;
    }
}
fn count(input: &mut impl BufRead, output: &mut impl Write, prompt: &str, max: u32) -> Result<u32> {
    loop {
        let s = line(input, output, prompt)?;
        if let Ok(n) = s.trim().parse::<u32>() {
            if n <= max {
                return Ok(n);
            }
        }
        writeln!(output, "Use a whole number from 0 to {max}.")
            .map_err(|_| Error::input("Cannot write setup terminal."))?;
    }
}
fn wizard(input: &mut impl BufRead, output: &mut impl Write) -> Result<ConversationSetup> {
    let mut s = ConversationSetup {
        topic: line(input, output, "What is the conversation about?")?,
        description: line(input, output, "Description (blank is fine):")?,
        context: line(
            input,
            output,
            "Context label for discovery (blank is fine):",
        )?,
        ..ConversationSetup::default()
    };
    s.activity = choice(
        input,
        output,
        "When setup finishes, may people vote and submit statements?",
        &activity_options(),
    )?;
    s.listing=choice(input,output,"How should it appear in the owner's conversation list? Draft is not an access restriction.",&listing_options())?;
    let invitation = choice(
        input,
        output,
        "How should invitations work? Existing members and the owner follow Node's current rules.",
        &invitation_options(),
    )?;
    let waves = loop {
        let n = count(
            input,
            output,
            "How many invitation waves should be created?",
            100,
        )?;
        if n > 0 || matches!(invitation, InvitationMode::Optional) {
            break n;
        }
        writeln!(output, "Required invitations need at least one wave.")
            .map_err(|_| Error::input("Cannot write setup terminal."))?;
    };
    let mut ww = Vec::new();
    for _ in 0..waves {
        loop {
            let owner = count(
                input,
                output,
                "How many codes should the owner distribute in this wave?",
                1000,
            )?;
            let per = count(
                input,
                output,
                "How many invitations per parent-wave participant? (First wave uses root codes.)",
                1000,
            )?;
            match Wave::new(owner, per) {
                Ok(w) => {
                    ww.push(w);
                    break;
                }
                Err(_) => {
                    writeln!(output, "At least one invitation count must be positive.")
                        .map_err(|_| Error::input("Cannot write setup terminal."))?;
                }
            }
        }
    }
    s.join.invitations = match invitation {
        InvitationMode::Optional => Invitations::Optional { waves: ww },
        InvitationMode::Required => {
            if ww.is_empty() {
                return Err(Error::input(
                    "Invitations are required, so provide at least one wave; nothing was sent.",
                ));
            }
            Invitations::Required {
                first_wave: ww.remove(0),
                later_waves: ww,
            }
        }
    };
    let external=choice(input,output,"What external-ID check should apply to fresh identities? Known identities can bypass today's check.",&external_identity_options())?;
    s.join.external_identity = match external {
        ExternalIdentityMode::Optional => ExternalIdentity::Optional,
        ExternalIdentityMode::Required => ExternalIdentity::Required,
        ExternalIdentityMode::Allowlist => {
            let n = loop {
                let n = count(input, output, "How many external IDs are allowed?", 1000)?;
                if n > 0 {
                    break n;
                }
                writeln!(output, "An allowlist needs at least one external ID.")
                    .map_err(|_| Error::input("Cannot write setup terminal."))?;
            };
            let mut ids = Vec::new();
            for _ in 0..n {
                ids.push(line(input, output, "External ID:")?);
            }
            ExternalIdentity::Allowlist {
                ids: ids.try_into().map_err(|_| {
                    Error::input("The allowlist needs distinct, nonempty external IDs.")
                })?,
            }
        }
    };
    s.moderation = choice(
        input,
        output,
        "When can an ordinary participant's statement be shown?",
        &moderation_options(),
    )?;
    s.visibility = choice(
        input,
        output,
        "Show the social participant list? This does not make identities or content private.",
        &visibility_options(),
    )?;
    s.data_access=choice(input,output,"Who may read the participants-of-interest dataset? This does not gate ordinary content reads.",&data_access_options())?;
    s.profanity_filter = choice(
        input,
        output,
        "Enable the profanity flag? It currently acts only for pro conversations.",
        &[("Yes", true), ("No", false)],
    )?;
    s.short_url = choice(
        input,
        output,
        "Request a short public conversation code?",
        &[("No", false), ("Yes", true)],
    )?;
    let n = count(
        input,
        output,
        "How many initial statements should the owner submit?",
        1000,
    )?;
    for _ in 0..n {
        s.seeds.push(line(input, output, "Initial statement:")?);
    }
    s.validate()?;
    Ok(s)
}
fn summary(s: &ConversationSetup) -> Value {
    json!({"topic":s.topic,"description":s.description,"context":s.context,"initial_statement_texts":s.seeds,"activity":s.activity,"listing":s.listing,"moderation":s.moderation,
        "invitation_mode":if matches!(s.join.invitations,Invitations::Required{..}){"required"}else{"optional"},
        "waves":s.join.invitations.waves().len(),"external_identity":match s.join.external_identity{ExternalIdentity::Optional=>"optional",ExternalIdentity::Required=>"required",ExternalIdentity::Allowlist{..}=>"allowlist"},
        "allowlisted_ids":match &s.join.external_identity{ExternalIdentity::Allowlist{ids}=>ids.as_slice().len(),_=>0},
        "initial_statements":s.seeds.len(),"visibility":s.visibility,"data_access":s.data_access,
        "profanity_filter":s.profanity_filter,"short_url":s.short_url,
        "current_behavior":"An external-ID allow-list is checked on every join, vote and comment, including known identities; a different external ID is a new identity. Requiring an external ID applies to new identities only. Draft is only a listing flag. Sign-in and separate comment permissions are not enforced. Read the setup admission table for exact paths.",
        "steps":["create closed with invitation gate","read back","apply settings while staged","read back","create and confirm invitation waves","write and confirm external-ID allowlist","submit and confirm initial statements","apply and confirm final participation settings"]})
}
pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
    no_interactive: bool,
    json_mode: bool,
) -> Result<Value> {
    let from = m.get_one::<String>("from");
    let interactive = from.is_none();
    let setup = if let Some(path) = from {
        serde_json::from_str::<ConversationSetup>(&read(path,2_000_000)?)
            .map_err(|_|Error::input("Invalid setup JSON. Use the typed setup format; unknown fields, empty allowlists and zero-invite waves are rejected."))?
    } else {
        if no_interactive || json_mode || !io::stdin().is_terminal() || !io::stdout().is_terminal()
        {
            return Err(Error::input(
                "Use --from setup.json outside an interactive terminal.",
            ));
        }
        wizard(&mut io::stdin().lock(), &mut io::stdout().lock())?
    };
    setup.validate()?;
    if let Some(path) = m.get_one::<String>("save") {
        save(Path::new(path), &setup)?;
    }
    let plan = summary(&setup);
    if interactive {
        println!(
            "Setup summary:\n{}",
            clean(&serde_json::to_string_pretty(&plan).unwrap())
        );
    }
    if m.get_flag("dry-run") {
        return Ok(json!({"state":"planned","summary":plan,"applied":false}));
    }
    if interactive {
        let answer = line(
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            "Apply this setup? Type yes to create it:",
        )?;
        if answer.trim() != "yes" {
            return Ok(json!({"state":"cancelled","applied":false}));
        }
    }
    apply(&setup, &client(config, site, timeout, true)?)
}
fn apply(s: &ConversationSetup, c: &Client) -> Result<Value> {
    let flags = s.node_flags();
    // Temporary staging values are operational state, not another policy mapping.
    // Node checks activity after membership; the invitation gate also prevents
    // ordinary fresh visitors from acquiring membership during setup.
    let mut staged = flags.clone();
    staged["is_active"] = json!(false);
    staged["treevite_enabled"] = json!(true);
    let mut steps = Vec::<Value>::new();
    let mut id: Option<String> = None;
    let mut step = String::from("create");
    let run = (|| -> Result<()> {
        let mut create = staged.clone();
        create.as_object_mut().unwrap().remove("xid_required");
        create.as_object_mut().unwrap().remove("use_xid_whitelist");
        let receipt = post(c, "/api/v3/conversations", create.clone())?;
        let code = receipt["conversation_id"]
            .as_str()
            .ok_or_else(incompatible)?;
        public_id(code).map_err(|_| incompatible())?;
        id = Some(code.into());
        steps.push(json!({"step":"create","state":"response_received","conversation_id":code}));
        step = "confirm_create".into();
        check_flags(&get(c, "/api/v3/conversations", code, &[])?, &create)?;
        steps[0]["state"] = json!("confirmed");
        // short_url is creation-only; applying it again would replace the code.
        staged.as_object_mut().unwrap().remove("short_url");
        staged["conversation_id"] = json!(code);
        step = "settings".into();
        c.request(
            "PUT",
            "/api/v3/conversations",
            &[],
            Some(staged.clone()),
            true,
        )
        .map_err(safe)?;
        steps.push(json!({"step":"settings","state":"response_received"}));
        step = "confirm_settings".into();
        check_flags(&get(c, "/api/v3/conversations", code, &[])?, &staged)?;
        steps.last_mut().unwrap()["state"] = json!("confirmed");
        for (i, w) in s.join.invitations.waves().iter().enumerate() {
            step = format!("wave_{}", i + 1);
            let r = post(
                c,
                "/api/v3/treevite/waves",
                json!({"conversation_id":code,"owner_invites":w.owner_invites(),"invites_per_user":w.per_participant(),"parent_wave":i}),
            )?;
            let wave = r["wave"].as_u64().ok_or_else(incompatible)?;
            let minted = r["invites_created"].as_u64().ok_or_else(incompatible)?;
            steps.push(json!({"step":step,"state":"response_received","wave":wave,"invites_created":minted}));
            step = format!("confirm_wave_{}", i + 1);
            let rows = get(
                c,
                "/api/v3/treevite/waves",
                code,
                &[("wave", wave.to_string())],
            )?;
            let rows = rows.as_array().ok_or_else(incompatible)?;
            if wave != i as u64 + 1
                || rows.len() != 1
                || rows[0]["owner_invites"] != w.owner_invites()
                || rows[0]["invites_per_user"] != w.per_participant()
                || rows[0]["parent_wave"] != i
                || minted
                    != (w.owner_invites() + if i == 0 { w.per_participant() } else { 0 }) as u64
            {
                return Err(incompatible());
            }
            let wave_id = rows[0]["id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| rows[0]["id"].as_u64().map(|v| v.to_string()))
                .ok_or_else(incompatible)?;
            if wave_id.is_empty() || !wave_id.bytes().all(|b| b.is_ascii_digit()) {
                return Err(incompatible());
            }
            let codes = get(
                c,
                "/api/v3/treevite/invites",
                code,
                &[("wave_id", wave_id), ("limit", "1".into())],
            )?;
            if codes["pagination"]["total"].as_u64() != Some(minted) {
                return Err(incompatible());
            }
            steps.last_mut().unwrap()["state"] = json!("confirmed");
        }
        if let ExternalIdentity::Allowlist { ids } = &s.join.external_identity {
            step = "xid_allowlist".into();
            post(
                c,
                "/api/v3/xidAllowList",
                json!({"conversation_id":code,"xid_allow_list":ids.as_slice()}),
            )?;
            steps.push(json!({"step":"xid_allowlist","state":"response_received","count":ids.as_slice().len()}));
            step = "confirm_xid_allowlist".into();
            let mut actual = std::collections::HashSet::new();
            for offset in [0, 500, 1000] {
                let r = get(
                    c,
                    "/api/v3/xidAllowList",
                    code,
                    &[("limit", "500".into()), ("offset", offset.to_string())],
                )?;
                let rows = r["xids"].as_array().ok_or_else(incompatible)?;
                for row in rows {
                    actual.insert(row["xid"].as_str().ok_or_else(incompatible)?.to_owned());
                }
                if r["pagination"]["hasMore"] == false {
                    break;
                }
                if offset == 1000 {
                    return Err(incompatible());
                }
            }
            if ids.as_slice().iter().any(|v| !actual.contains(v)) {
                return Err(incompatible());
            }
            steps.last_mut().unwrap()["additional_visible_entries"] =
                json!(actual.len() - ids.as_slice().len());
            steps.last_mut().unwrap()["state"] = json!("confirmed");
        }
        let mut posted = Vec::new();
        for (i, text) in s.seeds.iter().enumerate() {
            step = format!("statement_{}", i + 1);
            // The moderator endpoint authorizes the owner; no seed bypass flag.
            let r = post(
                c,
                "/api/v3/comments-bulk",
                json!({"conversation_id":code,"csv":seeds::single(text)?}),
            )?;
            let rows = r["results"].as_array().ok_or_else(incompatible)?;
            if rows.len() != 1 || rows[0]["status"] != "success" {
                return Err(incompatible());
            }
            let tid = rows[0]["tid"]
                .as_u64()
                .filter(|n| *n <= i32::MAX as u64)
                .ok_or_else(incompatible)?;
            steps.push(json!({"step":step,"state":"response_received","statement":tid}));
            posted.push((tid, text));
        }
        if !posted.is_empty() {
            // Node's moderation list ignores `tids` and returns every statement, so
            // one paged read confirms all of them (seeds are capped at 1,000).
            step = "confirm_statements".into();
            let mut seen = std::collections::HashMap::new();
            for offset in [0, 500, 1000] {
                let r = get(
                    c,
                    "/api/v3/comments",
                    code,
                    &[
                        ("moderation", "true".into()),
                        ("limit", "500".into()),
                        ("offset", offset.to_string()),
                    ],
                )?;
                for row in r["comments"].as_array().ok_or_else(incompatible)? {
                    let tid = row["tid"].as_u64().ok_or_else(incompatible)?;
                    seen.insert(tid, row.clone());
                }
                if r["pagination"]["hasMore"] == false {
                    break;
                }
                if offset == 1000 {
                    return Err(incompatible());
                }
            }
            for (tid, text) in &posted {
                let row = seen.get(tid).ok_or_else(incompatible)?;
                if row["txt"] != **text || row["mod"] != 1 || row["active"] != true {
                    return Err(incompatible());
                }
            }
            for st in steps.iter_mut() {
                if st["step"]
                    .as_str()
                    .is_some_and(|n| n.starts_with("statement_"))
                {
                    st["state"] = json!("confirmed");
                }
            }
        }
        step = "finish".into();
        let mut final_flags = flags.clone();
        final_flags.as_object_mut().unwrap().remove("short_url");
        final_flags["conversation_id"] = json!(code);
        c.request(
            "PUT",
            "/api/v3/conversations",
            &[],
            Some(final_flags.clone()),
            true,
        )
        .map_err(safe)?;
        steps.push(json!({"step":"finish","state":"response_received"}));
        step = "confirm_finish".into();
        check_flags(&get(c, "/api/v3/conversations", code, &[])?, &final_flags)?;
        steps.last_mut().unwrap()["state"] = json!("confirmed");
        Ok(())
    })();
    match run {
        Ok(()) => {
            Ok(json!({"state":"created","conversation_id":id,"steps":steps,"summary":summary(s)}))
        }
        // A refused create has no response to any step: nothing was created.
        Err(e) if steps.is_empty() && e.outcome == "rejected" => Err(safe(e)),
        Err(e) => {
            let (message, action, finish) = left_behind(s, id.as_deref(), &step);
            Ok(
                json!({"state":"setup_partial","conversation_id":id,"steps":steps,"failed_step":step,
                "error":safe(e),"message":message,"action":action,"finish":finish}),
            )
        }
    }
}
/// What a stopped setup left on the site, and the commands that finish it with
/// the requested settings. Until the final step, the staged conversation is
/// closed and invite-only.
fn left_behind(
    s: &ConversationSetup,
    id: Option<&str>,
    step: &str,
) -> (String, String, Vec<String>) {
    let never = "Never rerun new: it creates another conversation. No automatic retry was made.";
    let Some(id) = id else {
        return (
            format!("Setup stopped at {step} before the site confirmed a conversation ID. A conversation may exist, closed and invite-only."),
            format!("{never} Run polis conversation list to look for it before doing anything else."),
            vec![],
        );
    };
    let state = if step.ends_with("finish") {
        "may still be closed and invite-only"
    } else {
        "is closed and invite-only"
    };
    let mut finish = vec![format!(
        "polis conversation edit {id} --invite-only {} --external-id {}",
        matches!(s.join.invitations, Invitations::Required { .. }),
        s.join.external_identity.mode().name()
    )];
    if s.activity == Activity::Open {
        finish.push(format!("polis conversation reopen {id}"));
    }
    (
        format!("Setup stopped at {step}. Conversation {id} exists and {state}."),
        format!("{never} Inspect data.steps first: invitation waves, allow-list IDs and initial statements not confirmed there may be missing. Then finish it with: {}", finish.join(", then ")),
        finish,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wizard_uses_typed_choices_and_preserves_the_same_file_model() {
        let answers = [
            "Fixture topic",
            "Description",
            "context",
            "1",
            "1",
            "2",
            "1",
            "2",
            "0",
            "1",
            "1",
            "1",
            "1",
            "2",
            "1",
            "1",
            "Initial statement",
        ]
        .join("\n")
            + "\n";
        let mut output = Vec::new();
        let s = wizard(&mut io::Cursor::new(answers), &mut output).unwrap();
        s.validate().unwrap();
        assert!(matches!(s.join.invitations, Invitations::Required { .. }));
        assert_eq!(s.seeds, vec!["Initial statement"]);
        assert_eq!(s.node_flags()["treevite_enabled"], true);
        assert_eq!(
            serde_json::from_value::<ConversationSetup>(serde_json::to_value(&s).unwrap()).unwrap(),
            s
        );
    }
    #[test]
    fn terminal_controls_are_not_rendered_in_summary() {
        assert_eq!(clean("x\x1b\u{202e}"), "x");
    }
}
