/**
 * POLIS_DELPHI_ENTITLEMENT as the server reads it at startup (config.ts):
 * unset or blank is claim, the default; claim, claim_or_db and db are taken
 * as written (surrounding blanks trimmed); anything else stops the server.
 */
import { describe, expect, jest, test } from "@jest/globals";

function load(value: string | undefined): unknown {
  const previous = process.env.POLIS_DELPHI_ENTITLEMENT;
  if (value === undefined) delete process.env.POLIS_DELPHI_ENTITLEMENT;
  else process.env.POLIS_DELPHI_ENTITLEMENT = value;
  let config: any;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      config = require("../../src/config").default;
    });
  } finally {
    if (previous === undefined) delete process.env.POLIS_DELPHI_ENTITLEMENT;
    else process.env.POLIS_DELPHI_ENTITLEMENT = previous;
  }
  return config.delphiEntitlement;
}

describe("POLIS_DELPHI_ENTITLEMENT", () => {
  test.each([undefined, "", "  "])("%p is claim, the default", (value) => {
    expect(load(value)).toBe("claim");
  });

  test.each([
    ["claim", "claim"],
    ["claim_or_db", "claim_or_db"],
    ["db", "db"],
    [" db ", "db"],
  ])("%p is %p", (value, expected) => {
    expect(load(value)).toBe(expected);
  });

  test.each(["Claim", "DB", "claim-or-db", "claim,db", "true", "1", "off"])(
    "%p stops the server at startup",
    (value) => {
      expect(() => load(value)).toThrow(
        `POLIS_DELPHI_ENTITLEMENT must be claim, claim_or_db or db; got '${value}'`
      );
    }
  );
});
