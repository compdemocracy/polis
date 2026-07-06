/**
 * Wire codec for Delphi Storage V2 payloads — TypeScript twin of
 * delphi/delphi_storage/codec.py. The format is pinned by the shared
 * conformance fixtures (delphi/delphi_storage/conformance/cases/codec_*.json):
 *
 * - canonical JSON: keys sorted by UTF-8 byte order, compact, no NaN/Infinity;
 * - packed floats: little-endian IEEE-754 float64;
 * - compression: zstd frames (Node's built-in zlib zstd support, Node >= 22.15);
 * - payload envelopes: `meta` (JSON attributes) + optional binary `blob`:
 *     {"enc": "json", "body": <value>}                    — inline, no blob
 *     {"enc": "json+zstd", "bytes", "sha256"}             — blob = zstd(canonical JSON)
 *     {"enc": "f64+zstd", "count", "bytes", "sha256"}     — blob = zstd(packed f64)
 *   bytes/sha256 describe the UNCOMPRESSED payload (compressed bytes are never
 *   compared: zstd output varies across implementations).
 */
import * as crypto from "crypto";
import * as zlib from "zlib";

import { InvalidError } from "./errors";
import { utf8Compare } from "./keys";

/**
 * Canonical-JSON bodies up to this many UTF-8 bytes are stored inline;
 * larger ones are zstd-compressed into the blob.
 */
export const INLINE_LIMIT = 65536;

type ZstdCapableZlib = typeof zlib & {
  zstdCompressSync?: (buf: Buffer, options?: unknown) => Buffer;
  zstdDecompressSync?: (buf: Buffer, options?: unknown) => Buffer;
};

const z = zlib as ZstdCapableZlib;

function requireZstd<T>(fn: T | undefined, name: string): T {
  if (typeof fn !== "function") {
    throw new Error(`${name} unavailable — Node >= 22.15 is required for zstd support`);
  }
  return fn;
}

export function compress(data: Buffer): Buffer {
  return requireZstd(z.zstdCompressSync, "zlib.zstdCompressSync")(data);
}

export function decompress(data: Buffer): Buffer {
  return requireZstd(z.zstdDecompressSync, "zlib.zstdDecompressSync")(data);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new InvalidError(`non-finite number not JSON-serializable: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (kind === "string" || kind === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    // Sort keys by UTF-8 byte order to match Python's sort_keys (code points).
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort(utf8Compare);
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new InvalidError(`value of type ${kind} is not JSON-serializable`);
}

export function canonicalJsonDumps(value: unknown): string {
  return canonicalize(value);
}

export function packF64(values: number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 8);
  values.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return buf;
}

export function unpackF64(data: Buffer): number[] {
  if (data.length % 8 !== 0) {
    throw new InvalidError(`packed f64 length must be a multiple of 8, got ${data.length}`);
  }
  const out: number[] = new Array(data.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = data.readDoubleLE(i * 8);
  return out;
}

function sha256hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Marker wrapper: encode this payload as a packed float64 array. */
export class F64 {
  constructor(public values: number[]) {}
}

export interface PayloadMeta {
  enc: string;
  body?: unknown;
  bytes?: number;
  sha256?: string;
  count?: number;
}

export interface EncodedPayload {
  meta: PayloadMeta;
  blob: Buffer | null;
}

/**
 * Encode a payload for storage. `force` pins the encoding ('json',
 * 'json+zstd'); by default small JSON stays inline.
 */
export function encodePayload(value: unknown, force?: string): EncodedPayload {
  if (value instanceof F64) {
    const packed = packF64(value.values);
    return {
      meta: {
        enc: "f64+zstd",
        count: value.values.length,
        bytes: packed.length,
        sha256: sha256hex(packed),
      },
      blob: compress(packed),
    };
  }
  const raw = Buffer.from(canonicalJsonDumps(value), "utf8");
  if (force === "json" || (force === undefined && raw.length <= INLINE_LIMIT)) {
    return { meta: { enc: "json", body: value }, blob: null };
  }
  if (force !== undefined && force !== "json+zstd") {
    throw new InvalidError(`unknown forced encoding ${JSON.stringify(force)}`);
  }
  return {
    meta: { enc: "json+zstd", bytes: raw.length, sha256: sha256hex(raw) },
    blob: compress(raw),
  };
}

export function decodePayload(meta: PayloadMeta, blob: Buffer | null): unknown {
  const enc = meta.enc;
  if (enc === "json") return meta.body;
  if (enc === "json+zstd" || enc === "f64+zstd") {
    if (blob === null) throw new InvalidError(`encoding ${enc} requires a blob`);
    const raw = decompress(blob);
    if (meta.sha256 !== undefined && sha256hex(raw) !== meta.sha256) {
      throw new InvalidError("payload sha256 mismatch — corrupt blob");
    }
    if (meta.bytes !== undefined && raw.length !== meta.bytes) {
      throw new InvalidError("payload length mismatch — corrupt blob");
    }
    return enc === "json+zstd" ? JSON.parse(raw.toString("utf8")) : unpackF64(raw);
  }
  throw new InvalidError(`unknown payload encoding ${JSON.stringify(enc)}`);
}
