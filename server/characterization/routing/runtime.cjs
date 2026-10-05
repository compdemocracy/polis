const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const underscore = require('underscore');
const server = path.resolve(__dirname, '../..');
const realFiles = new Set(['nextComment.ts','comment.ts','conversation.ts','db/sql.ts','utils/pca.ts','utils/commentClusters.ts','votes/convention.ts','utils/zinvite.ts']);

exports.runtime = function runtime(client, fixture, mutate = null) {
  let now = 1700000000000;
  let observation;
  const timers=[]; const pending=new Set();
  function reset() { observation = { sql: [], dynamo: [], mathBytes: 0, translations: 0, pools: [], draws: [] }; }
  reset();
  const underscoreObserved = {...underscore, reduce(collection, fn, start, ...rest) {
    const result = underscore.reduce(collection, fn, start, ...rest);
    if (result && Array.isArray(result.lookup) && typeof result.lastCount === 'number') {
      let last = 0;
      observation.pools.push({path:'ordinary', candidates:result.lookup.map(([cumulative, row]) => {
        const weight = cumulative-last; last=cumulative; return {tid:row.tid,weight};
      })});
    }
    return result;
  }};
  async function query(sql, params = []) {
    observation.sql.push(sql.replace(/\s+/g,' ').trim());
    if (/ORDER BY.*random\(\)/i.test(sql)) {
      // Observer-only query, not charged to the application: same WHERE,
      // before ORDER/LIMIT, so rejected and seed-prioritized candidates are visible.
      const candidates = fixture.observePools===false?{rows:[]}:await client.query(sql.replace(/ ORDER BY[\s\S]*$/i,''), params);
      const seedFirst = /is_seed desc/i.test(sql) && candidates.rows.some(r => r.is_seed);
      observation.pools.push({path:'topical', candidates:candidates.rows.sort((a,b)=>a.tid-b.tid).map(r=>({tid:r.tid,weight:seedFirst&&!r.is_seed?0:1}))});
      await client.query('SELECT setseed(0.125)'); // pinned PG random, observer-only
    }
    const result = await client.query(sql, params);
    if (/select \* from math_main/i.test(sql)) {
      observation.mathBytes += result.rows.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.data)),0);
    }
    return result;
  }
  const trackedQuery=(sql,params)=>{const p=query(sql,params);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
  const pg = {
    queryP_metered: async(_name,sql,params)=>(await trackedQuery(sql,params)).rows,
    query(sql, params, cb) { trackedQuery(sql,params).then(x=>cb(null,x),e=>cb(e)); },
    queryP: async(sql,params)=>(await trackedQuery(sql,params)).rows,
    queryP_readOnly: async(sql,params)=>(await trackedQuery(sql,params)).rows,
  };
  const config = {mathEnv:'python',cacheMathResults:true,shouldUseTranslationAPI:fixture.translate!==false,
    getValidTopicalRatio:()=>fixture.ratio, dynamoDbEndpoint:'http://test.invalid', applicationName:'test'};
  const dynamo = {async send(command) {
    if(fixture.dynamoDelayMs) await new Promise(r=>setTimeout(r,fixture.dynamoDelayMs));
    const input = command.input; observation.dynamo.push(JSON.parse(JSON.stringify(input)));
    if (input.TableName==='Delphi_CommentClustersLLMTopicNames') {
      if (fixture.topicError) throw Error('generated topic-store error');
      const key = input.ExpressionAttributeValues[':tk'];
      if (fixture.oldDeleted && key.startsWith('old#')) return {Items:[]};
      const [,layer,cluster] = key.split('#');
      return {Items:[{layer_id:layer,cluster_id:cluster}]};
    }
    if (input.TableName==='Delphi_CommentHierarchicalClusterAssignments') {
      if (fixture.assignmentError) throw Error('generated membership-store error');
      const count = fixture.assignments===false?0:(fixture.count??6);
      const begin = input.ExclusiveStartKey?.offset??0, end=Math.min(count,begin+(fixture.pageSize??count));
      return {Items:Array.from({length:end-begin},(_,i)=>({comment_id:i+begin,layer0_cluster_id:(i+begin)%2===0?1:2,layer1_cluster_id:0})), ...(end<count?{LastEvaluatedKey:{offset:end}}:{})};
    }
    throw Error(`unexpected Dynamo table ${input.TableName}`);
  }};
  const cache = new Map();
  const mocks = {
    'config.ts':config, 'db/pg-query.ts':pg,
    'utils/logger.ts':Object.fromEntries(['debug','info','warn','error','silly'].map(k=>[k,()=>{}])),
    'utils/metered.ts':{MPromise:(_name,executor)=>new Promise(executor),addInRamMetric:()=>{}},
    'utils/common.ts':{polisTypes:{mod:{ok:1,ban:require('./fixture.cjs').MOD_BAN}},ifDefinedFirstElseSecond:(a,b)=>a===undefined?b:a},
    'utils/constants.ts':{DEFAULTS:{}}, 'utils/file-fetcher.ts':{makeFileFetcher:()=>()=>{},fetchIndex:()=>{}},
    'routes/comments.ts':{isProConvo:()=>{throw Error('unexpected moderation route');}},
    'utils/mathBundle.ts':{getMathBundle:()=>{throw Error('unexpected bundle path');}},
  };
  function load(file) {
    file=path.posix.normalize(file);
    if (Object.hasOwn(mocks,file)) return mocks[file];
    if (cache.has(file)) return cache.get(file).exports;
    if (!realFiles.has(file)) throw Error(`unapproved source import ${file}`);
    let source=fs.readFileSync(path.join(server,'src',file),'utf8');
    if (mutate?.file===file) {
      if (!source.includes(mutate.from)) throw Error(`mutation anchor missing: ${mutate.name}`);
      source=source.replace(mutate.from,mutate.to);
    }
    const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const module={exports:{}}; cache.set(file,module);
    const req = spec => {
      if (spec.startsWith('.')) return load(path.posix.join(path.posix.dirname(file),spec)+(spec.endsWith('.ts')?'':'.ts'));
      if(spec==='underscore') return underscoreObserved;
      if(spec==='@aws-sdk/client-dynamodb') return {DynamoDBClient:class {}};
      if(spec==='@aws-sdk/lib-dynamodb') return {DynamoDBDocumentClient:{from:()=>dynamo},QueryCommand:class {constructor(input){this.input=input;}}};
      if(spec==='@google-cloud/translate') return {v2:{Translate:class {async translate(txt,lang){observation.translations++;return [`${lang}: ${txt}`];}}}};
      if(!['lru-cache','sql','zlib','crypto'].includes(spec)) throw Error(`unapproved external import ${spec}`);
      return require(spec);
    };
    const math=Object.create(Math); math.random=()=>{const n=0.625;observation.draws.push(n);return n;};
    const DatePinned=class extends Date {static now(){return now;}};
    const context={module,exports:module.exports,require:req,Buffer,Math:math,Date:DatePinned,structuredClone,setTimeout:fixture.http?((fn)=>{timers.push(fn);return timers.length;}):setTimeout,clearTimeout,console};
    vm.runInNewContext(js,context,{filename:file}); return module.exports;
  }
  const next=load('nextComment.ts');
  return {next,reset,pg,load,timers,mutation:mutate,async drain(){for(const fn of timers.splice(0))fn();while(pending.size)await Promise.all([...pending]);},expire(){now+=3001;},observation(){return JSON.parse(JSON.stringify({...observation,sql:observation.sql.sort(),dynamo:observation.dynamo.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}));}};
};
