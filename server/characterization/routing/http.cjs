// Real HTTP transport and unchanged route/helper functions. Authentication and
// parameter parsing are fixed fixture inputs; this is not an auth middleware test.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const express=require('express'),request=require('supertest');
function functions(file,names,bindings,mutation) {
 let source=fs.readFileSync(path.resolve(__dirname,'../../src',file),'utf8');
 if(mutation?.file===file) {
  if(!source.includes(mutation.from))throw Error(`mutation anchor missing: ${mutation.name}`);
  source=source.replace(mutation.from,mutation.to);
 }
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const found=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
 if(found.length!==names.length)throw Error(`missing route/helper declaration in ${file}`);
 const js=ts.transpileModule(found.map(n=>n.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function(...Object.keys(bindings),`${js}\nreturn {${names.join(',')}};`)(...Object.values(bindings));
}
exports.request=async(rt,f)=>{
 rt.fixture=f;
 if(!rt.app) {
 const logger=Object.fromEntries(['error','warn','info','debug'].map(k=>[k,()=>{}]));
 const common={_:require('underscore'),pg:rt.pg,logger,failJson:(res,status,label)=>res.status(status).json({error:label}),getZinvite:rt.load('utils/zinvite.ts').getZinvite};
 const helpers=functions('server-helpers.ts',['finishOne','addConversationId','safeTimestampToMillis','updateConversationModifiedTime','updateLastInteractionTimeForConversation','updateVoteCount','addNoMoreCommentsRecord','addStar'],common,rt.mutation);
 const binding={...common,...helpers,...rt.load('votes/convention.ts'),getNextComment:rt.next.getNextComment,isDuplicateKey:e=>e.code==='23505',setTimeout:fn=>rt.timers.push(fn)};
 const get=functions('routes/comments.ts',['handle_GET_nextComment'],binding,rt.mutation).handle_GET_nextComment;
 const post=functions('routes/votes.ts',['doVotesPost','votesPost','handle_POST_votes'],binding,rt.mutation).handle_POST_votes;
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{const f=rt.fixture;req.p={zid:1,pid:f.pid,uid:100+f.pid,tid:1,vote:0,...(req.method==='GET'?{without:f.without}:req.body)};next();});
 app.get('/api/v3/nextComment',get);app.post('/api/v3/votes',post);rt.app=app;
 }
 const app=rt.app;
 const response=f.http==='POST'?await request(app).post('/api/v3/votes').send({tid:1,vote:0}):await request(app).get('/api/v3/nextComment');
 const beforeDeferred=rt.observation();
 await rt.drain();
 return {status:response.status,contentType:response.headers['content-type'],text:response.text,beforeDeferred:{postgresStatements:beforeDeferred.sql.length,dynamoCalls:beforeDeferred.dynamo.length,mathBytes:beforeDeferred.mathBytes}};
};
