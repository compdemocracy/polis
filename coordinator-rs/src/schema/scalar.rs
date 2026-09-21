//! Lossless serde representations for types without enabled postgres adapters.
use postgres::types::{FromSql, Kind, Type};
use serde::{Deserialize, Serialize};
use std::{error::Error, io};
type DecodeError = Box<dyn Error + Sync + Send>;

/// PostgreSQL microseconds relative to 2000-01-01; i64 extrema retain infinities.
/// Source: timestamptz columns in migration 000021, including the -infinity default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PgTimestamp(pub i64);
impl<'a> FromSql<'a> for PgTimestamp {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        Ok(Self(i64::from_sql(&Type::INT8, raw)?))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::TIMESTAMPTZ
    }
}

/// Exact 16-byte UUID; serde uses an array, never a lossy number.
/// Source: server/postgres/migrations/000009_add_uuid_to_zinvites.sql:2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PgUuid(pub [u8; 16]);
impl<'a> FromSql<'a> for PgUuid {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        Ok(Self(raw.try_into()?))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::UUID
    }
}

/// IEEE-754 bits preserve signed zero, nonfinite values and NaN payloads in JSON.
/// These storage wrappers are not the future computation API's numeric encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PgFloat4(pub u32);
impl<'a> FromSql<'a> for PgFloat4 {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        Ok(Self(f32::from_sql(&Type::FLOAT4, raw)?.to_bits()))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::FLOAT4
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PgFloat8(pub u64);
impl<'a> FromSql<'a> for PgFloat8 {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        Ok(Self(f64::from_sql(&Type::FLOAT8, raw)?.to_bits()))
    }
    fn accepts(ty: &Type) -> bool {
        *ty == Type::FLOAT8
    }
}

/// server/postgres/migrations/000017_create_byod_job_table.sql:1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Processing,
    Completed,
    Failed,
}
impl<'a> FromSql<'a> for JobStatus {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        match raw {
            b"pending" => Ok(Self::Pending),
            b"processing" => Ok(Self::Processing),
            b"completed" => Ok(Self::Completed),
            b"failed" => Ok(Self::Failed),
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, "UNKNOWN_JOB_STATUS").into()),
        }
    }
    fn accepts(ty: &Type) -> bool {
        ty.schema() == "public"
            && ty.name() == "job_status"
            && matches!(ty.kind(), Kind::Enum(labels) if labels == &["pending", "processing", "completed", "failed"])
    }
}

/// PostgreSQL JSON text retained exactly, including large decimal tokens.
/// A tagged wrapper distinguishes JSON null (text="null") from SQL NULL.
/// JSONB text is already server-normalized; this does not claim original-byte custody.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PgJson {
    pub text: String,
}
impl<'a> FromSql<'a> for PgJson {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, DecodeError> {
        let body = if *ty == Type::JSONB {
            match raw.split_first() {
                Some((1, body)) => body,
                _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "JSONB_VERSION").into()),
            }
        } else {
            raw
        };
        Ok(Self {
            text: String::from_sql(&Type::TEXT, body)?,
        })
    }
    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::JSON | Type::JSONB)
    }
}
