jest.mock("../../src/db/pg-query", () => ({__esModule:true,default:{queryP:jest.fn(),connectResultSnapshot:jest.fn()}}));
import { EventEmitter } from "events";
import pg from "../../src/db/pg-query";
import {sendPostgresResult,sqlPredicate,resultClient,decodeAttribute,itemBytes} from "../../src/utils/delphiResults";
import {encodeFamily} from "../../src/utils/delphiStorageCodec";
class QueryCommand { constructor(public input:any) {} }
class GetCommand { constructor(public input:any) {} }
const family="Delphi_CommentEmbeddings";
/** Statements other than transaction control reach this mock. */
const sql = jest.fn();
const row=(id:number,scope_key="scope",text?:string)=>({zid:1,scope_key,item_key:[{S:"1"},{N:String(id)}],
 item:{conversation_id:{S:"1"},comment_id:{N:String(id)},...(text ? {text:{S:text}} : {})},sort_n:String(id),sort_t:"",hash_t:'{"S": "1"}'});
const isPage = (text:string) => text.includes("pd_result_page");

beforeEach(()=>{
 jest.clearAllMocks();sql.mockReset();
 (pg.connectResultSnapshot as jest.Mock).mockImplementation(async()=>Object.assign(new EventEmitter(),{
  query:jest.fn(async(text:string,params:any[])=>/^(BEGIN|SET LOCAL|ROLLBACK)/.test(text)?{rows:[]}:{rows:await sql(text,params)}),release:jest.fn()}));
 process.env.DELPHI_RESULT_BACKEND="postgres";process.env.DELPHI_RESULT_ENV="generated";delete process.env.DELPHI_RESULT_SCOPE;
});
afterAll(()=>{delete process.env.DELPHI_RESULT_BACKEND;delete process.env.DELPHI_RESULT_ENV;});

test("key expressions use parameters for untrusted values",()=>{
 const values:any[]=[];
 const text=sqlPredicate("#c = :c AND begins_with(topic_key, :prefix)",{ExpressionAttributeNames:{"#c":"conversation_id"},ExpressionAttributeValues:{":c":"1' OR TRUE",":prefix":"%_"}},values);
 expect(text).not.toContain("1' OR TRUE");expect(text).toContain("starts_with");expect(values).toContain('%_');
});

test("a conversation query reads only that conversation's served family, with bound values",async()=>{
 process.env.DELPHI_RESULT_SCOPE="selected";sql.mockResolvedValue([row(0)]);
 await sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :id",ExpressionAttributeValues:{":id":"1' OR TRUE"}}));
 const [text,values]=sql.mock.calls[0];
 expect(text).toContain("pd_result_page($1,$4::integer[],$3,$2,");expect(text).not.toContain("OR TRUE");
 expect(values.slice(0,4)).toEqual(["generated",family,"selected",[]]);
 await sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :id",ExpressionAttributeValues:{":id":"1"}}));
 expect(sql.mock.calls[1][1].slice(0,5)).toEqual(["generated",family,"selected",[1],JSON.stringify({S:"1"})]);
});

test("a report key resolves its conversation through reports",async()=>{
 sql.mockResolvedValue([]);
 await sendPostgresResult(new QueryCommand({TableName:"report_narrative_store",KeyConditionExpression:"rid_section_model = :r",ExpressionAttributeValues:{":r":"rabc#topics#openai"}}));
 expect(sql.mock.calls[0][0]).toContain("ARRAY(SELECT zid FROM public.reports WHERE report_id=$3)");
 expect(sql.mock.calls[0][1][2]).toBe("rabc");
});

test("Limit pages carry the keyset position and the publication generations",async()=>{
 sql.mockImplementation(async(text:string,values:any[])=>{
  if (!isPage(text)) return [{zid:1,scope_key:"scope",generation:"1"}];
  const after=values.at(-2)?JSON.parse(values.at(-2)):null;
  return [row(0),row(1),row(2)].filter(r=>!after||Number(r.sort_n)>Number(after.n)).slice(0,values.at(-1));
 });
 const first=await sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"},Limit:2}));
 expect(first.Items.map((i:any)=>i.comment_id)).toEqual([0,1]);
 expect(first.LastEvaluatedKey).toMatchObject({conversation_id:"1",comment_id:1,_polisPgGenerations:{"1:scope":"1"},_polisPgAfter:{n:"1"}});
 const second=await sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"},Limit:2,ExclusiveStartKey:first.LastEvaluatedKey}));
 expect(second.Items.map((i:any)=>i.comment_id)).toEqual([2]);
 expect(second.LastEvaluatedKey).toBeUndefined();
 sql.mockImplementation(async(text:string)=>isPage(text)?[row(2)]:[{zid:1,scope_key:"scope",generation:"2"}]);
 await expect(sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"},ExclusiveStartKey:first.LastEvaluatedKey}))).rejects.toThrow("generation changed");
});

test("conflicting published scopes fail visibly",async()=>{
 sql.mockResolvedValue([row(0,"one","a"),row(0,"two","b")]);
 await expect(sendPostgresResult(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"}}))).rejects.toThrow("Ambiguous");
});

test("DynamoDB item sizes: base-100 numbers, 3-byte containers plus 1 per element",()=>{
 // Pinned against DynamoDB Local by the parity suite's page boundaries.
 expect(itemBytes({n:{N:"10000"}})).toBe(1+2);
 expect(itemBytes({n:{N:"10001"}})).toBe(1+4);
 expect(itemBytes({n:{N:"1.5"}})).toBe(1+3);
 expect(itemBytes({n:{N:"-0.00125"}})).toBe(1+4);
 expect(itemBytes({s:{S:"é"},b:{BOOL:true},z:{NULL:true}})).toBe(1+2+1+1+1+1);
 expect(itemBytes({l:{L:[{S:"ab"},{N:"1"}]},m:{M:{aa:{S:"xy"}}}})).toBe(1+3+1+2+1+2+1+3+1+2+2);
});

test("Postgres error never creates an AWS client",async()=>{
 const factory=jest.fn();sql.mockRejectedValue(new Error("database unavailable"));
 const client=resultClient(factory);
 await expect(client.send(new QueryCommand({TableName:family,KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"}}))).rejects.toThrow("database unavailable");
 expect(factory).not.toHaveBeenCalled();
});
test("unsafe integral numeric values fail instead of rounding",()=>{
 expect(()=>decodeAttribute({N:"9007199254740993"})).toThrow("precision");
});

test("ConversationIndex selects newest job by creation time, not UUID, within the conversation",async()=>{
 sql.mockResolvedValueOnce([
  {job_id:"z-older",conversation_id:"1",created_at:"2025-01-01T00:00:00Z",status:"COMPLETED"},
  {job_id:"a-newest",conversation_id:"1",created_at:"2026-01-01T00:00:00Z",status:"COMPLETED"}
 ]).mockResolvedValueOnce([]);
 const reply=await sendPostgresResult(new QueryCommand({TableName:"Delphi_JobQueue",IndexName:"ConversationIndex",
  KeyConditionExpression:"conversation_id = :c",ExpressionAttributeValues:{":c":"1"},ScanIndexForward:false,Limit:1}));
 expect(reply.Items[0].job_id).toBe("a-newest");
 expect(reply.LastEvaluatedKey).toMatchObject({job_id:"a-newest",conversation_id:"1",created_at:"2026-01-01T00:00:00Z"});
 expect(sql.mock.calls[0][0]).toContain("conversation_id=$2");expect(sql.mock.calls[0][1]).toEqual(["generated","1"]);
 expect(sql.mock.calls[1][0]).toContain("zid=$2");expect(sql.mock.calls[1][1]).toEqual(["generated",1]);
});

test("archived metadata preserves NUL, exposes exact unsafe decimal and never replaces a current queue row",async()=>{
 const codec_wire=encodeFamily("Delphi_JobQueue",[
  {job_id:{S:"legacy"},conversation_id:{S:"1"},status:{S:"PROCESSING"},logs:{S:"a\0b"},job_config:{M:{large:{N:"9007199254740993"}}}},
  {job_id:{S:"current"},status:{S:"PROCESSING"}}
 ]).toString();
 sql.mockResolvedValueOnce([{job_id:"current",status:"COMPLETED"}])
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
 sql.mockResolvedValue([]);
 await sendPostgresResult(new QueryCommand({TableName:"Delphi_JobQueue"}));
 expect(sql.mock.calls).toHaveLength(2);
 for (const [text,values] of sql.mock.calls) {
  expect(text).toContain("scope_key=$2");expect(values).toEqual(["generated","delphi"]);
 }
});

test("job get reads the job by id, binds current attempt logs, and skips archives it would hide",async()=>{
 const job_id="11111111-1111-1111-1111-111111111111",attempt="22222222-2222-2222-2222-222222222222";
 sql.mockResolvedValueOnce([{job_id,conversation_id:"1"}])
 .mockResolvedValueOnce([{value:{attempt_id:attempt}}]).mockResolvedValueOnce([{timestamp:"2026-01-01T00:00:00Z",level:"INFO",message:"actual child output"}]);
 const reply=await sendPostgresResult(new GetCommand({TableName:"Delphi_JobQueue",Key:{job_id}}));
 expect(reply.Item.logs.entries[0].message).toBe("actual child output");expect(reply.Item.log_attempt_id).toBe(attempt);
 const calls=sql.mock.calls;
 expect(calls[0][0]).toContain("job_id=$2");expect(calls[0][1]).toEqual(["generated",job_id]);
 expect(calls[1][1]).toEqual(["generated",job_id]);expect(calls[2][1]).toEqual(["generated",attempt]);
 expect(calls[2][0]).toContain("pq_attempt_logs($1::text,$2::uuid,NULL,1000)");
 expect(calls[2][0]).toContain("stream IN ('stdout','stderr')");
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
 expect(pg.connectResultSnapshot).not.toHaveBeenCalled();
});
