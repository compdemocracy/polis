jest.mock("../../src/db/pg-query", () => ({__esModule:true,default:{queryP:jest.fn()}}));
jest.mock("../../src/utils/logger", () => ({__esModule:true,default:{warn:jest.fn(),info:jest.fn()}}));
jest.mock("@aws-sdk/client-dynamodb", () => ({DynamoDB:jest.fn(() => {throw new Error("AWS must not be constructed");})}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({DynamoDBDocument:{from:jest.fn(() => {throw new Error("AWS must not be constructed");})}}));
import pg from "../../src/db/pg-query";
import {assessConversationLiveness} from "../../src/routes/delphi/jobGuard";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DELPHI_RESULT_BACKEND="postgres";
  process.env.DELPHI_RESULT_ENV="generated";
  process.env.DELPHI_RESULT_SCOPE="published";
});
afterAll(() => {
  delete process.env.DELPHI_RESULT_BACKEND;
  delete process.env.DELPHI_RESULT_ENV;
  delete process.env.DELPHI_RESULT_SCOPE;
});

test("Postgres liveness uses bound namespace and one authoritative snapshot without AWS",async () => {
  (pg.queryP as jest.Mock).mockResolvedValue([
    {job_id:"finished",status:"COMPLETED",work_live:false},
    {job_id:"unconfirmed-process",status:"FAILED",work_live:true},
    {job_id:"provider-pending",status:"COMPLETED",work_live:true}
  ]);
  const store={sweepConversation:jest.fn()};
  const result=await assessConversationLiveness("42' OR TRUE",store as any);
  expect(result.complete).toBe(true);
  expect([...result.liveByJobId]).toEqual([["finished",false],["unconfirmed-process",true],["provider-pending",true]]);
  expect(result.rowsByJobId.get("finished").status).toBe("COMPLETED");
  expect(store.sweepConversation).not.toHaveBeenCalled();
  expect(pg.queryP).toHaveBeenCalledTimes(1);
  const [sql,values]=(pg.queryP as jest.Mock).mock.calls[0];
  expect(values).toEqual(["generated","42' OR TRUE","published"]);
  expect(sql).not.toContain("42' OR TRUE");
  expect(sql).toContain("process_exit_confirmed_at IS NULL");
  expect(sql).toContain("submission_unknown");
});

test("Postgres failure stays uncertain without falling back to Dynamo",async () => {
  (pg.queryP as jest.Mock).mockRejectedValue(new Error("database unavailable"));
  const store={sweepConversation:jest.fn()};
  const result=await assessConversationLiveness("42",store as any);
  expect(result.complete).toBe(false);
  expect(result.liveByJobId.size).toBe(0);
  expect(store.sweepConversation).not.toHaveBeenCalled();
});

test("missing result environment refuses an unscoped query",async () => {
  delete process.env.DELPHI_RESULT_ENV;
  await expect(assessConversationLiveness("42")).rejects.toThrow("DELPHI_RESULT_ENV");
  expect(pg.queryP).not.toHaveBeenCalled();
});

test("legacy backend preserves the supplied admission store",async () => {
  process.env.DELPHI_RESULT_BACKEND="dynamodb";
  const store={sweepConversation:jest.fn().mockResolvedValue({kind:"none"})};
  expect((await assessConversationLiveness("42",store as any)).complete).toBe(true);
  expect(store.sweepConversation).toHaveBeenCalledWith("42");
  expect(pg.queryP).not.toHaveBeenCalled();
});
