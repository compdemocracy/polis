//! polis-shadow: compares what Node answered each shadowed vote with what the
//! read-only Rust shadow would have answered, from the log lines nginx, Node
//! and the shadow write, and prints aggregates and a verdict only. It runs
//! only the Logs Insights queries compiled into its route table (no query
//! text is accepted from anywhere), reads the stop rule's CloudWatch metrics,
//! and writes nothing. See README.md.
mod aws;
mod query;
mod report;
mod route;
mod time;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod eval;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

use anyhow::{Context, Result, bail, ensure};
use aws::{Aws, Outcome, Window};
use route::Route;
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

const USAGE: &str = "usage:
  polis-shadow queries [--route votes]
  polis-shadow run --route votes --from <UTC time> --to <UTC time> --log-group <name>
                   --db-instance <id> --load-balancer <app/name/id>
                   [--aws <program>] [--timeout-s <seconds>]
  polis-shadow report --route votes --results <directory>
                   [--from <UTC time> --to <UTC time>]
Exit: 0 pass, 1 stop, 2 too little evidence (or not evaluated), 3 error,
      4 examine (a criterion missed; no stop).";

/// The stop rule's baseline is the same span a week earlier.
const WEEK_S: i64 = 7 * 86_400;

/// The longest window one run may read (a week and a day of margin).
const MAX_WINDOW_S: i64 = 8 * 86_400;

#[derive(Debug, PartialEq)]
pub struct RunArgs {
    pub route: &'static str,
    pub window: (i64, i64),
    pub log_group: String,
    pub db_instance: String,
    pub load_balancer: String,
    pub aws: String,
    pub timeout_s: u64,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Queries {
        route: &'static str,
    },
    Run(RunArgs),
    Report {
        route: &'static str,
        results: PathBuf,
        window: (i64, i64),
    },
}

/// A resource name for an `aws` argument: letters, digits and `-_./:`,
/// nothing that could start an option or carry a query.
fn resource(flag: &str, value: String) -> Result<String> {
    ensure!(
        !value.is_empty()
            && value.len() <= 512
            && !value.starts_with('-')
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_./:".contains(&b)),
        "{flag} takes a resource name (letters, digits, - _ . / :)"
    );
    Ok(value)
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Command> {
    let mut args = args.into_iter();
    let command = args.next().context(USAGE)?;
    let mut options: BTreeMap<String, Option<String>> = BTreeMap::new();
    let valued = [
        "--route",
        "--from",
        "--to",
        "--log-group",
        "--db-instance",
        "--load-balancer",
        "--aws",
        "--timeout-s",
        "--results",
    ];
    while let Some(arg) = args.next() {
        let value = if valued.contains(&arg.as_str()) {
            Some(
                args.next()
                    .with_context(|| format!("{arg} needs a value"))?,
            )
        } else {
            bail!("unknown argument {arg}\n{USAGE}");
        };
        ensure!(
            options.insert(arg.clone(), value).is_none(),
            "{arg} given twice"
        );
    }
    let allowed: &[&str] = match command.as_str() {
        "queries" => &["--route"],
        "run" => &[
            "--route",
            "--from",
            "--to",
            "--log-group",
            "--db-instance",
            "--load-balancer",
            "--aws",
            "--timeout-s",
        ],
        "report" => &["--route", "--results", "--from", "--to"],
        _ => bail!("unknown command {command}\n{USAGE}"),
    };
    if let Some(extra) = options.keys().find(|k| !allowed.contains(&k.as_str())) {
        bail!("{command} does not take {extra}");
    }
    let mut take = |name: &str| options.remove(name).flatten();
    let route_key = take("--route").unwrap_or_else(|| route::VOTES.key.to_owned());
    let route = route::find(&route_key)
        .with_context(|| format!("unknown route {route_key}"))?
        .key;
    let window =
        |take: &mut dyn FnMut(&str) -> Option<String>, required: bool| -> Result<(i64, i64)> {
            match (take("--from"), take("--to")) {
                (Some(from), Some(to)) => {
                    let (from, to) = (time::parse(&from)?, time::parse(&to)?);
                    ensure!(from < to, "--from must be before --to");
                    ensure!(
                        to - from <= MAX_WINDOW_S,
                        "the window is at most eight days"
                    );
                    Ok((from, to))
                }
                (None, None) if !required => Ok((0, 0)),
                _ => bail!("--from and --to go together"),
            }
        };
    match command.as_str() {
        "queries" => Ok(Command::Queries { route }),
        "run" => {
            let window = window(&mut take, true)?;
            let mut need = |name: &str| -> Result<String> {
                resource(
                    name,
                    take(name).with_context(|| format!("run needs {name}"))?,
                )
            };
            let log_group = need("--log-group")?;
            let db_instance = need("--db-instance")?;
            let load_balancer = need("--load-balancer")?;
            let aws = take("--aws").unwrap_or_else(|| "aws".into());
            let timeout_s = match take("--timeout-s") {
                Some(t) => t.parse::<u64>().context("--timeout-s takes seconds")?,
                None => 900,
            };
            Ok(Command::Run(RunArgs {
                route,
                window,
                log_group,
                db_instance,
                load_balancer,
                aws,
                timeout_s,
            }))
        }
        _ => {
            let results = PathBuf::from(take("--results").context("report needs --results")?);
            let window = window(&mut take, false)?;
            Ok(Command::Report {
                route,
                results,
                window,
            })
        }
    }
}

/// The queries a run issues for a route, each checked against the allowlist.
pub fn compiled(route: Route) -> Result<Vec<query::Query>> {
    let queries = route.queries();
    for q in &queries {
        if let Some(why) = query::refusal(q) {
            bail!("compiled query refused by the allowlist: {why}");
        }
    }
    Ok(queries)
}

/// `run`: every compiled query and every stop-rule metric, then the report.
pub fn run(
    aws: &dyn Aws,
    args: &RunArgs,
    progress: &mut dyn std::io::Write,
) -> Result<report::Report> {
    let route = route::find(args.route).context("unknown route")?;
    let window = Window {
        from_s: args.window.0,
        to_s: args.window.1,
    };
    let timeout = Duration::from_secs(args.timeout_s);
    let mut results = report::Results::new();
    let mut scanned = 0.0;
    let mut issues = vec![];
    for q in compiled(route)? {
        let previous = q.previous_week.then(|| {
            (
                format!("{}_previous", q.name),
                q.clone(),
                window.earlier(WEEK_S),
            )
        });
        issues.push((q.name.to_owned(), q, window));
        issues.extend(previous);
    }
    for (name, q, window) in issues {
        let outcome = aws::run_query(aws, &args.log_group, &q, window, timeout)?;
        let entry = match outcome {
            Outcome::Rows {
                rows,
                bytes_scanned,
            } => {
                scanned += bytes_scanned;
                let _ = writeln!(progress, "query {name}: {} rows", rows.len());
                Ok(rows)
            }
            Outcome::Refused(message) => {
                let _ = writeln!(progress, "query {name}: refused");
                Err(if q.two_stage() {
                    format!(
                        "Logs Insights refused this query, which has two stats stages; this account may not support them ({message})"
                    )
                } else {
                    format!("Logs Insights refused this query ({message})")
                })
            }
        };
        results.insert(name, entry);
    }
    let _ = writeln!(progress, "Logs Insights scanned {:.1} MB", scanned / 1e6);
    let mut metrics = report::Metrics::new();
    for m in aws::stop_rule_metrics(&args.db_instance, &args.load_balancer, window) {
        let points = aws::read_metric(aws, &m).map_err(|e| format!("{e:#}"));
        metrics.insert(m.name.to_owned(), points);
    }
    Ok(report::build(&report::Inputs {
        route,
        window,
        results: &results,
        metrics: &metrics,
    }))
}

/// `report`: the same report from results saved as `<query>.json`
/// (get-query-results output) and `metric-<name>.json`
/// (get-metric-statistics output) in one directory.
pub fn report_from(
    route: Route,
    dir: &std::path::Path,
    window: (i64, i64),
) -> Result<report::Report> {
    let mut results = report::Results::new();
    let mut names = vec![];
    for q in compiled(route)? {
        names.push(q.name.to_owned());
        if q.previous_week {
            names.push(format!("{}_previous", q.name));
        }
    }
    for name in names {
        let path = dir.join(format!("{name}.json"));
        let entry = match std::fs::read_to_string(&path) {
            Ok(text) => match aws::parse_results(&text) {
                Ok((status, rows, _)) if status == "Complete" || status.is_empty() => Ok(rows),
                Ok((status, _, _)) => Err(format!("saved with status {status}")),
                Err(e) => Err(format!("{e:#}")),
            },
            Err(_) => Err("not in the results directory".into()),
        };
        results.insert(name, entry);
    }
    let window = Window {
        from_s: window.0,
        to_s: window.1,
    };
    let mut metrics = report::Metrics::new();
    for m in aws::stop_rule_metrics("-", "-", window) {
        let path = dir.join(format!("metric-{}.json", m.name));
        let entry = match std::fs::read_to_string(&path) {
            Ok(text) => aws::parse_datapoints(&text, m.stat).map_err(|e| format!("{e:#}")),
            Err(_) => Err("not in the results directory".into()),
        };
        metrics.insert(m.name.to_owned(), entry);
    }
    Ok(report::build(&report::Inputs {
        route,
        window,
        results: &results,
        metrics: &metrics,
    }))
}

fn real_main() -> Result<i32> {
    let command = parse_args(std::env::args().skip(1))?;
    let mut stdout = std::io::stdout();
    match command {
        Command::Queries { route } => {
            let route = route::find(route).context("unknown route")?;
            for q in compiled(route)? {
                writeln!(stdout, "-- {}: {}", q.name, q.about)?;
                if q.previous_week {
                    writeln!(
                        stdout,
                        "-- runs over the window, and again over the same window a week earlier"
                    )?;
                }
                if q.pad_s > 0 {
                    writeln!(
                        stdout,
                        "-- runs over the window widened by {} s on each side",
                        q.pad_s
                    )?;
                }
                writeln!(stdout, "{}\n", q.text(query::Bounds::Placeholders))?;
            }
            Ok(0)
        }
        Command::Run(args) => {
            let cli = aws::Cli {
                program: args.aws.clone(),
            };
            let report = run(&cli, &args, &mut std::io::stderr())?;
            write!(stdout, "{}", report.text)?;
            Ok(report.verdict.exit_code())
        }
        Command::Report {
            route,
            results,
            window,
        } => {
            let route = route::find(route).context("unknown route")?;
            let report = report_from(route, &results, window)?;
            write!(stdout, "{}", report.text)?;
            Ok(report.verdict.exit_code())
        }
    }
}

fn main() {
    match real_main() {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("polis-shadow: {e:#}");
            std::process::exit(3)
        }
    }
}
