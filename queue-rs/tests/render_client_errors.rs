//! Exercise exported client-error summaries through the command-line interface.
#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Output, Stdio};
type Row = BTreeMap<String, String>;

fn row(label: u64, count: &str) -> Row {
    [
        ("signature", format!("{label:016x}")),
        ("client", "report".into()),
        ("kind", "fetch".into()),
        ("total_count", count.into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect()
}
fn results(rows: Vec<Row>) -> Value {
    json!(
        rows.into_iter()
            .map(|row| row
                .into_iter()
                .map(|(field, value)| json!({"field":field,"value":value}))
                .collect::<Vec<_>>())
            .collect::<Vec<_>>()
    )
}
fn run_bytes(data: &[u8], args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_render-client-errors"))
        .arg("-")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Invalid CLI options can close stdin before reading it.
    let _ = child.stdin.take().unwrap().write_all(data);
    child.wait_with_output().unwrap()
}
fn run(data: &str, args: &[&str]) -> Output {
    run_bytes(data.as_bytes(), args)
}
fn run_json(rows: Vec<Row>, args: &[&str]) -> Output {
    run(&results(rows).to_string(), args)
}
fn good(output: Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    String::from_utf8(output.stdout).unwrap()
}
fn bad(output: Output) -> String {
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.starts_with("error:"));
    assert!(!error.contains("panicked"));
    error
}
#[test]
fn sorts_count_numerically_and_limits() {
    let output = good(run_json(
        vec![row(1, "9"), row(2, "1200"), row(3, "11")],
        &["--top", "2"],
    ));
    assert!(output.find("1200").unwrap() < output.find("11").unwrap());
    assert!(!output.contains(&row(1, "9")["signature"]));
    assert!(output.contains("COUNT"));
}
#[test]
fn ties_are_deterministic() {
    assert_eq!(
        good(run_json(vec![row(1, "3"), row(2, "3")], &[])),
        good(run_json(vec![row(2, "3"), row(1, "3")], &[]))
    );
}
#[test]
fn complete_response_wrapper() {
    good(run(
        &json!({"status":"Complete", "results":results(vec![row(1,"3")])}).to_string(),
        &[],
    ));
}
#[test]
fn incomplete_or_paginated_wrapper_rejected() {
    for extra in [
        json!({"status":"Running"}),
        json!({"status":"Failed"}),
        json!({"nextToken":"more"}),
    ] {
        let mut wrapper = json!({"results":results(vec![row(1,"3")])});
        wrapper
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        bad(run(&wrapper.to_string(), &[]));
    }
}
#[test]
fn csv_with_quoted_cells_and_bom() {
    let output = good(run(
        "\u{feff}signature,client,kind,total_count\r\n0000000000000001,\"report, preview\",fetch,3\r\n",
        &[],
    ));
    assert!(output.contains("report, preview"));
}
#[test]
fn file_input() {
    good(
        Command::new(env!("CARGO_BIN_EXE_render-client-errors"))
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/client-errors-export.json"
            ))
            .output()
            .unwrap(),
    );
}
#[test]
fn empty_results() {
    assert!(good(run_json(vec![], &[])).contains("No results"));
}
#[test]
fn optional_period_keeps_bins_separate() {
    let mut one = row(1, "3");
    one.insert("period".into(), "2026-01-01 00:00:00.000".into());
    let mut two = one.clone();
    two.insert("period".into(), "2026-01-02 00:00:00.000".into());
    let output = good(run_json(vec![one, two], &[]));
    assert!(output.contains("PERIOD") && output.contains("2026-01-02"));
}
#[test]
fn invalid_counts() {
    for value in [
        "0",
        "-1",
        "1.5",
        "NaN",
        "1e3",
        " 3",
        "03",
        "99999999999999999999",
        "+3",
    ] {
        bad(run_json(vec![row(1, value)], &[]));
    }
}
#[test]
fn invalid_signatures() {
    for value in [
        "",
        "abc",
        "zzzzzzzzzzzzzzzz",
        "fffffffffffffffff",
        "\nffffffffffffffff",
    ] {
        let mut item = row(1, "3");
        item.insert("signature".into(), value.into());
        bad(run_json(vec![item], &[]));
    }
}
#[test]
fn missing_required_fields() {
    for field in row(1, "3").keys() {
        let mut item = row(1, "3");
        item.remove(field);
        bad(run_json(vec![item], &[]));
    }
}
#[test]
fn duplicate_fields_and_headers() {
    let mut item = results(vec![row(1, "3")]);
    item[0]
        .as_array_mut()
        .unwrap()
        .push(json!({"field":"total_count","value":"4"}));
    bad(run(&item.to_string(), &[]));
    bad(run(
        "signature,signature,client,kind,total_count\na,b,c,fetch,1\n",
        &[],
    ));
}
#[test]
fn duplicate_groups_rejected() {
    bad(run_json(vec![row(1, "3"), row(1, "3")], &[]));
}
#[test]
fn invalid_kind() {
    let mut item = row(1, "3");
    item.insert("kind".into(), "unknown".into());
    bad(run_json(vec![item], &[]));
}
#[test]
fn all_kinds() {
    let kinds = [
        "error",
        "unhandledrejection",
        "console_error",
        "console_warn",
        "fetch",
        "xhr",
        "resource",
        "csp",
    ];
    let rows = kinds
        .iter()
        .enumerate()
        .map(|(i, kind)| {
            let mut item = row(i as u64, "3");
            item.insert("kind".into(), (*kind).into());
            item
        })
        .collect();
    let output = good(run_json(rows, &[]));
    for kind in kinds {
        assert!(output.contains(kind));
    }
}
#[test]
fn escape_terminal_and_table_content() {
    let mut item = row(1, "3");
    item.insert("period".into(), "\x1b[31m\n|<tag>\u{202e}".into());
    item.insert(
        "client".into(),
        "report\r\n\x1b]0;title\x07|<tag>\u{202e}".into(),
    );
    let output = good(run_json(vec![item], &[]));
    for value in ["\x1b", "\x07", "\r", "<tag>", "\u{202e}"] {
        assert!(!output.contains(value));
    }
    assert_eq!(output.lines().count(), 3);
    assert!(output.contains("\\u007c"));
}
#[test]
fn unknown_fields_never_printed() {
    let mut item = row(1, "3");
    item.insert("@ptr".into(), "ignored pointer".into());
    item.insert("extra".into(), "ignored detail".into());
    assert!(!good(run_json(vec![item], &[])).contains("ignored"));
}
#[test]
fn top_bounds() {
    for value in ["0", "-1", "1001", "1.2", &"9".repeat(5000)] {
        bad(run_json(vec![row(1, "3")], &["--top", value]));
    }
}
#[test]
fn malformed_inputs() {
    for value in [
        "{bad",
        "{}",
        "null",
        "[{}]",
        "[[{\"field\":\"x\"}]]",
        "signature,client,kind,total_count\na,b,fetch,1,extra\n",
    ] {
        bad(run(value, &[]));
    }
}
#[test]
fn mixed_periods_rejected() {
    let mut two = row(2, "3");
    two.insert("period".into(), "2026-01-01".into());
    bad(run_json(vec![row(1, "3"), two], &[]));
}
#[test]
fn error_does_not_echo_input() {
    let error = bad(run_json(vec![row(1, "\x1b[31mraw detail")], &[]));
    assert!(!error.contains("raw detail") && !error.contains('\x1b'));
}
#[test]
fn cells_are_bounded() {
    let mut item = row(1, "3");
    item.insert("client".into(), "x".repeat(10000));
    assert!(good(run_json(vec![item], &[])).len() < 1000);
}
#[test]
fn input_limits() {
    bad(run(&" ".repeat(16 * 1024 * 1024 + 1), &[]));
    bad(run(&json!(vec![json!([]); 10001]).to_string(), &[]));
}
#[test]
fn count_upper_bound() {
    let value = i64::MAX.to_string();
    assert!(good(run_json(vec![row(1, &value)], &[])).contains(&value));
    bad(run_json(
        vec![row(1, &(i64::MAX as u64 + 1).to_string())],
        &[],
    ));
}
#[test]
fn blank_client_or_period() {
    let mut item = row(1, "3");
    item.insert("client".into(), " \t".into());
    bad(run_json(vec![item], &[]));
    let mut item = row(1, "3");
    item.insert("period".into(), "".into());
    bad(run_json(vec![item], &[]));
}
#[test]
fn representative_fields_and_build_range_are_escaped() {
    let mut item = row(1, "3");
    let fields = [
        "error_message",
        "resource",
        "status",
        "page",
        "stack",
        "first_build",
        "latest_build",
    ];
    for field in fields {
        item.insert(field.into(), format!("{field}:\x1b\n|<>&`\u{202e}😀"));
    }
    let output = good(run_json(vec![item], &[]));
    for field in fields {
        assert!(output.contains(&field.to_uppercase()));
        assert!(output.contains(&format!(
            "{field}:\\u001b\\n\\u007c\\u003c\\u003e\\u0026\\u0060\\u202e\\ud83d\\ude00"
        )));
    }
    assert_eq!(output.lines().count(), 3);
}
#[test]
fn csv_multiline_quotes_and_invalid_rows() {
    let prefix = "signature,client,kind,total_count\n";
    assert!(
        good(run(
            &format!("{prefix}0000000000000001,\"report\n\"\"preview\"\"\",fetch,3\n"),
            &[]
        ))
        .contains("report\\n\\\"preview\\\"")
    );
    for suffix in [
        "a,b,fetch\n",
        "a,\"unterminated",
        "a,\"closed\"oops,fetch,3\n",
    ] {
        bad(run(&format!("{prefix}{suffix}"), &[]));
    }
}
#[test]
fn invalid_utf8_and_unreadable_file() {
    bad(run_bytes(&[0xff, 0xfe], &[]));
    bad(Command::new(env!("CARGO_BIN_EXE_render-client-errors"))
        .arg("/no/such/client-error-export.json")
        .output()
        .unwrap());
}
#[test]
fn csv_row_limit_and_nonstring_json() {
    let text = format!(
        "signature,client,kind,total_count\n{}",
        "0000000000000001,report,fetch,3\n".repeat(10001)
    );
    bad(run(&text, &[]));
    bad(run("[[{\"field\":\"total_count\",\"value\":3}]]", &[]));
}
#[test]
fn offline_count_sum_matches_cloudwatch_shaped_export() {
    // This checks fixture totals and rendering, not a live query parser.
    let events: Value =
        serde_json::from_str(include_str!("fixtures/client-errors-events.json")).unwrap();
    let export: Value =
        serde_json::from_str(include_str!("fixtures/client-errors-export.json")).unwrap();
    let mut totals = BTreeMap::<(String, String, String), u64>::new();
    for event in events.as_array().unwrap() {
        if event["message"] != "client_error" {
            continue;
        }
        let key = (
            event["signature"].as_str().unwrap().into(),
            event["client"].as_str().unwrap().into(),
            event["kind"].as_str().unwrap().into(),
        );
        *totals.entry(key).or_default() += event["count"].as_u64().unwrap();
    }
    let mut expected = BTreeMap::new();
    for pairs in export["results"].as_array().unwrap() {
        let row: Row = pairs
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| {
                (
                    pair["field"].as_str().unwrap().into(),
                    pair["value"].as_str().unwrap().into(),
                )
            })
            .collect();
        expected.insert(
            (
                row["signature"].clone(),
                row["client"].clone(),
                row["kind"].clone(),
            ),
            row["total_count"].parse::<u64>().unwrap(),
        );
    }
    assert_eq!(totals, expected);
    assert_eq!(
        totals[&("0000000000000001".into(), "report".into(), "fetch".into())],
        1007
    );
    let output = good(run(&export.to_string(), &[]));
    for value in [
        "1007",
        "Request failed",
        "/api/v3/votes",
        "500",
        "/report/:id",
        "app.js:2:3",
        "build-first",
        "build-latest",
    ] {
        assert!(output.contains(value), "missing {value}");
    }
    assert!(!output.contains("ignored pointer"));
}

fn positioned(label: u64, hash: &str, position: &str, count: &str) -> Row {
    let mut item = row(label, count);
    item.insert("kind".into(), "error".into());
    item.insert("error_message".into(), "TypeError".into());
    item.insert("status".into(), "0".into());
    item.insert(
        "stack".into(),
        format!("/report_bundle.{hash}.js:{position}"),
    );
    item.insert("first_build".into(), hash.into());
    item.insert("latest_build".into(), hash.into());
    item
}

#[test]
fn precise_positions_remain_rows_until_cross_build_grouping_is_requested() {
    let rows = vec![
        positioned(1, "12345678", "2:100", "3"),
        positioned(2, "12345678", "2:200", "5"),
        positioned(3, "87654321", "3:900", "7"),
    ];
    let precise = good(run_json(rows.clone(), &[]));
    assert_eq!(precise.lines().count(), 5);
    for position in ["2:100", "2:200", "3:900"] {
        assert!(precise.contains(position));
    }
    let grouped = good(run_json(rows.clone(), &["--group-builds"]));
    assert_eq!(grouped.lines().count(), 4);
    assert!(grouped.contains("GROUP_SIGNATURE"));
    assert!(grouped.contains("POSITION_SIGNATURES"));
    assert!(grouped.contains("/report_bundle.js"));
    assert!(grouped.lines().last().unwrap().starts_with("15"));
    let mut reversed = rows;
    reversed.reverse();
    assert_eq!(grouped, good(run_json(reversed, &["--group-builds"])));
}

#[test]
fn same_error_across_two_builds_groups_without_changing_input_rows() {
    let rows = vec![
        positioned(1, "12345678", "2:100", "3"),
        positioned(2, "87654321", "3:900", "7"),
    ];
    let precise = good(run_json(rows.clone(), &[]));
    assert_eq!(precise.lines().count(), 4);
    let grouped = good(run_json(rows, &["--group-builds"]));
    assert_eq!(grouped.lines().count(), 4);
    assert!(grouped.lines().last().unwrap().starts_with("10"));
}

#[test]
fn cross_build_grouping_keeps_client_kind_category_bundle_and_period_separate() {
    let base = positioned(1, "12345678", "2:100", "3");
    for (field, value) in [
        ("client", "admin"),
        ("kind", "console_error"),
        ("error_message", "RangeError"),
        ("status", "500"),
        ("stack", "/js/other.12345678.js:2:100"),
        ("period", "second"),
    ] {
        let mut one = base.clone();
        one.insert("period".into(), "first".into());
        let mut two = one.clone();
        two.insert("signature".into(), "0000000000000002".into());
        two.insert(field.into(), value.into());
        assert_eq!(
            good(run_json(vec![one, two], &["--group-builds"]))
                .lines()
                .count(),
            5,
            "{field}"
        );
    }
}

#[test]
fn cross_build_grouping_retains_plain_positions_and_incomplete_diagnostics() {
    for locations in [
        ["/js/app.js:2:100", "/js/app.js:2:200"],
        ["/js/app.short.js:2:100", "/js/app.short.js:2:200"],
        ["", ""],
    ] {
        let mut rows = vec![row(1, "3"), row(2, "7")];
        for (item, location) in rows.iter_mut().zip(locations) {
            item.insert("stack".into(), location.into());
            item.insert("error_message".into(), "TypeError".into());
        }
        assert_eq!(good(run_json(rows, &["--group-builds"])).lines().count(), 5);
    }
    let mut one = positioned(1, "12345678", "2:100", "3");
    let mut two = positioned(2, "87654321", "3:900", "7");
    for item in [&mut one, &mut two] {
        item.remove("error_message");
        item.remove("status");
    }
    assert_eq!(
        good(run_json(vec![one, two], &["--group-builds"]))
            .lines()
            .count(),
        5
    );
}

#[test]
fn cross_build_grouping_refuses_count_overflow_before_printing() {
    bad(run_json(
        vec![
            positioned(1, "12345678", "2:100", "9223372036854775807"),
            positioned(2, "87654321", "3:900", "1"),
        ],
        &["--group-builds"],
    ));
}

#[test]
fn cross_build_resource_and_astro_locations_use_the_same_normalization() {
    for (one, two, expected) in [
        (
            "/_astro/Layout.Bc1dEf2G.mjs:1:2",
            "/_astro/Layout.Dh3jKl4M.mjs:3:4",
            "/_astro/Layout.mjs",
        ),
        (
            "/static/js/admin_bundle.12345678.js:2:10",
            "/static/js/admin_bundle.87654321.js:2:20",
            "/static/js/admin_bundle.js",
        ),
        (
            "/js/participation_bundle.12345678.js:2:10",
            "/js/participation_bundle.87654321.js:2:20",
            "/js/participation_bundle.js",
        ),
    ] {
        let mut rows = vec![
            positioned(1, "12345678", "1:2", "3"),
            positioned(2, "87654321", "3:4", "7"),
        ];
        for (item, location) in rows.iter_mut().zip([one, two]) {
            item.insert("stack".into(), location.into());
        }
        let output = good(run_json(rows, &["--group-builds"]));
        assert_eq!(output.lines().count(), 4);
        assert!(output.contains(expected));
    }
    let mut rows = vec![row(1, "3"), row(2, "7")];
    for (item, hash) in rows.iter_mut().zip(["12345678", "87654321"]) {
        item.insert("resource".into(), format!("/js/app.{hash}.js"));
        item.insert("status".into(), "404".into());
    }
    let output = good(run_json(rows, &["--group-builds"]));
    assert_eq!(output.lines().count(), 4);
    assert!(output.contains("/js/app.js"));
}
