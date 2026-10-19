"""Compressor admission and exact cached-body negative controls."""
import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest

CI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI))
from compressor import FIELDS, admit_node, observe_node, validate_compressor
from replay_pins import select_pin


def admitted():
    return json.loads((CI / "replay-pins.json").read_text())["pins"][0]["compressor"]


def test_reviewed_compressor_passes_without_binding_install_path():
    validate_compressor(dict(admitted(), executable="/different/install/node"), admitted())


@pytest.mark.parametrize("field", FIELDS)
def test_changed_build_is_refused_even_with_node24(field):
    observed = dict(admitted())
    observed[field] = "unreviewed"
    with pytest.raises(ValueError, match="REPLAY_COMPRESSOR_UNADMITTED"):
        validate_compressor(observed, admitted())


@pytest.mark.parametrize("observation", [None, {}, {"node": "v24.21.0"}])
def test_missing_build_is_not_a_fallback(observation):
    runtime = dict(system="Darwin", machine="arm64", forced_kernel="not-forced", compressor=observation)
    for check in (admit_node, select_pin):
        with pytest.raises(ValueError, match="REPLAY_COMPRESSOR_UNADMITTED"):
            check(runtime, CI / "replay-pins.json")


def test_probe_hashes_actual_executable():
    import hashlib
    observed = observe_node()
    assert observed["executable_sha256"] == hashlib.sha256(Path(observed["executable"]).read_bytes()).hexdigest()
    assert all(observed[field] for field in FIELDS)


@pytest.mark.parametrize("mode", ["valid", "different_json", "reordered_json", "truncated", "not_gzip", "not_buffer"])
def test_actual_cached_gzip_contract(mode):
    helper = CI.parent / "tools/gzip_contract.cjs"
    script = r'''
const {assertGzipJson} = require(process.argv[1]);
const {gzipSync} = require('node:zlib');
const mode=process.argv[2];
let asJSON='{"a":1,"b":2}', asBufferOfGzippedJson=gzipSync(asJSON);
if(mode==='different_json') asJSON='{"a":2,"b":2}';
if(mode==='reordered_json') asJSON='{"b":2,"a":1}';
if(mode==='truncated') asBufferOfGzippedJson=asBufferOfGzippedJson.subarray(0,10);
if(mode==='not_gzip') asBufferOfGzippedJson=Buffer.from(asJSON);
if(mode==='not_buffer') asBufferOfGzippedJson=asBufferOfGzippedJson.toString('base64');
assertGzipJson({asJSON,asBufferOfGzippedJson});
'''
    result = subprocess.run(["node", "-e", script, str(helper), mode], capture_output=True, text=True)
    assert (result.returncode == 0) == (mode == "valid")


def test_compressor_is_admitted_before_campaign_controls():
    source = (CI / 'run.py').read_text()
    assert source.index('admit_node(receipt') < source.index('run("controls"')
    assert 'Node compressor changed during campaign' in source
