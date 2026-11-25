use polis_topic_map::stored::{self, Outcome, RunIdentity, Wires};
use polis_topic_map::{Proximity, Topics, build, from_run, page};
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

  polis-topic-map store --env ENV --job ID --run ID --batch ID --conversation ZID
                        --scope SCOPE [--selection RULE] --models FILE [--execution FILE]
                        --positions FILE --assignments FILE --names FILE --out FILE
      The step at the end of a Delphi run: the run's map as the codec file of
      Delphi_TopicMapDocument, from the codec files of the run's
      Delphi_UMAPGraph, Delphi_CommentHierarchicalClusterAssignments and
      Delphi_CommentClustersLLMTopicNames. models is a JSON file (the run's
      models, as its output manifest names them); execution is a JSON file,
      the run's record of its steps (delphi-run-execution/1).

  polis-topic-map from-run --env ENV --job ID --out DIR
      The same file for a run stored before the step, from its stored
      families (read with the Delphi daemon's own queue settings:
      QUEUE_DATABASE_URL, POLIS_JOBS_TRANSPORT and the rest). Writes
      DIR/Delphi_TopicMapDocument.jsonl and, when there is a map,
      DIR/topic-map.json. Never writes to the database. When the run's batch
      already holds a map, exits 3 unless the stored one is the same.

  polis-topic-map derived-worker
      The worker of the derived stage: claims one derived job at a time
      (class derived) and stores its source run's map in the job's own batch.
      Off unless POLIS_JOBS_DERIVED_WORKER=1. Needs POLIS_JOBS_ENV and the
      queue settings of from-run. Keeps nothing on disk.
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
        "store" => {
            let file = |key: &str| -> Result<String, String> { read(one(&args, key)?) };
            let models: serde_json::Value =
                serde_json::from_str(&file("models")?).map_err(|e| format!("models: {e}"))?;
            let run = RunIdentity {
                env: one(&args, "env")?.to_owned(),
                job_id: one(&args, "job")?.to_owned(),
                run_id: one(&args, "run")?.to_owned(),
                batch_id: one(&args, "batch")?.to_owned(),
                conversation_id: one(&args, "conversation")?
                    .parse()
                    .map_err(|_| "--conversation is a conversation id".to_string())?,
                scope: one(&args, "scope")?.to_owned(),
                selection: one(&args, "selection").ok().map(str::to_owned),
                models,
                execution: match one(&args, "execution") {
                    Ok(path) => {
                        serde_json::from_str(&read(path)?).map_err(|e| format!("execution: {e}"))?
                    }
                    Err(_) => stored::execution_unavailable("the run recorded no execution"),
                },
            };
            let (positions, assignments, names) =
                (file("positions")?, file("assignments")?, file("names")?);
            let made = stored::store(
                &run,
                &Wires {
                    positions: &positions,
                    assignments: &assignments,
                    names: &names,
                },
            )?;
            let out = one(&args, "out")?;
            fs::write(out, &made.wire).map_err(|e| format!("{out}: {e}"))?;
            eprintln!("{out}: {}", summary(&made.outcome, made.wire.len()));
            Ok(())
        }
        "derived-worker" => polis_topic_map::worker::daemon(|k| std::env::var(k).ok()),
        "from-run" => {
            let (env, job) = (one(&args, "env")?, one(&args, "job")?);
            let dir = std::path::PathBuf::from(one(&args, "out")?);
            let mut client = from_run::connect(|k| std::env::var(k).ok())?;
            let made = from_run::read(&mut client, env, job)?;
            fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            let family = dir.join(format!("{}.jsonl", stored::FAMILY));
            fs::write(&family, &made.stored.wire)
                .map_err(|e| format!("{}: {e}", family.display()))?;
            if let Some(document) = &made.stored.document {
                let path = dir.join("topic-map.json");
                fs::write(&path, document).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            eprintln!(
                "{}: {}",
                family.display(),
                summary(&made.stored.outcome, made.stored.wire.len())
            );
            match made.already {
                None => eprintln!("stored map: none (the run was stored before the step)"),
                Some(stored) if stored == made.stored.wire => {
                    eprintln!("stored map: the same bytes")
                }
                Some(_) => return Err(DIFFERENT.into()),
            }
            Ok(())
        }
        _ => Err(USAGE.to_string()),
    }
}

const DIFFERENT: &str = "stored map: DIFFERENT from the one made again from the run's families";

fn summary(outcome: &Outcome, wire: usize) -> String {
    match outcome {
        Outcome::Map {
            document,
            gzip,
            sha256,
        } => format!(
            "map, document {document} bytes, gzip {gzip} bytes, sha256 {sha256}, family file {wire} bytes"
        ),
        Outcome::NoMap { reason, document } => match document {
            Some(bytes) => format!("no map ({}), document {bytes} bytes", reason.as_str()),
            None => format!("no map ({})", reason.as_str()),
        },
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            if e == DIFFERENT {
                ExitCode::from(3)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}
