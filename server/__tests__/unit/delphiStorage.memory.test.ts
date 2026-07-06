/**
 * Conformance suite (memory backend) + codec fixture cases.
 *
 * Executes the SAME JSON operation-scripts as delphi's pytest suite
 * (delphi/delphi_storage/conformance/cases/) — the cross-language contract.
 * Spec: delphi/delphi_storage/conformance/README.md.
 */
import {
  loadCases,
  loadCodecCases,
  runCase,
  runCodecCase,
} from "../setup/delphi-storage-conformance";
import { MemoryDelphiStore } from "../../src/storage/delphi/memoryStore";

const cases = loadCases();
const codecCases = loadCodecCases();

describe("delphi storage conformance — memory backend", () => {
  it("finds the shared contract case files", () => {
    const names = cases.map((c) => c.name);
    for (const expected of [
      "roundtrip_basic",
      "query_ordering",
      "blob_chunking",
      "queue_claim",
      "latest_pointer",
      "run_manifest_fields",
      "validation",
    ]) {
      expect(names).toContain(expected);
    }
    expect(codecCases.length).toBeGreaterThan(0);
  });

  it.each(cases)("case $name", async (c) => {
    await runCase(new MemoryDelphiStore(), c);
  });

  it.each(codecCases)("codec case $name", (c) => {
    runCodecCase(c);
  });
});
