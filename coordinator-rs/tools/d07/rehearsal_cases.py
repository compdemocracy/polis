"""End-to-end public transitions using Clojure-owned recovery rows."""
import base64
import copy
import json
import subprocess
import sys
import time
from psycopg2.extras import Json
from cases import pca


def drain(c,label,*readers):
    c.dc('stop',*readers)
    for name in readers:
        cid=c.dc('ps','-a','-q',name).strip()
        state=json.loads(c.command(['docker','inspect',cid,'--format','{{json .State}}']))
        c.check(label+'/'+name,not state['Running'],container=cid)
    c.dc('rm','-f',*readers)


def consumers(c,zid,label,readers,previous=None):
    bodies={}
    for reader in readers:
        ns=c.readers[reader][0]
        status,_,raw=c.http(reader,'/identity',control=2)
        c.check(label+'/'+reader+'/namespace',status==200 and json.loads(raw)['math_env']==ns)
        bundle=c.bundle(zid,ns);tick=bundle['main']['math_tick']
        for mode in ('cold','warm','prefetched'):
            if mode=='prefetched':c.http(reader,'/prefetch',control=2)
            status,headers,raw=pca(c,reader,zid,previous)
            obj=json.loads(raw) if raw else {}
            data=copy.deepcopy(bundle['main']['data'])
            # Existing processMathObject projection: subgroup payloads and zid
            # are removed; object-valued group records receive their numeric id.
            for key in ('subgroup-repness','subgroup-votes','subgroup-clusters','zid'):
                data.pop(key,None)
            for key in ('repness','group-votes'):
                for gid,value in (data.get(key) or {}).items():
                    if isinstance(value,dict):value['id']=int(gid)
            # Cold merges the production template; prefetch returns stored data
            # with column clocks. All stored scientific fields must still agree.
            same=all(obj.get(k)==v for k,v in data.items() if k not in ('math_tick','caching_tick','zid'))
            directory=c.output/'served';directory.mkdir(exist_ok=True)
            (directory/f'{label.replace(chr(47),chr(45))}-{reader}-{mode}.json').write_text(json.dumps({'headers':headers,'body':obj},indent=2)+'\n')
            c.check(label+'/'+reader+'/'+mode,status==200 and obj.get('math_tick')==tick and same,
                    status=status,served_tick=obj.get('math_tick'),expected_tick=tick,
                    differing_keys=[k for k,v in data.items() if k not in ('math_tick','caching_tick','zid') and obj.get(k)!=v])
            if mode in bodies:c.check(label+'/'+reader+'/'+mode+'/same-namespace-bytes',raw==bodies[mode])
            else:bodies[mode]=raw
            status,_,_=pca(c,reader,zid,tick)
            c.check(label+'/'+reader+'/'+mode+'/current-etag',status==304)
        for kind,path in (('report','/api/v3/reports?report_id='+c.report(zid)),
                          ('votes-csv',f'/api/v3/reportExport/{c.report(zid)}/participant-votes.csv'),
                          ('groups-csv',f'/api/v3/reportExport/{c.report(zid)}/comment-groups.csv')):
            status,headers,raw=c.http(reader,path,headers={'x-forwarded-proto':'https'})
            c.check(label+'/'+reader+'/'+kind,status==200 and bool(raw),status=status,bytes=len(raw))
            (directory/f'{label.replace(chr(47),chr(45))}-{reader}-{kind}.body').write_bytes(raw)
        path='/api/v3/participation?conversation_id='+c.capability(zid)
        status,_,_=c.http(reader,path,headers={'authorization':'Bearer '+c.owner_token})
        c.check(label+'/'+reader+'/owner-auth',status==200,status=status)
        status,_,_=c.http(reader,path)
        c.check(label+'/'+reader+'/missing-auth',status in (401,403),status=status)
    return tick


def exercise(c):
    from run import ROOT
    # Local import above resolves the inherited D05 module; its ROOT is the
    # same attributed snapshot root as the D07 module.
    profiles=((1,*__import__('os').environ.get('D07_PROFILE','vw-warm').rsplit('-',1)),)
    for zid,slug,method in profiles:
        label=f'{slug}-{method}'
        cuts=c.receipt['public_inputs'][slug]['cuts']
        exclusion=c.legacy(zid,False,label+'/L-quarter',bootstrap_cut=cuts[0])
        saved=c.bundle(zid,'legacy')
        (c.output/(label+'-clojure-snapshot.json')).write_text(json.dumps(saved,sort_keys=True,indent=2)+'\n')
        c.start('server','reader_l2')
        status,_,raw=c.http('server','/tokens',control=1)
        assert status==200
        c.owner_token=json.loads(raw)['owner']
        claims=json.loads(base64.urlsafe_b64decode(c.owner_token.split('.')[1]+'=='))
        c.query('INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES(%s,1) ON CONFLICT DO NOTHING',(claims['sub'],))
        old=consumers(c,zid,label+'/L-initial',('server','reader_l2'))
        c.publish(label+'/P-quarter',(zid,))
        c.start('reader_p1')
        status,_,_=pca(c,'reader_p1',zid,old)
        c.check(label+'/negative-no-floor',status==304,old_etag=old)
        drain(c,label+'/reset-unfloored','reader_p1')
        c.transition('legacy','rustproto',zid,old,label+'/L-to-P',exclusion)
        c.publish(label+'/P-floor',(zid,))
        status,_,raw=c.http('reader_l2','/identity',control=2)
        c.check(label+'/negative-retained-reader',status==200 and json.loads(raw)['math_env']=='legacy')
        drain(c,label+'/drain-L','server','reader_l2')
        c.start('reader_p1','reader_p2')
        current=consumers(c,zid,label+'/P-serving',('reader_p1','reader_p2'),old)
        for cut,cutname in zip(cuts[1:],('half','full')):
            c.check(label+'/'+cutname+'/negative-missing-suffix',not c.census(zid,cut))
            c.ingest(zid,cut,label+'/'+cutname)
            c.publish(label+'/P-'+cutname,(zid,))
            # Explicit replacement makes cold/warm lifecycles independent of
            # the earlier cached generation; no cache mutation in the driver.
            drain(c,label+'/refresh-'+cutname,'reader_p1','reader_p2')
            c.start('reader_p1','reader_p2')
            current=consumers(c,zid,label+'/P-'+cutname+'-served',('reader_p1','reader_p2'),current)
        c.check(label+'/legacy-rows-retained',c.bundle(zid,'legacy')==saved)
        # Both paths preserve the complete durable source. Snapshot restores all
        # four Clojure-owned rows in one transaction under existing exclusion.
        if method=='snapshot':
            # A one-row restoration is not a coherent fallback. Roll back this
            # deliberate metadata defect before restoring the sealed snapshot.
            c.connection.autocommit=False
            try:
                c.query("UPDATE math_main SET math_tick=math_tick+1 WHERE zid=%s AND math_env='legacy'",(zid,))
                c.check(label+'/negative-partial-snapshot',not c.coherent(zid,'legacy'))
            finally:
                c.connection.rollback();c.connection.autocommit=True
            c.connection.autocommit=False
            try:
                for table,row in saved.items():
                    c.query(f'DELETE FROM math_{table} WHERE zid=%s AND math_env=%s',(zid,'legacy'))
                    c.query(f'INSERT INTO math_{table} SELECT * FROM json_populate_record(NULL::math_{table},%s)',(Json(row),))
                c.connection.commit()
            except BaseException:c.connection.rollback();raise
            finally:c.connection.autocommit=True
            c.check(label+'/snapshot-restored',c.bundle(zid,'legacy')==saved and c.census(zid,cuts[-1]))
        # Withdraw the actual Python namespace through the reviewed operator API
        # before any legacy process is allowed to reconnect. Retick once more
        # after catch-up before replacing serving readers.
        drain_digest=c.drain_evidence(zid,label)
        c.transition('rustproto','legacy',zid,current,label+'/withdraw-P',drain_digest)
        from run import os
        env=dict(c.env,DATABASE_URL=f'postgresql://d05_control@127.0.0.1:{c.port}/p027',
                 COORDINATOR_PUBLISHER_DATABASE_URL=f'postgresql://d05_publisher@127.0.0.1:{c.port}/p027',
                 MATH_ENV='rustproto',P026_PYTHON=sys.executable,PYTHONPATH=str(ROOT/'delphi'),
                 POLL_ALLOWLIST=str(zid),P026_ENVIRONMENT='generated')
        epoch=c.query("SELECT owner_epoch FROM polis_coordinator_leases WHERE math_env='rustproto' AND zid=%s",(zid,))
        restarted=subprocess.run([str(ROOT/'coordinator-rs/target/fault/debug/polis-coordinator'),'once'],
                                 cwd=ROOT/'delphi',env=env,capture_output=True,text=True,timeout=30)
        (c.output/(label+'-restart.log')).write_text(restarted.stdout+restarted.stderr)
        c.check(label+'/restart-denied',restarted.returncode==4 and epoch==c.query("SELECT owner_epoch FROM polis_coordinator_leases WHERE math_env='rustproto' AND zid=%s",(zid,)),exit_code=restarted.returncode)
        exclusion=c.legacy(zid,False,label+'/L-recovery')
        c.check(label+'/source-survives-recovery',c.census(zid,cuts[-1]))
        c.transition('rustproto','legacy',zid,current,label+'/route-L',exclusion)
        drain(c,label+'/drain-P','reader_p1','reader_p2')
        c.start('server','reader_l2')
        final=consumers(c,zid,label+'/L-returned',('server','reader_l2'),current)
        c.check(label+'/strictly-new-L-token',final>current)
        drain(c,label+'/finish','server','reader_l2')
