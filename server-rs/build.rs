fn main() {
    let dir = "vendor/node-zlib";
    println!("cargo:rerun-if-changed={dir}");
    println!("cargo:rerun-if-changed=src/gzip.c");
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
        .file("src/gzip.c")
        .warnings(false)
        .compile("p032_node_zlib");
}
