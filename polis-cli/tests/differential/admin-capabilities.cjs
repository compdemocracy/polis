'use strict';
// Derive generated local capabilities through the server's existing signer.
// Do not duplicate its legacy key in a test or use real addresses/resources.
if(process.env.P027_NETWORK_INTERNAL!=='1')throw Error('sealed fixture required');
const fs=require('node:fs'),vm=require('node:vm');
const ts=require('/app/node_modules/typescript');
const source=fs.readFileSync('/app/src/routes/notify.ts','utf8');
const start=source.indexOf('function paramsToStringSortedByName(');
const end=source.indexOf('function createNotificationsSubscribeUrl(');
if(start<0||end<=start)throw Error('signer source changed');
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const context={_:require('/app/node_modules/underscore'),crypto:require('node:crypto')};
vm.createContext(context);vm.runInContext(code,context,{timeout:1000});
const out={};
for(const name of ['subscribe','unsubscribe'])out[name]=context.createHmacForQueryParams('api/v3/notifications/'+name,{conversation_id:'2p027generated',email:'owner@example.invalid'});
process.stdout.write(JSON.stringify(out));
