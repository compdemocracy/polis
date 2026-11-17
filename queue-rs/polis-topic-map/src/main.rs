use polis_topic_map::{Proximity, Topics, build, page};
use std::collections::BTreeMap;
use std::fs;
use std::process::ExitCode;

const USAGE: &str = "polis-topic-map: the data and the standalone page of the first-party topic map

  polis-topic-map data --proximity FILE --topics FILE [--comments FILE]
                       --title TEXT [--attribution TEXT] --out FILE
      FILE formats: the JSON bodies of GET /api/v3/topicMod/proximity?layer_id=all
      and GET /api/v3/delphi; comments is a JSON object of comment id to text.

  polis-topic-map page --template FILE --out FILE
                       [--text NAME=FILE]... [--script NAME=FILE]... [--base64 NAME=FILE]...
      Fills each {{{NAME}}} slot of the template: --text as is, --script made
      safe to sit inside a script element, --base64 as base64 of the bytes.
";

fn args_map(args: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {}", args[i]))?;
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("--{key} needs a value"))?;
        out.push((key.to_string(), value.clone()));
        i += 2;
    }
    Ok(out)
}

fn one<'a>(args: &'a [(String, String)], key: &str) -> Result<&'a str, String> {
    args.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .ok_or_else(|| format!("--{key} is required"))
}

fn read(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

fn run() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = argv.split_first().ok_or(USAGE)?;
    let args = args_map(rest)?;
    match command.as_str() {
        "data" => {
            let prox: Proximity = serde_json::from_str(&read(one(&args, "proximity")?)?)
                .map_err(|e| format!("proximity: {e}"))?;
            let topics: Topics = serde_json::from_str(&read(one(&args, "topics")?)?)
                .map_err(|e| format!("topics: {e}"))?;
            let comments: BTreeMap<String, String> = match one(&args, "comments") {
                Ok(path) => {
                    serde_json::from_str(&read(path)?).map_err(|e| format!("comments: {e}"))?
                }
                Err(_) => BTreeMap::new(),
            };
            let data = build(
                prox,
                topics,
                &comments,
                one(&args, "title")?,
                one(&args, "attribution").unwrap_or(""),
            )?;
            let out = one(&args, "out")?;
            fs::write(
                out,
                serde_json::to_string(&data).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("{out}: {e}"))?;
            eprintln!(
                "{out}: {} points, {} topics in {} levels",
                data.points.id.len(),
                data.topics.len(),
                data.levels.len()
            );
            Ok(())
        }
        "page" => {
            let template = read(one(&args, "template")?)?;
            let mut slots = Vec::new();
            for (kind, spec) in &args {
                if !matches!(kind.as_str(), "text" | "script" | "base64") {
                    continue;
                }
                let (name, path) = spec
                    .split_once('=')
                    .ok_or_else(|| format!("--{kind} takes NAME=FILE, got {spec}"))?;
                let value = match kind.as_str() {
                    "text" => read(path)?,
                    "script" => page::script_safe(&read(path)?),
                    _ => page::base64(&fs::read(path).map_err(|e| format!("{path}: {e}"))?),
                };
                slots.push((name.to_string(), value));
            }
            let html = page::fill(&template, &slots)?;
            let out = one(&args, "out")?;
            fs::write(out, &html).map_err(|e| format!("{out}: {e}"))?;
            eprintln!("{out}: {} bytes", html.len());
            Ok(())
        }
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
