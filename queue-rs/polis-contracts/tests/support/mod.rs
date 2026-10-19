//! Shared by the contract tests: repository paths, fixture files, and a JSON
//! Schema checker for exactly the keywords the generated contracts use (a
//! port of the dependency-free client-report validator,
//! server/src/contracts/clientReportValidator.ts). An unknown keyword fails
//! the test rather than being skipped.
#![allow(dead_code)]
use polis_contracts::delphi_job_result::Timestamp;
use polis_contracts::wire::{JsMap, Json};
use std::path::{Path, PathBuf};

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn read(relative: &str) -> String {
    let path = repo().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The `.json` files of a fixture directory, by name without the extension.
pub fn fixtures(directory: &str) -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(directory);
    let mut out: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path
                .file_name()?
                .to_str()?
                .strip_suffix(".json")?
                .to_owned();
            Some((name, std::fs::read_to_string(&path).ok()?))
        })
        .collect();
    out.sort();
    out
}

/// `JSON.stringify(JSON.parse(text))`: the text without whitespace outside strings.
pub fn minify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

const ISO_8601: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$";
const SHA256_HEX: &str = "^[0-9a-f]{64}$";
const KEYWORDS: [&str; 23] = [
    "$schema",
    "$id",
    "$comment",
    "title",
    "description",
    "type",
    "const",
    "enum",
    "anyOf",
    "properties",
    "required",
    "patternProperties",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
    "minProperties",
    "maxProperties",
];

/// The schema violations of `value`; empty means valid.
pub fn violations(schema: &Json, value: &Json) -> Vec<String> {
    let mut errors = Vec::new();
    check(schema, value, "", &mut errors);
    errors
}

fn object(json: &Json) -> &JsMap<String, Json> {
    match json {
        Json::Object(map) => map,
        other => panic!("a schema node is an object, not {other:?}"),
    }
}

fn number(json: Option<&Json>) -> Option<f64> {
    match json {
        Some(Json::Number(n)) => Some(n.get()),
        _ => None,
    }
}

/// Order-insensitive equality for objects, as `contractEqual`.
fn equal(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| equal(v, w)))
        }
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| equal(v, w))
        }
        _ => a == b,
    }
}

fn pointer(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn check(schema: &Json, value: &Json, path: &str, errors: &mut Vec<String>) {
    let s = object(schema);
    for (k, _) in s.iter() {
        assert!(
            KEYWORDS.contains(&k.as_str()),
            "keyword {k} is not implemented"
        );
    }
    let at = if path.is_empty() { "/" } else { path };
    if let Some(Json::Array(branches)) = s.get("anyOf") {
        let mut best: Option<Vec<String>> = None;
        for branch in branches {
            let mut e = Vec::new();
            check(branch, value, path, &mut e);
            if e.is_empty() {
                return;
            }
            if best.as_ref().is_none_or(|b| e.len() < b.len()) {
                best = Some(e);
            }
        }
        errors.push(format!(
            "{at}: must match one of {} alternatives",
            branches.len()
        ));
        errors.extend(best.unwrap_or_default());
        return;
    }
    if let Some(Json::String(kind)) = s.get("type") {
        let ok = match kind.as_str() {
            "null" => matches!(value, Json::Null),
            "array" => matches!(value, Json::Array(_)),
            "object" => matches!(value, Json::Object(_)),
            "integer" => matches!(value, Json::Number(n) if n.get().fract() == 0.0),
            "number" => matches!(value, Json::Number(_)),
            "string" => matches!(value, Json::String(_)),
            "boolean" => matches!(value, Json::Bool(_)),
            other => panic!("type {other} is not implemented"),
        };
        if !ok {
            errors.push(format!("{at}: must be {kind}"));
            return;
        }
    }
    if let Some(c) = s.get("const") {
        if !equal(c, value) {
            errors.push(format!("{at}: must be {c:?}"));
        }
    }
    if let Some(Json::Array(options)) = s.get("enum") {
        if !options.iter().any(|o| equal(o, value)) {
            errors.push(format!("{at}: must be one of the enum"));
        }
    }
    if let Json::String(text) = value {
        if let Some(min) = number(s.get("minLength")) {
            if (text.chars().count() as f64) < min {
                errors.push(format!("{at}: must have at least {min} characters"));
            }
        }
        if let Some(Json::String(pattern)) = s.get("pattern") {
            let matches = match pattern.as_str() {
                ISO_8601 => Timestamp::new(text.clone()).is_ok(),
                SHA256_HEX => {
                    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                }
                _ => panic!("pattern {pattern} is not implemented"),
            };
            if !matches {
                errors.push(format!("{at}: must match {pattern}"));
            }
        }
    }
    if let Json::Number(n) = value {
        if number(s.get("minimum")).is_some_and(|m| n.get() < m) {
            errors.push(format!("{at}: below minimum"));
        }
        if number(s.get("maximum")).is_some_and(|m| n.get() > m) {
            errors.push(format!("{at}: above maximum"));
        }
    }
    if let Json::Array(items) = value {
        if number(s.get("minItems")).is_some_and(|m| (items.len() as f64) < m) {
            errors.push(format!("{at}: too few items"));
        }
        if number(s.get("maxItems")).is_some_and(|m| (items.len() as f64) > m) {
            errors.push(format!("{at}: too many items"));
        }
        if s.get("uniqueItems") == Some(&Json::Bool(true)) {
            for i in 0..items.len() {
                for j in i + 1..items.len() {
                    if equal(&items[i], &items[j]) {
                        errors.push(format!("{at}: items {i} and {j} must be unique"));
                    }
                }
            }
        }
        if let Some(item_schema) = s.get("items") {
            for (i, item) in items.iter().enumerate() {
                check(item_schema, item, &pointer(path, &i.to_string()), errors);
            }
        }
    }
    if let Json::Object(map) = value {
        if number(s.get("minProperties")).is_some_and(|m| (map.len() as f64) < m) {
            errors.push(format!("{at}: too few properties"));
        }
        if number(s.get("maxProperties")).is_some_and(|m| (map.len() as f64) > m) {
            errors.push(format!("{at}: too many properties"));
        }
        if let Some(Json::Array(required)) = s.get("required") {
            for name in required {
                if let Json::String(name) = name {
                    if !map.contains_key(name) {
                        errors.push(format!("{at}: must have property {name:?}"));
                    }
                }
            }
        }
        let properties = s.get("properties").map(object);
        let patterns = s.get("patternProperties").map(object);
        for (key, child) in map.iter() {
            let here = pointer(path, key);
            let mut matched = false;
            if let Some(sub) = properties.and_then(|p| p.get(key)) {
                matched = true;
                check(sub, child, &here, errors);
            }
            if let Some(patterns) = patterns {
                for (pattern, sub) in patterns.iter() {
                    assert_eq!(pattern, "^(.*)$", "pattern {pattern} is not implemented");
                    matched = true;
                    check(sub, child, &here, errors);
                }
            }
            if !matched && s.get("additionalProperties") == Some(&Json::Bool(false)) {
                errors.push(format!("{at}: must not have property {key:?}"));
            }
        }
    }
}
