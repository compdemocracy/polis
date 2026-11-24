//! `polis-topic-names name --in hierarchy.json --out names.json --namer '<json>'`
//!
//! Exit status: 0 when `names.json` was written, whatever its outcome; 2 for a
//! usage error (nothing written); 1 when `hierarchy.json` cannot be read or
//! checked, or `names.json` cannot be written (nothing written).

use polis_topic_names::{Hierarchy, KEY_ENV, Namer, RUN_MAX_ENV, RunCap, client, name_topics};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: polis-topic-names name --in <hierarchy.json> --out <names.json> --namer '<namer json>'\n\
  The key is read from DELPHI_NAMING_ANTHROPIC_API_KEY and the per-run cap (dollars) from\n\
  DELPHI_NAMING_RUN_MAX_USD (0.50 when unset). --api-base <url> is for tests only.";

struct Args {
    input: PathBuf,
    output: PathBuf,
    namer: Namer,
    api_base: Option<String>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut it = argv.iter();
    match it.next().map(String::as_str) {
        Some("name") => {}
        Some(other) => return Err(format!("unknown subcommand {other:?}")),
        None => return Err("no subcommand".into()),
    }
    let (mut input, mut output, mut namer, mut api_base) = (None, None, None, None);
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let value = match inline {
            Some(v) => v,
            None => it
                .next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))?,
        };
        let slot = match flag {
            "--in" => &mut input,
            "--out" => &mut output,
            "--namer" => &mut namer,
            "--api-base" => &mut api_base,
            other => return Err(format!("unknown flag {other:?}")),
        };
        if slot.replace(value).is_some() {
            return Err(format!("{flag} given twice"));
        }
    }
    let namer =
        Namer::from_json(&namer.ok_or("--namer is required")?).map_err(|e| e.to_string())?;
    Ok(Args {
        input: input.ok_or("--in is required")?.into(),
        output: output.ok_or("--out is required")?.into(),
        namer,
        api_base,
    })
}

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("polis-topic-names: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let text = match std::fs::read_to_string(&args.input) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "polis-topic-names: cannot read {}: {e}",
                args.input.display()
            );
            return ExitCode::from(1);
        }
    };
    let hierarchy = match Hierarchy::from_json(&text) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("polis-topic-names: {e}");
            return ExitCode::from(1);
        }
    };
    let key = std::env::var(KEY_ENV).ok();
    let cap = RunCap::from_setting(std::env::var(RUN_MAX_ENV).ok().as_deref());
    let mut settings = client::Settings::default();
    if let Some(base) = args.api_base {
        settings.api_base = base;
    }
    let file = name_topics(&hierarchy, &args.namer, key.as_deref(), cap, &settings);
    if let Err(e) = write_atomically(&args.output, &file.to_json()) {
        eprintln!(
            "polis-topic-names: cannot write {}: {e}",
            args.output.display()
        );
        return ExitCode::from(1);
    }
    eprintln!(
        "polis-topic-names: {} topics, outcome {}{}",
        hierarchy.len(),
        file.outcome,
        file.reason
            .as_deref()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    );
    ExitCode::SUCCESS
}
