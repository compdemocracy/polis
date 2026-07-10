/**
 * Unit tests for the Delphi Storage V2 TypeScript codec + keys.
 *
 * These pin the same cross-language wire format as delphi's
 * tests/test_delphi_storage_codec.py and tests/test_delphi_storage_keys.py —
 * canonical JSON, little-endian packed float64, zstd envelopes, claim-order
 * strings, canonical timestamps. The normative spec lives in
 * delphi/delphi_storage/conformance/README.md.
 */
import * as crypto from "crypto";

import {
  F64,
  INLINE_LIMIT,
  canonicalJsonDumps,
  compress,
  decodePayload,
  decompress,
  encodePayload,
  packF64,
  unpackF64,
} from "../../src/storage/delphi/codec";
import {
  CHUNK_MARKER,
  GENERIC_ENTITIES,
  artifactKey,
  claimOrder,
  logSk,
  scopeForRid,
  scopeForZid,
  scopesForRun,
  tsAddSeconds,
  validateTs,
} from "../../src/storage/delphi/keys";
import { normalizeRunManifest } from "../../src/storage/delphi/interface";

const T0 = "2026-07-06T10:00:00.000Z";
const T1 = "2026-07-06T10:00:01.000Z";

describe("canonicalJsonDumps", () => {
  it("sorts keys compactly", () => {
    expect(canonicalJsonDumps({ b: 1, a: [1.5, "x"] })).toBe('{"a":[1.5,"x"],"b":1}');
  });

  it("does not escape unicode", () => {
    expect(canonicalJsonDumps({ k: "café 😀" })).toBe('{"k":"café 😀"}');
  });

  it("sorts nested keys", () => {
    expect(canonicalJsonDumps({ o: { b: 1, a: 2 } })).toBe('{"o":{"a":2,"b":1}}');
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJsonDumps({ x: NaN })).toThrow();
    expect(() => canonicalJsonDumps({ x: Infinity })).toThrow();
  });
});

describe("packF64", () => {
  it("round-trips", () => {
    const values = [0.0, 0.5, -1.25, 1e300, 5e-324, Math.PI];
    expect(unpackF64(packF64(values))).toEqual(values);
  });

  it("is little-endian IEEE-754", () => {
    expect(packF64([0.5]).toString("hex")).toBe("000000000000e03f");
  });

  it("handles empty arrays", () => {
    expect(packF64([]).length).toBe(0);
    expect(unpackF64(Buffer.alloc(0))).toEqual([]);
  });
});

describe("zstd", () => {
  it("round-trips binary data", () => {
    const raw = Buffer.concat(
      Array.from({ length: 10 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    );
    const comp = compress(raw);
    expect(decompress(comp).equals(raw)).toBe(true);
  });
});

describe("payload envelopes", () => {
  it("keeps small JSON inline", () => {
    const value = { pca: [0.1, 0.2], n: 3 };
    const enc = encodePayload(value);
    expect(enc.meta.enc).toBe("json");
    expect(enc.blob).toBeNull();
    expect(decodePayload(enc.meta, enc.blob)).toEqual(value);
  });

  it("compresses large JSON with sha256 of the uncompressed bytes", () => {
    const value = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, v: i * 0.5 })) };
    const raw = Buffer.from(canonicalJsonDumps(value), "utf8");
    expect(raw.length).toBeGreaterThan(INLINE_LIMIT);
    const enc = encodePayload(value);
    expect(enc.meta.enc).toBe("json+zstd");
    expect(enc.meta.bytes).toBe(raw.length);
    expect(enc.meta.sha256).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
    expect(decodePayload(enc.meta, enc.blob)).toEqual(value);
  });

  it("encodes float64 payloads bit-exactly", () => {
    const values = [0.1, 1e-9, 1e300, -0.0, 5e-324];
    const enc = encodePayload(new F64(values));
    expect(enc.meta.enc).toBe("f64+zstd");
    expect(enc.meta.count).toBe(5);
    const out = decodePayload(enc.meta, enc.blob) as number[];
    expect(packF64(out).equals(packF64(values))).toBe(true);
  });

  it("rejects unknown encodings", () => {
    expect(() => decodePayload({ enc: "protobuf" }, Buffer.alloc(0))).toThrow();
  });
});

describe("claimOrder", () => {
  it("formats priority-inverted fixed width", () => {
    expect(claimOrder(5, T1, "jobB")).toBe(`9994#${T1}#jobB`);
    expect(claimOrder(0, T0, "jobA")).toBe(`9999#${T0}#jobA`);
  });

  it("sorts higher priority first, then FIFO, then job_id", () => {
    expect(claimOrder(5, T1, "b") < claimOrder(0, T0, "a")).toBe(true);
    expect(claimOrder(0, T0, "a") < claimOrder(0, T1, "b")).toBe(true);
    expect(claimOrder(0, T0, "a") < claimOrder(0, T0, "b")).toBe(true);
  });

  it("clamps priority", () => {
    expect(claimOrder(-3, T0, "x").startsWith("9999#")).toBe(true);
    expect(claimOrder(20000, T0, "x").startsWith("0000#")).toBe(true);
  });
});

describe("timestamps", () => {
  it("accepts the canonical format", () => {
    expect(validateTs(T0)).toBe(T0);
  });

  it.each([
    "2026-07-06 10:00:00",
    "2026-07-06T10:00:00Z",
    "2026-07-06T10:00:00.000+00:00",
    "2026-07-06T10:00:00.000",
    "not a ts",
    "",
  ])("rejects %s", (bad) => {
    expect(() => validateTs(bad)).toThrow();
  });

  it("adds seconds", () => {
    expect(tsAddSeconds("2026-07-06T10:01:00.000Z", 300)).toBe("2026-07-06T10:06:00.000Z");
    expect(tsAddSeconds("2026-07-06T23:59:30.500Z", 60)).toBe("2026-07-07T00:00:30.500Z");
  });
});

describe("scopes and keys", () => {
  it("builds scopes", () => {
    expect(scopeForZid(7, "FULL_PIPELINE")).toBe("zid#7#FULL_PIPELINE");
    expect(scopeForRid(42, "NARRATIVE_BATCH")).toBe("rid#42#NARRATIVE_BATCH");
  });

  it("derives scopes from runs", () => {
    const base = { job_id: "j", enqueued_at: T0 };
    expect(
      scopesForRun(normalizeRunManifest({ ...base, job_type: "FULL_PIPELINE", zid: 7 }))
    ).toEqual(["zid#7#FULL_PIPELINE"]);
    expect(
      scopesForRun(
        normalizeRunManifest({ ...base, job_type: "NARRATIVE_BATCH", zid: 7, rid: 42 })
      )
    ).toEqual(["rid#42#NARRATIVE_BATCH"]);
    expect(
      scopesForRun(normalizeRunManifest({ ...base, job_type: "IMPORTED", zid: 7 }))
    ).toEqual([]);
    expect(() =>
      scopesForRun(normalizeRunManifest({ ...base, job_type: "FULL_PIPELINE" }))
    ).toThrow();
  });

  it("builds zero-padded log keys", () => {
    expect(logSk(1)).toBe("log#00000001");
    expect(logSk(12345678)).toBe("log#12345678");
  });

  it("builds artifact keys and rejects the chunk marker", () => {
    expect(artifactKey("umap", "topic", 0, 3)).toBe("umap#topic#0#3");
    expect(() => artifactKey("math", `bad${CHUNK_MARKER}part`)).toThrow();
  });

  it("excludes runs and latest from generic entities", () => {
    expect(GENERIC_ENTITIES).toEqual([
      "run_inputs",
      "artifacts",
      "topic_moderation",
      "collective_statements",
    ]);
  });
});
