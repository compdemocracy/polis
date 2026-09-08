import json
import os
from pathlib import Path
import subprocess
from coordinator.conftest import ROOT,seed,connect,rows,assert_coherent


def fixture_file(tmp_path,payloads,expected=None):
    path=tmp_path/'payload.json'
    path.write_text(json.dumps(dict(zid=1,expected_tick=expected,checkpoint={'fixture':'synthetic-golden'},payloads=payloads),allow_nan=False))
    return path


def test_rust_python_postgres_row_shape_golden(db,launch,tmp_path):
    from polismath.conversation.conversation import Conversation
    from polismath.engine_adapter import emit_payloads
    seed(db)
    conv=Conversation(1,last_updated=1)
    conv=conv.update_votes({'votes':[dict(pid=p,tid=t,vote=1 if p%2 else -1,created=1000+p*4+t) for p in range(6) for t in range(4)],'lastVoteTimestamp':1023},recompute=False)
    conv=conv.recompute()
    payload=emit_payloads(conv,1)
    path=fixture_file(tmp_path,payload)
    launch(db,'publish-fixture',args=(path,)).done()
    from polismath.database.postgres import PostgresClient,PostgresConfig
    pg=PostgresClient(PostgresConfig(url=db,math_env='python',ssl_mode='disable'))
    # Both writers receive exactly the same Python-emitted blob input.
    tick=pg.increment_math_tick(1)
    pg.write_math_bidtopid(1,payload['bidtopid'],math_tick=tick)
    pg.write_participant_stats(1,payload['ptptstats'],math_tick=tick)
    pg.write_math_main(1,payload['main'],last_vote_timestamp=payload['main']['lastVoteTimestamp'],math_tick=tick)
    pg.shutdown()
    c=connect(db)
    with c.cursor() as cur:
        for table in ('math_main','math_bidtopid','math_ptptstats'):
            cur.execute(f"SELECT data::text,math_tick FROM {table} WHERE zid=1 ORDER BY math_env")
            a,b=cur.fetchall()
            assert a==b,table # identical PostgreSQL JSONB text bytes, not just dicts
    c.close()


def test_expected_tick_conflict_preserves_current(db,launch,tmp_path):
    seed(db);launch(db).done()
    before=rows(db)
    p={k:before[t]['data'] for k,t in [('main','math_main'),('bidtopid','math_bidtopid'),('ptptstats','math_ptptstats')]}
    out,_=launch(db,'publish-fixture',args=(fixture_file(tmp_path,p,expected=999),)).done()
    assert 'Conflict' in out
    assert rows(db)==before


def test_release_binary_rejects_fault_descriptor_before_db():
    binary=ROOT/'coordinator-rs/target/release/polis-coordinator'
    env=dict(os.environ,P026_FAULT_DIR='/nonexistent/synthetic-control')
    env.pop('DATABASE_URL',None)
    r=subprocess.run([str(binary),'once'],env=env,capture_output=True,text=True)
    assert r.returncode==1 and 'FAULT-CONTROL-REFUSED' in r.stderr
    assert 'database' not in r.stderr.lower()


def test_coherent_point_read_and_quiet_noop(db,launch):
    seed(db);launch(db).done()
    before=rows(db)
    out,_=launch(db,'read',args=(1,)).done()
    assert json.loads(out)['math_tick']==before['math_main']['math_tick']
    launch(db).done()
    assert rows(db)==before


def test_release_build_cannot_enable_fault_feature():
    env=dict(os.environ,CARGO_HOME='/private/tmp/p026-toolchain/cargo',RUSTUP_HOME='/private/tmp/p026-toolchain/rustup')
    r=subprocess.run(['/private/tmp/p026-toolchain/cargo/bin/cargo','check','--manifest-path',str(ROOT/'coordinator-rs/Cargo.toml'),'--release','--features','fault-injection'],env=env,capture_output=True,text=True,timeout=90)
    assert r.returncode!=0 and 'fault-injection is forbidden in release builds' in r.stderr


def test_missing_checkpoint_metadata_is_repaired(db,launch):
    seed(db);launch(db).done()
    c=connect(db)
    with c.cursor() as cur:
        cur.execute("UPDATE math_ticks SET input_checkpoint=NULL WHERE zid=1 AND math_env='rustproto'")
    c.close()
    launch(db,'read',args=(1,)).done(code=1)
    launch(db).done()
    assert_coherent(db)
