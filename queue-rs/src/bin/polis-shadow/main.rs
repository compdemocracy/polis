//! polis-shadow: compares what Node answered each shadowed request (a vote,
//! a comment) with what the read-only Rust shadow would have answered, from
//! the log lines nginx, Node and the shadow write, and prints aggregates and
//! a verdict only. It runs only the Logs Insights queries compiled into its
//! route table (no query text is accepted from anywhere), reads the stop
//! rule's CloudWatch metrics, and writes nothing. See README.md.
mod aws;
mod query;
mod report;
mod report_comments;
mod route;
mod route_comments;
mod slices;
mod time;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod eval;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests_comments;

use anyhow::{Context, Result, bail, ensure};
use aws::{Aws, Outcome, Window};
use route::Route;
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

const USAGE: &str = "usage:
  polis-shadow queries [--route votes|comments]
  polis-shadow run --route votes|comments --from <UTC time> --to <UTC time>
                   --log-group <name> --db-instance <id> --load-balancer <app/name/id>
                   [--aws <program>] [--timeout-s <seconds>]
  polis-shadow report --route votes|comments --results <directory>
                   [--from <UTC time> --to <UTC time>]
Exit: 0 pass, 1 stop, 2 too little evidence (or not evaluated), 3 error,
      4 examine (a criterion missed; no stop).";

/// The stop rule's baseline is the same span a week earlier.
const WEEK_S: i64 = 7 * 86_400;

/// The longest window one run may read: for votes a week and a day of
/// margin; for comments 92 days, because a comment's evidence is defined by
/// counts that a week of comments does not reach. Neither is a definition of
/// enough evidence: the minimum counts are.
fn max_window_s(route: Route) -> i64 {
    match route.kind {
        route::Kind::Votes { .. } => 8 * 86_400,
        route::Kind::Comments => 92 * 86_400,
    }
}

/// The shadow prints its line after its read-back of what Node stored: two
/// seconds after the copy arrived, or ten when the first look found nothing.
pub const READBACK_MAX_S: i64 = 10;

/// How long after a line is written a query may still not return it. Measured
/// once on this log group: each line was queryable within about five seconds
/// of being written, yet a query made while its window was still open
/// returned nothing from the window's last two minutes. Five minutes is two
/// and a half times that.
pub const DELIVERY_LAG_S: i64 = 300;

/// A window must have ended this long ago before it is read.
pub const SETTLE_S: i64 = READBACK_MAX_S + DELIVERY_LAG_S;

/// Refuses a window whose lines may still be arriving. A comparison made
/// over such a window sets lines that have arrived beside lines that have
/// not, and finds differences that are not there.
pub fn settled(window: (i64, i64), now_s: i64) -> Result<()> {
    ensure!(
        window.1 + SETTLE_S <= now_s,
        "the window ends {} and it is {}: its lines may still be arriving. A window must have ended at least {SETTLE_S} s ago ({READBACK_MAX_S} s for the shadow's second read-back, which its line waits for, and {DELIVERY_LAG_S} s for the log's delivery). The latest --to that can be read now is {}",
        time::format(window.1),
        time::format(now_s),
        time::format(now_s - SETTLE_S)
    );
    Ok(())
}

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
    let found = route::find(&route_key).with_context(|| format!("unknown route {route_key}"))?;
    let route = found.key;
    let window =
        |take: &mut dyn FnMut(&str) -> Option<String>, required: bool| -> Result<(i64, i64)> {
            match (take("--from"), take("--to")) {
                (Some(from), Some(to)) => {
                    let (from, to) = (time::parse(&from)?, time::parse(&to)?);
                    ensure!(from < to, "--from must be before --to");
                    ensure!(
                        to - from <= max_window_s(found),
                        "the window is at most {} days for this route",
                        max_window_s(found) / 86_400
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

/// What a refused query is reported as.
fn refused(q: &query::Query, message: &str) -> String {
    if q.two_stage() {
        format!(
            "Logs Insights refused this query, which has two stats stages; this account may not support them ({message})"
        )
    } else {
        format!("Logs Insights refused this query ({message})")
    }
}

/// One sliced query (a join): run once for each slice of the window, each
/// slice's total checked against nginx's count for the same span, and the
/// slices added up. Anything short of every slice complete is an error entry
/// that says so: a join is never reported from part of its window.
fn run_sliced(
    aws: &dyn Aws,
    args: &RunArgs,
    q: &query::Query,
    window: Window,
    results: &report::Results,
    scanned: &mut f64,
    progress: &mut dyn std::io::Write,
) -> Result<Result<Vec<aws::Row>, String>> {
    ensure!(
        q.additive(),
        "{}: a sliced query's final stage must hold counts only",
        q.name
    );
    let bins = match results.get("edge_bins") {
        Some(Ok(rows)) => slices::bins(rows),
        Some(Err(why)) => Err(why.clone()),
        None => Err("not run".to_owned()),
    };
    let planned = bins.and_then(|bins| {
        slices::plan(window, &bins, route::SLICE_MAX_REQUESTS).map(|plan| (plan, bins))
    });
    let (plan, bins) = match planned {
        Ok(planned) => planned,
        Err(why) => {
            let _ = writeln!(progress, "query {}: not run", q.name);
            return Ok(Err(format!(
                "not run: the count of requests by five minutes, which the slices are planned from, is not usable ({why})"
            )));
        }
    };
    let timeout = Duration::from_secs(args.timeout_s);
    let mut parts = vec![];
    for (i, slice) in plan.iter().enumerate() {
        let place = format!("slice {} of {}", i + 1, plan.len());
        match aws::run_query(aws, &args.log_group, q, *slice, timeout)? {
            Outcome::Rows {
                rows,
                bytes_scanned,
            } => {
                *scanned += bytes_scanned;
                if rows.len() >= route::ROW_LIMIT {
                    let _ = writeln!(progress, "query {}: cut off", q.name);
                    return Ok(Err(format!(
                        "{place}: {} rows, the most Logs Insights returns; the result may be cut off",
                        route::ROW_LIMIT
                    )));
                }
                let (joined, expected) = (
                    slices::joined(&rows),
                    slices::expected(window, *slice, &bins),
                );
                if joined != expected {
                    let _ = writeln!(progress, "query {}: withheld", q.name);
                    return Ok(Err(format!(
                        "withheld: {place} joined {joined} requests where nginx logged {expected}; a result was cut off, or lines were still arriving between the two queries"
                    )));
                }
                parts.push(rows);
            }
            Outcome::Refused(message) => {
                let _ = writeln!(progress, "query {}: refused", q.name);
                return Ok(Err(refused(q, &message)));
            }
        }
    }
    let rows = if parts.len() == 1 {
        parts.remove(0)
    } else {
        slices::merge(&q.final_keys(), parts)
    };
    let _ = writeln!(
        progress,
        "query {}: {} rows from {} slice(s)",
        q.name,
        rows.len(),
        plan.len()
    );
    Ok(Ok(rows))
}

/// `run`: every compiled query and every stop-rule metric, then the report.
/// `now_s` is the present, in epoch seconds: a window that has not settled
/// (`settled`) is refused before anything is asked of AWS.
pub fn run(
    aws: &dyn Aws,
    args: &RunArgs,
    now_s: i64,
    progress: &mut dyn std::io::Write,
) -> Result<report::Report> {
    let route = route::find(args.route).context("unknown route")?;
    settled(args.window, now_s)?;
    let window = Window {
        from_s: args.window.0,
        to_s: args.window.1,
    };
    let timeout = Duration::from_secs(args.timeout_s);
    let mut results = report::Results::new();
    let mut scanned = 0.0;
    for q in compiled(route)? {
        if q.sliced {
            let entry = run_sliced(aws, args, &q, window, &results, &mut scanned, progress)?;
            results.insert(q.name.to_owned(), entry);
            continue;
        }
        let span = if q.recent {
            route::stop_span(window)
        } else {
            window
        };
        let mut issues = vec![(q.name.to_owned(), span)];
        if q.previous_week {
            issues.push((format!("{}_previous", q.name), span.earlier(WEEK_S)));
        }
        for (name, window) in issues {
            // In one piece, or piece by piece for a query whose rows are
            // bins of time; a piece that may be cut off spoils the whole.
            let mut entry = Ok(vec![]);
            for piece in slices::chunks(window, q.chunk_s) {
                match aws::run_query(aws, &args.log_group, &q, piece, timeout)? {
                    Outcome::Rows {
                        rows,
                        bytes_scanned,
                    } => {
                        scanned += bytes_scanned;
                        if q.chunk_s > 0 && rows.len() >= route::ROW_LIMIT {
                            entry = Err("its result may be cut off".to_owned());
                            break;
                        }
                        if let Ok(all) = &mut entry {
                            all.extend(rows);
                        }
                    }
                    Outcome::Refused(message) => {
                        entry = Err(refused(&q, &message));
                        break;
                    }
                }
            }
            let _ = match &entry {
                Ok(rows) => writeln!(progress, "query {name}: {} rows", rows.len()),
                Err(_) => writeln!(progress, "query {name}: refused or cut off"),
            };
            results.insert(name, entry);
        }
    }
    let _ = writeln!(progress, "Logs Insights scanned {:.1} MB", scanned / 1e6);
    let mut metrics = report::Metrics::new();
    let stop = route::stop_span(window);
    for m in aws::stop_rule_metrics(&args.db_instance, &args.load_balancer, stop) {
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

/// One saved `get-query-results` output. An error says what is wrong with
/// the file and never quotes it.
fn saved(path: &std::path::Path) -> Option<Result<Vec<aws::Row>, String>> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(match aws::parse_results(&text) {
        Ok((status, rows, _)) if status == "Complete" || status.is_empty() => {
            if rows.len() >= route::ROW_LIMIT {
                Err(format!(
                    "{} rows, the most Logs Insights returns; the result may be cut off",
                    route::ROW_LIMIT
                ))
            } else {
                Ok(rows)
            }
        }
        Ok((status, _, _)) => Err(
            match ["Running", "Scheduled", "Failed", "Cancelled", "Timeout"]
                .iter()
                .find(|known| **known == status)
            {
                Some(known) => format!("saved with status {known}"),
                None => "saved with a status that is not Complete".to_owned(),
            },
        ),
        Err(_) => Err("not a get-query-results output".to_owned()),
    })
}

/// `report`: the same report from results saved as `<query>.json`
/// (get-query-results output) and `metric-<name>.json`
/// (get-metric-statistics output) in one directory. A join that was run in
/// slices is saved as `join.0.json`, `join.1.json` and so on, and added up.
pub fn report_from(
    route: Route,
    dir: &std::path::Path,
    window: (i64, i64),
) -> Result<report::Report> {
    let mut results = report::Results::new();
    for q in compiled(route)? {
        let mut names = vec![q.name.to_owned()];
        if q.previous_week {
            names.push(format!("{}_previous", q.name));
        }
        for name in names {
            let mut entry = saved(&dir.join(format!("{name}.json")));
            if entry.is_none() && q.sliced {
                let mut parts = vec![];
                let mut failed = None;
                while let Some(part) = saved(&dir.join(format!("{name}.{}.json", parts.len()))) {
                    match part {
                        Ok(rows) => parts.push(rows),
                        Err(why) => {
                            failed = Some(format!("slice {}: {why}", parts.len() + 1));
                            break;
                        }
                    }
                }
                entry = match failed {
                    Some(why) => Some(Err(why)),
                    None if parts.is_empty() => None,
                    None => Some(Ok(slices::merge(&q.final_keys(), parts))),
                };
            }
            results.insert(
                name,
                entry.unwrap_or_else(|| Err("not in the results directory".into())),
            );
        }
    }
    let window = Window {
        from_s: window.0,
        to_s: window.1,
    };
    let mut metrics = report::Metrics::new();
    for m in aws::stop_rule_metrics("-", "-", route::stop_span(window)) {
        let path = dir.join(format!("metric-{}.json", m.name));
        let entry = match std::fs::read_to_string(&path) {
            Ok(text) => aws::parse_datapoints(&text, m.stat)
                .map_err(|_| "not a get-metric-statistics output".to_owned()),
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
                if q.recent {
                    writeln!(
                        stdout,
                        "-- runs over the last {} days of the window at most (the stop rule's span)",
                        route::STOP_SPAN_S / 86_400
                    )?;
                }
                if q.chunk_s > 0 {
                    writeln!(
                        stdout,
                        "-- runs over the window {} days at a time",
                        q.chunk_s / 86_400
                    )?;
                }
                if q.sliced {
                    writeln!(
                        stdout,
                        "-- runs once for each slice of the window (at most {} requests in a slice, by edge_bins) and the slices are added up",
                        route::SLICE_MAX_REQUESTS
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
            let now_s = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .context("the clock is before 1970")?
                .as_secs() as i64;
            let report = run(&cli, &args, now_s, &mut std::io::stderr())?;
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
