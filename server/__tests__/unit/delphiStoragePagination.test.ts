jest.mock("../../src/config", () => ({__esModule:true,default:jest.requireActual("../../src/config").default}));
jest.mock("../../src/utils/logger", () => ({__esModule:true,default:{debug:jest.fn(),error:jest.fn(),warn:jest.fn(),info:jest.fn()}}));
jest.mock("../../src/utils/dynamoClient", () => ({makeDynamoClient:jest.fn(() => {throw new Error("DynamoDB must not be constructed");})}));
jest.mock("../../src/utils/delphiResults", () => {
  const send = jest.fn();
  return {send, resultClient: () => ({send})};
});
import {makeDynamoClient} from "../../src/utils/dynamoClient";
import DynamoStorageService from "../../src/utils/storage";
const {send} = jest.requireMock("../../src/utils/delphiResults");

const item = (key: string, report_data: string) => ({rid_section_model:key, timestamp:"2026-01-01T00:00:00Z", report_data});
beforeEach(() => { jest.clearAllMocks(); send.mockReset(); });

test("report reader follows an empty filtered page and retains later row order and JSON string bytes", async () => {
  const bytes=['{"text":"first  Ω","nested":[1,2]}','{"text":"second\\nline"}'];
  send.mockResolvedValueOnce({Items:[], LastEvaluatedKey:{rid_section_model:"generated-other#0999"}})
    .mockResolvedValueOnce({Items:[item("rlocalpage#section-a",bytes[0]), item("rlocalpage#section-b",bytes[1])]});
  const result=await new DynamoStorageService("report_narrative_store").getAllByReportID("rlocalpage#");
  expect(result.success).toBe(true);
  expect(result.data?.map(entry=>entry.rid_section_model)).toEqual(["rlocalpage#section-a","rlocalpage#section-b"]);
  expect(result.data?.map(entry=>entry.report_data)).toEqual(bytes);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({rid_section_model:"generated-other#0999"});
  expect(makeDynamoClient).not.toHaveBeenCalled();
});

test("a changed generation on a later page refuses partial report success", async () => {
  send.mockResolvedValueOnce({Items:[item("rlocalpage#0000","stored")], LastEvaluatedKey:{rid_section_model:"rlocalpage#0000"}})
    .mockRejectedValueOnce(new Error("result generation changed; restart pagination"));
  const result=await new DynamoStorageService("report_narrative_store").getAllByReportID("rlocalpage#");
  expect(result.success).toBe(false);
  expect(result.data).toBeUndefined();
  expect(result.error?.message).toContain("generation changed");
  expect(send).toHaveBeenCalledTimes(2);
  expect(makeDynamoClient).not.toHaveBeenCalled();
});
