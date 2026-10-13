//! The embeddings spool and the set digest (migration 000038), shared by the
//! writer and reader behind one flag. Pure bytes: no database type, no network.
//!
//! One spool layout moves embeddings in both directions as a bounded, regular
//! file whose sha256 the manifest or frame pins:
//!   * the Python writer (`graph_embed`, the legacy pipeline) writes it, and the
//!     daemon reads it, chunks it into `pd_embedding_put`, then `pd_embedding_close`;
//!   * the daemon streams a closed set out by binary COPY, rewrites it in this
//!     same layout, and the Python reader (`graph_cluster`) reads it.
//!
//! Rust never reserializes a float as JSON, and Python never parses Postgres
//! binary: the daemon owns the one translation, from `COPY ... (FORMAT binary)`.
//!
//! Layout (little-endian), matching `delphi/polismath/delphi_storage/embedding_spool.py`:
//!   magic      8 bytes  b"PLEMBSP1"
//!   dims       u16      1..=2000
//!   row_count  u32
//!   model_len  u16      1..=200
//!   model      model_len bytes, UTF-8
//!   then row_count rows, each:
//!     tid        i32   >= 0
//!     text_sha   32 bytes
//!     vector     dims * f32
//!
//! The set digest reproduces `pd_embedding_close`'s `content_sha`: sha256 of one
//! line per row in tid order, `tid:hex(text_sha):hex(sha256(array_send(embedding)))`,
//! joined by '\n'. `array_send` of a `real[]` is the field's exact bytes in a
//! binary COPY, so the daemon hashes those bytes directly, never a reconstruction.
use super::sha256_hex;
use anyhow::{Result, ensure};

/// A bounded spool: the biggest production conversation is ~9k comments (~14 MB
/// at 384 dims); 100k comments is ~157 MB. Matches the family-spool run bound.
pub const MAX_SPOOL_BYTES: usize = 268_435_456;
const MAGIC: &[u8; 8] = b"PLEMBSP1";
const MAX_DIMS: usize = 2000;
const MAX_MODEL: usize = 200;
/// `pd_embedding_put` admits at most this many rows per call.
pub const PUT_CHUNK: usize = 4096;
/// The one embedding model migration 000038 seeds (model_id 1, 384 dims). It is
/// the name `graph_embed` writes; the legacy pipeline's bare `all-MiniLM-L6-v2`
/// normalizes to it. One model today; a second arrives as another seeded row.
pub const MODEL_MINILM: &str = "sentence-transformers/all-MiniLM-L6-v2";

/// Postgres float4 element Oid, for reading `array_send` in a binary COPY field.
const FLOAT4_OID: u32 = 700;
/// `PGCOPY\n\377\r\n\0`, the binary COPY file signature.
const COPY_SIGNATURE: &[u8; 11] = b"PGCOPY\n\xff\r\n\0";

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub tid: i32,
    pub text_sha: [u8; 32],
    pub vector: Vec<f32>,
}

/// The rows of one set plus the content digest the set receipt carries.
pub struct Set {
    pub model: String,
    pub dims: u16,
    pub rows: Vec<Row>,
    /// sha256 reproducing `delphi_embedding_sets.content_sha`.
    pub content_sha: String,
}

fn u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

/// Serialize rows to the shared spool layout. Caller guarantees tid order and
/// equal vector lengths; this re-checks the bounds that keep readers safe.
pub fn write_spool(model: &str, dims: u16, rows: &[Row]) -> Result<Vec<u8>> {
    ensure!(
        (1..=MAX_DIMS).contains(&(dims as usize)),
        "embedding_spool_dims"
    );
    ensure!(
        (1..=MAX_MODEL).contains(&model.len()),
        "embedding_spool_model"
    );
    let count = u32::try_from(rows.len())?;
    let mut buf = Vec::with_capacity(16 + model.len() + rows.len() * (36 + dims as usize * 4));
    buf.extend_from_slice(MAGIC);
    u16_le(&mut buf, dims);
    buf.extend_from_slice(&count.to_le_bytes());
    u16_le(&mut buf, model.len() as u16);
    buf.extend_from_slice(model.as_bytes());
    for row in rows {
        ensure!(row.tid >= 0, "embedding_spool_tid");
        ensure!(row.vector.len() == dims as usize, "embedding_spool_width");
        buf.extend_from_slice(&row.tid.to_le_bytes());
        buf.extend_from_slice(&row.text_sha);
        for v in &row.vector {
            ensure!(v.is_finite(), "embedding_spool_value");
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    ensure!(buf.len() <= MAX_SPOOL_BYTES, "embedding_spool_bound");
    Ok(buf)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| anyhow::anyhow!("embedding_spool_truncated"))?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into()?))
    }
}

/// Parse a spool written by `write_spool` (or by the Python side). Refuses any
/// unexpected magic, bound, width or trailing byte.
pub fn read_spool(bytes: &[u8]) -> Result<(String, u16, Vec<Row>)> {
    ensure!(bytes.len() <= MAX_SPOOL_BYTES, "embedding_spool_bound");
    let mut r = Reader { bytes, at: 0 };
    ensure!(r.take(8)? == MAGIC, "embedding_spool_magic");
    let dims = r.u16()?;
    ensure!(
        (1..=MAX_DIMS).contains(&(dims as usize)),
        "embedding_spool_dims"
    );
    let count = r.u32()? as usize;
    let model_len = r.u16()? as usize;
    ensure!(
        (1..=MAX_MODEL).contains(&model_len),
        "embedding_spool_model"
    );
    let model = std::str::from_utf8(r.take(model_len)?)?.to_owned();
    // Cap the pre-allocation by what the remaining bytes could hold, so the
    // header count cannot drive a huge reservation before any row is read. A row
    // is at least `4 (tid) + 32 (text_sha) + dims*4` bytes, and a well-formed
    // spool has `bytes.len() >= 16 + model_len + count*stride`, so this never
    // under-reserves for valid input; a hostile count is bounded to
    // `bytes.len()/stride`, itself bounded by `MAX_SPOOL_BYTES` (checked above).
    let row_stride = 36 + dims as usize * 4;
    let mut rows = Vec::with_capacity(count.min(bytes.len() / row_stride));
    for _ in 0..count {
        let tid = r.i32()?;
        ensure!(tid >= 0, "embedding_spool_tid");
        let text_sha: [u8; 32] = r.take(32)?.try_into()?;
        let mut vector = Vec::with_capacity(dims as usize);
        for _ in 0..dims {
            let v = f32::from_le_bytes(r.take(4)?.try_into()?);
            ensure!(v.is_finite(), "embedding_spool_value");
            vector.push(v);
        }
        rows.push(Row {
            tid,
            text_sha,
            vector,
        });
    }
    ensure!(r.at == bytes.len(), "embedding_spool_trailing");
    Ok((model, dims, rows))
}

struct Copy<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Copy<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| anyhow::anyhow!("embedding_copy_truncated"))?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into()?))
    }
}

/// Decode a `COPY (SELECT tid, text_sha, embedding FROM pd_embedding_rows(...))
/// TO STDOUT (FORMAT binary)` stream into rows, reproducing the set digest from
/// the exact `array_send` bytes of each embedding field. The daemon then rewrites
/// the rows with `write_spool`; the digest check is against the set receipt.
pub fn set_from_copy_binary(bytes: &[u8], model: &str, dims: u16) -> Result<Set> {
    ensure!(bytes.len() <= MAX_SPOOL_BYTES, "embedding_copy_bound");
    let mut c = Copy { bytes, at: 0 };
    ensure!(c.take(11)? == COPY_SIGNATURE, "embedding_copy_signature");
    let _flags = c.i32()?;
    let extension = c.u32()? as usize;
    c.take(extension)?; // header extension, always empty here
    let mut rows = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    loop {
        let fields = c.i16()?;
        if fields == -1 {
            break; // file trailer
        }
        ensure!(fields == 3, "embedding_copy_fields");
        // tid int4
        ensure!(c.i32()? == 4, "embedding_copy_tid_len");
        let tid = c.i32()?;
        ensure!(tid >= 0, "embedding_copy_tid");
        // text_sha bytea, exactly 32 bytes
        ensure!(c.i32()? == 32, "embedding_copy_sha_len");
        let text_sha: [u8; 32] = c.take(32)?.try_into()?;
        // embedding real[], array_send bytes
        let field_len = c.i32()?;
        ensure!(field_len >= 0, "embedding_copy_array_null");
        let raw = c.take(field_len as usize)?;
        let vector = decode_float4_array(raw, dims)?;
        lines.push(format!("{tid}:{}:{}", hex(&text_sha), sha256_hex(raw)));
        rows.push(Row {
            tid,
            text_sha,
            vector,
        });
    }
    ensure!(c.at == bytes.len(), "embedding_copy_trailing");
    Ok(Set {
        model: model.to_owned(),
        dims,
        content_sha: sha256_hex(lines.join("\n").as_bytes()),
        rows,
    })
}

/// Decode one `array_send(real[])` value: a one-dimensional float4 array whose
/// length is exactly `dims`, lower bound 1, no null element.
fn decode_float4_array(raw: &[u8], dims: u16) -> Result<Vec<f32>> {
    let mut c = Copy { bytes: raw, at: 0 };
    ensure!(c.i32()? == 1, "embedding_array_ndims");
    let _has_null = c.i32()?;
    ensure!(c.u32()? == FLOAT4_OID, "embedding_array_elem");
    let length = c.i32()?;
    ensure!(length == i32::from(dims), "embedding_array_dims");
    ensure!(c.i32()? == 1, "embedding_array_lbound");
    let mut vector = Vec::with_capacity(dims as usize);
    for _ in 0..dims {
        ensure!(c.i32()? == 4, "embedding_array_width");
        let v = f32::from_be_bytes(c.take(4)?.try_into()?);
        ensure!(v.is_finite(), "embedding_array_value");
        vector.push(v);
    }
    ensure!(c.at == raw.len(), "embedding_array_trailing");
    Ok(vector)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Row> {
        vec![
            Row {
                tid: 0,
                text_sha: [1u8; 32],
                vector: vec![0.5, -1.0, 2.25],
            },
            Row {
                tid: 7,
                text_sha: [2u8; 32],
                vector: vec![0.0, 1.5, -3.5],
            },
        ]
    }

    #[test]
    fn spool_round_trips_and_pins_layout() -> Result<()> {
        let bytes = write_spool("sentence-transformers/all-MiniLM-L6-v2", 3, &rows())?;
        let (model, dims, back) = read_spool(&bytes)?;
        assert_eq!(model, "sentence-transformers/all-MiniLM-L6-v2");
        assert_eq!(dims, 3);
        assert_eq!(back, rows());
        assert_eq!(&bytes[..8], MAGIC);
        Ok(())
    }

    #[test]
    fn spool_refuses_bad_magic_width_and_trailing() {
        let mut bytes = write_spool("m", 3, &rows()).unwrap_or_default();
        assert!(read_spool(&bytes).is_ok());
        bytes.push(0);
        assert!(read_spool(&bytes).is_err(), "trailing byte");
        let mut bad = write_spool("m", 3, &rows()).unwrap_or_default();
        bad[0] = b'X';
        assert!(read_spool(&bad).is_err(), "magic");
        assert!(
            write_spool(
                "m",
                3,
                &[Row {
                    tid: 0,
                    text_sha: [0; 32],
                    vector: vec![1.0]
                }]
            )
            .is_err(),
            "width"
        );
        assert!(write_spool("", 3, &rows()).is_err(), "empty model");
        assert!(write_spool("m", 0, &rows()).is_err(), "zero dims");
    }

    /// A spool header that declares far more rows than its bytes could hold must
    /// not drive a huge `Vec` reservation before any row is read: the capacity is
    /// capped by the remaining bytes, and the short body is refused as truncated.
    /// Hand-built so the count is hostile (`u32::MAX`) with an empty row body.
    #[test]
    fn read_spool_caps_capacity_from_a_crafted_header() -> Result<()> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&3u16.to_le_bytes()); // dims
        bytes.extend_from_slice(&u32::MAX.to_le_bytes()); // crafted row_count
        bytes.extend_from_slice(&1u16.to_le_bytes()); // model_len
        bytes.extend_from_slice(b"m"); // model, then no rows at all
        let error = read_spool(&bytes).err().map(|e| e.to_string());
        assert_eq!(error, Some("embedding_spool_truncated".into()));
        Ok(())
    }

    /// Build a binary COPY stream of (tid, text_sha, embedding) by hand, then
    /// confirm the parser and the digest. `array_send` is reproduced here.
    fn copy_binary(rows: &[Row]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(COPY_SIGNATURE);
        out.extend_from_slice(&0i32.to_be_bytes()); // flags
        out.extend_from_slice(&0u32.to_be_bytes()); // extension length
        for row in rows {
            out.extend_from_slice(&3i16.to_be_bytes());
            out.extend_from_slice(&4i32.to_be_bytes());
            out.extend_from_slice(&row.tid.to_be_bytes());
            out.extend_from_slice(&32i32.to_be_bytes());
            out.extend_from_slice(&row.text_sha);
            let arr = array_send(&row.vector);
            out.extend_from_slice(&(arr.len() as i32).to_be_bytes());
            out.extend_from_slice(&arr);
        }
        out.extend_from_slice(&(-1i16).to_be_bytes()); // trailer
        out
    }

    fn array_send(vector: &[f32]) -> Vec<u8> {
        let mut a = Vec::new();
        a.extend_from_slice(&1i32.to_be_bytes()); // ndim
        a.extend_from_slice(&0i32.to_be_bytes()); // has_null
        a.extend_from_slice(&FLOAT4_OID.to_be_bytes());
        a.extend_from_slice(&(vector.len() as i32).to_be_bytes());
        a.extend_from_slice(&1i32.to_be_bytes()); // lower bound
        for v in vector {
            a.extend_from_slice(&4i32.to_be_bytes());
            a.extend_from_slice(&v.to_be_bytes());
        }
        a
    }

    #[test]
    fn copy_binary_decodes_rows_and_reproduces_digest() -> Result<()> {
        let rows = rows();
        let set = set_from_copy_binary(&copy_binary(&rows), "m", 3)?;
        assert_eq!(set.rows, rows);
        // The digest matches the documented line format over array_send bytes.
        let lines: Vec<String> = rows
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}",
                    r.tid,
                    hex(&r.text_sha),
                    sha256_hex(&array_send(&r.vector))
                )
            })
            .collect();
        assert_eq!(set.content_sha, sha256_hex(lines.join("\n").as_bytes()));
        Ok(())
    }

    #[test]
    fn spool_bytes_match_the_python_writer() -> Result<()> {
        // The exact same input produces this digest from
        // delphi/polismath/delphi_storage/embedding_spool.py, pinning the shared
        // byte layout across the two languages.
        let rows = vec![
            Row {
                tid: 0,
                text_sha: [1u8; 32],
                vector: vec![0.5, -1.0, 2.25],
            },
            Row {
                tid: 7,
                text_sha: [2u8; 32],
                vector: vec![0.0, 1.5, -3.5],
            },
        ];
        let bytes = write_spool("conformance", 3, &rows)?;
        assert_eq!(bytes.len(), 123);
        assert_eq!(
            sha256_hex(&bytes),
            "acae4b4261be36be2696fa8ddd959467d0f031ed6ede05e9d8b692b9d4fda893"
        );
        Ok(())
    }

    #[test]
    fn copy_binary_refuses_wrong_dims_and_shape() {
        let rows = rows();
        assert!(
            set_from_copy_binary(&copy_binary(&rows), "m", 4).is_err(),
            "dims"
        );
        let mut stream = copy_binary(&rows);
        stream.truncate(stream.len() - 1);
        assert!(set_from_copy_binary(&stream, "m", 3).is_err(), "truncated");
        assert!(set_from_copy_binary(b"not a copy stream at all!!", "m", 3).is_err());
    }
}
