//! The AWS CLI, spawned as a subprocess (no AWS SDK): Logs Insights
//! `start-query` and `get-query-results`, and CloudWatch
//! `get-metric-statistics`. The environment (credentials, region, proxy) is
//! the caller's. Every argument list is built here from a compiled query or a
//! fixed metric; nothing from the command line reaches a query string.
use crate::query::{Bounds, Query};
use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// One result row: field name to value, as Logs Insights returns them.
pub type Row = BTreeMap<String, String>;

pub struct Reply {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs one `aws` command (the arguments after `aws`).
pub trait Aws {
    fn call(&self, args: &[String]) -> Result<Reply>;
    /// Waits between polls of a running query.
    fn pause(&self, wait: Duration) {
        std::thread::sleep(wait);
    }
}

pub struct Cli {
    pub program: String,
}

impl Aws for Cli {
    fn call(&self, args: &[String]) -> Result<Reply> {
        let out = std::process::Command::new(&self.program)
            .args(["--output", "json"])
            .args(args)
            .output()
            .with_context(|| format!("could not run {}", self.program))?;
        Ok(Reply {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// The window, in epoch seconds, end exclusive.
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub from_s: i64,
    pub to_s: i64,
}

impl Window {
    pub fn bounds(&self) -> Bounds {
        Bounds::Window {
            from_ms: self.from_s * 1000,
            to_ms: self.to_s * 1000,
        }
    }
    pub fn earlier(&self, seconds: i64) -> Window {
        Window {
            from_s: self.from_s - seconds,
            to_s: self.to_s - seconds,
        }
    }
}

/// The `start-query` arguments for a compiled query over a window (padded by
/// the query's own margin).
pub fn start_query_args(log_group: &str, q: &Query, window: Window) -> Vec<String> {
    vec![
        "logs".into(),
        "start-query".into(),
        "--log-group-name".into(),
        log_group.into(),
        "--start-time".into(),
        (window.from_s - q.pad_s).to_string(),
        "--end-time".into(),
        (window.to_s + q.pad_s).to_string(),
        "--query-string".into(),
        q.text(window.bounds()),
    ]
}

/// What became of a query.
pub enum Outcome {
    Rows {
        rows: Vec<Row>,
        bytes_scanned: f64,
    },
    /// Logs Insights would not run it (malformed for this account, failed,
    /// cancelled or timed out): the message to print.
    Refused(String),
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no message")
        .chars()
        .take(300)
        .collect()
}

/// Parses `get-query-results` output.
pub fn parse_results(text: &str) -> Result<(String, Vec<Row>, f64)> {
    let value: serde_json::Value =
        serde_json::from_str(text).context("get-query-results did not return JSON")?;
    let status = value
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_owned();
    let mut rows = vec![];
    for row in value
        .get("results")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
    {
        let mut out = Row::new();
        for cell in row.as_array().into_iter().flatten() {
            let (Some(field), Some(v)) = (
                cell.get("field").and_then(|f| f.as_str()),
                cell.get("value"),
            ) else {
                continue;
            };
            if field == "@ptr" {
                continue;
            }
            let v = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => continue,
                other => other.to_string(),
            };
            out.insert(field.to_owned(), v);
        }
        rows.push(out);
    }
    let bytes = value
        .pointer("/statistics/bytesScanned")
        .and_then(|b| b.as_f64())
        .unwrap_or(0.0);
    Ok((status, rows, bytes))
}

pub fn run_query(
    aws: &dyn Aws,
    log_group: &str,
    q: &Query,
    window: Window,
    timeout: Duration,
) -> Result<Outcome> {
    let started = aws.call(&start_query_args(log_group, q, window))?;
    if !started.ok {
        let message = first_line(&started.stderr);
        // A query this account's Logs Insights does not accept is a refusal
        // to report, not an error to stop on; access and network failures
        // are errors.
        if message.contains("MalformedQueryException") || message.contains("InvalidParameter") {
            return Ok(Outcome::Refused(message));
        }
        bail!("aws logs start-query failed: {message}");
    }
    let id = serde_json::from_str::<serde_json::Value>(&started.stdout)
        .ok()
        .and_then(|v| {
            v.get("queryId")
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .context("start-query returned no queryId")?;
    let begun = Instant::now();
    let mut wait = Duration::from_millis(500);
    loop {
        let reply = aws.call(&[
            "logs".into(),
            "get-query-results".into(),
            "--query-id".into(),
            id.clone(),
        ])?;
        if !reply.ok {
            bail!(
                "aws logs get-query-results failed: {}",
                first_line(&reply.stderr)
            );
        }
        let (status, rows, bytes_scanned) = parse_results(&reply.stdout)?;
        match status.as_str() {
            "Complete" => {
                return Ok(Outcome::Rows {
                    rows,
                    bytes_scanned,
                });
            }
            "Failed" | "Cancelled" | "Timeout" | "Unknown" => {
                return Ok(Outcome::Refused(format!("the query ended {status}")));
            }
            _ => {}
        }
        if begun.elapsed() > timeout {
            return Ok(Outcome::Refused(format!(
                "no result within {} s",
                timeout.as_secs()
            )));
        }
        aws.pause(wait);
        wait = (wait * 2).min(Duration::from_secs(5));
    }
}

/// A CloudWatch statistic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stat {
    Average,
    Sum,
    P99,
}

/// A fixed metric the stop rule reads.
#[derive(Clone, Debug)]
pub struct Metric {
    pub name: &'static str,
    pub namespace: &'static str,
    pub metric: &'static str,
    pub dimension: (&'static str, String),
    pub period_s: i64,
    pub stat: Stat,
    pub window: Window,
}

/// CloudWatch returns at most 1,440 datapoints per call.
const MAX_POINTS: i64 = 1440;

pub fn metric_args(m: &Metric, from_s: i64, to_s: i64) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "cloudwatch".into(),
        "get-metric-statistics".into(),
        "--namespace".into(),
        m.namespace.into(),
        "--metric-name".into(),
        m.metric.into(),
        "--dimensions".into(),
        format!("Name={},Value={}", m.dimension.0, m.dimension.1),
        "--start-time".into(),
        crate::time::format(from_s),
        "--end-time".into(),
        crate::time::format(to_s),
        "--period".into(),
        m.period_s.to_string(),
    ];
    match m.stat {
        Stat::Average => args.extend(["--statistics".into(), "Average".into()]),
        Stat::Sum => args.extend(["--statistics".into(), "Sum".into()]),
        Stat::P99 => args.extend(["--extended-statistics".into(), "p99".into()]),
    }
    args
}

/// Parses `get-metric-statistics` output into (epoch seconds, value), sorted.
pub fn parse_datapoints(text: &str, stat: Stat) -> Result<Vec<(i64, f64)>> {
    let value: serde_json::Value =
        serde_json::from_str(text).context("get-metric-statistics did not return JSON")?;
    let mut out = vec![];
    for point in value
        .get("Datapoints")
        .and_then(|d| d.as_array())
        .into_iter()
        .flatten()
    {
        let Some(at) = point.get("Timestamp").and_then(|t| t.as_str()) else {
            continue;
        };
        let v = match stat {
            Stat::Average => point.get("Average"),
            Stat::Sum => point.get("Sum"),
            Stat::P99 => point.pointer("/ExtendedStatistics/p99"),
        };
        if let Some(v) = v.and_then(|v| v.as_f64()) {
            out.push((crate::time::parse(at)?, v));
        }
    }
    out.sort_by_key(|p| p.0);
    Ok(out)
}

pub fn read_metric(aws: &dyn Aws, m: &Metric) -> Result<Vec<(i64, f64)>> {
    let mut out = vec![];
    let mut from = m.window.from_s;
    while from < m.window.to_s {
        let to = (from + m.period_s * MAX_POINTS).min(m.window.to_s);
        let reply = aws.call(&metric_args(m, from, to))?;
        if !reply.ok {
            bail!(
                "aws cloudwatch get-metric-statistics ({}) failed: {}",
                m.name,
                first_line(&reply.stderr)
            );
        }
        out.extend(parse_datapoints(&reply.stdout, m.stat)?);
        from = to;
    }
    out.sort_by_key(|p| p.0);
    out.dedup_by_key(|p| p.0);
    Ok(out)
}

/// The stop rule's metrics for a window: database CPU (5-minute averages),
/// the load balancer's target response time p99 by hour and target 5xx by
/// day, each also for the same window a week earlier.
pub fn stop_rule_metrics(db_instance: &str, load_balancer: &str, window: Window) -> Vec<Metric> {
    const WEEK: i64 = 7 * 86_400;
    let db = ("DBInstanceIdentifier", db_instance.to_owned());
    let lb = ("LoadBalancer", load_balancer.to_owned());
    vec![
        Metric {
            name: "db_cpu",
            namespace: "AWS/RDS",
            metric: "CPUUtilization",
            dimension: db,
            period_s: 300,
            stat: Stat::Average,
            window,
        },
        Metric {
            name: "lb_p99",
            namespace: "AWS/ApplicationELB",
            metric: "TargetResponseTime",
            dimension: lb.clone(),
            period_s: 3600,
            stat: Stat::P99,
            window,
        },
        Metric {
            name: "lb_p99_previous",
            namespace: "AWS/ApplicationELB",
            metric: "TargetResponseTime",
            dimension: lb.clone(),
            period_s: 3600,
            stat: Stat::P99,
            window: window.earlier(WEEK),
        },
        Metric {
            name: "target_5xx",
            namespace: "AWS/ApplicationELB",
            metric: "HTTPCode_Target_5XX_Count",
            dimension: lb.clone(),
            period_s: 86_400,
            stat: Stat::Sum,
            window,
        },
        Metric {
            name: "target_5xx_previous",
            namespace: "AWS/ApplicationELB",
            metric: "HTTPCode_Target_5XX_Count",
            dimension: lb,
            period_s: 86_400,
            stat: Stat::Sum,
            window: window.earlier(WEEK),
        },
    ]
}
