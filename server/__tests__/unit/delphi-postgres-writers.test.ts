import {randomUUID} from "crypto";
import pg from "../../src/db/pg-query";
import {admitDelphiJob} from "../../src/routes/delphi/jobGuard";
import {resultClient,sendPostgresResult} from "../../src/utils/delphiResults";
import {PutCommand,DeleteCommand,GetCommand} from "@aws-sdk/lib-dynamodb";

const campaign = process.env.DELPHI_WRITER_PROOF === "1" ? describe : describe.skip;
campaign("Postgres writer real SQL boundary with Dynamo stopped",()=>{
  beforeAll(()=>{
    process.env.DELPHI_RESULT_BACKEND="postgres";
    process.env.DELPHI_RESULT_ENV="writer-node-proof";
    process.env.DELPHI_RESULT_SCOPE="delphi";
    process.env.DELPHI_WRITER_CODE_SHA="d6f9ed6093e46b3c07db98f3c644bbbd9c4e87cd";
  });
  test("synchronous adapters put and delete with no legacy client construction",async()=>{
    const factory=jest.fn(()=>{throw new Error("Dynamo constructed");});
    const client=resultClient(factory as any);
    const key={zid_topic_jobid:"1#node#generated"};
    await client.send(new PutCommand({TableName:"Delphi_CollectiveStatement",Item:{...key,text:"node-generated"}}));
    expect((await sendPostgresResult(new GetCommand({TableName:"Delphi_CollectiveStatement",Key:key}))).Item.text).toBe("node-generated");
    await client.send(new DeleteCommand({TableName:"Delphi_CollectiveStatement",Key:key}));
    expect((await sendPostgresResult(new GetCommand({TableName:"Delphi_CollectiveStatement",Key:key}))).Item).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
  test("both route payloads admit; non-UUID batch ids normalize; nested model/config survives",async()=>{
    const key=randomUUID();
    const request={scope:{conversationId:"2",jobType:"FULL_PIPELINE",jobConfig:JSON.stringify({include_moderation:false})},
      jobItem:{job_id:randomUUID()},idempotencyKey:key};
    const first=await admitDelphiJob(request);
    expect(first.outcome).toBe("created");
    expect((await admitDelphiJob(request)).jobId).toBe(first.jobId);
    expect((await admitDelphiJob({...request,scope:{...request.scope,jobConfig:'{"changed":true}'}})).outcome).toBe("idempotency_conflict");
    const nested={job_type:"CREATE_NARRATIVE_BATCH",stages:[{config:{model:"fixed-proof-model",max_batch_size:7,no_cache:true}}]};
    const batch=await admitDelphiJob({scope:{conversationId:"1",reportId:"rlocalwriter",jobType:"CREATE_NARRATIVE_BATCH",jobConfig:JSON.stringify(nested)},
      jobItem:{job_id:"batch_report_generated_123_suffix"},idempotencyKey:randomUUID()});
    expect(batch.outcome).toBe("created");
    expect(batch.jobId).toMatch(/^[0-9a-f-]{36}$/);
    const config=await pg.queryP<{job_config:any}>("SELECT job_config FROM delphi_result_jobs WHERE env='writer-node-proof' AND job_id=$1",[batch.jobId]);
    expect(config[0].job_config).toMatchObject({model:"fixed-proof-model",batch_size:7,no_cache:true,include_moderation:true,result_backend:"postgres"});
  });
  test("Postgres selection refuses unsupported and invalid writes without fallback",async()=>{
    await expect(sendPostgresResult(new PutCommand({TableName:"Delphi_JobQueue",Item:{job_id:"generated"}}))).rejects.toThrow();
    await expect(sendPostgresResult(new PutCommand({TableName:"Delphi_CollectiveStatement",Item:{zid_topic_jobid:"bad#key"}}))).rejects.toThrow();
  });
});
