import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import pg from "../../src/db/pg-query";
import { getOrCreateUserIDFromOidcSub } from "../../src/auth/create-user";
import { pool, closePool } from "../setup/db-test-helpers";

// Real application pool and real PostgreSQL; only scheduling is controlled.
// Stealing a just-released BEGIN session recreates the production interleaving
// deterministically. A transaction-owned client cannot be stolen this way.
describe("OIDC transaction ownership", () => {
  const suffix = randomUUID();
  const email = `oidc-tx-${suffix}@example.invalid`;
  const sub = `public-fixture-oidc-tx-${suffix}`;
  let uid: number;
  let zid: number;
  let pid: number;

  beforeAll(async () => {
    uid = (await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING uid", [email])).rows[0].uid;
    await pool.query("INSERT INTO oidc_user_mappings (oidc_sub,uid) VALUES ($1,$2)", [sub, uid]);
    zid = (await pool.query("INSERT INTO conversations (owner,topic) VALUES ($1,$2) RETURNING zid", [uid, "Public-fixture OIDC transaction witness"])).rows[0].zid;
    pid = (await pool.query("INSERT INTO participants (uid,zid) VALUES ($1,$2) RETURNING pid", [uid,zid])).rows[0].pid;
  });
  afterAll(async () => {
    await pool.query("DELETE FROM comments WHERE zid=$1", [zid]);
    await pool.query("DELETE FROM participants WHERE zid=$1", [zid]);
    await pool.query("DELETE FROM conversations WHERE zid=$1", [zid]);
    await pool.query("DELETE FROM oidc_user_mappings WHERE uid=$1", [uid]);
    await pool.query("DELETE FROM users WHERE uid=$1 OR email=$2", [uid, `new-${email}`]);
    await closePool();
  });

  test("acknowledged seed survives pool eviction and its tid is never reused", async () => {
    let held: PoolClient | undefined;
    const original = pg.query;
    const spy = jest.spyOn(pg, "query").mockImplementation((sql, ...args) => {
      if (sql === "BEGIN") {
        const callback = args[1];
        return original(sql, args[0], (err: any, result: any) => {
          if (err) return callback(err, result);
          pg.connect().then((client) => { held = client; callback(null, result); }, callback);
        });
      }
      return original(sql, ...args);
    });
    try {
      expect(await getOrCreateUserIDFromOidcSub(sub, { email })).toBe(uid);
    } finally {
      spy.mockRestore();
      held?.release();
    }
    const insert = (txt: string) => pg.queryP(
      "INSERT INTO comments (pid,zid,uid,txt,is_seed) VALUES ($1,$2,$3,$4,true) RETURNING tid",
      [pid,zid,uid,txt]
    ) as Promise<{tid: number}[]>;
    const [seed] = await insert("Public-fixture acknowledged seed");
    // Observe through a different pool, then deterministically evict the last
    // application session (the same rollback as idle eviction, without a timer).
    const visibleBefore = await pool.query("SELECT tid FROM comments WHERE zid=$1 AND tid=$2", [zid,seed.tid]);
    const lastClient = await pg.connect();
    lastClient.release(true);
    const [next] = await insert("Public-fixture subsequent seed");
    const visibleAfter = await pool.query("SELECT tid FROM comments WHERE zid=$1 ORDER BY tid", [zid]);
    expect(visibleBefore.rows).toEqual([{tid: seed.tid}]);
    expect(next.tid).toBeGreaterThan(seed.tid);
    expect(visibleAfter.rows).toEqual([{tid: seed.tid}, {tid: next.tid}]);
  });

  test("new users and replacement mappings commit on the same owned client", async () => {
    const newSub = `${sub}-new`;
    const newEmail = `new-${email}`;
    const newUid = await getOrCreateUserIDFromOidcSub(newSub, {email: newEmail});
    expect((await pool.query("SELECT uid FROM oidc_user_mappings WHERE oidc_sub=$1", [newSub])).rows).toEqual([{uid:newUid}]);
    expect(await getOrCreateUserIDFromOidcSub(`${sub}-replacement`, {email})).toBe(uid);
    expect((await pool.query("SELECT oidc_sub FROM oidc_user_mappings WHERE uid=$1", [uid])).rows).toEqual([{oidc_sub:`${sub}-replacement`}]);
    await pool.query("DELETE FROM oidc_user_mappings WHERE uid=$1", [newUid]);
  });

  test("a rejected mapping write rolls back the preceding user upsert", async () => {
    // Database varchar limit fails the mapping insert AFTER a successful upsert.
    await expect(getOrCreateUserIDFromOidcSub("x".repeat(256), {email, name:"must roll back"})).rejects.toThrow();
    expect((await pool.query("SELECT hname FROM users WHERE uid=$1", [uid])).rows[0].hname).not.toBe("must roll back");
    expect((await pool.query("SELECT oidc_sub FROM oidc_user_mappings WHERE uid=$1", [uid])).rows).toEqual([{oidc_sub:`${sub}-replacement`}]);
  });
});
