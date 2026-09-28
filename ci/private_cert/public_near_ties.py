#!/usr/bin/env python3
"""Public coincident-geometry stream through both real replay drivers.

Run --expect-tie after stacking the BLAS PCA change. Without that change the
same stream normally passes without using a tie. No engine monkeypatch is used.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
from unittest.mock import patch
from public_revote_columns import ROOT, gate, record_case
import near_ties


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--expect-tie',action='store_true')
    args=parser.parse_args()
    out=args.out.resolve();out.mkdir()
    os.environ['PYTHONPATH']=str(ROOT/'delphi')
    for key in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'):
        os.environ[key]='1'
    fixture=ROOT/'delphi/tests/replay_harness/fixtures/near_tie_votes.json'
    case=json.loads(fixture.read_text())
    report=record_case(case,out/'case')
    expected=gate.certify.prepare_entry(gate.certify.BatteryEntry('pc-revote-02',
        'uniform6-clojure-legacy',schedule_path=out/'case/schedule.json',role='revote-heavy'))
    with tempfile.TemporaryDirectory() as tmp, patch.object(near_ties,'measure_recording',return_value=None):
        before=gate.verify_pairs([expected],out/'case/recordings',Path(tmp),attribution=True)
    tie=report['entries'][0].get('decision_tie')
    if args.expect_tie:
        assert before['verdict']=='FAIL' and report['verdict']=='PASS' and tie is not None
    else:
        assert report['verdict']=='PASS'
    # A genuine continuous error stays red, including after an observed tie.
    mutated=out/'negative-recordings';shutil.copytree(out/'case/recordings',mutated)
    rec=gate.store.recording_dir('pc-revote-02','uniform6-clojure-legacy',root=mutated)
    path=rec/'py/step-005.json';doc=gate.read(path)
    doc['blob']['pca']['comment-projection'][0][0]+=1.
    path.write_bytes(gate.encoded(doc))
    with tempfile.TemporaryDirectory() as tmp:
        negative=gate.verify_pairs([expected],mutated,Path(tmp),attribution=True)
    assert negative['verdict']=='FAIL'
    result=dict(before=before['verdict'],after=report['verdict'],tie=tie,
        non_tie_negative=negative['verdict'],checks=report['checks'],
        controls=report['negative_controls'],fixture_sha256=gate.file_digest(fixture))
    gate.dump(out/'summary.json',result)
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    main()
