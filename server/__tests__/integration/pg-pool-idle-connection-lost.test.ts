/**
 * A pooled connection lost while it sits idle in a pool (a database restart or
 * failover, a dropped network path, pg_terminate_backend) never takes the
 * server down. pg-pool reports that loss as an "error" event on the pool; an
 * "error" event with no listener is thrown from the socket callback, reaches
 * the process 'uncaughtException' handler (src/server-middleware.ts), and that
 * handler exits the process. So every pool in src/db/pg-query.ts that a
 * connect helper reaches must listen: the loss is logged, pg-pool has already
 * dropped the dead connection, and the next checkout gets a live one.
 */
import { afterAll, beforeAll, expect, test } from "@jest/globals";
import dotenv from "dotenv";
import { Pool, PoolClient } from "pg";
import pg from "../../src/db/pg-query";
import { onParticipationPools } from "../../src/db/participation-scope";

dotenv.config({ override: false });

let admin: Pool;

beforeAll(() => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
});

afterAll(async () => {
  await admin.end();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `work` the way a participation route runs its handlers. */
function inParticipationScope<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    onParticipationPools(undefined, undefined, () => {
      work().then(resolve, reject);
    })
  );
}

const POOLS: [string, () => Promise<PoolClient>][] = [
  ["read-write", () => pg.connect()],
  ["read", () => pg.connectReadOnly()],
  ["participation", () => inParticipationScope(() => pg.connect())],
  [
    "participation-read",
    () => inParticipationScope(() => pg.connectReadOnly()),
  ],
  ["result-snapshot", () => pg.connectResultSnapshot()],
  ["agent-exchange", () => pg.connectAgentExchange()],
];

test.each(POOLS)(
  "%s pool: an idle connection lost is logged and the next checkout is answered",
  async (_role, connect) => {
    const client = await connect();
    const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
    const lost = rows[0].pid;
    client.release();

    await admin.query("SELECT pg_terminate_backend($1)", [lost]);
    // Wait for the backend to exit, then for its closed socket to reach the
    // pool, which is where an unlistened "error" event would be thrown.
    for (let i = 0; i < 100; i += 1) {
      const alive = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid = $1",
        [lost]
      );
      if (alive.rowCount === 0) break;
      await wait(20);
    }
    await wait(300);

    const next = await connect();
    try {
      const answer = await next.query(
        "SELECT 42 AS n, pg_backend_pid() AS pid"
      );
      expect(answer.rows[0].n).toBe(42);
      expect(answer.rows[0].pid).not.toBe(lost);
    } finally {
      next.release();
    }
  },
  15000
);
