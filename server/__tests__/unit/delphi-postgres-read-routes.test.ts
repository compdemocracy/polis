jest.mock("../../src/db/pg-query",()=>({__esModule:true,default:{queryP:jest.fn()}}));
jest.mock("../../src/utils/logger",()=>({__esModule:true,default:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}}));
jest.mock("../../src/config",()=>({__esModule:true,default:jest.requireActual("../../src/config").default}));
jest.mock("../../src/utils/parameter",()=>({getZidFromReport:jest.fn().mockResolvedValue(1)}));
jest.mock("../../src/routes/delphi/jobGuard",()=>({assessConversationLiveness:jest.fn()}));
jest.mock("@aws-sdk/client-s3",()=>({S3Client:jest.fn(()=>{throw new Error("no S3 allowed")}),ListObjectsV2Command:jest.fn()}));
import pg from "../../src/db/pg-query";
import {S3Client} from "@aws-sdk/client-s3";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {assessConversationLiveness} from "../../src/routes/delphi/jobGuard";
import {handle_GET_delphi_visualizations} from "../../src/routes/delphi/visualizations";
import {getCurrentDelphiJobId} from "../../src/routes/delphi/topicAgenda";
import {encodeFamily} from "../../src/utils/delphiStorageCodec";
beforeEach(()=>{
 jest.clearAllMocks();jest.spyOn(DynamoDBClient.prototype,"send").mockRejectedValue(new Error("no DynamoDB allowed") as never);process.env.DELPHI_RESULT_BACKEND="postgres";process.env.DELPHI_RESULT_ENV="test";process.env.DELPHI_RESULT_SCOPE="delphi";
});
afterAll(()=>{delete process.env.DELPHI_RESULT_BACKEND;delete process.env.DELPHI_RESULT_ENV;delete process.env.DELPHI_RESULT_SCOPE;});
test("agenda attributes selections to the published root, not a newer completed math job",async()=>{
 (pg.queryP as jest.Mock).mockResolvedValue([{job_id:"served-root"}]);
 expect(await getCurrentDelphiJobId("1")).toBe("served-root");
 expect((pg.queryP as jest.Mock).mock.calls[0][0]).toContain("delphi_result_publications");
 expect((pg.queryP as jest.Mock).mock.calls[0][1]).toEqual(["test",1,"delphi"]);
 expect(DynamoDBClient.prototype.send).not.toHaveBeenCalled();
});
test("visualization metadata is local and archived processing controls are never live work",async()=>{
 const codec_wire=encodeFamily("Delphi_JobQueue",[{job_id:{S:"historical"},conversation_id:{S:"1"},created_at:{S:"2026-01-01T00:00:00Z"},status:{S:"PROCESSING"}}]).toString();
 (pg.queryP as jest.Mock).mockResolvedValueOnce([{job_id:"current",conversation_id:"1",created_at:"2026-01-02T00:00:00Z",status:"COMPLETED"}])
 .mockResolvedValueOnce([{zid:1,scope_key:"delphi",generation:"1",codec_wire}]);
 (assessConversationLiveness as jest.Mock).mockResolvedValue({complete:true,liveByJobId:new Map([["current",false]]),rowsByJobId:new Map()});
 const res:any={status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()};
 await handle_GET_delphi_visualizations({query:{report_id:"rlocaltest"}} as any,res);
 expect(res.json.mock.calls[0][0]).toMatchObject({status:"success",visualizations:[],jobs:expect.arrayContaining([
  expect.objectContaining({jobId:"historical",status:"PROCESSING",archived:true,workLive:false}),expect.objectContaining({jobId:"current",workLive:false})
 ])});
 expect(S3Client).not.toHaveBeenCalled();expect(DynamoDBClient.prototype.send).not.toHaveBeenCalled();
});
