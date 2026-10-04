import { afterEach, describe, expect, jest, test } from "@jest/globals";
import {
  CLIENT_QUERY_TIMEOUT_MS,
  guardedRead,
  OpsReadError,
  setOpsConnectForTests,
  TRANSACTION_DEADLINE_MS,
} from "../../src/ops/guardedRead";
import { OpsPanelDef, PanelCache } from "../../src/ops/pages";

afterEach(() => {
  setOpsConnectForTests(null);
  jest.useRealTimers();
});

function fakeClient(onQuery: (text: string) => Promise<unknown> | unknown) {
  const log: string[] = [];
  const client = {
    log,
    on: jest.fn(),
    removeListener: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (q: string | { text: string }) => {
      // guardedRead passes a config object (text, values, query_timeout).
      const text = typeof q === "string" ? q : q.text;
      log.push(text);
      const r = await onQuery(text);
      return r || { rows: [] };
    }),
  };
  return client;
}

describe("guardedRead", () => {
  test("wraps the work in a bounded READ ONLY transaction", async () => {
    const client = fakeClient(() => ({ rows: [{ n: 1 }] }));
    setOpsConnectForTests(async () => client as any);
    const rows = await guardedRead((q) => q("SELECT 1 AS n", []));
    expect(rows).toEqual([{ n: 1 }]);
    expect(client.log[0]).toBe("BEGIN READ ONLY");
    expect(client.log[1]).toContain("SET LOCAL statement_timeout = '3000ms'");
    expect(client.log[1]).toContain("SET LOCAL lock_timeout = '100ms'");
    expect(client.log[2]).toBe("SELECT 1 AS n");
    expect(client.log[3]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledWith(false);
  });

  test("admits one transaction at a time per process", async () => {
    let active = 0;
    let peak = 0;
    const client = fakeClient(async (text) => {
      if (text.startsWith("SELECT")) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }
    });
    setOpsConnectForTests(async () => client as any);
    await Promise.all(
      [1, 2, 3, 4].map(() => guardedRead((q) => q("SELECT pg_sleep(0)", [])))
    );
    expect(peak).toBe(1);
  });

  test.each([
    ["57014", "timeout"],
    ["55P03", "lock_timeout"],
    ["42P01", "db_error"],
  ])(
    "SQLSTATE %s becomes %s, rolled back, never driver text",
    async (code, reason) => {
      const client = fakeClient((text) => {
        if (text.startsWith("SELECT")) {
          throw Object.assign(new Error("driver text with details"), { code });
        }
      });
      setOpsConnectForTests(async () => client as any);
      const err = await guardedRead((q) => q("SELECT 1", [])).catch((e) => e);
      expect(err).toBeInstanceOf(OpsReadError);
      expect(err.reason).toBe(reason);
      expect(err.message).not.toContain("driver text");
      expect(client.log).toContain("ROLLBACK");
      expect(client.release).toHaveBeenCalledWith(false);
    }
  );

  test("a failed ROLLBACK discards the client", async () => {
    const client = fakeClient((text) => {
      if (text.startsWith("SELECT") || text === "ROLLBACK")
        throw new Error("gone");
    });
    setOpsConnectForTests(async () => client as any);
    await expect(guardedRead((q) => q("SELECT 1", []))).rejects.toBeInstanceOf(
      OpsReadError
    );
    expect(client.release).toHaveBeenCalledWith(true);
  });

  test("a pool that cannot hand out a client fails as pool_busy and the late client is released", async () => {
    jest.useFakeTimers();
    const client = fakeClient(() => undefined);
    let hand: (c: unknown) => void = () => undefined;
    setOpsConnectForTests(() => new Promise((r) => (hand = r as any)));
    const pending = guardedRead((q) => q("SELECT 1", [])).catch((e) => e);
    await jest.advanceTimersByTimeAsync(3001);
    const err = await pending;
    expect(err.reason).toBe("pool_busy");
    hand(client);
    await Promise.resolve();
    expect(client.release).toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("guardedRead client-side bounds (a server answer that never comes)", () => {
  test("every statement carries query_timeout", async () => {
    const client = fakeClient(() => ({ rows: [] }));
    setOpsConnectForTests(async () => client as any);
    await guardedRead((q) => q("SELECT 1", []));
    for (const [arg] of client.query.mock.calls as any[]) {
      expect(arg.query_timeout).toBe(CLIENT_QUERY_TIMEOUT_MS);
    }
    expect(CLIENT_QUERY_TIMEOUT_MS).toBeGreaterThan(3000);
  });

  test("pg's read timeout is reported as timeout, the client is destroyed without a ROLLBACK, and the next read runs", async () => {
    let first = true;
    const client = fakeClient((text) => {
      if (text === "SELECT stuck" && first) {
        first = false;
        throw new Error("Query read timeout");
      }
    });
    setOpsConnectForTests(async () => client as any);
    const err = await guardedRead((q) => q("SELECT stuck", [])).catch((e) => e);
    expect(err).toBeInstanceOf(OpsReadError);
    expect(err.reason).toBe("timeout");
    expect(client.log).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
    await expect(guardedRead((q) => q("SELECT 1", []))).resolves.toEqual([]);
  });

  test("a transaction past its deadline frees the mutex and destroys the client", async () => {
    jest.useFakeTimers();
    const stuck = fakeClient((text) =>
      text === "SELECT never" ? new Promise(() => undefined) : undefined
    );
    const fresh = fakeClient(() => ({ rows: [{ ok: 1 }] }));
    let n = 0;
    setOpsConnectForTests(async () => (n++ === 0 ? stuck : fresh) as any);
    const pending = guardedRead((q) => q("SELECT never", [])).catch((e) => e);
    const next = guardedRead((q) => q("SELECT 1", []));
    await jest.advanceTimersByTimeAsync(TRANSACTION_DEADLINE_MS + 1);
    const err = await pending;
    expect(err).toBeInstanceOf(OpsReadError);
    expect(err.reason).toBe("timeout");
    expect(stuck.release).toHaveBeenCalledTimes(1);
    expect(stuck.release).toHaveBeenCalledWith(true);
    await expect(next).resolves.toEqual([{ ok: 1 }]);
  });
});

describe("PanelCache", () => {
  function panel(load: OpsPanelDef["load"]): OpsPanelDef {
    return {
      id: "p",
      title: "P",
      source: "test",
      ttl_s: 60,
      columns: [],
      load,
    };
  }

  test("is lazy, single-flight and serves from memory inside the TTL", async () => {
    let now = 1_000_000;
    const cache = new PanelCache(() => now);
    let release: () => void = () => undefined;
    const load = jest.fn(
      () =>
        new Promise<any>((r) => {
          release = () => r([{ window: "w", n: 1 }]);
        })
    );
    const def = panel(load as any);
    expect(load).not.toHaveBeenCalled();
    const a = cache.get("page", def);
    const b = cache.get("page", def);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ra.hit).toBe(false);
    expect(rb.hit).toBe(true);
    now += 59_000;
    expect((await cache.get("page", def)).hit).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    now += 2_000;
    const next = cache.get("page", def);
    release();
    await next;
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a failure keeps the last good rows and backs off, doubling until a success", async () => {
    let now = 0;
    const cache = new PanelCache(() => now);
    let fail = false;
    const load = jest.fn(async () => {
      if (fail) throw new OpsReadError("timeout");
      return [{ window: "w", n: 5 }];
    });
    const def = panel(load as any);
    await cache.get("page", def);
    fail = true;
    now += 61_000;
    const first = await cache.get("page", def);
    expect(first.panel).toMatchObject({
      status: "unavailable",
      reason: "timeout",
    });
    expect(first.panel.rows).toEqual([{ window: "w", n: 5 }]);
    // Backoff 1x: no new read for 60 s.
    now += 59_000;
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(2);
    now += 2_000;
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(3);
    // Backoff 2x: no new read for 120 s.
    now += 119_000;
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(3);
    fail = false;
    now += 2_000;
    const ok = await cache.get("page", def);
    expect(ok.panel.status).toBe("ok");
    expect(load).toHaveBeenCalledTimes(4);
  });

  test("a failure on a long-TTL panel is retried after 60 s, and the hold never passes 5 minutes", async () => {
    let now = 0;
    const cache = new PanelCache(() => now);
    const load = jest.fn(async () => {
      throw new OpsReadError("timeout");
    });
    const def = { ...panel(load as any), ttl_s: 15 * 60 };
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(1);
    // Hold 1x: 60 s, not the 15-minute TTL.
    now += 59_000;
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(1);
    now += 2_000;
    await cache.get("page", def);
    expect(load).toHaveBeenCalledTimes(2);
    // Keep failing: holds 120, 240, then capped at 300 s from there on.
    for (const hold of [120_000, 240_000, 300_000, 300_000, 300_000]) {
      const calls = load.mock.calls.length;
      now += hold - 1_000;
      await cache.get("page", def);
      expect(load).toHaveBeenCalledTimes(calls);
      now += 2_000;
      await cache.get("page", def);
      expect(load).toHaveBeenCalledTimes(calls + 1);
      now -= 1_000;
    }
  });

  test("an unexpected error is reported with a closed reason", async () => {
    const cache = new PanelCache(() => 0);
    const { panel: p } = await cache.get(
      "page",
      panel(async () => {
        throw new Error("something with details");
      })
    );
    expect(p).toMatchObject({ status: "unavailable", reason: "error" });
  });
});
