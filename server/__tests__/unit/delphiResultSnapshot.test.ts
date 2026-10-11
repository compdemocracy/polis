import { EventEmitter } from "events";
import pg from "../../src/db/pg-query";
import { resultQuery, withResultSnapshot } from "../../src/utils/delphiResultSnapshot";
jest.mock("../../src/db/pg-query", () => ({__esModule:true, default:{connectResultSnapshot:jest.fn(),queryP:jest.fn()}}));

const client = (rows: (sql: string) => any = () => [{value:1}]) => Object.assign(new EventEmitter(), {
  query: jest.fn(async (sql: string) => ({rows: rows(sql)})), release: jest.fn(),
});
const statements = (c: any) => c.query.mock.calls.map(([sql]: [string]) => sql);
beforeEach(() => { jest.clearAllMocks(); });

test("each read runs in its own read-only snapshot and returns its connection when it ends", async () => {
  const first = client(), second = client();
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await withResultSnapshot(async query => { await query("SELECT topics"); await query("SELECT assignments"); });
  expect(statements(first)).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '30s'; SET LOCAL idle_in_transaction_session_timeout = '30s'",
    "SELECT topics", "SELECT assignments", "ROLLBACK"]);
  expect(first.release).toHaveBeenCalledWith(undefined);
  // The connection is back before the caller's next step: a later read is a new snapshot.
  await resultQuery("SELECT topics");
  expect(pg.connectResultSnapshot).toHaveBeenCalledTimes(2);
  expect(statements(second)).toContain("SELECT topics");
  expect(second.release).toHaveBeenCalledTimes(1);
});

test("a failed statement rolls back and keeps the healthy connection", async () => {
  const failure = new Error("unsupported result index");
  const c = client(sql => { if (sql === "SELECT bad") throw failure; return []; });
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(c);
  await expect(resultQuery("SELECT bad")).rejects.toBe(failure);
  expect(statements(c)).toContain("ROLLBACK");
  expect(c.release).toHaveBeenCalledWith(undefined);
});

test("a connection error is never reused and cannot crash the process", async () => {
  const failure = new Error("idle transaction terminated");
  const c = client();
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(c);
  await expect(withResultSnapshot(async query => {
    await query("SELECT topics");
    c.emit("error", failure);
    return query("SELECT assignments");
  })).rejects.toBe(failure);
  expect(statements(c)).not.toContain("ROLLBACK");
  expect(c.release).toHaveBeenCalledWith(failure);
});

test("failed setup releases the connection", async () => {
  const failure = new Error("begin failed");
  const c = client(sql => { if (sql.startsWith("BEGIN")) throw failure; return []; });
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(c);
  await expect(resultQuery("SELECT topics")).rejects.toBe(failure);
  expect(c.release).toHaveBeenCalledTimes(1);
});
