import { afterEach, describe, expect, test } from "@jest/globals";

import {
  CONSTANT_CONVENTION_SOURCE,
  EXPORT_AGREE,
  EXPORT_DISAGREE,
  EXPORT_NULL_VALUE,
  EXPORT_PASS,
  STORAGE_AGREE_VALUE,
  StorageConvention,
  VOTES,
  Vote,
  VoteConventionError,
  WIRE_AGREE,
  WIRE_AGREE_VALUE,
  WIRE_DISAGREE,
  WIRE_PASS,
  WIRE_VOTE_MAX,
  WIRE_VOTE_MIN,
  addToTally,
  currentStorageConvention,
  emptyTally,
  exportToSemantic,
  exportToStorage,
  isVote,
  resetConventionSource,
  semanticToExport,
  semanticToStorage,
  semanticToWire,
  setConventionSource,
  storageSqlValue,
  storageToExport,
  storageToSemantic,
  storageToWire,
  wireToSemantic,
  wireToStorage,
} from "../../src/votes/convention";

// The storage convention after the planned un-flip, used to prove that the
// wire and the export do not move when storage does.
const FLIPPED: StorageConvention = { agreeValue: 1, version: 1 };
const TODAY: StorageConvention = { agreeValue: -1, version: 0 };

afterEach(() => resetConventionSource());

describe("the constants", () => {
  test("wire is frozen at agree = -1", () => {
    expect(WIRE_AGREE_VALUE).toBe(-1);
    expect([WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS]).toEqual([-1, 1, 0]);
    expect([WIRE_VOTE_MIN, WIRE_VOTE_MAX]).toEqual([-1, 1]);
  });

  test("export is fixed at agree = +1", () => {
    expect([EXPORT_AGREE, EXPORT_DISAGREE, EXPORT_PASS]).toEqual([1, -1, 0]);
    expect(EXPORT_NULL_VALUE).toBe(0);
  });

  test("storage today is agree = -1 from the constant source", () => {
    expect(STORAGE_AGREE_VALUE).toBe(-1);
    expect(currentStorageConvention()).toEqual({
      agreeValue: -1,
      version: null,
    });
    expect(CONSTANT_CONVENTION_SOURCE.current().agreeValue).toBe(-1);
  });

  test("VOTES lists the three semantic votes and isVote recognises only them", () => {
    expect([...VOTES]).toEqual(["agree", "disagree", "pass"]);
    for (const v of VOTES) expect(isVote(v)).toBe(true);
    for (const v of ["Agree", "skip", -1, 0, 1, null, undefined]) {
      expect(isVote(v)).toBe(false);
    }
  });
});

describe("the convention source", () => {
  test("an injected source is used by every storage conversion", () => {
    setConventionSource({ current: () => FLIPPED });
    expect(currentStorageConvention()).toBe(FLIPPED);
    expect(storageToSemantic(1)).toBe("agree");
    expect(semanticToStorage("agree")).toBe(1);
    expect(wireToStorage(-1)).toBe(1);
    expect(storageToWire(1)).toBe(-1);
    expect(exportToStorage(1)).toBe(1);
    expect(storageToExport(1)).toBe(1);
    expect(storageSqlValue("agree")).toBe(1);
  });

  test("reset restores the constant", () => {
    setConventionSource({ current: () => FLIPPED });
    resetConventionSource();
    expect(currentStorageConvention().agreeValue).toBe(-1);
  });

  test("a source returning an impossible agree value is refused", () => {
    setConventionSource({
      current: () => ({ agreeValue: 0 as unknown as -1, version: 9 }),
    });
    expect(() => currentStorageConvention()).toThrow(VoteConventionError);
    expect(() => storageToSemantic(-1)).toThrow(VoteConventionError);
  });

  test("a per-call convention overrides the source", () => {
    expect(storageToSemantic(1, { convention: FLIPPED })).toBe("agree");
    expect(storageToSemantic(1)).toBe("disagree");
  });
});

describe("each conversion, today's convention", () => {
  const table: Array<[Vote, number, number, number]> = [
    // vote, wire, storage, export
    ["agree", -1, -1, 1],
    ["disagree", 1, 1, -1],
    ["pass", 0, 0, 0],
  ];

  test.each(table)(
    "%s: wire %d, storage %d, export %d",
    (vote, wire, storage, exp) => {
      expect(wireToSemantic(wire)).toBe(vote);
      expect(semanticToWire(vote)).toBe(wire);
      expect(storageToSemantic(storage)).toBe(vote);
      expect(semanticToStorage(vote)).toBe(storage);
      expect(exportToSemantic(exp)).toBe(vote);
      expect(semanticToExport(vote)).toBe(exp);
      expect(wireToStorage(wire)).toBe(storage);
      expect(storageToWire(storage)).toBe(wire);
      expect(exportToStorage(exp)).toBe(storage);
      expect(storageToExport(storage)).toBe(exp);
      expect(storageSqlValue(vote)).toBe(storage);
    }
  );

  test("pass never becomes negative zero", () => {
    expect(Object.is(storageToExport(0), 0)).toBe(true);
    expect(Object.is(wireToStorage(0), 0)).toBe(true);
    expect(Object.is(exportToStorage(0), 0)).toBe(true);
    expect(Object.is(semanticToExport("pass"), 0)).toBe(true);
  });
});

describe("each conversion, after the un-flip (agree = +1 in storage)", () => {
  test("the wire and export do not move; only storage does", () => {
    const o = { convention: FLIPPED };
    expect(wireToStorage(WIRE_AGREE, o)).toBe(1);
    expect(wireToStorage(WIRE_DISAGREE, o)).toBe(-1);
    expect(storageToWire(1, o)).toBe(WIRE_AGREE);
    expect(storageToExport(1, o)).toBe(EXPORT_AGREE);
    expect(exportToStorage(EXPORT_AGREE, o)).toBe(1);
    expect(storageToSemantic(-1, o)).toBe("disagree");
    expect(storageSqlValue("disagree", o)).toBe(-1);
  });

  test("a wire agree exports as +1 under both storage conventions", () => {
    for (const convention of [TODAY, FLIPPED]) {
      const o = { convention };
      expect(storageToExport(wireToStorage(WIRE_AGREE, o), o)).toBe(
        EXPORT_AGREE
      );
    }
  });
});

describe("NULL: in null, out null (export writes EXPORT_NULL_VALUE)", () => {
  for (const nullish of [null, undefined]) {
    test(`${String(nullish)}`, () => {
      expect(wireToSemantic(nullish)).toBeNull();
      expect(storageToSemantic(nullish)).toBeNull();
      expect(exportToSemantic(nullish)).toBeNull();
      expect(wireToStorage(nullish)).toBeNull();
      expect(storageToWire(nullish)).toBeNull();
      expect(exportToStorage(nullish)).toBeNull();
      expect(storageToExport(nullish)).toBe(EXPORT_NULL_VALUE);
      // Even under "throw", NULL is not an error.
      expect(storageToSemantic(nullish, { onInvalid: "throw" })).toBeNull();
    });
  }

  test("the export NULL cell is byte-identical to the old String(-null)", () => {
    expect(String(storageToExport(null))).toBe(String(-null));
  });
});

describe("out-of-range values", () => {
  const invalid = [2, -2, 7, 0.5, NaN];

  test.each(invalid)("%p throws by default", (raw) => {
    expect(() => wireToSemantic(raw)).toThrow(VoteConventionError);
    expect(() => storageToSemantic(raw)).toThrow(VoteConventionError);
    expect(() => exportToSemantic(raw)).toThrow(VoteConventionError);
    expect(() => wireToStorage(raw)).toThrow(VoteConventionError);
    expect(() => storageToWire(raw)).toThrow(VoteConventionError);
    expect(() => exportToStorage(raw)).toThrow(VoteConventionError);
    expect(() => storageToExport(raw)).toThrow(VoteConventionError);
  });

  test.each(invalid)("%p is null under skip for semantic reads", (raw) => {
    expect(storageToSemantic(raw, { onInvalid: "skip" })).toBeNull();
    expect(wireToSemantic(raw, { onInvalid: "skip" })).toBeNull();
    expect(exportToSemantic(raw, { onInvalid: "skip" })).toBeNull();
  });

  test.each(invalid)(
    "%p is unchanged under keep for numeric conversions",
    (raw) => {
      expect(wireToStorage(raw, { onInvalid: "keep" })).toBe(raw);
      expect(storageToWire(raw, { onInvalid: "keep" })).toBe(raw);
      expect(exportToStorage(raw, { onInvalid: "keep" })).toBe(raw);
    }
  );

  test.each([2, -2, 7])(
    "%p exports under keep exactly as the old String(-row.vote)",
    (raw) => {
      expect(String(storageToExport(raw, { onInvalid: "keep" }))).toBe(
        String(-raw)
      );
    }
  );

  test("the error names the representation and the value", () => {
    expect(() => storageToSemantic(7)).toThrow(/7 is not a storage vote/);
  });

  test("an unknown semantic value is refused", () => {
    expect(() => semanticToWire("Agree" as Vote)).toThrow(VoteConventionError);
    expect(() => semanticToStorage("skip" as Vote)).toThrow(
      VoteConventionError
    );
    expect(() => storageSqlValue("" as Vote)).toThrow(VoteConventionError);
  });
});

describe("round trips", () => {
  for (const convention of [TODAY, FLIPPED]) {
    const o = { convention };
    describe(`storage agree = ${convention.agreeValue}`, () => {
      test.each([...VOTES])("%s survives every representation", (vote) => {
        expect(wireToSemantic(semanticToWire(vote))).toBe(vote);
        expect(storageToSemantic(semanticToStorage(vote, o), o)).toBe(vote);
        expect(exportToSemantic(semanticToExport(vote))).toBe(vote);
      });

      test.each([-1, 0, 1])("wire %d → storage → wire", (wire) => {
        expect(storageToWire(wireToStorage(wire, o), o)).toBe(wire);
      });

      test.each([-1, 0, 1])("export %d → storage → export", (exp) => {
        expect(storageToExport(exportToStorage(exp, o), o)).toBe(exp);
      });

      test.each([-1, 0, 1])("storage %d → wire → storage", (raw) => {
        expect(wireToStorage(storageToWire(raw, o), o)).toBe(raw);
      });
    });
  }
});

describe("tally", () => {
  test("counts semantic votes and NULL separately", () => {
    const t = emptyTally();
    for (const raw of [-1, -1, 1, 0, null, 7]) {
      addToTally(t, storageToSemantic(raw, { onInvalid: "skip" }));
    }
    expect(t).toEqual({ agree: 2, disagree: 1, pass: 1, none: 2 });
    addToTally(t, "pass", 3);
    expect(t.pass).toBe(4);
  });
});
