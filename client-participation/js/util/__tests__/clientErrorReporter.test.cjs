const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "../../../..");
const files = ["client-participation/js/util", "client-admin/src/util", "client-report/src/util", "client-participation-alpha/src/lib"];
function fixture(file, changes = {}) {
  const calls=[], listeners={}, store={}, captures={}, timers=[];
  const win={location:{href:"https://example.test/alpha/example?secret=value",origin:"https://example.test",pathname:"/alpha/example"},
    navigator:{sendBeacon:(url,body)=>{calls.push({url,body});return true;}},
    sessionStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;}},
    setTimeout:(fn)=>{timers.push(fn);return timers.length;},
    addEventListener:(name,fn,capture)=>{listeners[name]=fn;captures[name]=capture;}, ...changes};
  const sandbox={window:win,URL,JSON,Date,Promise,Set,Blob,Error:changes.ReporterError||Error,module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(path.join(root,file,"clientErrorReporter.js"),"utf8"),sandbox);
  const install=()=>win.PolisClientErrors.install({client:"alpha",build:"a".repeat(40),apiBase:"https://example.test/",window:win});
  const report=install();
  return {calls,win,listeners,report,install,store,captures,flush:()=>{const pending=timers.splice(0);pending.forEach(fn=>fn());}};
}
for(const file of files) {
  test(file+": route families remain distinct while identifiers stay private",()=>{
    const project=fixture(file).win.PolisClientErrors.fields;
    const resources=['votes','nextComment','participationInit','users','xids','participants','bidToPid','reports','delphi'].map(x=>'/api/v3/'+x);
    const events=resources.map(resource=>project({client:'alpha',kind:'fetch',status:500,resource}));
    assert.deepEqual(events.map(x=>x.resource),resources);
    assert.equal(new Set(events.map(x=>x.signature)).size,resources.length);
    for(const [resource,expected] of [['/api/v3/zinvites/12345','/api/v3/zinvites/:id'],['/alpha/2AbCdEf9','/alpha/:id'],['/api/v3/metadata/answers/123','/api/v3/metadata/answers/:id'],['/unknown-private/private-value','/:id/:id'],['/favicon.ico','/favicon.ico'],['/twemoji/14/svg/1f600.svg','/twemoji/:id/:id/:id'],['/fonts/private-name.woff2','/fonts/:id'],['/images/private-name.png','/images/:id'],['/css/private-name.css','/css/:id']])
      assert.equal(project({client:'alpha',kind:'resource',resource}).resource,expected);
  });
  test(file+": third-party resources keep only the host and round trip",async()=>{
    const f=fixture(file);
    f.report('resource','','https://user:password@cdn.example:8443/private-name.js?secret=x#text');
    f.report('resource','','/private-name.js?secret=x');
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events[0].resource,'https://cdn.example');
    assert.equal(events[1].resource,'/:id');
    assert.notEqual(events[0].signature,events[1].signature);
    assert.deepEqual(JSON.parse(JSON.stringify(f.win.PolisClientErrors.fields(events[0]))),events[0]);
    assert.doesNotMatch(JSON.stringify(events),/user|password|private-name|secret|text/);
  });
  test(file+": host markers bound length and preserve IPv6 without ports",()=>{
    const project=fixture(file).win.PolisClientErrors.fields;
    for(const [resource,expected] of [['http://user:password@[2001:db8::1]:8080/private?text=x','http://[2001:db8::1]'],['https://'+Array(4).fill('a'.repeat(50)).join('.')+'/private','']]) {
      const event=project({client:'alpha',kind:'resource',resource});
      assert.equal(event.resource,expected);assert.deepEqual(project(event),event);
    }
  });
  test(file+": hashed build frames retain positions while ignoring content hashes",()=>{
    const project=fixture(file).win.PolisClientErrors.fields;
    for(const [one,two] of [['/report_bundle.12345678abcdef00.js:2:123','/report_bundle.87654321abcdef00.js:3:456'],['/static/js/admin_bundle.12345678abcdef00.js:2:123','/static/js/admin_bundle.87654321abcdef00.js:3:456'],['/js/participation_bundle.12345678.js:2:123','/js/participation_bundle.87654321.js:3:456'],['/_astro/Survey.Bc1dEf2G.js:2:123','/_astro/Survey.Dh3jKl4M.js:3:456']]) {
      const a=project({client:'alpha',kind:'error',message:'TypeError',stack:one});
      const b=project({client:'alpha',kind:'error',message:'TypeError',stack:two,build:'b'.repeat(40)});
      assert.notEqual(a.signature,b.signature);assert.equal(a.stack,one);assert.equal(b.stack,two);
      const samePosition=project({client:'alpha',kind:'error',message:'TypeError',stack:two.replace(/:\d+:\d+$/,':2:123')});
      assert.equal(a.signature,samePosition.signature);
    }
  });
  test(file+": three positions in one hashed bundle send three reports",async()=>{
    const f=fixture(file);
    const positions=['2:631474','2:98765','1:200'];
    for(const position of positions) f.listeners.error({error:{message:'TypeError',stack:'/js/participation_bundle.12345678.js:'+position}});
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.signature)).size,3);
    assert.deepEqual(events.map(e=>e.stack),positions.map(p=>'/js/participation_bundle.12345678.js:'+p));
    f.listeners.error({error:{message:'TypeError',stack:events[1].stack}});f.flush();
    const repeat=JSON.parse(await f.calls[3].body.text());
    assert.equal(repeat.signature,events[1].signature);assert.equal(repeat.stack,events[1].stack);assert.equal(repeat.count,1);
  });
  test(file+": console callers in one hashed bundle remain distinct",async()=>{
    let column=10;class ReporterError { constructor(){this.stack='Error\n at report (https://example.test/js/reporter.js:1:2)\n at caller (https://example.test/static/js/admin_bundle.12345678.js:2:'+column+')';} }
    const f=fixture(file,{ReporterError,console:{error(){},warn(){}}});
    for(column of [10,20,30]) f.win.console.error('private text');
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.signature)).size,3);
    assert.deepEqual(events.map(e=>e.stack),[10,20,30].map(c=>'/static/js/admin_bundle.12345678.js:2:'+c));
  });
  test(file+": fetch and XHR do not report successful or cached responses",async()=>{
    let status=200;
    class XHR { constructor(){this.events={};this.status=status;} addEventListener(k,fn){this.events[k]=fn;} open(){} send(){} }
    const f=fixture(file,{XMLHttpRequest:XHR,fetch:()=>Promise.resolve({status})});
    for(status of [200,204,301,302,304]) {
      assert.equal((await f.win.fetch('/api/v3/bid')).status,status);
      const xhr=new XHR();xhr.open('GET','/api/v3/bid');xhr.send();xhr.events.loadend();
    }
    assert.equal(f.calls.length,0);
    status=404;await f.win.fetch('/api/v3/bid');const xhr=new XHR();xhr.open('GET','/api/v3/bid');xhr.send();xhr.events.loadend();assert.equal(f.calls.length,2);
  });
  test(file+": server projection preserves emitted bundle frames and signatures",()=>{
    const f=fixture(file), project=f.win.PolisClientErrors.fields;
    for(const resource of ['/report_bundle.abcd.js','/report_vendor_d3-3.0.min.js','/_astro/app.js','/static/js/app.js','/js/app.js']) {
      const data=project({client:'alpha',kind:'error',build:'a'.repeat(40),page:'/alpha/example',message:'TypeError: private',stack:'Error: private\n at run (https://example.test'+resource+'?private=x:3:4)',resource});
      assert.equal(data.stack,resource+':3:4');
      assert.deepEqual(project(data),data);
    }
  });
  test(file+": signature groups the same top frame across builds and caller stacks",()=>{
    const f=fixture(file), project=f.win.PolisClientErrors.fields;
    const data={client:'alpha',kind:'error',message:'TypeError: private',stack:'/_astro/app.js:3:4\n/_astro/caller.js:1:2',page:'/alpha/example'};
    assert.equal(project(data).signature,project({...data,build:'a'.repeat(40),stack:'/_astro/app.js:3:4\n/_astro/other.js:9:2',page:'/report/example'}).signature);
  });
  test(file+": pagehide flushes repeats and font failure contains no family text",async()=>{
    const events={};const f=fixture(file,{document:{fonts:{addEventListener:(name,fn)=>{events[name]=fn;}}}});
    events.loadingerror({fontfaces:[{family:'private family'}]});events.loadingerror({fontfaces:[{family:'private family'}]});f.listeners.pagehide();
    const payloads=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(payloads.reduce((n,p)=>n+p.count,0),2);assert.ok(payloads.every(p=>p.kind==='resource'));assert.doesNotMatch(JSON.stringify(payloads),/private|family/);
  });
  test(file+": reused XHR removes observation listeners after completion",()=>{
    class XHR { constructor(){this.events={};this.status=502;} addEventListener(k,fn){(this.events[k]??=new Set()).add(fn);} removeEventListener(k,fn){this.events[k].delete(fn);} open(){} send(){} }
    const f=fixture(file,{XMLHttpRequest:XHR}), xhr=new XHR();
    for(let i=0;i<5;i++) {
      xhr.open('GET','/api/v3/comments');xhr.send();assert.equal(xhr.events.loadend.size,1);
      [...xhr.events.loadend].forEach(fn=>fn());assert.ok(Object.values(xhr.events).every(s=>s.size===0));
    }
    f.flush();assert.equal(f.calls.length,2);
  });
  test(file+": resolves relative fetch and XHR paths without query data",async()=>{
    class XHR { constructor(){this.events={};this.status=503;} addEventListener(k,fn){this.events[k]=fn;} open(){} send(){} }
    const f=fixture(file,{XMLHttpRequest:XHR,fetch:()=>Promise.resolve({status:500})});
    await f.win.fetch('api/v3/comments?private=x');const xhr=new XHR();xhr.open('GET','comments?private=x');xhr.send();xhr.events.loadend();
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events[0].resource,'/alpha/api/v3/comments');assert.equal(events[1].resource,'/alpha/comments');assert.doesNotMatch(JSON.stringify(events),/private/);
  });
  test(file+": session limits persist across installation on another page",()=>{
    const store={};const sessionStorage={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;}};
    const a=fixture(file,{sessionStorage});for(let i=0;i<20;i++)a.report('fetch','HTTP '+(400+i),'/api/v3/comments',{status:400+i});
    const b=fixture(file,{sessionStorage});b.report('error','TypeError');assert.equal(b.calls.length,0);
    const rate=JSON.parse(store['polis-client-errors-rate']);rate.sent=0;rate.total=200;store['polis-client-errors-rate']=JSON.stringify(rate);
    const c=fixture(file,{sessionStorage});c.report('error','TypeError');assert.equal(c.calls.length,0);
  });
  test(file+": console signatures retain sanitized caller locations",async()=>{
    let line=10;class ReporterError { constructor(){this.stack='Error: private\n at reporter (https://example.test/js/reporter.js:1:2)\n at userName (https://example.test/js/app.js?private=x:'+line+':3)';} }
    const f=fixture(file,{ReporterError,console:{error(){},warn(){}}});
    f.win.console.warn('private %s','identity');line=20;f.win.console.warn('private %s','identity');
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events.length,2);assert.equal(events[0].stack,'/js/app.js:10:3');assert.equal(events[1].stack,'/js/app.js:20:3');assert.notEqual(events[0].signature,events[1].signature);assert.doesNotMatch(JSON.stringify(events),/private|identity|reporter|userName/);
  });
  test(file+": payload excludes identity and response text",async()=>{
    const f=fixture(file); f.report("fetch",new Error("private prose"),"/api/v3/comments?xid=private");
    assert.equal(f.calls.length,1); const p=JSON.parse(await f.calls[0].body.text());
    assert.equal(f.calls[0].url,"https://example.test/api/v3/clientErrors");
    assert.deepEqual(p,{client:"alpha",build:"a".repeat(40),page:"/alpha/:id",kind:"fetch",message:"Request failed",stack:"",resource:"/api/v3/comments",method:"",status:0,duration_ms:0,signature:p.signature,count:1});
    assert.match(p.signature,/^[a-f0-9]{16}$/);
  });
  test(file+": repeats flush occurrence deltas with stable signatures",async()=>{
    const f=fixture(file);
    f.report("error",new Error("Failed to fetch"),"/api/v3/math/pca2");
    f.report("error",new Error("Failed to fetch"),"/api/v3/math/pca2");
    f.install()("error",new Error("Failed to fetch"),"/api/v3/math/pca2");
    assert.equal(f.calls.length,1); f.flush(); assert.equal(f.calls.length,2);
    const [a,b]=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(a.count,1); assert.equal(b.count,2); assert.equal(a.signature,b.signature);
  });
  test(file+": session transmission rate is bounded and stores no payload",()=>{
    const f=fixture(file);
    for(let i=0;i<100;i++) f.report("fetch",new Error("HTTP "+(400+i)),"/api/v3/comments",{status:400+i});
    assert.equal(f.calls.length,20);
    assert.ok(Object.values(f.store).some(x=>x.length>0));
    assert.doesNotMatch(JSON.stringify(f.store),/private|example|Failed|comments/);
  });
  test(file+": capture listener observes resource failures and CSP",async()=>{
    const f=fixture(file); assert.equal(f.captures.error,true);
    for(const tagName of ["SCRIPT","LINK","IMG","FONT"]) f.listeners.error({target:{tagName,src:"https://cdn.example/assets/app.js?private=x",href:"/assets/style.css?private=x"}});
    f.listeners.securitypolicyviolation({blockedURI:"https://cdn.example/assets/app.js?secret=x",violatedDirective:"script-src",sample:"private text"});
    f.flush(); const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.ok(events.some(e=>e.kind==='resource')); assert.ok(events.some(e=>e.kind==='csp'));
    assert.doesNotMatch(JSON.stringify(events),/private|secret|script-src/);
  });
  test(file+": console wrappers preserve receiver, arguments and return value",async()=>{
    const original=[]; const console={error(...args){original.push({receiver:this,args});return 42;},warn(...args){original.push({receiver:this,args});}};
    const f=fixture(file,{console}); const detail={identity:'private'};
    assert.equal(console.error('TypeError: %s', 'private prose',detail),42); console.warn('private prose',detail);
    assert.equal(original[0].receiver,console); assert.equal(original[0].args[2],detail);
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.deepEqual(events.map(e=>e.kind),['console_error','console_warn']);
    assert.doesNotMatch(JSON.stringify(events),/private|identity|%s/);
  });
  test(file+": fetch observes HTTP and rejection without consuming responses",async()=>{
    const response={status:503,ok:false,get body(){throw Error('must not read');}};
    const failure=Error('private'); const calls=[];
    const f=fixture(file,{fetch:function(...args){calls.push({receiver:this,args});return args[0].includes('offline')?Promise.reject(failure):Promise.resolve(response);}});
    assert.equal(await f.win.fetch('/api/v3/comments?secret=private',{method:'POST',body:'private'}),response);
    await assert.rejects(f.win.fetch('/offline?secret=private'),e=>e===failure);
    const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events.length,2); assert.equal(events[0].method,'POST'); assert.equal(events[0].status,503); assert.equal(events[1].status,0);
    assert.equal(calls[0].receiver,f.win); assert.doesNotMatch(JSON.stringify(events),/secret|private/);
  });
  test(file+": XHR completion, timeout and error retain API behavior",async()=>{
    class XHR { constructor(){this.events={};this.status=0;} addEventListener(k,fn){this.events[k]=fn;} open(...args){this.openArgs=args;return 'opened';} send(body){this.body=body;return 'sent';} }
    const f=fixture(file,{XMLHttpRequest:XHR});
    for(const [event,status] of [['loadend',502],['timeout',0],['error',0]]) {
      const xhr=new XHR(); assert.equal(xhr.open('PATCH','/api/v3/comments?private=x'), 'opened'); assert.equal(xhr.send('private text'),'sent'); xhr.status=status; xhr.events[event](); if(event!=='loadend') xhr.events.loadend();
    }
    f.flush(); const events=await Promise.all(f.calls.map(async c=>JSON.parse(await c.body.text())));
    assert.equal(events.reduce((n,e)=>n+e.count,0),3); assert.ok(events.every(e=>e.kind==='xhr'&&e.method==='PATCH')); assert.doesNotMatch(JSON.stringify(events),/private/);
  });
  test(file+": installs both browser events once",()=>{
    const f=fixture(file); assert.equal(typeof f.listeners.error,"function"); assert.equal(typeof f.listeners.unhandledrejection,"function");
    f.listeners.error({error:new Error("Failed to fetch"),filename:"/js/app.js"});
    f.listeners.unhandledrejection({reason:new Error("Load failed")}); assert.equal(f.calls.length,2);
  });
  test(file+": beacon false uses credentialless keepalive fetch",async()=>{
    const fetched=[]; const f=fixture(file,{navigator:{sendBeacon:()=>false},fetch:(url,options)=>{fetched.push({url,options});return Promise.reject(Error("offline"));}});
    f.report("fetch",new Error("failed"),"/api/v3/comments"); await new Promise(r=>setImmediate(r));
    assert.equal(fetched.length,1); assert.equal(fetched[0].options.credentials,"omit"); assert.equal(fetched[0].options.keepalive,true); assert.equal(fetched[0].options.referrerPolicy,"no-referrer");
  });
  test(file+": errors in storage, beacon and getters never escape",()=>{
    const sent=[]; const f=fixture(file,{sessionStorage:{getItem:()=>{throw Error();}},navigator:{sendBeacon:()=>{throw Error();}},fetch:(u,o)=>{sent.push(o);return Promise.resolve();}});
    f.report("fetch",{get message(){throw Error();}},"/api/v3/comments");
    f.report("fetch",new Error("HTTP 502"),"/api/v3/math/pca2"); assert.equal(sent.length,1);
  });
  test(file+": rejects external API bases without disabling same-origin reporting",()=>{
    const f=fixture(file); f.win.PolisClientErrors.install({client:"alpha",window:f.win,apiBase:"https://elsewhere.invalid/"})("error",new Error("failed"));
    assert.equal(f.calls.length,0); f.report("error",new Error("Failed to fetch")); assert.equal(f.calls.length,1);
  });
}

for (const file of files) {
  test(file + ": inline document frames never carry conversation-dependent positions", () => {
    const project = fixture(file).win.PolisClientErrors.fields;
    for (const raw of [
      "Error: private message\n at privateName (https://example.test/2private?token=secret:123:45)",
      "privateName@https://example.test/2private?token=secret:123:45"
    ]) {
      const data = project({client: "participation", kind: "error", page: "/2private", message: "private message", stack: raw});
      assert.equal(data.stack, "/:id");
      assert.equal(data.message, "Error");
      assert.deepEqual(project(data), data);
      assert.doesNotMatch(JSON.stringify(data), /private|secret|token/);
      assert.equal(data.signature, project({...data, stack: "/:id:999:98765"}).signature);
    }
    assert.equal(project({client: "admin", kind: "error", page: "/home", stack: "at https://example.test/home:12:3"}).stack, "/home");
    assert.equal(project({client: "admin", kind: "error", page: "/home", stack: "at https://example.test/private:12:3"}).stack, "");
  });
  test(file + ": stackless errors use browser coordinates and opaque errors stay explicit", async () => {
    const f = fixture(file);
    f.listeners.error({message: "private text", filename: "https://example.test/js/app.js?token=secret", lineno: 41, colno: 9});
    f.listeners.error({message: "Script error.", filename: "", lineno: 0, colno: 0});
    const data = await Promise.all(f.calls.map(async c => JSON.parse(await c.body.text())));
    assert.equal(data[0].stack, "/js/app.js:41:9");
    assert.equal(data[0].message, "Error");
    assert.equal(data[1].stack, "");
    assert.equal(data[1].message, "Script error.");
    assert.doesNotMatch(JSON.stringify(data), /private|secret|token/);
    data.forEach(d => assert.deepEqual(JSON.parse(JSON.stringify(f.win.PolisClientErrors.fields(d))), d));
  });
  test(file + ": only shipped emoji asset names survive projection", () => {
    const project = fixture(file).win.PolisClientErrors.fields;
    const dir = path.join(root, "client-admin/public/twemoji/14.0.2/72x72");
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith(".png"))) {
      const resource = "/twemoji/14.0.2/72x72/" + name;
      const data = project({client: "admin", kind: "resource", resource: resource + "?token=secret#private"});
      assert.equal(data.resource, resource);
      assert.deepEqual(project(data), data);
    }
    for (const name of ["private.png", "12345.png", "1f600.png", "1f44b.svg"]) {
      const data = project({client: "admin", kind: "resource", resource: "/twemoji/14.0.2/72x72/" + name});
      assert.equal(data.resource, "/twemoji/:id/:id/:id");
    }
    assert.equal(project({client: "admin", kind: "resource", resource: "https://third.example/twemoji/14.0.2/72x72/1f44b.png"}).resource, "https://third.example");
  });
}

for (const file of files) {
  test(file + ": inline reporter wrappers do not hide distinct bundle callers", () => {
    const project = fixture(file).win.PolisClientErrors.fields;
    const payloads = [10, 20].map(column => project({client: "participation", kind: "unhandledrejection", page: "/2private", message: "Failed to fetch", stack: "TypeError: Failed to fetch\n    at win.fetch (https://example.test/2private:1:458)\n    at caller (https://example.test/js/app.js:2:" + column + ")"}));
    assert.deepEqual(payloads.map(p => p.stack), ["/js/app.js:2:10", "/js/app.js:2:20"]);
    assert.notEqual(payloads[0].signature, payloads[1].signature);
  });
  test(file + ": Firefox nested function names keep the throwing frame", () => {
    const project = fixture(file).win.PolisClientErrors.fields;
    const payload = project({client: "participation", kind: "error", stack: "handleVote/<@https://example.test/js/app.js:4:57\nhandleVote@https://example.test/js/app.js:4:35"});
    assert.equal(payload.stack, "/js/app.js:4:57\n/js/app.js:4:35");
  });
  test(file + ": V8 message tails never supply positions", () => {
    const project = fixture(file).win.PolisClientErrors.fields;
    for (const tail of ["/2private:5550100:42", "https://example.test/2private:1234:5678", "/js/x.js:5550100:42"]) {
      const payload = project({client: "participation", kind: "error", page: "/2private", stack: "Error: see " + tail + "\n    at caller (https://example.test/js/app.js:2:3)"});
      assert.equal(payload.stack, "/js/app.js:2:3");
    }
    assert.equal(project({client: "participation", kind: "error", stack: "Error: person@/js/private.js:42:42"}).stack, "");
    for (const prefix of ["data:x", "blob:https://example.test", "chrome-extension://abc", "file:///tmp"]) {
      assert.equal(project({client: "participation", kind: "error", stack: "Error\n    at " + prefix + "/js/alice.js:1:5"}).stack, "");
    }
  });
  test(file + ": stackless inline errors are identical across preload sizes", async () => {
    const payloads = [];
    for (const [id, line, col] of [["2first", 1, 12282], ["2second", 12, 12333]]) {
      const f = fixture(file, {location: {href: "https://example.test/" + id, origin: "https://example.test", pathname: "/" + id}});
      f.listeners.error({message: "private", filename: f.win.location.href, lineno: line, colno: col});
      payloads.push(JSON.parse(await f.calls[0].body.text()));
    }
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(payloads[0].stack, "/:id");
  });
}
test("receiver projection bounds worst-case stack CPU per report and burst", () => {
  const project = require(path.join(root, "server/src/utils/clientErrorReporter.js")).fields;
  const inputs = ["/".repeat(4000), "/a".repeat(2000), "/js/".repeat(1000), "https://".repeat(500), Array(12).fill("/".repeat(682)).join("\n")];
  for (const stack of inputs) {
    const input = {client: "participation", kind: "error", page: "/2private", stack};
    project(input);
    const start = performance.now();
    for (let i = 0; i < 100; i++) project(input);
    const burst = performance.now() - start;
    assert.ok(burst < 50, "100-report projection burst must cost <50 ms; got " + burst);
  }
});

for (const file of files) require("./clientErrorPrivacyCases.cjs")(root, file + "/clientErrorReporter.js");
