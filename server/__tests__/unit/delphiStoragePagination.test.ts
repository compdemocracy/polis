jest.mock("../../src/db/pg-query", () => ({__esModule:true,default:{queryP:jest.fn()}}));
jest.mock("../../src/config", () => ({__esModule:true,default:jest.requireActual("../../src/config").default}));
jest.mock("../../src/utils/logger", () => ({__esModule:true,default:{debug:jest.fn(),error:jest.fn(),warn:jest.fn()}}));
jest.mock("../../src/utils/dynamoClient", () => ({makeDynamoClient:jest.fn(() => {throw new Error("DynamoDB must not be constructed");})}));
import pg from "../../src/db/pg-query";
import {makeDynamoClient} from "../../src/utils/dynamoClient";
import DynamoStorageService from "../../src/utils/storage";

const row=(key:string,report_data:string,generation="1") => ({
  zid:1,scope_key:"report",generation,item:{
    rid_section_model:{S:key},timestamp:{S:"2026-01-01T00:00:00Z"},report_data:{S:report_data}
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DELPHI_RESULT_BACKEND="postgres";
  process.env.DELPHI_RESULT_ENV="generated";
  process.env.DELPHI_RESULT_SCOPE="report";
});
afterAll(() => {
  delete process.env.DELPHI_RESULT_BACKEND;
  delete process.env.DELPHI_RESULT_ENV;
  delete process.env.DELPHI_RESULT_SCOPE;
});

test("report reader follows an empty filtered page and retains later row order and JSON string bytes",async () => {
  const bytes=['{"text":"first  Ω","nested":[1,2]}','{"text":"second\\nline"}'];
  const rows=Array.from({length:1000},(_,i)=>row(`generated-other#${String(i).padStart(4,"0")}`,"unrelated"));
  rows.push(row("rlocalpage#section-a",bytes[0]),row("rlocalpage#section-b",bytes[1]));
  (pg.queryP as jest.Mock).mockResolvedValue(rows);
  const result=await new DynamoStorageService("report_narrative_store").getAllByReportID("rlocalpage#");
  expect(result.success).toBe(true);
  expect(result.data?.map(item=>item.rid_section_model)).toEqual(["rlocalpage#section-a","rlocalpage#section-b"]);
  expect(result.data?.map(item=>item.report_data)).toEqual(bytes);
  expect(pg.queryP).toHaveBeenCalledTimes(2);
  expect(makeDynamoClient).not.toHaveBeenCalled();
});

test("a changed generation on a later page refuses partial report success",async () => {
  const rows=Array.from({length:1001},(_,i)=>row(`rlocalpage#${String(i).padStart(4,"0")}`,"stored"));
  (pg.queryP as jest.Mock).mockResolvedValueOnce(rows)
    .mockResolvedValueOnce(rows.map(item=>({...item,generation:"2"})));
  const result=await new DynamoStorageService("report_narrative_store").getAllByReportID("rlocalpage#");
  expect(result.success).toBe(false);
  expect(result.data).toBeUndefined();
  expect(result.error?.message).toContain("generation changed");
  expect(pg.queryP).toHaveBeenCalledTimes(2);
  expect(makeDynamoClient).not.toHaveBeenCalled();
});
