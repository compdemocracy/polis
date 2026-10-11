import { EventEmitter } from "events";
import pg from "../../src/db/pg-query";
import { delphiResultSnapshot, resultQuery } from "../../src/utils/delphiResultSnapshot";
jest.mock("../../src/db/pg-query", () => ({__esModule:true, default:{connectResultSnapshot:jest.fn(),queryP:jest.fn()}}));
jest.mock("../../src/utils/logger", () => ({__esModule:true,default:{error:jest.fn()}}));
const tick = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => { jest.clearAllMocks(); process.env.DELPHI_RESULT_BACKEND="postgres"; });
afterAll(() => { delete process.env.DELPHI_RESULT_BACKEND; });
test("parallel family reads share a transaction and finish/close release once", async () => {
  const client = Object.assign(new EventEmitter(), {query:jest.fn().mockResolvedValue({rows:[{value:1}]}),release:jest.fn()});
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(client);
  const res = new EventEmitter();
  await new Promise<void>((resolve,reject) => delphiResultSnapshot({} as any,res as any, (() => {
    Promise.all([resultQuery("SELECT topics"),resultQuery("SELECT assignments")]).then(() => resolve(),reject);
  }) as any));
  expect(pg.connectResultSnapshot).toHaveBeenCalledTimes(1);
  expect(client.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  res.emit("finish"); res.emit("close"); await tick();
  expect(client.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(1);
  expect(client.release).toHaveBeenCalledTimes(1);
});
test("requests without results acquire no client, and failed setup releases it", async () => {
  const empty = new EventEmitter();
  delphiResultSnapshot({} as any,empty as any, (()=>{}) as any);
  empty.emit("close"); expect(pg.connectResultSnapshot).not.toHaveBeenCalled();
  const failure = new Error("begin failed");
  const client = Object.assign(new EventEmitter(), {query:jest.fn().mockRejectedValue(failure),release:jest.fn()});
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(client);
  const res = new EventEmitter();
  await new Promise<void>((resolve,reject) => delphiResultSnapshot({} as any,res as any, (() => {
    resultQuery("SELECT topics").then(()=>reject(new Error("expected failure")),error=>{
      expect(error).toBe(failure); resolve();
    });
  }) as any));
  res.emit("close"); await tick();
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledWith(failure);
});

test("connection errors cannot crash the process or reuse a failed snapshot", async () => {
  const client = Object.assign(new EventEmitter(), {query:jest.fn().mockResolvedValue({rows:[]}),release:jest.fn()});
  (pg.connectResultSnapshot as jest.Mock).mockResolvedValue(client);
  const res = new EventEmitter();
  const failure = new Error("idle transaction terminated");
  await new Promise<void>((resolve,reject) => delphiResultSnapshot({} as any,res as any, (() => {
    (async () => {
      await resultQuery("SELECT topics");
      client.emit("error",failure);
      await expect(resultQuery("SELECT assignments")).rejects.toBe(failure);
      resolve();
    })().catch(reject);
  }) as any));
  res.emit("finish"); await tick();
  expect(client.release).toHaveBeenCalledWith(failure);
});
