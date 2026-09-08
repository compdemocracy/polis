import json
from pathlib import Path
import pytest
from polismath.engine_adapter import Adapter, ProtocolError, descriptor, strict_json


def setup(tmp_path, votes=None, ops=None, sign=-1):
    src=tmp_path/"in"; dst=tmp_path/"out"; src.mkdir()
    votes = votes or []
    rows=[dict(slot=i+1,source_ordinal=i,stream_ordinal=i,created_ms=1000+i,pid=2,tid=3,raw_vote=v,weight_x_32767=None) for i,v in enumerate(votes)]
    (src/"votes.jsonl").write_text(''.join(json.dumps(v)+'\n' for v in rows))
    (src/"mods.jsonl").write_text('')
    manifest=dict(schema="polis-input/1",fixture_id="synthetic-empty",storage_agree_value=sign,ordering="frozen-extract-order",votes=descriptor(src,"votes.jsonl"),moderation=descriptor(src,"mods.jsonl"),parent=None)
    (src/"manifest.json").write_text(json.dumps(manifest))
    (src/"schedule.json").write_text(json.dumps({"schema":"polis-schedule/1","operations":ops or []}))
    p=dict(input_manifest=descriptor(src,"manifest.json"),resolved_schedule=descriptor(src,"schedule.json"),required_capabilities=["rebuild-prefix/1"],config=dict(profile="candidate-profile",seed=42,pca_mode="powerit",empty_contract=True,init_vector="ones"))
    return Adapter(src,dst),p


def req(op,p,rid=1):
    return dict(protocol="polis-engine/1",run_id="synthetic-run-001",session_id="synthetic-session-001",request_id=rid,op=op,payload=p)


def test_contract_apply_votes_example(tmp_path):
    op=dict(op="apply_votes",payload=dict(from_slot_exclusive=0,to_slot_inclusive=3))
    worker,p=setup(tmp_path,[-1,0,1],[op]);worker.handle(req("initialize",p))
    result=worker.handle(req(op["op"],op["payload"],2))
    assert result["observed_state_cursors"]["votes"]["slot"]==3
    assert worker.conv.raw_rating_mat.loc[2,3]==-1


def test_contract_empty_snapshot(tmp_path):
    ops=[dict(op="compute",payload=dict(compute_id="c0",logical_clock=0)),dict(op="snapshot",payload=dict(checkpoint_id="checkpoint-000"))]
    worker,p=setup(tmp_path,ops=ops);worker.handle(req("initialize",p))
    worker.handle(req("compute",ops[0]["payload"],2))
    response=worker.handle(req("snapshot",ops[1]["payload"],4))
    assert set(response)=={"checkpoint_id","manifest"}
    main=json.loads((worker.output_root/"checkpoint-000/main.json").read_text())
    assert main["n"]==0 and main["tids"]==[] and main["pca"]["center"]==[]
    assert main["lastVoteTimestamp"]==0
    assert json.loads((worker.output_root/"checkpoint-000/bidtopid.json").read_text())==dict(zid="synthetic-empty",bidToPid=[],lastVoteTimestamp=0)


@pytest.mark.parametrize("vote",[None,True,2,"-1"])
def test_reject_invalid_vote_before_mutation(tmp_path,vote):
    worker,p=setup(tmp_path,[vote])
    with pytest.raises(ProtocolError) as error: worker.handle(req("initialize",p))
    assert error.value.code=="INVALID_INPUT" and worker.state=="NEW"


@pytest.mark.parametrize("raw",['{"a":1,"a":2}','{"a":NaN}','{"a":Infinity}'])
def test_strict_json(raw):
    with pytest.raises(ProtocolError):strict_json(raw)


def test_checksum_and_path(tmp_path):
    worker,p=setup(tmp_path)
    p["input_manifest"]["sha256"]="0"*64
    with pytest.raises(ProtocolError) as error:worker.handle(req("initialize",p))
    assert error.value.code=="CHECKSUM_MISMATCH"


def test_symlink(tmp_path):
    worker,p=setup(tmp_path)
    (worker.input_root/"linked").symlink_to(worker.input_root/"manifest.json")
    p["input_manifest"]["path"]="linked"
    with pytest.raises(ProtocolError): worker.handle(req("initialize",p))


def test_sequence_replay_rejected(tmp_path):
    worker,p=setup(tmp_path)
    worker.handle(req("initialize",p))
    with pytest.raises(ProtocolError):worker.handle(req("initialize",p))


def test_gap_rejected(tmp_path):
    op=dict(op="apply_votes",payload=dict(from_slot_exclusive=1,to_slot_inclusive=2))
    worker,p=setup(tmp_path,[-1,1],[op]);worker.handle(req("initialize",p))
    with pytest.raises(ProtocolError):worker.handle(req(op["op"],op["payload"],2))


@pytest.mark.parametrize('raw',[b'[]\n',b'{"bad":true}\n',b'NaN\n',b'x'*65537+b'\n'])
def test_stdio_errors_are_terminal_and_framed(tmp_path,raw):
    import os,subprocess,sys
    env=dict(os.environ,OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1')
    process=subprocess.run([sys.executable,'-m','polismath.engine_adapter','--input-root',str(tmp_path),'--output-root',str(tmp_path/'out')],input=raw,capture_output=True,env=env,timeout=20)
    assert process.returncode==1
    lines=process.stdout.splitlines();assert len(lines)==1
    response=json.loads(lines[0]);assert response['ok'] is False


def test_restore_rejects_wrong_parent(tmp_path):
    ops=[dict(op='restore',payload=dict(profile='rebuild-prefix/1',parent={'foreign':True},payload={},vote_cursor=0,moderation_cursor=0))]
    worker,p=setup(tmp_path,ops=ops);worker.handle(req('initialize',p))
    with pytest.raises(ProtocolError) as error:worker.handle(req('restore',ops[0]['payload'],2))
    assert error.value.code=='STATE_INCOMPATIBLE'
