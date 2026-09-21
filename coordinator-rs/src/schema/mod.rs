//! Descriptive storage types only. No runtime caller adopts these rows.
//!
//! Source inventory: server/postgres/migrations/000000_initial.sql through
//! 000021_create_polis_coordinator.sql. The adjacent catalog was measured on
//! PostgreSQL 17.11; tests bind it to every migration's bytes. A changed or new
//! migration requires a fresh isolated census and review, even for a change
//! that does not alter columns. This intentionally avoids parsing PL/pgSQL DDL.
//! Domain CHECK constraints and authorization remain in their existing owners.
use postgres::{
    Row,
    types::{FromSql, Type},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::error::Error;

pub mod dynamo;
pub mod jobs;
mod scalar;
pub use scalar::*;

#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub name: &'static str,
    pub postgres_type: &'static str,
    pub nullable: bool,
    pub source: &'static str,
    pub accepts: fn(&Type) -> bool,
}

pub trait StorageRow: Sized + Serialize + DeserializeOwned {
    const TABLE: &'static str;
    const COLUMNS: &'static [Column];
    fn from_row(row: &Row) -> Result<Self, postgres::Error>;
}

pub struct Table {
    pub name: &'static str,
    pub columns: &'static [Column],
    pub roundtrip: fn(Value) -> Result<Value, serde_json::Error>,
    pub decode: fn(&Row) -> Result<Value, Box<dyn Error + Sync + Send>>,
}
fn roundtrip<T: StorageRow>(value: Value) -> Result<Value, serde_json::Error> {
    serde_json::to_value(serde_json::from_value::<T>(value)?)
}
fn decode<T: StorageRow>(row: &Row) -> Result<Value, Box<dyn Error + Sync + Send>> {
    Ok(serde_json::to_value(T::from_row(row)?)?)
}

macro_rules! row {
    ($row:ident, $table:literal, $source:literal; $( $field:ident: $ty:ty => ($name:literal, $pg:literal, $nullable:literal, $field_source:literal), )*) => {
        #[doc = $source]
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $row {
            $( #[doc = $field_source] pub $field: $ty, )*
        }
        impl StorageRow for $row {
            const TABLE: &'static str = $table;
            const COLUMNS: &'static [Column] = &[
                $( Column {name: $name, postgres_type: $pg, nullable: $nullable, source: $field_source, accepts: <$ty as FromSql>::accepts}, )*
            ];
            fn from_row(row: &Row) -> Result<Self, postgres::Error> {
                Ok(Self { $( $field: row.try_get($name)?, )* })
            }
        }
    }
}
mod rows;
pub use rows::*;
