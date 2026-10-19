//! Bounded legacy narrative reads on a pool independent of participation.
use crate::{
    delphi_reports::contract,
    wire::{JsMap, JsNumber, Json},
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        statement_timeout: std::time::Duration::from_millis(200),
        ..crate::delphi_reports::pool_limits()
    }
}

pub async fn answer(app: &crate::route::App, query: contract::Request) -> Option<String> {
    let report = query.report_id.as_ref()?.clone();
    let rid = report.clone();
    let env = app.delphi_narratives_env.clone();
    let scope = app.delphi_narratives_scope.clone();
    let items=app.delphi_narratives_db.as_ref()?.with(move |c| {
        // One complete, bounded family snapshot: an oversized family stays on
        // Node, so its paginated reads are never replaced by a partial result.
        let rows=c.query("WITH page AS MATERIALIZED (SELECT item_key::text AS item_key,item::text AS item,ordinality FROM public.pd_result_page($1,ARRAY(SELECT zid FROM reports WHERE report_id=$2),$3,'Delphi_NarrativeReports',NULL,NULL,NULL,NULL,false,1001) WITH ORDINALITY), bounded AS (SELECT *,sum(octet_length(item_key)+octet_length(item)) OVER () <= 524288 AS fits FROM page) SELECT CASE WHEN fits THEN item_key END,CASE WHEN fits THEN item END FROM bounded ORDER BY ordinality", &[&env,&rid,&scope])?;
        ensure!(rows.len()<=1000,"result row bound");
        let mut seen=BTreeMap::<String,Value>::new();
        let mut items=Vec::new();
        for row in rows {
            let key:String=row.try_get(0)?;
            let text:String=row.try_get(1)?;
            let item:Value=serde_json::from_str(&text)?;
            if let Some(prior)=seen.insert(key,item.clone()) {ensure!(prior==item,"ambiguous result scopes");continue;}
            // Decode every attribute, including fields not present in output.
            let decoded=decode_object(&item)?;
            let Some(Json::String(id))=decoded.get("report_id") else {continue};
            if id!=&rid {continue;}
            let Some(ts)=string(&decoded,"timestamp")? else {continue};
            let key=string(&decoded,"rid_section_model")?.ok_or_else(||anyhow::anyhow!("missing key"))?;
            ensure!(ts.is_ascii() && key.is_ascii(),"index ordering");
            items.push((ts,key,decoded));
        }
        items.sort_by(|a,b| a.0.cmp(&b.0).then_with(||a.1.cmp(&b.1)));
        Ok(items.into_iter().map(|(_,_,item)|item).collect::<Vec<_>>())
    }).await.ok()?;
    let body = response(items, &query).ok()?;
    (body.len() <= 1024 * 1024).then_some(body)
}
fn decode_object(item: &Value) -> Result<JsMap<String, Json>> {
    let m = item
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid object"))?;
    // JSONB emits keys by UTF-8 byte length, then byte value; the Node
    // decoder retains that order before JavaScript integer-key enumeration.
    let mut fields: Vec<_> = m.iter().collect();
    fields.sort_by(|(a, _), (b, _)| {
        a.len()
            .cmp(&b.len())
            .then_with(|| a.as_bytes().cmp(b.as_bytes()))
    });
    JsMap::try_from_entries(
        fields
            .into_iter()
            .map(|(k, v)| Ok((k.clone(), decode(v)?)))
            .collect::<Result<Vec<_>>>()?,
    )
    .map_err(Into::into)
}
fn decode(v: &Value) -> Result<Json> {
    let m = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid attribute"))?;
    ensure!(m.len() == 1, "ambiguous attribute");
    if let Some(s) = v.get("S").and_then(Value::as_str) {
        return Ok(Json::String(s.into()));
    }
    if let Some(b) = v.get("BOOL").and_then(Value::as_bool) {
        return Ok(Json::Bool(b));
    }
    if v.get("NULL") == Some(&Value::Bool(true)) {
        return Ok(Json::Null);
    }
    if let Some(s) = v.get("N").and_then(Value::as_str) {
        let n: f64 = s.parse()?;
        ensure!(
            n.is_finite() && (n.fract() != 0.0 || n.abs() <= 9_007_199_254_740_991.0),
            "numeric reader precision"
        );
        return Ok(Json::Number(JsNumber::new(n)?));
    }
    if let Some(l) = v.get("L").and_then(Value::as_array) {
        return Ok(Json::Array(l.iter().map(decode).collect::<Result<_>>()?));
    }
    if let Some(m) = v.get("M") {
        return Ok(Json::Object(decode_object(m)?));
    }
    anyhow::bail!("unsupported attribute")
}
fn string(row: &JsMap<String, Json>, key: &str) -> Result<Option<String>> {
    match row.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(s)) => Ok(Some(s.clone())),
        _ => anyhow::bail!("unsupported string coercion"),
    }
}
fn truthy(j: &Json) -> bool {
    match j {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::String(s) => !s.is_empty(),
        Json::Number(n) => n.get() != 0.0,
        _ => true,
    }
}
fn or(row: &JsMap<String, Json>, key: &str, default: Json) -> Json {
    row.get(key)
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or(default)
}
fn safe_key(k: &str) -> Result<()> {
    ensure!(
        !matches!(
            k,
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
        "inherited property"
    );
    Ok(())
}
fn ordered<T>(v: Vec<(String, T)>) -> Result<JsMap<String, T>> {
    Ok(JsMap::try_from_entries(v)?)
}
// Default Node/ICU collation for the bounded timestamp alphabet. Do not
// parse dates: doing so loses microseconds and changes the legacy ordering.
// Other alphabets stay on Node until their collation is characterized.
fn timestamp_key(value: &str) -> Option<Vec<u8>> {
    if value.len() > 64 {
        return None;
    }
    value
        .bytes()
        .map(|b| match b {
            b'-' => Some(0),
            b':' => Some(1),
            b'.' => Some(2),
            b'+' => Some(3),
            b'0'..=b'9' => Some(4 + b - b'0'),
            b'T' => Some(14),
            b'Z' => Some(15),
            _ => None,
        })
        .collect()
}
fn response(items: Vec<JsMap<String, Json>>, q: &contract::Request) -> Result<String> {
    let rid = q
        .report_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("missing report"))?
        .clone();
    if items.is_empty() {
        return Ok(crate::wire::to_json(&contract::ReportsResponse {
            status: contract::Status::Success,
            message: "No reports found for the given report identifier.",
            request_report_id: rid.clone(),
            queried_gsi_report_id: rid,
            reports: JsMap::new(),
            current_job_id: None,
            available_runs: None,
        })?);
    }
    let mut groups: Vec<(String, Vec<JsMap<String, Json>>)> = Vec::new();
    for item in items {
        let ts = string(&item, "timestamp")?.unwrap_or_default();
        // These are stored strings, not JavaScript Dates. Preserve every
        // fractional digit and the original offset in both response fields.
        ensure!(timestamp_key(&ts).is_some(), "locale timestamp ordering");
        let job = string(&item, "job_id")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                format!(
                    "unknown_job_{}",
                    if ts.is_empty() {
                        "nodate"
                    } else {
                        &ts[..ts.len().min(10)]
                    }
                )
            });
        safe_key(&job)?;
        if let Some((_, g)) = groups.iter_mut().find(|(k, _)| k == &job) {
            g.push(item);
        } else {
            groups.push((job, vec![item]));
        }
    }
    // Object.keys enumerates integer job ids before sorting. Stable sorting
    // keeps that order when the latest timestamps compare equal.
    let ordered_groups = ordered(groups)?;
    let mut groups: Vec<_> = ordered_groups
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let latest = |rows: &Vec<JsMap<String, Json>>| {
        rows.iter()
            .filter_map(|r| match r.get("timestamp") {
                Some(Json::String(s)) => Some(s.as_str()),
                _ => None,
            })
            .max()
            .unwrap_or("")
            .to_owned()
    };
    // The latest item uses JavaScript > (ASCII here), whereas run ordering
    // uses localeCompare. In particular '-' sorts before '+' only in the
    // latter. The admitted alphabet has distinct primary collation weights.
    groups.sort_by_cached_key(|(_, rows)| std::cmp::Reverse(timestamp_key(&latest(rows))));
    let current = q.job_id.clone().unwrap_or_else(|| groups[0].0.clone());
    safe_key(&current)?;
    let mut sections: Vec<(String, contract::Section)> = Vec::new();
    if let Some((_, rows)) = groups.iter().find(|(k, _)| k == &current) {
        for row in rows {
            let key = string(row, "rid_section_model")?.unwrap_or_default();
            let parts: Vec<_> = key.split('#').collect();
            if parts.len() < 2 {
                continue;
            }
            let name = parts[1].to_string();
            safe_key(&name)?;
            let section = contract::Section {
                section: name.clone(),
                model: parts.get(2).unwrap_or(&"unknown").to_string(),
                timestamp: or(row, "timestamp", Json::String(String::new())),
                report_data: or(row, "report_data", Json::String(String::new())),
                errors: row.get("errors").cloned(),
                job_id: row.get("job_id").cloned(),
                metadata: or(row, "metadata", Json::Null),
            };
            if let Some((_, old)) = sections.iter_mut().find(|(k, _)| k == &name) {
                *old = section;
            } else {
                sections.push((name, section));
            }
        }
    }
    let sections = ordered(sections)?;
    if let Some(section) = &q.section {
        safe_key(section)?;
    }
    if let (Some(section), Some(topic)) = (&q.section, &q.topic_key) {
        safe_key(topic)?;
        let data = if let Some(s) = sections.get(section) {
            let encoded = crate::wire::to_json(s)?;
            let Json::Object(o) = serde_json::from_str::<Json>(&encoded)? else {
                unreachable!()
            };
            o.get(topic).filter(|v| truthy(v)).cloned()
        } else {
            None
        };
        return Ok(crate::wire::to_json(&contract::TopicResponse {
            status: if data.is_some() {
                contract::Status::Success
            } else {
                contract::Status::Error
            },
            message: if data.is_some() {
                "Topic report retrieved successfully"
            } else {
                "Topic report not found"
            },
            request_report_id: rid.clone(),
            queried_gsi_report_id: rid,
            section: section.clone(),
            topic_key: topic.clone(),
            data,
        })?);
    }
    let encode = |s: &contract::Section| -> Result<Json> {
        Ok(serde_json::from_str(&crate::wire::to_json(s)?)?)
    };
    let reports = if let Some(filter) = &q.section {
        let selected = sections
            .get(filter)
            .or_else(|| {
                sections
                    .iter()
                    .find(|(k, _)| k.contains(filter))
                    .map(|(_, v)| v)
            })
            .or_else(|| sections.get("undefined"));
        ordered(vec![(
            filter.clone(),
            selected
                .map(encode)
                .transpose()?
                .unwrap_or(Json::Object(JsMap::new())),
        )])?
    } else {
        ordered(
            sections
                .iter()
                .map(|(k, v)| Ok((k.clone(), encode(v)?)))
                .collect::<Result<Vec<_>>>()?,
        )?
    };
    let available_runs = groups
        .iter()
        .map(|(job, rows)| contract::Run {
            job_id: job.clone(),
            latest_timestamp: latest(rows),
            model: or(&rows[0], "model", Json::String("unknown".into())),
            section_count: rows.len(),
            is_current: job == &current,
        })
        .collect();
    Ok(crate::wire::to_json(&contract::ReportsResponse {
        status: contract::Status::Success,
        message: "Reports retrieved successfully",
        request_report_id: rid.clone(),
        queried_gsi_report_id: rid,
        reports,
        current_job_id: Some(current),
        available_runs: Some(available_runs),
    })?)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn row(job: &str, section: &str, ts: &str) -> JsMap<String, Json> {
        decode_object(&json!({"job_id":{"S":job},"rid_section_model":{"S":format!("r#{section}#m")},"timestamp":{"S":ts},"report_data":{"S":"generated"}})).unwrap()
    }
    fn query() -> contract::Request {
        contract::Request {
            report_id: Some("r".into()),
            ..Default::default()
        }
    }
    #[test]
    fn timestamp_strings_keep_microseconds_offsets_and_zero_padding() {
        let older = "2023-11-14T19:51:01.000001+00:00";
        let newer = "2023-11-14T19:51:01.000008+00:00";
        let r = response(
            vec![row("old", "a", older), row("new", "b", newer)],
            &query(),
        )
        .unwrap();
        let body: Value = serde_json::from_str(&r).unwrap();
        assert_eq!(body["reports"]["b"]["timestamp"], newer);
        assert_eq!(body["available_runs"][0]["latest_timestamp"], newer);
        assert_eq!(body["available_runs"][1]["latest_timestamp"], older);
        let mut q = query();
        q.section = Some("b".into());
        q.topic_key = Some("timestamp".into());
        let r = response(vec![row("new", "b", newer)], &q).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&r).unwrap()["data"], newer);
    }
    #[test]
    fn run_order_uses_string_collation_not_instants_or_millisecond_dates() {
        let timestamps = [
            "2023-11-14T19:51:01-01:00",
            "2023-11-14T19:51:01+01:00",
            "2023-11-14T19:51:01.000001+00:00",
            "2023-11-14T19:51:01.000008+00:00",
            "2023-11-14T19:51:01Z",
        ];
        let items = timestamps
            .iter()
            .enumerate()
            .map(|(i, t)| row(&format!("j{i}"), "s", t))
            .collect();
        let body: Value = serde_json::from_str(&response(items, &query()).unwrap()).unwrap();
        let jobs: Vec<_> = body["available_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["job_id"].as_str().unwrap())
            .collect();
        assert_eq!(jobs, ["j4", "j1", "j3", "j2", "j0"]);
        // Within a run the handler chooses the maximum with JavaScript >,
        // which differs from localeCompare for the timezone sign.
        let body: Value = serde_json::from_str(
            &response(
                vec![
                    row("same", "a", timestamps[0]),
                    row("same", "b", timestamps[1]),
                ],
                &query(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(body["available_runs"][0]["latest_timestamp"], timestamps[0]);
    }
    #[test]
    fn latest_job_and_duplicate_sections_keep_legacy_order() {
        let r = response(
            vec![
                row("old", "s", "2023-11-14T00:00:00Z"),
                row("new", "10", "2023-11-15T00:00:00Z"),
                row("new", "2", "2023-11-15T00:00:01Z"),
                row("new", "10", "2023-11-15T00:00:02Z"),
            ],
            &query(),
        )
        .unwrap();
        assert!(r.contains("\"current_job_id\":\"new\""));
        assert!(r.find("\"2\":").unwrap() < r.find("\"10\":").unwrap());
        assert!(r.contains("\"sectionCount\":3"));
        assert!(!r.contains("\"errors\""));
        assert!(r.contains("\"metadata\":null"));
    }
    #[test]
    fn requested_missing_job_and_section_return_empty_object() {
        let mut q = query();
        q.job_id = Some("absent".into());
        q.section = Some("missing".into());
        let r = response(vec![row("old", "s", "2023-11-14T00:00:00Z")], &q).unwrap();
        assert!(r.contains("\"reports\":{\"missing\":{}}"));
        assert!(r.contains("\"isCurrent\":false"));
        q.job_id = Some("__proto__".into());
        assert!(response(vec![row("old", "s", "2023-11-14T00:00:00Z")], &q).is_err());
    }
    #[test]
    fn reports_review_unmatched_section_uses_undefined_section() {
        let mut q = query();
        q.section = Some("zzz".into());
        let rows = || vec![row("j", "undefined", "2023-11-14T00:00:00Z")];
        let body: Value = serde_json::from_str(&response(rows(), &q).unwrap()).unwrap();
        assert_eq!(body["reports"]["zzz"]["report_data"], "generated");
        assert_eq!(body["reports"]["zzz"]["section"], "undefined");
        // Topic lookup uses the section directly, without this fallback.
        q.topic_key = Some("report_data".into());
        let body: Value = serde_json::from_str(&response(rows(), &q).unwrap()).unwrap();
        assert_eq!(body["message"], "Topic report not found");
    }
    #[test]
    fn topic_filter_reads_wrapper_property_and_preserves_null() {
        let mut q = query();
        q.section = Some("s".into());
        q.topic_key = Some("report_data".into());
        let r = response(vec![row("j", "s", "2023-11-14T00:00:00Z")], &q).unwrap();
        assert!(r.contains("\"data\":\"generated\""));
        q.topic_key = Some("metadata".into());
        let r = response(vec![row("j", "s", "2023-11-14T00:00:00Z")], &q).unwrap();
        assert!(r.contains("Topic report not found"));
        assert!(decode(&json!({"N":"9007199254740992"})).is_err());
    }
}
