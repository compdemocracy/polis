//! Node-identical gzip and deflate.
//!
//! Node's `zlib` is Chromium's zlib fork. Its deflate makes different match
//! choices from stock zlib, so the same JSON compresses to different bytes. The
//! route serves stored gzip bodies (full mode) and the compression middleware's
//! gzip (subset mode), and the conformance replay compares bytes, so this crate
//! compiles Node's own zlib sources (`vendor/node-zlib`, pinned to Node v22.23.2)
//! and calls them through one small C function.

unsafe extern "C" {
    fn polis_api_deflate_stream(
        input: *const u8,
        length: u32,
        output: *mut u8,
        capacity: *mut u32,
        window_bits: i32,
        sizes: *mut u32,
        pieces: *mut u32,
    ) -> i32;
    fn polis_api_deflate(
        input: *const u8,
        length: u32,
        output: *mut u8,
        capacity: *mut u32,
        window_bits: i32,
    ) -> i32;
}

/// Largest body this process will compress. Bodies are math blobs well under it.
const LIMIT: usize = 256 * 1024 * 1024;

fn deflate(bytes: &[u8], window_bits: i32) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(bytes.len() <= LIMIT, "compression input over limit");
    // deflateBound-style headroom: stored blocks cost 5 bytes per 16 KiB, plus
    // the wrapper. Z_FINISH with too little room is reported, never truncated.
    let mut output = vec![0u8; bytes.len() + bytes.len() / 8 + 1024];
    let mut capacity = u32::try_from(output.len())?;
    let length = u32::try_from(bytes.len())?;
    // SAFETY: `bytes` and `output` are live, disjoint buffers whose lengths fit
    // u32 and are passed exactly; the C function writes at most `capacity`
    // bytes into `output`, reports the count written, and frees its stream.
    let code = unsafe {
        polis_api_deflate(
            bytes.as_ptr(),
            length,
            output.as_mut_ptr(),
            &mut capacity,
            window_bits,
        )
    };
    anyhow::ensure!(code == 0, "zlib status {code}");
    output.truncate(capacity as usize);
    Ok(output)
}

/// `zlib.gzip(buf)` / `zlib.createGzip()` output.
pub fn gzip(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    deflate(bytes, 15 + 16)
}

/// The HTTP chunks the compression middleware writes for `body`: the pieces
/// a Node zlib stream emits for `stream.end(body)` (see `zlib_shim.c`), which
/// are the wrapper header alone, then the rest in 16 KiB output buffers.
pub fn node_stream(body: &[u8], gzip: bool) -> anyhow::Result<Vec<Vec<u8>>> {
    anyhow::ensure!(body.len() <= LIMIT, "compression input over limit");
    let capacity_bytes = body.len() + body.len() / 8 + 64 * 1024;
    let mut output = vec![0u8; capacity_bytes];
    let mut capacity = u32::try_from(output.len())?;
    let mut sizes = vec![0u32; capacity_bytes / 1024 + 16];
    let mut pieces = u32::try_from(sizes.len())?;
    let length = u32::try_from(body.len())?;
    // SAFETY: as in `deflate`; additionally `sizes` holds `pieces` u32 slots
    // and the C function writes at most that many, reporting the count used.
    let code = unsafe {
        polis_api_deflate_stream(
            body.as_ptr(),
            length,
            output.as_mut_ptr(),
            &mut capacity,
            if gzip { 15 + 16 } else { 15 },
            sizes.as_mut_ptr(),
            &mut pieces,
        )
    };
    anyhow::ensure!(code == 0, "zlib status {code}");
    let mut chunks = Vec::with_capacity(pieces as usize);
    let mut at = 0usize;
    for size in &sizes[..pieces as usize] {
        let end = at + *size as usize;
        chunks.push(output[at..end].to_vec());
        at = end;
    }
    anyhow::ensure!(at == capacity as usize, "zlib piece accounting");
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_header_matches_node() {
        let out = gzip(b"{}").unwrap();
        // magic, deflate, no flags, mtime 0, xfl 0, OS 3 (Unix): Node's header.
        assert_eq!(&out[..10], &[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
    }

    /// Bytes Node v22.23.2 produced for `zlib.gzipSync('{"a":[1,2,3],"b":"x"}')`.
    #[test]
    fn small_body_matches_node_bytes() {
        let out = gzip(br#"{"a":[1,2,3],"b":"x"}"#).unwrap();
        assert_eq!(
            out,
            [
                31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 171, 86, 74, 84, 178, 138, 54, 212, 49, 210, 49,
                142, 213, 81, 74, 82, 178, 82, 170, 80, 170, 5, 0, 14, 105, 147, 52, 21, 0, 0, 0
            ]
        );
    }

    fn sha256(bytes: &[u8]) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Piece sizes and bytes Node v22.23.2 produced for `createGzip().end(x)`
    /// and `createDeflate().end(x)` on the same inputs.
    #[test]
    fn stream_pieces_match_node() {
        let sizes = |b: &[u8], gzip: bool| -> Vec<usize> {
            node_stream(b, gzip).unwrap().iter().map(Vec::len).collect()
        };
        assert_eq!(sizes(br#"{"a":[1,2,3],"b":"x"}"#, true), [10, 31]);
        assert_eq!(sizes(b"{}", false), [2, 8]);
        // `res.end()` with no body: a single finish, header and trailer together.
        assert_eq!(sizes(b"", true), [20]);

        let mut x: u32 = 2_463_534_242;
        let noise: Vec<u8> = (0..70_000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x & 255) as u8
            })
            .collect();
        assert_eq!(sizes(&noise, true), [16384, 16384, 16384, 16384, 26, 4481]);
        assert_eq!(
            sha256(&node_stream(&noise, true).unwrap().concat()),
            "53f0a46e1706bfd8b7b435d348bd10eba3beed4481f58f6bf7a81c6949c34215"
        );
        assert_eq!(
            node_stream(&noise, true).unwrap().concat(),
            gzip(&noise).unwrap()
        );

        let rows: Vec<String> = (0..30_000u64)
            .map(|i| format!("{{\"i\":{i},\"v\":{}}}", (i * 7919) % 1000))
            .collect();
        let big = format!("[{}]", rows.join(","));
        assert_eq!(big.len(), 585_591);
        assert_eq!(
            sizes(big.as_bytes(), true),
            [16384, 16384, 16384, 16384, 2165, 14219, 2759]
        );
        assert_eq!(
            sha256(&gzip(big.as_bytes()).unwrap()),
            "e42374f589be6fda0e58022b16174b6b7e4b5b3a25f6ecb7ba325337a948faa5"
        );
    }
}
