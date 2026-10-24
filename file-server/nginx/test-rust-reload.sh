#!/usr/bin/env bash
# Local Docker proof, callable by CI. All resources belong to a unique project.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
project="rustreload-$$-${RANDOM}"
work=$(mktemp -d)
compose=(docker compose -p "$project" -f "$work/compose.json")
cleanup() {
  "${compose[@]}" logs --no-color nginx-proxy >&2 || true
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$project:local" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
export RELOAD_TEST_ROOT="$root" RELOAD_TEST_WORK="$work" RELOAD_TEST_PROJECT="$project"
python3 - <<'PY'
import json,os,pathlib
root=os.environ['RELOAD_TEST_ROOT']; work=pathlib.Path(os.environ['RELOAD_TEST_WORK'])
def stub(port,body):
 return {'image':'nginx:1.21.5-alpine','entrypoint':['sh','-c',f'printf \'server {{ listen {port}; location / {{ return 200 "{body}"; }} }}\' > /etc/nginx/conf.d/default.conf; exec nginx -g "daemon off;"']}
config={'services':{'server':stub(5000,'node'),'client-participation-alpha':stub(4321,'alpha'),'polis-api':stub(5100,'rust'),'nginx-proxy':{'image':os.environ['RELOAD_TEST_PROJECT']+':local','build':{'context':root+'/file-server','dockerfile':'nginx.Dockerfile'},'depends_on':['server','client-participation-alpha'],'ports':['127.0.0.1::80'],'volumes':['routing:/var/lib/polis-routing']}},'volumes':{'routing':{}}}

# Delay after headers to prove draining protects a response that cannot fall back.
rust_code = """from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os,time
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path=='/health' and os.environ.get('FAIL_HEALTH')=='1':
   self.send_response(503); self.end_headers(); return
  self.send_response(200); self.send_header('Content-Length','4'); self.end_headers()
  if 'slow' in self.path: time.sleep(4)
  self.wfile.write(b'rust')
 def log_message(self,*args): pass
ThreadingHTTPServer(('0.0.0.0',5100),Handler).serve_forever()
"""
config['services']['polis-api']={'image':'python:3.12-alpine','entrypoint':['python','-u','-c',rust_code],'environment':{'FAIL_HEALTH':'${FAIL_HEALTH:-0}'}}
(work/'compose.json').write_text(json.dumps(config))
PY
"${compose[@]}" pull polis-api
"${compose[@]}" build nginx-proxy
"${compose[@]}" up -d server client-participation-alpha nginx-proxy
python3 - <<'PY'
import concurrent.futures,http.client,json,os,pathlib,subprocess,threading,time
root=pathlib.Path(os.environ['RELOAD_TEST_ROOT']);work=pathlib.Path(os.environ['RELOAD_TEST_WORK']);project=os.environ['RELOAD_TEST_PROJECT']
opts=['-p',project,'-f',str(work/'compose.json')];dc=['docker','compose',*opts]
def run(args,check=True,**kw):return subprocess.run(args,check=check,capture_output=True,text=True,**kw)
proxy=run(dc+['ps','-q','nginx-proxy']).stdout.strip()
port=int(run(dc+['port','nginx-proxy','80']).stdout.strip().rsplit(':',1)[1])
def req(path='/api/v3/math/pca2',method='GET'):
 c=http.client.HTTPConnection('127.0.0.1',port,timeout=8)
 try:
  c.request(method,path,body='{}' if method=='POST' else None);r=c.getresponse();return r.status,r.read().decode()
 finally:c.close()
for _ in range(50):
 try:
  if req()==(200,'node'):break
 except OSError:pass
 time.sleep(.1)
else:raise AssertionError('initial Node readiness')
print('ok 1 all-off starts with Rust absent',flush=True)
stop=threading.Event();samples=[];lock=threading.Lock()
paths=[('participationInit','GET','/api/v3/participationInit'),('nextComment','GET','/api/v3/nextComment'),('votes','POST','/api/v3/votes'),('comments','POST','/api/v3/comments'),('pca2','GET','/api/v3/math/pca2')]
def probe(name,method,path):
 while not stop.is_set():
  try:status,body=req(path,method);ok=status==200 and body in (['node','rust'] if name=='pca2' else ['node'])
  except Exception:ok=False
  with lock:samples.append((name,ok))
  stop.wait(.05)
threads=[threading.Thread(target=probe,args=p) for p in paths]
for t in threads:t.start()
def flip(routes):
 r=run(['bash',str(root/'scripts/rust-api-switch.sh'),routes,*opts],False)
 assert r.returncode==0,r.stdout+r.stderr
 assert run(dc+['ps','-q','nginx-proxy']).stdout.strip()==proxy
try:
 for cycle in range(2):
  flip('pca2');assert req()==(200,'rust')
  before=run(['docker','exec',proxy,'readlink','/var/lib/polis-routing/current']).stdout
  bad=run(['bash',str(root/'scripts/rust-api-switch.sh'),'unknown-route',*opts],False)
  assert bad.returncode!=0 and req()==(200,'rust')
  assert run(['docker','exec',proxy,'readlink','/var/lib/polis-routing/current']).stdout==before
  # A broken candidate config also preserves the last working generation.
  bad=run(['docker','exec','-e','RUST_API_ROUTES=pca2','-e','RUST_API_RESOLVER=127.0.0.11 invalid_option',proxy,'/usr/local/bin/polis-rust-routes','--reload'],False)
  assert bad.returncode!=0 and req()==(200,'rust')
  assert run(['docker','exec',proxy,'readlink','/var/lib/polis-routing/current']).stdout==before
  flip('');assert req()==(200,'node')
  assert not run(dc+['ps','--status','running','-q','polis-api']).stdout.strip()
 print('ok 2 two on/off cycles, Rust attribution, unchanged nginx ID, invalid selections preserved',flush=True)
finally:
 stop.set()
 for t in threads:t.join()
summary={name:{'n':sum(n==name for n,ok in samples),'failed':sum(n==name and not ok for n,ok in samples)} for name,_,_ in paths}
print(json.dumps(summary),flush=True)
assert all(v['n']>0 and v['failed']==0 for v in summary.values())
print('ok 3 five concurrent streams, zero failures',flush=True)
# Restart tests deliberately interrupt the listener and are outside flip probes.
def refresh():
 global proxy,port
 proxy=run(dc+['ps','-q','nginx-proxy']).stdout.strip()
 port=int(run(dc+['port','nginx-proxy','80']).stdout.strip().rsplit(':',1)[1])
def ready(body):
 for _ in range(100):
  try:
   if req()==(200,body):return
  except OSError:pass
  time.sleep(.1)
 raise AssertionError('startup readiness: '+body)
def persisted():
 return run(['docker','exec',proxy,'cat','/var/lib/polis-routing/current/routes']).stdout.strip()
def dependencies():
 return {name:run(dc+['ps','-q',name]).stdout.strip() for name in ['nginx-proxy','server','client-participation-alpha']}
flip('pca2')
assert persisted()=='pca2'
run(dc+['up','-d','--no-deps','--force-recreate','nginx-proxy'])
refresh();ready('node');assert persisted()==''
print('ok 4 unset startup environment overrides persisted on selection',flush=True)
# A nonempty list also replaces (rather than merges with) the old selection.
overlay=work/'startup.json'
overlay.write_text(json.dumps({'services':{'nginx-proxy':{'environment':{'RUST_API_ROUTES':'pca2'}}}}))
run(dc+['-f',str(overlay),'up','-d','--no-deps','--force-recreate','nginx-proxy'])
refresh();ready('rust');assert persisted()=='pca2'
overlay.write_text(json.dumps({'services':{'nginx-proxy':{'environment':{'RUST_API_ROUTES':''}}}}))
run(dc+['-f',str(overlay),'up','-d','--no-deps','--force-recreate','nginx-proxy'])
refresh();ready('node');assert persisted()==''
print('ok 5 explicit startup on then off obeys deployment env on initialized volume',flush=True)
# Hold the actual kernel lock; a second renderer must not delete/bypass it.
run(['docker','exec','-d',proxy,'sh','-c','exec 9>/var/lib/polis-routing/render.flock; flock 9; touch /tmp/render-held; exec sleep 300'])
for _ in range(100):
 if run(['docker','exec',proxy,'test','-f','/tmp/render-held'],False).returncode==0:break
 time.sleep(.05)
else:raise AssertionError('lock holder did not start')
before=run(['docker','exec',proxy,'readlink','/var/lib/polis-routing/current']).stdout
busy=run(['docker','exec','-e','RUST_API_ROUTES=pca2',proxy,'/usr/local/bin/polis-rust-routes','--reload'],False)
assert busy.returncode!=0 and 'Another route render is active' in busy.stderr
assert run(['docker','exec',proxy,'readlink','/var/lib/polis-routing/current']).stdout==before
assert req()==(200,'node')
print('ok 6 live render lock excludes a competing renderer without changing traffic',flush=True)
# Preserve the volume and both the old directory and new lock file across KILL.
run(['docker','exec',proxy,'mkdir','/var/lib/polis-routing/render.lock'])
run(dc+['kill','-s','SIGKILL','nginx-proxy'])
run(dc+['start','nginx-proxy']);refresh();ready('node')
assert persisted()==''
assert run(['docker','exec',proxy,'test','-d','/var/lib/polis-routing/render.lock'],False).returncode==0
flip('pca2');assert req()==(200,'rust')
print('ok 7 hard stop releases kernel lock; stale directory does not prevent startup or reload',flush=True)
# Wait until response headers arrive, then switch off. The old worker must
# finish the body before the controller stops Rust.
def delayed_response(signal):
 c=http.client.HTTPConnection('127.0.0.1',port,timeout=20)
 c.request('GET','/api/v3/math/pca2?slow=1');r=c.getresponse();signal.set()
 try:return r.status,r.read().decode()
 finally:c.close()
with concurrent.futures.ThreadPoolExecutor() as pool:
 signal=threading.Event();pending=pool.submit(delayed_response,signal)
 assert signal.wait(5)
 flip('')
 assert pending.result()==(200,'rust')
print('ok 8 down flip drains a Rust body already past its headers',flush=True)
flip('pca2')
with concurrent.futures.ThreadPoolExecutor() as pool:
 signal=threading.Event();pending=pool.submit(delayed_response,signal)
 assert signal.wait(5)
 timed=run(['docker','exec','-e','RUST_API_ROUTES=','-e','RUST_API_DRAIN_SECONDS=0',proxy,'/usr/local/bin/polis-rust-routes','--reload'],False)
 assert timed.returncode!=0 and 'within the bound' in timed.stderr
 assert run(dc+['ps','--status','running','-q','polis-api']).stdout.strip()
 assert not pending.done(), 'response must still be outstanding at immediate retry'
 flip('')
 assert pending.result()==(200,'rust')
assert not run(dc+['ps','--status','running','-q','polis-api']).stdout.strip()
print('ok 9 immediate retry after drain timeout waits for earlier shutting-down worker',flush=True)
# A real failed health response must leave Node serving and dependencies intact.
before=dependencies()
failed=run(['bash',str(root/'scripts/rust-api-switch.sh'),'pca2',*opts],False,env=dict(os.environ,FAIL_HEALTH='1'))
assert failed.returncode!=0 and 'Rust health failed; selection remains on Node' in failed.stderr
assert dependencies()==before
assert req()==(200,'node') and persisted()==''
assert run(dc+['ps','--status','running','-q','polis-api']).stdout.strip()
flip('')
print('ok 10 failed Rust health leaves map on Node and recreates no dependency',flush=True)

print('PASS: 10 reload groups',flush=True)
PY
