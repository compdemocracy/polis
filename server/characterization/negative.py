#!/usr/bin/env python3
"""Live destructive controls run ONLY in p027; stop after first mismatch."""
import json,pathlib,shutil,subprocess,sys
from run import ROOT,HERE,ENV,COMPOSE,dc,ready,provenance

def cli(*args):
 return subprocess.run(COMPOSE+['exec','-T','-e','P027_STOP_ON_DIFF=1','driver','node','characterization/cli.cjs',*args],cwd=ROOT,env=ENV,text=True,capture_output=True)
def reset():
 dc('up','-d','server','driver');ready()
 dc('exec','-T','driver','node','characterization/cli.cjs','seed');dc('restart','server','dynamodb');ready();provenance();dc('exec','-T','driver','node','characterization/cli.cjs','seed-pages')
def main():
 ENV['P027_NEGATIVE_CONTROLS']='1'
 source=HERE/'artifacts/recording';out=[]
 for name in ['response','effect']:
  target=HERE/'artifacts'/('negative-'+name)
  if target.exists():shutil.rmtree(target)
  shutil.copytree(source,target)
  dc('exec','-T','driver','node','characterization/mutate.cjs','/artifacts/recording','/artifacts/'+target.name,name)
  reset();r=cli('replay','/artifacts/'+target.name)
  if r.returncode!=1 or 'DIFF' not in r.stdout:raise RuntimeError(f'{name} control did not detect semantic difference: {r.stdout} {r.stderr}')
  out.append({'control':name,'exit':r.returncode,'output':r.stdout.strip()});print(f'PASS control {name}: replayer exited {r.returncode}')
 reset()
 dc('exec','-T','driver','node','-e',"fetch('http://server:5001/drop-route').then(r=>{if(!r.ok)process.exit(1)})")
 r=cli('coverage')
 if r.returncode!=1 or 'route inventory mismatch' not in r.stderr:raise RuntimeError('removed-route census did not fail')
 out.append({'control':'remove-route','exit':r.returncode,'output':r.stderr.strip()});print('PASS control remove-route: census exited 1')
 for mutation,reason in [('hang-route','completion deadline exceeded'),('error-route','process error during case'),('exit-route','completion deadline exceeded')]:
  reset();dc('exec','-T','driver','node','-e',f"fetch('http://server:5001/{mutation}').then(r=>{{if(!r.ok)process.exit(1)}})")
  r=cli('probe-oracle')
  if r.returncode!=1 or reason not in r.stdout:raise RuntimeError(mutation+' oracle did not fail: '+r.stdout+r.stderr)
  out.append({'control':mutation,'exit':r.returncode,'output':r.stdout.strip()});print('PASS control '+mutation+': oracle exited 1')
 reset()
 # Temporarily enabling prod-style notification behavior must still be physically sealed.
 r=subprocess.run(COMPOSE+['run','--rm','--no-deps','-e','DEV_MODE=false','server','node','characterization/email-control.cjs'],cwd=ROOT,env=ENV,text=True,capture_output=True)
 if r.returncode!=0 or 'blocked before transport' not in r.stdout:raise RuntimeError('email control failed: '+r.stdout+r.stderr)
 out.append({'control':'real-email-loop','exit':r.returncode,'output':r.stdout.strip()});print('PASS control real-email-loop: SES v2 send blocked')
 # A transport with no JS observer still has no route to the internet.
 r=subprocess.run(COMPOSE+['exec','-T','server','node','-e',"const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>{console.error('EGRESS ESCAPED');process.exit(1)});s.on('error',e=>{console.log('network blocked: '+e.code);process.exit(0)});setTimeout(()=>{s.destroy();console.log('network blocked: deadline');process.exit(0)},1000)"],cwd=ROOT,env=ENV,text=True,capture_output=True)
 if r.returncode!=0:raise RuntimeError('network egress control failed')
 out.append({'control':'unobserved-network-egress','exit':r.returncode,'output':r.stdout.strip()})
 (HERE/'artifacts/negative-controls.json').write_text(json.dumps(out,indent=2)+'\n')
if __name__=='__main__':main()
