//! Bounded PostgreSQL topics, preserving the legacy route's two read boundaries.
use crate::{delphi_read::contract, wire::JsMap};
use anyhow::{Result, ensure};
use postgres::Client;
use serde_json::Value;
use std::collections::BTreeMap;
const TOPICS: &str = "Delphi_CommentClustersLLMTopicNames";
const NARRATIVES: &str = "Delphi_NarrativeReports";
const MAX_ROWS: usize = 1000;
const MAX_BYTES: usize = 512 * 1024;

pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        statement_timeout: std::time::Duration::from_millis(200),
        ..crate::delphi_read::pool_limits()
    }
}

/// Never merge Node's distinct narrative/topic snapshots. Bounded requests run
/// sequentially and release their own connection between the two reads.
pub async fn answer(app: &crate::route::App, zid: i32, report: String) -> Option<String> {
    if !(1..=999999999).contains(&zid) {
        return None;
    }
    let pool = app.delphi_topics_db.as_ref()?;
    let env = app.delphi_topics_env.clone();
    let scope = app.delphi_topics_scope.clone();
    let rid = report.clone();
    let job = pool
        .with(move |c| narrative(c, &env, scope.as_deref(), &rid))
        .await
        .ok()?;
    let env = app.delphi_topics_env.clone();
    let scope = app.delphi_topics_scope.clone();
    let rows = pool
        .with(move |c| family(c, &env, scope.as_deref(), TOPICS, Some(zid), None))
        .await
        .ok()?;
    let body = crate::wire::to_json(&response(rows, zid, report, job).ok()?).ok()?;
    (body.len() <= 1024 * 1024).then_some(body)
}

fn family(
    c: &mut Client,
    env: &str,
    scope: Option<&str>,
    name: &str,
    zid: Option<i32>,
    report: Option<&str>,
) -> Result<Vec<Value>> {
    // The function walks exactly the served family. Its default key order is
    // Node's pre-index ordering. Extra rows or more than a conservative single
    // page go back to Node, without returning a partial snapshot.
    let rows = c.query("WITH page AS MATERIALIZED (SELECT item_key::text AS item_key, item::text AS item, ordinality FROM public.pd_result_page($1, CASE WHEN $5::text IS NULL THEN ARRAY[$2]::integer[] ELSE ARRAY(SELECT zid FROM reports WHERE report_id=$5) END, $3, $4, NULL,NULL,NULL,NULL,false,1001) WITH ORDINALITY), bounded AS (SELECT *, sum(octet_length(item_key)+octet_length(item)) OVER () <= 524288 AS fits FROM page) SELECT CASE WHEN fits THEN item_key END, CASE WHEN fits THEN item END FROM bounded ORDER BY ordinality", &[&env,&zid,&scope,&name,&report])?;
    ensure!(rows.len() <= MAX_ROWS, "result row bound");
    let mut bytes = 0;
    let mut seen = BTreeMap::<String, Value>::new();
    let mut items = Vec::new();
    for row in rows {
        let key: String = row.try_get(0)?;
        let text: String = row.try_get(1)?;
        bytes += text.len();
        ensure!(bytes <= MAX_BYTES, "single-page result bound");
        let item: Value = serde_json::from_str(&text)?;
        if let Some(prior) = seen.insert(key, item.clone()) {
            ensure!(prior == item, "ambiguous result scopes");
            continue;
        }
        validate_item(&item)?;
        items.push(item);
    }
    Ok(items)
}

// Node decodes every attribute, even fields the response does not use. Refuse
// unsupported representations rather than bypassing a decoder failure.
fn validate_item(item: &Value) -> Result<()> {
    let fields = item
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid item"))?;
    for v in fields.values() {
        validate_attribute(v)?;
    }
    Ok(())
}
fn validate_attribute(v: &Value) -> Result<()> {
    let tag = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid attribute"))?;
    ensure!(tag.len() == 1, "ambiguous attribute");
    if v.get("S").is_some_and(Value::is_string)
        || v.get("BOOL").is_some_and(Value::is_boolean)
        || v.get("NULL") == Some(&Value::Bool(true))
    {
        return Ok(());
    }
    if let Some(s) = v.get("N").and_then(Value::as_str) {
        let n: f64 = s.parse()?;
        ensure!(
            n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0),
            "numeric reader precision"
        );
        return Ok(());
    }
    if let Some(list) = v.get("L").and_then(Value::as_array) {
        for x in list {
            validate_attribute(x)?;
        }
        return Ok(());
    }
    if let Some(map) = v.get("M") {
        return validate_item(map);
    }
    anyhow::bail!("unsupported attribute");
}
fn text(item: &Value, key: &str) -> Result<contract::Text> {
    match item.get(key) {
        None => Ok(None),
        Some(v) if v.get("NULL") == Some(&Value::Bool(true)) => Ok(Some(None)),
        Some(v) => Ok(Some(Some(
            v.get("S")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("unsupported string field"))?
                .into(),
        ))),
    }
}
fn string(item: &Value, key: &str) -> Result<Option<String>> {
    Ok(text(item, key)?.flatten())
}
fn property(item: &Value, key: &str) -> Result<String> {
    let value = match item.get(key) {
        None => "undefined".into(),
        Some(v) if v.get("NULL") == Some(&Value::Bool(true)) => "null".into(),
        Some(v) if v.get("S").is_some() => v["S"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid string"))?
            .into(),
        Some(v) => {
            let n: f64 = v["N"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("unsupported property"))?
                .parse()?;
            ensure!(
                n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0,
                "unsupported property number"
            );
            crate::js::stringify(&crate::js::Js::Num(n))
        }
    };
    ensure!(
        !matches!(
            value.as_str(),
            "__proto__"
                | "constructor"
                | "prototype"
                | "toString"
                | "valueOf"
                | "hasOwnProperty"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "toLocaleString"
                | "__defineGetter__"
                | "__defineSetter__"
                | "__lookupGetter__"
                | "__lookupSetter__"
        ),
        "inherited object property"
    );
    Ok(value)
}
fn narrative(
    c: &mut Client,
    env: &str,
    scope: Option<&str>,
    report: &str,
) -> Result<Option<String>> {
    let mut rows = Vec::new();
    for item in family(c, env, scope, NARRATIVES, None, Some(report))? {
        if string(&item, "report_id")?.as_deref() != Some(report) {
            continue;
        }
        if let Some(ts) = string(&item, "timestamp")? {
            let key = string(&item, "rid_section_model")?
                .ok_or_else(|| anyhow::anyhow!("missing narrative key"))?;
            ensure!(
                ts.is_ascii() && key.is_ascii(),
                "unsupported index ordering"
            );
            rows.push((ts, key, item));
        }
    }
    // ReportIdTimestampIndex is ascending. Limit 1 is before reading section.
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let Some((_, _, first)) = rows.first() else {
        return Ok(None);
    };
    let Some(section) = string(first, "section")? else {
        return Ok(None);
    };
    if !section.contains('_') {
        return Ok(None);
    }
    for w in section.as_bytes().windows(36) {
        if w.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        }) {
            return Ok(Some(std::str::from_utf8(w)?.into()));
        }
    }
    Ok(None)
}
fn response(
    items: Vec<Value>,
    zid: i32,
    report: String,
    job: Option<String>,
) -> Result<contract::TopicsResponse> {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for item in items {
        ensure!(
            string(&item, "conversation_id")?.as_deref() == Some(zid.to_string().as_str()),
            "conversation key"
        );
        let model = string(&item, "model_name")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".into());
        let created = string(&item, "created_at")?.unwrap_or_default();
        ensure!(created.is_ascii(), "unsupported date prefix");
        let key = format!("{}_{}", model, &created[..created.len().min(10)]);
        ensure!(key != "__proto__", "inherited run property");
        if let Some((_, rows)) = groups.iter_mut().find(|(k, _)| k == &key) {
            rows.push(item);
        } else {
            groups.push((key, vec![item]));
        }
    }
    let mut runs = Vec::new();
    for (key, rows) in groups {
        let first = &rows[0];
        let created = string(first, "created_at")?.unwrap_or_default();
        let millis = if created.is_empty() {
            0
        } else {
            crate::delphi_logs::iso_millis(&created)
                .ok_or_else(|| anyhow::anyhow!("unsupported Date ordering"))?
        };
        let mut layers: Vec<(String, Vec<(String, contract::Topic)>)> = Vec::new();
        for item in &rows {
            let layer = property(item, "layer_id")?;
            let cluster = property(item, "cluster_id")?;
            let topic = contract::Topic {
                topic_name: text(item, "topic_name")?,
                model_name: text(item, "model_name")?,
                created_at: text(item, "created_at")?,
                topic_key: text(item, "topic_key")?,
            };
            if !layers.iter().any(|(k, _)| k == &layer) {
                layers.push((layer.clone(), Vec::new()));
            }
            let target = &mut layers
                .iter_mut()
                .find(|(k, _)| k == &layer)
                .ok_or_else(|| anyhow::anyhow!("missing layer"))?
                .1;
            if let Some((_, old)) = target.iter_mut().find(|(k, _)| k == &cluster) {
                *old = topic;
            } else {
                target.push((cluster, topic));
            }
        }
        let layers = JsMap::try_from_entries(
            layers
                .into_iter()
                .map(|(k, v)| Ok((k, JsMap::try_from_entries(v)?)))
                .collect::<Result<Vec<_>>>()?,
        )?;
        runs.push((
            key,
            millis,
            contract::Run {
                model_name: text(first, "model_name")?,
                created_date: text(first, "created_at")?,
                topics_by_layer: layers,
                item_count: rows.len(),
                job_uuid: job.clone(),
            },
        ));
    }
    runs.sort_by_key(|a| std::cmp::Reverse(a.1));
    let message = if runs.is_empty() {
        "No LLM topics found for this conversation"
    } else {
        "LLM topics retrieved successfully"
    };
    Ok(contract::TopicsResponse {
        status: contract::Success::Success,
        message,
        report_id: report,
        runs: JsMap::try_from_entries(runs.into_iter().map(|(k, _, r)| (k, r)))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn duplicate_cluster_overwrites_without_reordering_and_counts_all_items() {
        let row = |key: &str, cluster: &str, name: &str| json!({"conversation_id":{"S":"105"},"topic_key":{"S":key},"layer_id":{"N":"0"},"cluster_id":{"N":cluster},"model_name":{"S":"m"},"created_at":{"S":"2023-11-14T00:00:00Z"},"topic_name":{"S":name}});
        let result = response(
            vec![
                row("a", "10", "old"),
                row("b", "2", "second"),
                row("c", "10", "new"),
            ],
            105,
            "generated-report".into(),
            None,
        )
        .unwrap();
        let encoded = crate::wire::to_json(&result).unwrap();
        assert!(encoded.find("\"2\":").unwrap() < encoded.find("\"10\":").unwrap());
        assert!(!encoded.contains("old"));
        assert!(encoded.contains("new"));
        assert!(encoded.contains("\"item_count\":3"));
    }
    #[test]
    fn missing_and_null_properties_and_unsafe_keys_are_distinct() {
        let mut row =
            json!({"conversation_id":{"S":"105"},"topic_key":{"S":"a"},"topic_name":{"NULL":true}});
        let encoded = crate::wire::to_json(
            &response(vec![row.clone()], 105, "generated-report".into(), None).unwrap(),
        )
        .unwrap();
        assert!(encoded.contains("\"topic_name\":null"));
        assert!(!encoded.contains("\"model_name\""));
        assert!(encoded.contains("\"undefined\":{\"undefined\":"));
        row["layer_id"] = json!({"S":"__proto__"});
        assert!(response(vec![row], 105, "generated-report".into(), None).is_err());
        assert!(validate_attribute(&json!({"N":"9007199254740992"})).is_err());
    }
}
