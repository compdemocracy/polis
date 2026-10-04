//! Compiles the zlib that Node v22.23.2 ships (Chromium's fork, vendored under
//! `vendor/node-zlib`) so gzip output is byte-identical to Node's. Stock zlib
//! produces different bytes for the same input (see README, "Why vendored zlib").
fn main() {
    let dir = "vendor/node-zlib";
    println!("cargo:rerun-if-changed={dir}");
    println!("cargo:rerun-if-changed=src/zlib_shim.c");
    cc::Build::new()
        .include(dir)
        .define("CPU_NO_SIMD", None)
        .files(
            [
                "adler32.c",
                "crc32.c",
                "deflate.c",
                "trees.c",
                "zutil.c",
                "cpu_features.c",
            ]
            .map(|name| format!("{dir}/{name}")),
        )
        .file("src/zlib_shim.c")
        .warnings(false)
        .compile("polis_api_node_zlib");
}
