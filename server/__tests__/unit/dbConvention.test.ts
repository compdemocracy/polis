import { describe, expect, test } from "@jest/globals";

import { STORAGE_AGREE_VALUE } from "../../src/votes/convention";
import {
  SUPPORTED_VOTE_CONTRACTS,
  VOTE_CONVENTION_GUIDE,
  VoteConventionStartupError,
  declareCommand,
  judgeDatabaseConvention,
  readDatabaseConvention,
  requireDeclaredConvention,
} from "../../src/votes/dbConvention";

// The other sign, derived from the chokepoint so no literal sign appears here.
const OTHER = -STORAGE_AGREE_VALUE as typeof STORAGE_AGREE_VALUE;
const CONTRACT = SUPPORTED_VOTE_CONTRACTS[0];

/** A fake database: what the presence probe and the row query answer. */
function fakeQuery(
  present: boolean,
  rows: Array<Record<string, unknown>>,
  log: string[] = []
) {
  return async (sql: string) => {
    log.push(sql);
    if (sql.includes("to_regclass")) return [{ present }];
    if (sql.includes("vote_convention_current()")) return rows;
    throw new Error(`unexpected query: ${sql}`);
  };
}

function row(version: number, agreeValue: number, contractVersion = CONTRACT) {
  return { version, agree_value: agreeValue, contract_version: contractVersion };
}

describe("readDatabaseConvention", () => {
  test("no table: migration 000023 not applied", async () => {
    const log: string[] = [];
    expect(await readDatabaseConvention(fakeQuery(false, [], log))).toEqual({
      state: "no-table",
    });
    expect(log).toHaveLength(1);
  });

  test("table without a row: undeclared", async () => {
    expect(await readDatabaseConvention(fakeQuery(true, []))).toEqual({
      state: "no-row",
    });
  });

  test("the declared row, with text numbers accepted as pg returns them", async () => {
    expect(
      await readDatabaseConvention(
        fakeQuery(true, [
          { version: "0", agree_value: String(STORAGE_AGREE_VALUE), contract_version: "1" },
        ])
      )
    ).toEqual({
      state: "declared",
      version: 0,
      agreeValue: STORAGE_AGREE_VALUE,
      contractVersion: 1,
    });
  });

  test("two rows is a refusal, never a guess", async () => {
    await expect(
      readDatabaseConvention(
        fakeQuery(true, [row(0, STORAGE_AGREE_VALUE), row(1, OTHER)])
      )
    ).rejects.toThrow(VoteConventionStartupError);
  });
});

describe("judgeDatabaseConvention", () => {
  test("the sign this build is built for starts", () => {
    const verdict = judgeDatabaseConvention(
      { state: "declared", version: 0, agreeValue: STORAGE_AGREE_VALUE, contractVersion: CONTRACT },
      "server"
    );
    expect(verdict).toEqual({
      ok: true,
      convention: { agreeValue: STORAGE_AGREE_VALUE, version: 0 },
    });
  });

  test("no table: names the migration file, the declare command and the guide", () => {
    const verdict = judgeDatabaseConvention({ state: "no-table" }, "server");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("vote_convention_not_installed");
    expect(verdict.message).toContain("Polis cannot start (server)");
    expect(verdict.message).toContain("000023_vote_convention.sql");
    expect(verdict.message).toContain(declareCommand());
    expect(verdict.message).toContain("Nothing has been changed");
    expect(verdict.message).toContain(`${VOTE_CONVENTION_GUIDE}#guard`);
  });

  test("no row: names the exact declare command and the guide", () => {
    const verdict = judgeDatabaseConvention({ state: "no-row" }, "import worker");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("vote_convention_undeclared");
    expect(verdict.message).toContain("Polis cannot start (import worker)");
    expect(verdict.message).toContain(`"${declareCommand()}"`);
    expect(verdict.message).toContain("Nothing has been changed");
    expect(verdict.message).toContain(`${VOTE_CONVENTION_GUIDE}#declare`);
  });

  test("a row naming the other sign refuses: this build would invert every vote", () => {
    const verdict = judgeDatabaseConvention(
      { state: "declared", version: 1, agreeValue: OTHER, contractVersion: CONTRACT },
      "server"
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("vote_convention_mismatch");
    expect(verdict.message).toContain("declares vote convention version 1");
    expect(verdict.message).toContain("built for agree = ");
    expect(verdict.message).toContain("every vote inverted");
    expect(verdict.message).toContain(`${VOTE_CONVENTION_GUIDE}#mismatch`);
  });

  test("a contract this build does not know refuses before the sign is judged", () => {
    const verdict = judgeDatabaseConvention(
      { state: "declared", version: 0, agreeValue: STORAGE_AGREE_VALUE, contractVersion: CONTRACT + 1 },
      "server"
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("vote_convention_contract_unsupported");
    expect(verdict.message).toContain(`contract ${CONTRACT + 1}`);
    expect(verdict.message).toContain(`${VOTE_CONVENTION_GUIDE}#a-newer-database`);
  });

  test("the declare command names the sign this build is built for", () => {
    expect(declareCommand()).toBe(
      `make vote-convention-declare AGREE=${STORAGE_AGREE_VALUE}`
    );
    expect(declareCommand(OTHER)).toMatch(/AGREE=[+-]1$/);
  });
});

describe("requireDeclaredConvention", () => {
  test("returns the convention when the database declares this build's sign", async () => {
    await expect(
      requireDeclaredConvention(fakeQuery(true, [row(0, STORAGE_AGREE_VALUE)]), "server")
    ).resolves.toEqual({ agreeValue: STORAGE_AGREE_VALUE, version: 0 });
  });

  test("throws the operator message on an undeclared database", async () => {
    await expect(
      requireDeclaredConvention(fakeQuery(true, []), "server")
    ).rejects.toMatchObject({
      name: "VoteConventionStartupError",
      code: "vote_convention_undeclared",
    });
  });

  test("a read replica is checked too and must agree with the primary", async () => {
    await expect(
      requireDeclaredConvention(
        fakeQuery(true, [row(0, STORAGE_AGREE_VALUE)]),
        "server",
        fakeQuery(true, [])
      )
    ).rejects.toMatchObject({ code: "vote_convention_undeclared" });
    await expect(
      requireDeclaredConvention(
        fakeQuery(true, [row(0, STORAGE_AGREE_VALUE)]),
        "server",
        fakeQuery(true, [row(0, STORAGE_AGREE_VALUE)])
      )
    ).resolves.toEqual({ agreeValue: STORAGE_AGREE_VALUE, version: 0 });
  });
});
