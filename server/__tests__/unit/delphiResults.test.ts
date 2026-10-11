jest.mock("../../src/db/pg-query", () => ({__esModule:true,default:{queryP:jest.fn()}}));
import pg from "../../src/db/pg-query";
import {sendPostgresResult,sqlPredicate,resultClient,decodeAttribute} from "../../src/utils/delphiResults";
import {encodeFamily} from "../../src/utils/delphiStorageCodec";
class QueryCommand { constructor(public input:any) {} }
class GetCommand { constructor(public input:any) {} }
const family="Delphi_CommentEmbeddings";
const row=(id:number,generation="1",scope_key="scope")=>({zid:1,scope_key,generation,item:{conversation_id:{S:"1"},comment_id:{N:String(id)}}});

beforeEach(()=>{jest.clearAllMocks();process.env.DELPHI_RESULT_BACKEND="postgres";process.env.DELPHI_RESULT_ENV="generated";delete process.env.DELPHI_RESULT_SCOPE;});
afterAll(()=>{delete process.env.DELPHI_RESULT_BACKEND;delete process.env.DELPHI_RESULT_ENV;});

test("key expressions use parameters for untrusted values",()=>{
 const values:any[]=[];
 const text=sqlPredicate("#c = :c AND begins_with(topic_key, :prefix)",{ExpressionAttributeNames:{"#c":"conversation_id"},ExpressionAttributeValues:{":c":"1' OR TRUE",":prefix":"%_"}},values);
 expect(text).not.toContain("1' OR TRUE");expect(text).toContain("starts_with");expect(values).toContain('%_');
});
test("pagination carries generation and refuses mixed snapshots",async()=>{
 (pg.queryP as jest.Mock).mockResolvedValue([row(0),row(1)]);
 const first=await sendPostgresResult(new QueryCommand({TableName:family,Limit:1}));
 expect(first.Items[0].comment_id).toBe(0);
 const second=await sendPostgresResult(new QueryCommand({TableName:family,Limit:1,ExclusiveStartKey:first.LastEvaluatedKey}));
 expect(second.Items[0].comment_id).toBe(1);
 (pg.queryP as jest.Mock).mockResolvedValue([row(0,"2"),row(1,"2")]);
 await expect(sendPostgresResult(new QueryCommand({TableName:family,ExclusiveStartKey:first.LastEvaluatedKey}))).rejects.toThrow("generation changed");
});
test("SQL is scoped to environment and configured publication",async()=>{
 process.env.DELPHI_RESULT_SCOPE="selected";(pg.queryP as jest.Mock).mockResolvedValue([row(0)]);
 await sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :id",ExpressionAttributeValues:{":id":"1"}}));
 expect((pg.queryP as jest.Mock).mock.calls[0][1]).toEqual(['generated',family,'selected','conversation_id',JSON.stringify({S:'1'})]);
});
test("conflicting published scopes fail visibly",async()=>{
 (pg.queryP as jest.Mock).mockResolvedValue([row(0),{...row(0,"1","other"),item:{...row(0).item,text:{S:"different"}}}]);
 await expect(sendPostgresResult(new QueryCommand({TableName:family}))).rejects.toThrow("Ambiguous");
});
test("Postgres error never creates an AWS client",async()=>{
 const factory=jest.fn();(pg.queryP as jest.Mock).mockRejectedValue(new Error("database unavailable"));
 const client=resultClient(factory);
 await expect(client.send(new QueryCommand({TableName:family}))).rejects.toThrow("database unavailable");
 expect(factory).not.toHaveBeenCalled();
});
test("unsafe integral numeric values fail instead of rounding",()=>{
 expect(()=>decodeAttribute({N:"9007199254740993"})).toThrow("precision");
});

test("ConversationIndex selects newest job by creation time, not UUID",async()=>{
 (pg.queryP as jest.Mock).mockResolvedValueOnce([
  {job_id:"z-older",conversation_id:"1",created_at:"2025-01-01T00:00:00Z",status:"COMPLETED"},
  {job_id:"a-newest",conversation_id:"1",created_at:"2026-01-01T00:00:00Z",status:"COMPLETED"}
 ]).mockResolvedValueOnce([]);
 const reply=await sendPostgresResult(new QueryCommand({TableName:"Delphi_JobQueue",IndexName:"ConversationIndex",ScanIndexForward:false,Limit:1}));
 expect(reply.Items[0].job_id).toBe("a-newest");
});

test("archived metadata preserves NUL, exposes exact unsafe decimal and never replaces a current queue row",async()=>{
 const codec_wire=encodeFamily("Delphi_JobQueue",[
  {job_id:{S:"legacy"},conversation_id:{S:"1"},status:{S:"PROCESSING"},logs:{S:"a\0b"},job_config:{M:{large:{N:"9007199254740993"}}}},
  {job_id:{S:"current"},status:{S:"PROCESSING"}}
 ]).toString();
 (pg.queryP as jest.Mock).mockResolvedValueOnce([{job_id:"current",status:"COMPLETED"}])
 .mockResolvedValueOnce([{zid:1,scope_key:"scope",generation:"4",codec_wire}]);
 const reply=await sendPostgresResult(new QueryCommand({TableName:"Delphi_JobQueue"}));
 const legacy=reply.Items.find((item:any)=>item.job_id==="legacy");
 expect(legacy).toMatchObject({archived:true,logs:"a\0b",status:"PROCESSING",job_config:{large:"9007199254740993"}});
 expect(legacy.unreadable_metadata_reason).toContain("precision");
 expect(legacy.legacy_control_item.job_config.M.large.N).toBe("9007199254740993");
 expect(reply.Items.find((item:any)=>item.job_id==="current").status).toBe("COMPLETED");
});

test("modern job metadata uses the same graph scope as liveness and archived controls",async()=>{
 process.env.DELPHI_RESULT_SCOPE="delphi";
 (pg.queryP as jest.Mock).mockResolvedValue([]);
 await sendPostgresResult(new QueryCommand({TableName:"Delphi_JobQueue"}));
 expect((pg.queryP as jest.Mock).mock.calls).toHaveLength(2);
 for (const [sql,values] of (pg.queryP as jest.Mock).mock.calls) {
  expect(sql).toContain("scope_key=$2");expect(values).toEqual(["generated","delphi"]);
 }
});

test("job get binds current attempt logs while job listings do not fetch log payloads",async()=>{
 const job_id="11111111-1111-1111-1111-111111111111",attempt="22222222-2222-2222-2222-222222222222";
 (pg.queryP as jest.Mock).mockResolvedValueOnce([{job_id,conversation_id:"1"}]).mockResolvedValueOnce([])
 .mockResolvedValueOnce([{value:{attempt_id:attempt}}]).mockResolvedValueOnce([{timestamp:"2026-01-01T00:00:00Z",level:"INFO",message:"actual child output"}]);
 const reply=await sendPostgresResult(new GetCommand({TableName:"Delphi_JobQueue",Key:{job_id}}));
 expect(reply.Item.logs.entries[0].message).toBe("actual child output");expect(reply.Item.log_attempt_id).toBe(attempt);
 const calls=(pg.queryP as jest.Mock).mock.calls;
 expect(calls[2][1]).toEqual(["generated",job_id]);expect(calls[3][1]).toEqual(["generated",attempt]);
 expect(calls[3][0]).toContain("pq_attempt_logs($1::text,$2::uuid,NULL,1000)");
 expect(calls[3][0]).toContain("stream IN ('stdout','stderr')");
});

// A merge must preserve the existing reader without any activation setting.
test.each([undefined, "dynamodb"])("backend %s forwards unchanged to DynamoDB", async backend => {
 if (backend === undefined) delete process.env.DELPHI_RESULT_BACKEND;
 else process.env.DELPHI_RESULT_BACKEND = backend;
 const command = new QueryCommand({TableName:family});
 const response = {Items:[{legacy:true}]};
 const send = jest.fn().mockResolvedValue(response);
 const factory = jest.fn(() => ({send}));
 expect(await resultClient(factory).send(command)).toBe(response);
 expect(send).toHaveBeenCalledWith(command);
 expect(pg.queryP).not.toHaveBeenCalled();
});
