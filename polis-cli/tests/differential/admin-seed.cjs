'use strict';
// Empty local analysis stores enable queue admission and public empty feeds.
// No worker/provider is started; existing missing-store scenarios run first.
if(process.env.P027_NETWORK_INTERNAL!=='1')throw Error('sealed fixture required');
const {DynamoDBClient,CreateTableCommand}=require('/app/node_modules/@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,PutCommand}=require('/app/node_modules/@aws-sdk/lib-dynamodb');
(async()=>{
 const client=new DynamoDBClient({region:'us-east-1',endpoint:'http://dynamodb:8000',credentials:{accessKeyId:'generatedlocal',secretAccessKey:'generatedlocal'}});
 const tables=require('/app/characterization/dynamo-schema.json').tables;
 for(const [TableName,spec] of Object.entries(tables))await client.send(new CreateTableCommand({TableName,...spec}));
 await client.send(new CreateTableCommand({TableName:'Delphi_JobActiveGuard',KeySchema:[{AttributeName:'guard_key',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'guard_key',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST'}));
 await DynamoDBDocumentClient.from(client).send(new PutCommand({TableName:'Delphi_JobQueue',Item:{job_id:'generated-job',conversation_id:'1',report_id:'r2p027generated',status:'COMPLETED',created_at:'2023-11-14T22:13:20.000Z',logs:JSON.stringify({entries:[{timestamp:'2023-11-14T22:13:20.000Z',level:'INFO',message:'Generated completed job'}]})}}));
 console.log(JSON.stringify({tables:Object.keys(tables).length+1,workers:0}));
})().catch(error=>{console.error(JSON.stringify({stage:'admin-store',name:error.name}));process.exit(1)});
