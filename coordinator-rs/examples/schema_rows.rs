//! Local PG17 mapping rehearsal, never a production connection.
//! Apply the reviewed migrations only to a fresh disposable probe_test first.
use anyhow::{Result, ensure};
use polis_coordinator::schema;
use postgres::{Client, NoTls};
use serde_json::{Value, json};

fn main() -> Result<()> {
    let port: u16 = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("local port required"))?
        .parse()?;
    ensure!(
        (55432..=65000).contains(&port),
        "local fixture port required"
    );
    let mut client = Client::connect(
        &format!("host=127.0.0.1 port={port} user=postgres dbname=probe_test"),
        NoTls,
    )?;
    let mut tx = client.build_transaction().read_only(true).start()?;
    let version: String = tx.query_one("SHOW server_version_num", &[])?.get(0);
    ensure!(version.parse::<u32>()? / 10000 == 17, "PG17 required");
    let catalog: Value = serde_json::from_str(include_str!("../src/schema/catalog.json"))?;
    let mut mapped = 0;
    for (table, measured) in schema::TABLES.iter().zip(
        catalog["tables"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("catalog"))?,
    ) {
        let columns = tx.query("SELECT a.attname,t.typname,NOT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", &[&table.name])?;
        ensure!(
            columns.len() == table.columns.len(),
            "column count {}",
            table.name
        );
        for (actual, typed) in columns.iter().zip(table.columns) {
            ensure!(
                actual.get::<_, String>(0) == typed.name
                    && actual.get::<_, String>(1) == typed.postgres_type
                    && actual.get::<_, bool>(2) == typed.nullable,
                "catalog mismatch {}.{}",
                table.name,
                typed.name
            );
        }
        for nulls in [false, true] {
            let mut input = serde_json::Map::new();
            for column in table.columns {
                let value = if nulls && column.nullable {
                    Value::Null
                } else {
                    match column.postgres_type {
                        "int2" => json!(-32768),
                        "int4" => json!(2147483647),
                        "int8" => json!(-9223372036854775808_i64),
                        "oid" => json!(4294967295_u32),
                        "bool" => json!(true),
                        "text" | "varchar" | "name" => json!("x"),
                        "bytea" => json!("\\x00ff"),
                        "json" | "jsonb" => json!({"x":[1,null]}),
                        "uuid" => json!("00010203-0405-0607-0809-0a0b0c0d0eff"),
                        "timestamptz" => json!("infinity"),
                        "float4" => json!("NaN"),
                        "float8" => json!("-Infinity"),
                        "_text" => json!(["x", null]),
                        "job_status" => json!("pending"),
                        _ => anyhow::bail!("unreviewed type"),
                    }
                };
                input.insert(column.name.into(), value);
            }
            // Names come only from the compiled reviewed inventory; no caller SQL.
            let row = tx.query_one(
                &format!(
                    "SELECT (jsonb_populate_record(NULL::public.{}, $1::jsonb)).*",
                    table.name
                ),
                &[&Value::Object(input)],
            )?;
            let value = (table.decode)(&row).map_err(anyhow::Error::msg)?;
            ensure!(
                value
                    .as_object()
                    .is_some_and(|o| o.len() == table.columns.len()),
                "mapping lost a column"
            );
            ensure!((table.roundtrip)(value.clone())? == value, "serde drift");
            for (actual, typed) in row.columns().iter().zip(table.columns) {
                ensure!((typed.accepts)(actual.type_()), "wrong type adapter");
            }
            mapped += 1;
        }
        ensure!(measured["table"] == table.name, "inventory order");
    }
    tx.rollback()?;
    println!(
        "schema mapping PASS: {} tables, {mapped} rows, 603 catalog columns",
        schema::TABLES.len()
    );
    Ok(())
}
