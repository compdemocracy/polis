/**
 * Committed regressions for the failure seams of pg-query's withTransaction.
 *
 * Each of these can otherwise be mistaken for success, and each was found or
 * confirmed by an out-of-tree probe rather than by reasoning. They live here so
 * a later edit to the shared helper cannot remove the behaviour unnoticed.
 *
 * The pool is mocked: these are about what the helper does with a client, not
 * about PostgreSQL. The real-server counterparts - the session bounds actually
 * in effect, a swallowed statement error producing a ROLLBACK command tag, and
 * a genuinely terminated backend - are covered against a live database in
 * __tests__/integration/queue-substrate.test.ts.
 */
import { EventEmitter } from "node:events";

type Responder = (text: string, client: FakeClient) => unknown;

class FakeClient extends EventEmitter {
  statements: string[] = [];
  releases: unknown[] = [];
  responder?: Responder;

  constructor(responder?: Responder) {
    super();
    this.responder = responder;
  }

  async query(text: string): Promise<unknown> {
    this.statements.push(text);
    const answer = this.responder
      ? await this.responder(text, this)
      : undefined;
    if (answer !== undefined) return answer;
    return { command: text === "COMMIT" ? "COMMIT" : "", rows: [] };
  }

  release(err?: unknown): void {
    this.releases.push(err);
  }
}

// jest.mock factories may only reference names beginning with "mock".
const mockConnectQueue: unknown[] = [];

jest.mock("pg", () => {
  const actual = jest.requireActual("pg");
  class MockPool {
    connect(): Promise<unknown> {
      const next = mockConnectQueue.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (!next) return Promise.reject(new Error("no scripted client"));
      return Promise.resolve(next);
    }
    query(): Promise<unknown> {
      return Promise.resolve({ rows: [] });
    }
    on(): void {
      /* pools are not exercised here */
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, Pool: MockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import pgQuery, { CommitOutcomeUnknownError } from "../../src/db/pg-query";

function scripted(responder?: Responder): FakeClient {
  const client = new FakeClient(responder);
  mockConnectQueue.push(client);
  return client;
}

afterEach(() => {
  mockConnectQueue.length = 0;
});

describe("withTransaction", () => {
  it("commits and returns the callback's value, releasing a healthy client", async () => {
    const client = scripted();
    await expect(pgQuery.withTransaction(async () => 42)).resolves.toBe(42);
    expect(client.statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(client.statements[client.statements.length - 1]).toBe("COMMIT");
    expect(client.releases).toEqual([false]);
    // A pooled client is handed back without this helper's error listener.
    expect(client.listenerCount("error")).toBe(0);
  });

  it("applies the declared /1 session policy immediately after BEGIN", async () => {
    const client = scripted();
    await pgQuery.withTransaction(async () => 42);
    const policy = client.statements[1];
    expect(policy).toContain("SET LOCAL TIME ZONE 'UTC'");
    expect(policy).toContain("lock_timeout = '500ms'");
    expect(policy).toContain("statement_timeout = '5s'");
    expect(policy).toContain("idle_in_transaction_session_timeout = '5s'");
    // PostgreSQL 17 only, so it is guarded rather than issued unconditionally.
    expect(policy).toContain("transaction_timeout");
    expect(policy).toContain("server_version_num");
  });

  it.each(["BEGIN", "SET LOCAL"])(
    "rolls back and never runs the callback when %s fails",
    async (seam) => {
      const boom = new Error("public-fixture");
      const client = scripted((text) => {
        if (text.startsWith(seam)) throw boom;
        return undefined;
      });
      let ran = false;
      await expect(
        pgQuery.withTransaction(async () => {
          ran = true;
          return 42;
        })
      ).rejects.toBe(boom);
      expect(ran).toBe(false);
      expect(client.statements).toContain("ROLLBACK");
      expect(client.releases).toEqual([false]);
    }
  );

  it("preserves the callback's error and rolls back", async () => {
    const boom = new Error("work");
    const client = scripted();
    await expect(
      pgQuery.withTransaction(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(client.statements).toContain("ROLLBACK");
    expect(client.releases).toEqual([false]);
  });

  it("destroys the client when the rollback itself fails", async () => {
    const boom = new Error("work");
    const client = scripted((text) => {
      if (text === "ROLLBACK") throw new Error("rollback");
      return undefined;
    });
    await expect(
      pgQuery.withTransaction(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    // A client whose transaction state is unknown must not be pooled.
    expect(client.releases).toEqual([true]);
  });

  it("reports a failed COMMIT as an unknown outcome, not a rollback", async () => {
    const client = scripted((text) => {
      if (text === "COMMIT") throw new Error("socket");
      return undefined;
    });
    await expect(
      pgQuery.withTransaction(async () => 42)
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(client.releases).toEqual([true]);
  });

  it("refuses to report success when COMMIT answers with a ROLLBACK tag", async () => {
    // A callback that swallows a statement error leaves the transaction
    // aborted; returning normally here would report a write that never landed.
    const client = scripted((text) =>
      text === "COMMIT" ? { command: "ROLLBACK", rows: [] } : undefined
    );
    await expect(pgQuery.withTransaction(async () => 42)).rejects.toThrow(
      "transaction_was_aborted"
    );
    expect(client.releases).toEqual([false]);
  });

  it("fails and destroys the client when the backend dies between queries", async () => {
    const boom = new Error("terminating connection");
    const client = scripted();
    await expect(
      pgQuery.withTransaction(async () => {
        // With no listener attached this escapes as an unhandled EventEmitter
        // error rather than failing the transaction.
        client.emit("error", boom);
        return 42;
      })
    ).rejects.toBe(boom);
    expect(client.releases).toEqual([true]);
    // A discarded client keeps the listener: it may emit again asynchronously.
    expect(client.listenerCount("error")).toBe(1);
  });

  it("propagates a failure to acquire a connection", async () => {
    const boom = new Error("pool exhausted");
    mockConnectQueue.push(boom);
    await expect(pgQuery.withTransaction(async () => 42)).rejects.toBe(boom);
  });
});
