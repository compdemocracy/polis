import { jest, describe, expect, test, beforeEach } from "@jest/globals";

// Mock the DB layer so we can drive the transaction into its failure paths.
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(),
    queryP: jest.fn(),
    queryP_readOnly: jest.fn(),
  },
}));

jest.mock("../../src/utils/fail", () => ({
  __esModule: true,
  failJson: jest.fn(),
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

// Import after the mocks so they take effect.
import pg from "../../src/db/pg-query";
import { failJson } from "../../src/utils/fail";
import { handle_POST_domainWhitelist } from "../../src/utils/domain";

const mockConnect = pg.connect as unknown as jest.Mock;
const mockFailJson = failJson as unknown as jest.Mock;

/**
 * A stand-in for a pg PoolClient. `rollbackFails` simulates the case where the
 * connection is unusable by the time we try to clean up, which is what leaves a
 * client stuck inside an aborted transaction.
 */
function makeFakeClient({ rollbackFails }: { rollbackFails: boolean }) {
  const release = jest.fn();
  const query = jest.fn(async (sql: unknown) => {
    const text = String(sql);
    if (text.startsWith("ROLLBACK")) {
      if (rollbackFails) {
        throw new Error("connection terminated during rollback");
      }
      return { rows: [] };
    }
    if (text.startsWith("insert into site_domain_whitelist")) {
      throw new Error("null value in column site_id");
    }
    return { rows: [] };
  });
  return { query, release };
}

function makeReq() {
  return { p: { uid: 1234, domain_whitelist: "example.com" } } as any;
}

function makeRes() {
  return { json: jest.fn() } as any;
}

describe("setDomainWhitelist transaction cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("releases the client for reuse when the rollback succeeds", async () => {
    const client = makeFakeClient({ rollbackFails: false });
    mockConnect.mockResolvedValue(client as never);

    await handle_POST_domainWhitelist(makeReq(), makeRes());

    expect(client.release).toHaveBeenCalledTimes(1);
    // A falsy argument returns the connection to the pool, which is correct
    // here: the transaction was rolled back cleanly.
    expect(client.release.mock.calls[0][0]).toBeFalsy();
  });

  test("destroys the client when the rollback itself fails", async () => {
    const client = makeFakeClient({ rollbackFails: true });
    mockConnect.mockResolvedValue(client as never);

    await handle_POST_domainWhitelist(makeReq(), makeRes());

    expect(client.release).toHaveBeenCalledTimes(1);
    // A truthy argument destroys the connection instead of handing the next
    // borrower a client still inside an aborted transaction (25P02).
    expect(client.release.mock.calls[0][0]).toBeTruthy();
  });

  test("reports the same failure to the caller either way", async () => {
    for (const rollbackFails of [false, true]) {
      jest.clearAllMocks();
      mockConnect.mockResolvedValue(makeFakeClient({ rollbackFails }) as never);

      await handle_POST_domainWhitelist(makeReq(), makeRes());

      expect(mockFailJson).toHaveBeenCalledTimes(1);
      const [, status, errCode, err] = mockFailJson.mock.calls[0] as any[];
      expect(status).toBe(500);
      expect(errCode).toBe("polis_err_post_domainWhitelist_misc");
      // The original write error surfaces, not the cleanup failure.
      expect((err as Error).message).toBe("null value in column site_id");
    }
  });
});
