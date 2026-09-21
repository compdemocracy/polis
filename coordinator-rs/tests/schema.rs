use anyhow::{Result, ensure};
use polis_coordinator::schema::{self, *};
use postgres::types::{FromSql, Kind, Type};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};

fn catalog() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../src/schema/catalog.json"
    ))?)
}
fn pg_type(name: &str) -> Result<Type> {
    Ok(match name {
        "int2" => Type::INT2,
        "int4" => Type::INT4,
        "int8" => Type::INT8,
        "oid" => Type::OID,
        "bool" => Type::BOOL,
        "text" => Type::TEXT,
        "varchar" => Type::VARCHAR,
        "name" => Type::NAME,
        "uuid" => Type::UUID,
        "float4" => Type::FLOAT4,
        "float8" => Type::FLOAT8,
        "bytea" => Type::BYTEA,
        "json" => Type::JSON,
        "jsonb" => Type::JSONB,
        "timestamptz" => Type::TIMESTAMPTZ,
        "_text" => Type::TEXT_ARRAY,
        "job_status" => Type::new(
            "job_status".into(),
            99999,
            Kind::Enum(vec![
                "pending".into(),
                "processing".into(),
                "completed".into(),
                "failed".into(),
            ]),
            "public".into(),
        ),
        _ => anyhow::bail!("unrepresented PostgreSQL type {name}"),
    })
}
fn sample(kind: &str) -> Result<Value> {
    Ok(match kind {
        "int2" => json!(i16::MIN),
        "int4" => json!(i32::MAX),
        "int8" => json!(i64::MIN),
        "oid" => json!(u32::MAX),
        "bool" => json!(true),
        "text" | "varchar" | "name" => json!("public fixture"),
        "uuid" => json!([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255]),
        "float4" => json!(f32::NAN.to_bits()),
        "float8" => json!(f64::NEG_INFINITY.to_bits()),
        "bytea" => json!([0, 255]),
        "json" | "jsonb" => json!({"text":"{\"nested\":[1,null,\"x\"]}"}),
        "timestamptz" => json!(i64::MAX),
        "_text" => json!(["x", null, ""]),
        "job_status" => json!("pending"),
        _ => anyhow::bail!("missing sample for {kind}"),
    })
}

#[test]
fn schema_migration_inventory_requires_fresh_census() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow::anyhow!("root"))?;
    let expected = catalog()?;
    let mut names = BTreeSet::new();
    for file in expected["migrations"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("migrations"))?
    {
        let name = file["path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("path"))?;
        let bytes = fs::read(root.join(name))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            file["sha256"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("hash"))?,
            "migration changed: regenerate the isolated PG census and review row types: {name}"
        );
        names.insert(name.to_owned());
    }
    let actual = fs::read_dir(root.join("server/postgres/migrations"))?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|p| {
            p.extension().is_some_and(|s| s == "sql")
                && p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('0'))
        })
        .map(|p| {
            p.strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(anyhow::Error::from)
        })
        .collect::<Result<BTreeSet<_>>>()?;
    assert_eq!(
        actual, names,
        "added/removed migration requires a fresh schema census"
    );
    Ok(())
}

#[test]
fn schema_all_columns_types_nullability_and_serde() -> Result<()> {
    let data = catalog()?;
    let tables = data["tables"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("tables"))?;
    assert_eq!(tables.len(), schema::TABLES.len());
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow::anyhow!("root"))?;
    let mut total = 0;
    for (measured, row) in tables.iter().zip(schema::TABLES) {
        assert_eq!(measured["table"], row.name);
        let columns = measured["columns"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("columns"))?;
        assert_eq!(columns.len(), row.columns.len());
        let mut value = serde_json::Map::new();
        for (declared, typed) in columns.iter().zip(row.columns) {
            assert_eq!(declared["name"], typed.name);
            assert_eq!(declared["udt"], typed.postgres_type);
            assert_eq!(declared["nullable"] == "YES", typed.nullable);
            assert_eq!(declared["introduced"], typed.source);
            assert!(
                (typed.accepts)(&pg_type(typed.postgres_type)?),
                "incompatible {}.{}",
                row.name,
                typed.name
            );
            let (file, line) = typed
                .source
                .rsplit_once(':')
                .ok_or_else(|| anyhow::anyhow!("source pointer"))?;
            ensure!(
                fs::read_to_string(root.join(file))?
                    .lines()
                    .nth(line.parse::<usize>()? - 1)
                    .is_some(),
                "bad source pointer"
            );
            value.insert(typed.name.into(), sample(typed.postgres_type)?);
            total += 1;
        }
        let original = Value::Object(value.clone());
        assert_eq!((row.roundtrip)(original.clone())?, original);
        for column in row.columns {
            value.insert(column.name.into(), Value::Null);
            let result = (row.roundtrip)(Value::Object(value.clone()));
            if column.nullable {
                assert!(result.is_ok(), "nullable {}.{}", row.name, column.name);
            } else {
                assert!(result.is_err(), "nonnullable {}.{}", row.name, column.name);
            }
            value.insert(column.name.into(), sample(column.postgres_type)?);
        }
        value.insert("unreviewed_column".into(), json!(1));
        assert!((row.roundtrip)(Value::Object(value)).is_err());
    }
    assert_eq!(total, 603);
    Ok(())
}

#[test]
fn schema_lossless_scalar_binary_controls() -> Result<()> {
    for v in [i64::MIN, -1, 0, i64::MAX] {
        let t = PgTimestamp::from_sql(&Type::TIMESTAMPTZ, &v.to_be_bytes())
            .map_err(anyhow::Error::msg)?;
        assert_eq!(t.0, v);
        assert_eq!(
            serde_json::from_str::<PgTimestamp>(&serde_json::to_string(&t)?)?,
            t
        );
    }
    for bits in [
        0_u64,
        1_u64 << 63,
        f64::INFINITY.to_bits(),
        0x7ff8000000000123,
    ] {
        let f =
            PgFloat8::from_sql(&Type::FLOAT8, &bits.to_be_bytes()).map_err(anyhow::Error::msg)?;
        assert_eq!(f.0, bits);
        assert_eq!(
            serde_json::from_str::<PgFloat8>(&serde_json::to_string(&f)?)?,
            f
        );
    }
    assert!(PgUuid::from_sql(&Type::UUID, &[0; 15]).is_err());
    assert!(PgTimestamp::from_sql(&Type::TIMESTAMPTZ, &[0; 7]).is_err());
    assert!(JobStatus::from_sql(&pg_type("job_status")?, b"unreviewed").is_err());
    assert!(!PgTimestamp::accepts(&Type::INT8));
    let raw = b"123456789012345678901234567890.1234567890123456789";
    let decoded = PgJson::from_sql(&Type::JSON, raw).map_err(anyhow::Error::msg)?;
    assert_eq!(decoded.text.as_bytes(), raw);
    let json_null = Some(PgJson {
        text: "null".into(),
    });
    assert_eq!(
        serde_json::from_value::<Option<PgJson>>(serde_json::to_value(&json_null)?)?,
        json_null
    );
    assert_ne!(
        serde_json::to_value(json_null)?,
        serde_json::to_value(None::<PgJson>)?
    );
    assert!(PgJson::from_sql(&Type::JSONB, b"\x02null").is_err());
    Ok(())
}

#[test]
fn schema_job_contracts_preserve_legacy_shapes() -> Result<()> {
    use schema::jobs::*;
    let item = json!({"job_type":"FULL_PIPELINE","job_id":"public-job","conversation_id":"1","report_id":null,"job_config":"{\"include_moderation\":true}","future_field":{"x":1}});
    let decoded: DelphiJob = serde_json::from_value(item.clone())?;
    assert_eq!(serde_json::to_value(decoded)?, item);
    assert!(serde_json::from_value::<DelphiJob>(json!({"job_type":"UNREVIEWED"})).is_err());
    let export = json!({"email":"fixture@example.invalid","zid":1,"at-date":1,"format":"csv"});
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<GenerateExportDataJob>(
            export.clone()
        )?)?,
        export
    );
    let import = json!({"jobId":1,"zid":1,"s3Key":"public/input.csv"});
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<ImportMappingJob>(import.clone())?)?,
        import
    );
    fn check<T: serde::Serialize + serde::de::DeserializeOwned>(value: Value) -> Result<()> {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone())?)?,
            value
        );
        Ok(())
    }
    check::<CreateNarrativeBatchJob>(
        json!({"job_id":"public-job","conversation_id":"1","report_id":"public-report","job_config":"{}","environment":"{}"}),
    )?;
    check::<AwaitingNarrativeBatchJob>(
        json!({"job_id":"public-check","batch_job_id":"public-root","batch_id":"public-batch","conversation_id":"1","report_id":"public-report"}),
    )?;
    check::<NoopJob>(
        json!({"env":"test","zid":1,"productKey":"public","actorScope":"public","requestKey":"public","priority":1,"maxAttempts":3}),
    )?;
    check::<UpdateMathJob>(json!({"zid":1,"math_update_type":{"legacy":true}}))?;
    check::<GenerateReportDataJob>(json!({"rid":"public-report","zid":1,"math_tick":null}))?;
    check::<NotificationJob>(json!({"zid":1,"modified":1}))?;
    Ok(())
}

#[test]
fn schema_dynamo_decimal_null_and_extension_controls() -> Result<()> {
    use schema::dynamo::*;
    let item = json!({"job_id":"public-job","status":{"S":"PENDING"},"priority":{"N":"123456789012345678901234567890.12345678"},"job_results":{"NULL":true},"unreviewed":{"M":{"x":{"B":[0,255]}}}});
    let decoded: DelphiJobQueueItem = serde_json::from_value(item.clone())?;
    assert_eq!(serde_json::to_value(decoded)?, item);
    assert_ne!(
        serde_json::from_value::<DelphiJobQueueItem>(json!({"job_id":"public-job"}))?.job_results,
        serde_json::from_value::<DelphiJobQueueItem>(
            json!({"job_id":"public-job","job_results":{"NULL":true}})
        )?
        .job_results
    );
    assert!(
        serde_json::from_value::<DelphiJobQueueItem>(json!({"status":{"S":"PENDING"}})).is_err()
    );
    Ok(())
}

#[test]
fn schema_every_dynamo_item_roundtrips() -> Result<()> {
    use schema::dynamo::*;
    fn check<T: serde::Serialize + serde::de::DeserializeOwned>(value: Value) -> Result<()> {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone())?)?,
            value
        );
        Ok(())
    }
    check::<DelphiPCAConversationConfigItem>(
        json!({"zid": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiPCAResultsItem>(
        json!({"zid": "public", "math_tick": "1", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiKMeansClustersItem>(
        json!({"zid_tick": "public", "group_id": "1", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentRoutingItem>(
        json!({"zid_tick": "public", "comment_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiRepresentativeCommentsItem>(
        json!({"zid_tick_gid": "public", "comment_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiPCAParticipantProjectionsItem>(
        json!({"zid_tick": "public", "participant_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiJobQueueItem>(
        json!({"job_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiJobActiveGuardItem>(
        json!({"guard_key": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentExtremityItem>(
        json!({"conversation_id": "public", "comment_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiNarrativeReportsItem>(
        json!({"rid_section_model": "public", "timestamp": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiUMAPConversationConfigItem>(
        json!({"conversation_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentEmbeddingsItem>(
        json!({"conversation_id": "public", "comment_id": "1", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentHierarchicalClusterAssignmentsItem>(
        json!({"conversation_id": "public", "comment_id": "1", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentClustersStructureKeywordsItem>(
        json!({"conversation_id": "public", "cluster_key": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiUMAPGraphItem>(
        json!({"conversation_id": "public", "edge_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentClustersFeaturesItem>(
        json!({"conversation_id": "public", "cluster_key": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCommentClustersLLMTopicNamesItem>(
        json!({"conversation_id": "public", "topic_key": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiTopicAgendaSelectionsItem>(
        json!({"conversation_id": "public", "participant_id": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<DelphiCollectiveStatementItem>(
        json!({"zid_topic_jobid": "public", "extra": {"N": "1.0000000000000000000000000000000000001"}}),
    )?;
    check::<ReportNarrativeStoreItem>(
        json!({"rid_section_model": "public", "timestamp": "public"}),
    )?;
    check::<LegacyBatchJobItem>(json!({"batch_id": "public"}))?;
    check::<TopicModerationStatusItem>(
        json!({"conversation_id": "public", "topic_key": "public"}),
    )?;
    check::<LegacyCommentClustersItem>(json!({}))?;
    Ok(())
}
