/**
 * Cross-language golden test for the frozen Delphi storage codec
 * (`delphi-storage-codec/1`, P-077 P2-0).
 *
 * Python writes -> TypeScript reads: every family file in
 * delphi/polismath/delphi_storage/golden/ was written by the Python codec; this
 * module must decode it and re-encode exactly the same bytes.
 *
 * TypeScript writes -> Python reads: the items below are built here, encoded,
 * and must equal golden/cross/written-by-node.jsonl byte for byte; the Python
 * test decodes that file and compares it with its own definition of the same
 * items (golden_corpus.cross_items). Set DELPHI_CODEC_WRITE_CROSS=1 to rewrite
 * the file after a deliberate change (a new codec version, never an edit of /1).
 */
import { describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import {
  CODEC_VERSION,
  CodecError,
  FAMILIES,
  Item,
  canonicalNumber,
  decodeFamily,
  encodeFamily,
} from "../../src/utils/delphiStorageCodec";

const GOLDEN = path.resolve(
  __dirname,
  "../../../delphi/polismath/delphi_storage/golden"
);
const CROSS = path.join(GOLDEN, "cross", "written-by-node.jsonl");

function crossItems(): Item[] {
  return [
    {
      job_id: { S: "cross-1" },
      n: { N: "-12.5" },
      s: { S: "caf\u00e9\u0000\u{1f600}" },
      b: { B: new Uint8Array([0x00, 0xff]) },
      ss: { SS: ["z", "a"] },
      ns: { NS: ["2", "10"] },
      bs: { BS: [new Uint8Array([0x09]), new Uint8Array([0x01])] },
      l: { L: [{ BOOL: false }, { NULL: true }] },
      m: { M: { k2: { N: "1" }, k1: { S: '{"json":true}' } } },
    },
    { job_id: { S: "cross-0" }, empty: { S: "" } },
  ];
}

describe("delphi storage codec", () => {
  it("has version delphi-storage-codec/1 and all twenty families", () => {
    expect(CODEC_VERSION).toBe("delphi-storage-codec/1");
    expect(Object.keys(FAMILIES)).toHaveLength(20);
  });

  it("reads every Python-written golden family and rewrites identical bytes", () => {
    const sums = fs
      .readFileSync(path.join(GOLDEN, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("  "));
    expect(sums.map(([, f]) => f.replace(/\.jsonl$/, "")).sort()).toEqual(
      Object.keys(FAMILIES).sort()
    );
    for (const [sum, file] of sums) {
      const bytes = fs.readFileSync(path.join(GOLDEN, file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sum);
      const { family, items } = decodeFamily(bytes);
      expect(`${family}.jsonl`).toBe(file);
      expect(items.length).toBeGreaterThan(0);
      expect(Buffer.compare(encodeFamily(family, items), bytes)).toBe(0);
    }
  });

  it("keeps numbers as text, sets as sets and JSON strings as strings", () => {
    const { items } = decodeFamily(
      fs.readFileSync(path.join(GOLDEN, "Delphi_JobQueue.jsonl"))
    );
    const edge = items.find((i) =>
      (i.job_id as { S: string }).S.endsWith("9002")
    ) as any;
    expect(edge.numbers.L[4]).toEqual({
      N: "12345678901234567890123456789012345678",
    });
    expect(edge.number_set.NS).toEqual(["-1", "0.5", "10", "9"]);
    expect(Buffer.from(edge.binary.B).toString("latin1")).toBe(
      "\x00\x01\xfe\xff generated"
    );
    expect(edge.json_text.S).toBe(
      '{"id":"generated","paragraphs":[{"title":"A"}]}'
    );
    expect(edge.nul_and_controls.S.charCodeAt(1)).toBe(0);
    expect(edge.false).toEqual({ BOOL: false });
  });

  it("TS writes the cross file that Python reads", () => {
    const bytes = encodeFamily("Delphi_JobQueue", crossItems());
    if (process.env.DELPHI_CODEC_WRITE_CROSS === "1")
      fs.writeFileSync(CROSS, bytes);
    expect(Buffer.compare(bytes, fs.readFileSync(CROSS))).toBe(0);
    expect(decodeFamily(bytes).items).toHaveLength(2);
  });

  it("canonicalises numbers the way DynamoDB returns them", () => {
    const cases: Array<[string, string]> = [
      ["1.50", "1.5"],
      ["1E+2", "100"],
      ["-0", "0"],
      ["0.0", "0"],
      ["1e-10", "0.0000000001"],
      ["00012", "12"],
      [".5", "0.5"],
      ["5.", "5"],
      ["-1.2300e5", "-123000"],
    ];
    for (const [input, out] of cases) expect(canonicalNumber(input)).toBe(out);
    for (const bad of [
      "",
      "1e",
      "NaN",
      "Infinity",
      "0x10",
      "1E+126",
      "1E-131",
      "\u0663",
      "1\u0663",
      "\uff11",
      "1e\u0663",
    ])
      expect(() => canonicalNumber(bad)).toThrow(CodecError);
    expect(() => canonicalNumber("1" + "1".repeat(38))).toThrow(CodecError);
  });

  it("refuses malformed attribute values instead of building data", () => {
    const bad: unknown[] = [
      { SS: "ab" },
      { NS: "12" },
      { BS: new Uint8Array([1]) },
      { B: 3 },
      { B: "AQ==" },
      { BS: ["AQ=="] },
      { BS: [3] },
      { SS: [1] },
      { L: "x" },
      { M: [] },
      { BOOL: 1 },
      { NULL: false },
      { S: 1 },
      { N: 1 },
      { X: "1" },
      { S: "a", N: "1" },
    ];
    for (const av of bad)
      expect(() =>
        encodeFamily("Delphi_JobQueue", [
          { job_id: { S: "a" }, x: av } as unknown as Item,
        ])
      ).toThrow(CodecError);
  });

  it("refuses anything that is not byte-canonical", () => {
    const head =
      '{"codec":"delphi-storage-codec/1","family":"Delphi_JobQueue","key":["job_id"]}';
    const bad = [
      `${head}\n{"job_id":{"S":"a"},"n":{"N":"1.50"}}\n`,
      `${head}\n{"n":{"N":"1"}, "job_id":{"S":"a"}}\n`,
      `${head}\n{"job_id":{"S":"a"},"ss":{"SS":["b","a"]}}\n`,
      `${head}\n{"job_id":{"S":"a"},"ss":{"SS":["a","a"]}}\n`,
      `${head}\n{"job_id":{"S":"a"},"ss":{"SS":[]}}\n`,
      `${head}\n{"job_id":{"S":"b"}}\n{"job_id":{"S":"a"}}\n`,
      `${head}\n{"job_id":{"S":"a"}}\n{"job_id":{"S":"a"}}\n`,
      `${head}\n{"job_id":{"S":"a"},"b":{"B":"AQ"}}\n`,
      `${head}\n{"job_id":{"N":"1"}}\n`,
      `${head}\n{"job_id":{"S":"a"},"x":{"S":"\\u00e9"}}\n`,
      `${head}\n{"job_id":{"S":"a"},"x":{"S":"\\ud800"}}\n`,
      `${head}\n{"job_id":{"S":"a"}}`,
      `${head}\n{"job_id":{"S":"a"},"x":{"Q":"1"}}\n`,
      `{"codec":"delphi-storage-codec/2","family":"Delphi_JobQueue","key":["job_id"]}\n`,
    ];
    for (const text of bad)
      expect(() => decodeFamily(Buffer.from(text, "utf8"))).toThrow();
    expect(() =>
      encodeFamily("Delphi_JobQueue", [
        { job_id: { S: "a" } },
        { job_id: { S: "a" } },
      ])
    ).toThrow(CodecError);
    expect(() => encodeFamily("Not_A_Table", [{ k: { S: "a" } }])).toThrow(
      CodecError
    );
  });

  it("preserves an attribute named __proto__ as data", () => {
    const item = JSON.parse('{"job_id":{"S":"p"},"__proto__":{"S":"x"}}');
    const bytes = encodeFamily("Delphi_JobQueue", [item]);
    const back = decodeFamily(bytes).items[0];
    expect(Object.keys(back).sort()).toEqual(["__proto__", "job_id"]);
    expect(Buffer.compare(encodeFamily("Delphi_JobQueue", [back]), bytes)).toBe(
      0
    );
  });
});
