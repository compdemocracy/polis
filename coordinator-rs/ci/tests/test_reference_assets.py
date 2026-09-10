"""Missing Git history never bypasses immutable committed-oracle admission."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import pytest

CI=Path(__file__).resolve().parents[1]
ROOT=CI.parents[1]
sys.path.insert(0,str(CI))
import reference_assets as assets
PINS=json.loads((CI/'inventory-v2.json').read_bytes())['reference_assets']


@pytest.mark.parametrize('identity',sorted(PINS))
def test_all_committed_oracles_match_the_reviewed_content_pin_without_history(identity,monkeypatch):
    monkeypatch.setattr(assets.shutil,'which',lambda _:None)
    reference,source=identity.split(':',1)
    raw=assets.load_asset(ROOT,reference,source)
    assert hashlib.sha256(raw).hexdigest()==PINS[identity]['sha256']


@pytest.mark.parametrize('mutation',['missing','changed','untracked-substitute','path-escape','symlink','bad-digest','upstream-disagreement'])
def test_oracle_refuses_missing_tampered_or_foreign_sources(tmp_path,monkeypatch,mutation):
    identity=next(iter(PINS));reference,source=identity.split(':',1)
    pin=dict(PINS[identity]);target=tmp_path/pin['path'];target.parent.mkdir(parents=True)
    target.write_bytes((ROOT/pin['path']).read_bytes())
    (tmp_path/'.git').write_text('read-only marker')
    monkeypatch.setattr(assets.shutil,'which',lambda _:'/usr/bin/git')
    monkeypatch.setattr(assets.subprocess,'run',lambda *a,**k:subprocess.CompletedProcess(a,128,b'',b'unavailable'))
    if mutation in ('missing','untracked-substitute'):target.unlink()
    if mutation=='untracked-substitute':
        original=tmp_path/source;original.parent.mkdir(parents=True,exist_ok=True);original.write_text('untracked fallback forbidden')
    elif mutation=='changed':target.write_bytes(b'pass\n')
    elif mutation=='path-escape':pin['path']='../outside'
    elif mutation=='symlink':
        target.unlink();target.symlink_to(ROOT/PINS[identity]['path'])
    elif mutation=='bad-digest':pin['sha256']='invalid'
    elif mutation=='upstream-disagreement':
        monkeypatch.setattr(assets.subprocess,'run',lambda *a,**k:subprocess.CompletedProcess(a,0,b'wrong history',b''))
    (tmp_path/'coordinator-rs/ci/inventory-v2.json').write_text(json.dumps({'reference_assets':{identity:pin}}))
    with pytest.raises(ValueError,match='collection:'):
        assets.load_asset(tmp_path,reference,source)


def test_available_history_checks_upstream_pin_and_unavailable_history_is_optional(monkeypatch):
    identity=next(iter(PINS));reference,source=identity.split(':',1)
    raw=(ROOT/PINS[identity]['path']).read_bytes()
    monkeypatch.setattr(assets.shutil,'which',lambda _:'/usr/bin/git')
    for code in (0,128):
        monkeypatch.setattr(assets.subprocess,'run',lambda *a,**k:subprocess.CompletedProcess(a,code,raw,b''))
        assert assets.load_asset(ROOT,reference,source)==raw
