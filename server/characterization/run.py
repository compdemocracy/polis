#!/usr/bin/env python3
"""Host orchestrator. Only the dedicated p027 Docker project is mutable."""
import hashlib,json,os,pathlib,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
HERE=ROOT/'server/characterization'
ENV=dict(os.environ)
project=ENV.get('COMPOSE_PROJECT_NAME','')
if not __import__('re').fullmatch(r'p027r4fix-[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?',project):raise RuntimeError('set a unique COMPOSE_PROJECT_NAME=p027r4fix-<random>')
ports=[int(ENV[k]) for k in ['POLIS_RECOVERY_PG_PORT','P027_HTTP_PORT','P027_CONTROL_PORT']]
if len(set(ports))!=3 or any(p<55930 or p>55939 for p in ports):raise RuntimeError('set three unique host ports in 55930–55939')
ENV['RECOVERY_PG_PORT']=str(ports[0])
ENV.setdefault('BUILDX_CONFIG','/private/tmp/'+project+'-buildx')
COMPOSE=['docker','compose','-f',str(HERE/'compose.yml')]
def run(*args,capture=False,check=True):
 return subprocess.run(args,cwd=ROOT,env=ENV,text=True,check=check,stdout=subprocess.PIPE if capture else None).stdout
def dc(*args,capture=False,check=True):return run(*COMPOSE,*args,capture=capture,check=check)
def digest_files(files):
 h=hashlib.sha256()
 for p in sorted(files):h.update(str(p.relative_to(ROOT)).encode());h.update(p.read_bytes())
 return h.hexdigest()
def provenance():
 ids=dc('ps','-q',capture=True).split()
 if len(ids)<6:raise RuntimeError('all six sealed services must be running')
 containers=json.loads(run('docker','inspect',*ids,capture=True))
 networks={n['NetworkID'] for c in containers for n in c['NetworkSettings']['Networks'].values()}
 inspected=json.loads(run('docker','network','inspect',*sorted(networks),capture=True))
 if len(inspected)!=1 or any(not n['Internal'] or n['Labels'].get('com.docker.compose.project')!=project for n in inspected):raise RuntimeError('EGRESS GATE: every container must attach ONLY to the p027 internal network')
 # Container capabilities / networking must not provide an escape hatch.
 for c in containers:
  if c['HostConfig']['Privileged'] or c['HostConfig'].get('CapAdd'):raise RuntimeError('EGRESS GATE: privileged/cap-add container')
 for c in containers:
  if c['Config']['Labels']['com.docker.compose.service']=='server':
   mounts={m['Destination']:m for m in c['Mounts']}
   server_env=dict(x.split('=',1) for x in c['Config']['Env'])
   if any(p not in mounts or mounts[p]['RW'] for p in ['/app/src','/app/app.ts','/app/index.ts']):raise RuntimeError('source snapshot exclusions require read-only source mounts')
 source=list((ROOT/'server/src').rglob('*.ts'))+[ROOT/'server/app.ts',ROOT/'server/index.ts',ROOT/'server/package-lock.json']
 stack={'commit':run('git','rev-parse','HEAD',capture=True).strip(),'sourceHash':digest_files(source),'migrationHash':digest_files((ROOT/'server/postgres/migrations').glob('*.sql')),'composeHash':hashlib.sha256((HERE/'compose.yml').read_bytes()).hexdigest(),'images':{c['Config']['Labels']['com.docker.compose.service']:c['Image'] for c in containers},'networkInternal':True,'networkCount':1,'generatedOnly':True,'fixtureClock':1700000000000,'harnessHash':digest_files([p for p in HERE.iterdir() if p.suffix in ['.cjs','.sql','.py','.json']]),'mathSeedImage':json.loads(run('docker','image','inspect','p011-delphi-test:latest',capture=True))[0]['Id'],'mathEnv':server_env['MATH_ENV'],'negativeControls':server_env.get('P027_NEGATIVE_CONTROLS','0'),'markers':server_env.get('P027_MARKERS','1')}
 (HERE/'artifacts').mkdir(exist_ok=True)
 (HERE/'artifacts/stack.json').write_text(json.dumps(stack,indent=2)+'\n')
 return stack
def ready():
 for _ in range(60):
  result=subprocess.run(COMPOSE+['exec','-T','server','node','-e',"fetch('http://localhost:5001/ready',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],cwd=ROOT,env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if result.returncode==0:return
  time.sleep(1)
 raise RuntimeError('readiness deadline exceeded')
def main():
 command=sys.argv[1] if len(sys.argv)>1 else 'record'
 if command=='down':dc('down','-v');return
 if command=='build':run('docker','compose','-f','docker-compose.test.yml','--env-file','test.env','build','server','postgres','file-server','oidc-simulator');return
 dc('up','-d');dc('restart','server');ready();provenance()
 if command in ['record','replay']:
  if command=='replay' and not (HERE/'artifacts'/((sys.argv[2] if len(sys.argv)>2 else 'recording'))/'index.json').exists():dc('exec','-T','driver','node','characterization/baseline.cjs','/artifacts/'+(sys.argv[2] if len(sys.argv)>2 else 'recording'))
  # Reset SQL and restart the web process to reset LRU caches and observer state.
  # Dynamo has no tables in the boundary corpus; restart it for a clean independent replay.
  dc('exec','-T','driver','node','characterization/cli.cjs','seed')
  dc('run','--rm','--no-deps','math-seed')
  dc('restart','server','dynamodb');ready();provenance()
  dc('exec','-T','driver','node','characterization/cli.cjs','seed-pages')
  if len(sys.argv)>3 and sys.argv[3]=='nominal':dc('exec','-T','driver','node','characterization/cli.cjs','init-dynamo')
  dc('exec','-T','-e','P027_ONLY='+ENV.get('P027_ONLY',''),'-e','P027_PARITY_ONLY='+ENV.get('P027_PARITY_ONLY',''),'driver','node','characterization/cli.cjs',command,'/artifacts/'+(sys.argv[2] if len(sys.argv)>2 else 'recording'),sys.argv[3] if len(sys.argv)>3 else 'boundary',sys.argv[4] if len(sys.argv)>4 else '1')
 elif command=='coverage':dc('exec','-T','driver','node','characterization/cli.cjs','coverage')
 elif command=='test':dc('exec','-T','server','node','--test','characterization/test.cjs','characterization/corrections.test.cjs','characterization/recorded.test.cjs','characterization/round2.test.cjs','characterization/runtime.test.cjs')
 else:raise RuntimeError('unknown command')
if __name__=='__main__':
 try:main()
 except (RuntimeError,subprocess.CalledProcessError) as e:print(str(e),file=sys.stderr);sys.exit(1)
