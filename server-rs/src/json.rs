//! Compact JSON.stringify-compatible finite number spelling, independent of key order.
use serde::Serialize;
use std::io::{self, Write};
struct JsFormatter;
impl serde_json::ser::Formatter for JsFormatter {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(ryu_js::Buffer::new().format(value).as_bytes())
    }
    fn write_f32<W: ?Sized + Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }
    fn write_u64<W: ?Sized + Write>(&mut self, writer: &mut W, value: u64) -> io::Result<()> {
        if value > 9_007_199_254_740_991 {
            return Err(io::Error::other("integer exceeds JS safe range"));
        }
        writer.write_all(value.to_string().as_bytes())
    }
}
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = Vec::new();
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut bytes,
        JsFormatter,
    ))?;
    Ok(bytes)
}
unsafe extern "C" {
    fn p032_gzip(input: *const u8, length: u32, output: *mut u8, capacity: *mut u32) -> i32;
}
pub fn gzip(bytes: &[u8]) -> io::Result<Vec<u8>> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(io::Error::other("gzip input limit"));
    }
    let mut output = vec![0; bytes.len() + bytes.len() / 8 + 1024];
    let mut capacity = output.len() as u32;
    // SAFETY: input and output are disjoint live buffers. All lengths fit u32;
    // the C adapter bounds zlib writes by capacity and always frees its stream.
    let code = unsafe {
        p032_gzip(
            bytes.as_ptr(),
            bytes.len() as u32,
            output.as_mut_ptr(),
            &mut capacity,
        )
    };
    if code != 0 {
        return Err(io::Error::other(format!("gzip status {code}")));
    }
    output.truncate(capacity as usize);
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn js_numbers_and_escaping() {
        assert_eq!(
            encode(&[1.0, -0.0, 1e21, 1e-7, 1e-6]).unwrap(),
            b"[1,0,1e+21,1e-7,0.000001]"
        );
        assert_eq!(
            encode(&"\"\\\n\u{000f}é\u{2028}").unwrap(),
            "\"\\\"\\\\\\n\\u000fé\u{2028}\"".as_bytes()
        );
        assert!(encode(&9_007_199_254_740_992u64).is_err());
    }
}
#[cfg(test)]
mod gzip_tests {
    use super::*;
    #[test]
    fn stored_gzip_golden_buffers() {
        for (json, compressed) in [
            (
                include_bytes!("../contract/zero-approved.json").as_slice(),
                include_bytes!("../contract/zero-approved.json.gz").as_slice(),
            ),
            (
                include_bytes!("../contract/populated.json").as_slice(),
                include_bytes!("../contract/populated.json.gz").as_slice(),
            ),
            (
                include_bytes!("../contract/keys-gzip.json").as_slice(),
                include_bytes!("../contract/keys-gzip.json.gz").as_slice(),
            ),
        ] {
            assert_eq!(gzip(json).unwrap(), compressed);
        }
    }
    #[test]
    fn typed_populated_roundtrip() {
        let raw = include_bytes!("../contract/populated.json");
        let data: crate::model::MathData = serde_json::from_slice(raw).unwrap();
        assert_eq!(encode(&data).unwrap(), raw);
    }
}
#[cfg(test)]
mod model_tests {
    use super::*;
    use crate::model::{MathData, Subset};
    #[test]
    fn subset_order_duplicates_unknown_and_prototypes() {
        let data: MathData =
            serde_json::from_slice(include_bytes!("../contract/populated.json")).unwrap();
        let keys = [
            "n-cmts",
            "tids",
            "n-cmts",
            "unknown",
            "__proto__",
            "constructor",
            "toString",
        ]
        .map(String::from);
        assert_eq!(
            encode(&Subset {
                data: &data,
                keys: &keys
            })
            .unwrap(),
            br#"{"n-cmts":6,"tids":[0,1,2,3,4,5]}"#
        );
        assert_eq!(
            encode(&Subset {
                data: &data,
                keys: &[String::new()]
            })
            .unwrap(),
            b"{}"
        );
    }
    #[test]
    fn typed_absence_is_not_null_or_unknown() {
        let raw = std::str::from_utf8(include_bytes!("../contract/zero-approved.json")).unwrap();
        let empty: MathData = serde_json::from_str(raw).unwrap();
        assert!(empty.proj.is_none());
        let null_optional = raw.replacen('{', "{\"proj\":null,", 1);
        assert!(serde_json::from_str::<MathData>(&null_optional).is_err());
        let unknown = raw.replacen('{', "{\"unreviewed\":1,", 1);
        assert!(serde_json::from_str::<MathData>(&unknown).is_err());
        let wrong_count = raw.replace("\"n-cmts\":0", "\"n-cmts\":null");
        assert!(serde_json::from_str::<MathData>(&wrong_count).is_err());
    }
}
