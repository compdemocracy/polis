"""Gate mutations for platform pins and mandatory fresh engine byte equality."""
import copy
import json
from pathlib import Path
import platform
import sys

import pytest

CI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CI))
from replay_pins import child_runtimes, kernel_environment, runtime_identity, select_pin, validate_kernel, REQUIRED_WORKERS
from verify import comparisons


def runtime(system, machine):
    requested='Haswell' if (system,machine)==('Linux','x86_64') else 'not-forced'
    return dict(system=system,machine=machine,forced_kernel=requested,blas=[
        dict(prefix=p,internal_api='openblas',architecture='Haswell',num_threads=1)
        for p in ('libopenblas','libscipy_openblas')])


def fixture_registry(tmp_path):
    # Exercise the actual admitted registry, including the forced Linux witnesses.
    return CI / 'replay-pins.json'


def fixture(tmp_path, system, machine):
    evidence = CI.parent / "evidence"
    baseline = {p.name: p.read_bytes() for p in evidence.glob("*.json")}
    artifacts, fresh = tmp_path / "artifacts", tmp_path / "evidence"
    artifacts.mkdir()
    fresh.mkdir()
    for name, raw in baseline.items():
        (artifacts / name).write_bytes(raw)
        (fresh / name).write_bytes(raw)
    selected = select_pin(runtime(system,machine), fixture_registry(tmp_path))
    for name, witness in selected["pin"]["witnesses"].items():
        directory = fresh if name.startswith("d4") else artifacts
        (directory / name).write_text(json.dumps(witness))
    replay = json.loads(baseline["vw-equivalence.json"])
    for row, pin in zip(replay["checkpoints"], selected["pin"]["checkpoints"], strict=True):
        row["rust"] = row["python"] = pin["rust"]
    (artifacts / "vw-equivalence.json").write_text(json.dumps(replay))
    return artifacts, fresh, baseline, selected, replay


@pytest.mark.parametrize("system,machine", [("Darwin", "arm64"), ("Linux", "x86_64")])
def test_known_platform_passes_and_receipt_identifies_pin(tmp_path, system, machine):
    artifacts, fresh, baseline, selected, _ = fixture(tmp_path, system, machine)
    result = comparisons(artifacts, fresh, baseline, selected)
    assert result["replay_pin"] == selected
    assert len(selected["registry_sha256"]) == 64
    assert selected["pin"]["attribution"]["replay_sha256"]
    assert result["checkpoints"] == 3


@pytest.mark.parametrize("system,machine", [("Darwin", "arm64"), ("Linux", "x86_64")])
@pytest.mark.parametrize("mutation,error", [
    ("fresh-rust", "REPLAY_FRESH_ENGINE_MISMATCH"),
    ("fresh-python", "REPLAY_FRESH_ENGINE_MISMATCH"),
    ("deltas", "REPLAY_FRESH_ENGINE_MISMATCH"),
    ("both-drift", "REPLAY_HISTORICAL_DRIFT"),
    ("other-platform", "REPLAY_HISTORICAL_DRIFT"),
    ("cut", "REPLAY_HISTORICAL_DRIFT"),
    ("tick", "REPLAY_HISTORICAL_DRIFT"),
    ("fold", "REPLAY_STABLE_FIELDS_DRIFT"),
    ("profile", "REPLAY_PROFILE_DRIFT"),
])
def test_platform_admission_preserves_fresh_and_historical_checks(tmp_path, system, machine, mutation, error):
    artifacts, fresh, baseline, selected, replay = fixture(tmp_path, system, machine)
    row = replay["checkpoints"][0]
    if mutation.startswith("fresh-"):
        row[mutation.removeprefix("fresh-")] = "0" * 64
    elif mutation == "deltas":
        row["deltas"] = ["drift"]
    elif mutation == "both-drift":
        row["rust"] = row["python"] = "0" * 64
    elif mutation == "other-platform":
        other = {"system": "Linux", "machine": "x86_64"} if system == "Darwin" else {"system": "Darwin", "machine": "arm64"}
        row["rust"] = row["python"] = select_pin(runtime(**other), fixture_registry(tmp_path))["pin"]["checkpoints"][0]["rust"]
    elif mutation in ("cut", "tick"):
        row[mutation] += 1
    elif mutation == "fold":
        row["fold_errors"]["python"] = ["lost vote"]
    else:
        replay["profile"] = "different experiment"
    (artifacts / "vw-equivalence.json").write_text(json.dumps(replay))
    with pytest.raises(ValueError, match=error):
        comparisons(artifacts, fresh, baseline, selected)


@pytest.mark.parametrize("system,machine", [("Linux", "aarch64"), ("Darwin", "x86_64"), ("Windows", "AMD64"), ("", "")])
def test_unknown_platform_fails_closed(system, machine):
    with pytest.raises(ValueError, match="REPLAY_PLATFORM_UNADMITTED"):
        select_pin(runtime(system,machine), CI / "replay-pins.json")


@pytest.mark.parametrize("mutation", ["duplicate", "empty", "digest", "checkpoint", "schema"])
def test_bad_pin_registry_refused(tmp_path, mutation):
    registry = json.loads((CI / "replay-pins.json").read_text())
    if mutation == "duplicate":
        registry["pins"].append(copy.deepcopy(registry["pins"][0]))
    elif mutation == "empty":
        registry["pins"] = []
    elif mutation == "digest":
        registry["pins"][0]["checkpoints"][0]["rust"] = "bad"
    elif mutation == "checkpoint":
        registry["pins"][0]["checkpoints"].reverse()
    else:
        registry["schema"] = "unknown"
    path = tmp_path / "pins.json"
    path.write_text(json.dumps(registry))
    with pytest.raises(ValueError, match="REPLAY_PLATFORM_PINS_INVALID"):
        select_pin(runtime("Darwin","arm64"), path)


def test_runtime_records_actual_os_machine_and_blas():
    runtime = runtime_identity()
    assert runtime["system"] == platform.system()
    assert runtime["machine"] == platform.machine()
    assert runtime["blas_observed"] and runtime["blas"]
    assert all(row["user_api"] == "blas" and row["internal_api"] for row in runtime["blas"])


def test_arm_pin_keeps_reviewed_laptop_bytes(tmp_path):
    artifacts, fresh, baseline, selected, _ = fixture(tmp_path, "Darwin", "arm64")
    old = json.loads(baseline["vw-equivalence.json"])
    old["checkpoints"][0]["rust"] = "0" * 64
    baseline["vw-equivalence.json"] = json.dumps(old).encode()
    with pytest.raises(ValueError, match="REPLAY_LAPTOP_PIN_DRIFT"):
        comparisons(artifacts, fresh, baseline, selected)


@pytest.mark.parametrize("system,machine", [("Darwin", "arm64"), ("Linux", "x86_64")])
@pytest.mark.parametrize("mutation,error", [
    ("polarity-pair", "POLARITY_FRESH_MISMATCH"),
    ("polarity-negative", "POLARITY_FRESH_MISMATCH"),
    ("polarity-both", "comparison drift"),
    ("schedule-pair", "POLARITY_FRESH_MISMATCH"),
    ("schedule-negative", "POLARITY_FRESH_MISMATCH"),
    ("tie-negative", "POLARITY_FRESH_MISMATCH"),
    ("reader-pair", "D4_FRESH_ENGINE_MISMATCH"),
    ("reader-both", "D4 drift"),
    ("empty-published", "D4 stable empty fields or published bytes drift"),
    ("empty-stable", "D4 stable empty fields or published bytes drift"),
])
def test_seven_witnesses_keep_paired_negative_and_historical_checks(tmp_path, system, machine, mutation, error):
    artifacts, fresh, baseline, selected, _ = fixture(tmp_path, system, machine)
    if mutation.startswith("polarity"):
        path = artifacts / "polarity-vw.json"
    elif mutation.startswith("schedule"):
        path = artifacts / "polarity-rebuild-schedule.json"
    elif mutation.startswith("tie"):
        path = artifacts / "semantic-tie-key.json"
    elif mutation.startswith("reader"):
        path = fresh / "d4-node-reader.json"
    else:
        path = fresh / "d4-node-reader-empty.json"
    current = json.loads(path.read_text())
    if mutation == "polarity-pair":
        current["b"] = "0" * 64
    elif mutation in ("polarity-negative", "tie-negative"):
        current["negative"] = current["a"]
    elif mutation == "polarity-both":
        current["a"] = current["b"] = "0" * 64
    elif mutation == "schedule-pair":
        current[0]["paired"] = "0" * 64
    elif mutation == "schedule-negative":
        current[0]["negative"] = current[0]["positive"]
    elif mutation.startswith("reader"):
        current["served"]["python"]["mapping_sha256"] = "0" * 64
        if mutation == "reader-both":
            current["served"]["rustproto"]["mapping_sha256"] = "0" * 64
    elif mutation == "empty-published":
        current["served"]["rustproto"]["raw"]["gzip_sha256"] = "0" * 64
    else:
        current["served"]["python"]["tids"] = [99]
    path.write_text(json.dumps(current))
    with pytest.raises(ValueError, match=error):
        comparisons(artifacts, fresh, baseline, selected)


@pytest.mark.parametrize("system,machine", [("Darwin", "arm64"), ("Linux", "x86_64")])
def test_existing_empty_clock_observation_remains_observation(tmp_path, system, machine):
    artifacts, fresh, baseline, selected, _ = fixture(tmp_path, system, machine)
    path = fresh / "d4-node-reader-empty.json"
    current = json.loads(path.read_text())
    current["served"]["python"]["last_vote_timestamp"] += 1
    path.write_text(json.dumps(current))
    result = comparisons(artifacts, fresh, baseline, selected)
    assert result["synthesized_empty_byte_equality_claimed"] is False
    assert len(result["empty_observations"]) == 9


@pytest.mark.parametrize('system,machine,expected',[('Linux','x86_64','Haswell'),('Darwin','arm64',None)])
def test_campaign_environment_overrides_inherited_kernel_before_children(system,machine,expected):
    incoming={'OPENBLAS_CORETYPE':'Cooperlake','UNCHANGED':'value'}
    result=kernel_environment(incoming,system,machine)
    assert result.get('OPENBLAS_CORETYPE')==expected
    assert result['UNCHANGED']=='value' and incoming['OPENBLAS_CORETYPE']=='Cooperlake'


@pytest.mark.parametrize('mutation',['numpy-kernel','scipy-kernel','missing-library','extra-library','other-api','threads','requested','missing-request','unforced-linux'])
def test_forced_kernel_refuses_unhonoured_observation(mutation):
    r=runtime('Linux','x86_64')
    if mutation=='numpy-kernel':r['blas'][0]['architecture']='Cooperlake'
    elif mutation=='scipy-kernel':r['blas'][1]['architecture']='SkylakeX'
    elif mutation=='missing-library':r['blas'].pop()
    elif mutation=='extra-library':r['blas'].append(copy.deepcopy(r['blas'][0]))
    elif mutation=='other-api':r['blas'][0]['internal_api']='mkl'
    elif mutation=='threads':r['blas'][0]['num_threads']=2
    elif mutation=='requested':r['forced_kernel']='Cooperlake'
    elif mutation=='missing-request':r.pop('forced_kernel')
    else:r['forced_kernel']='not-forced'
    with pytest.raises(ValueError,match='REPLAY_KERNEL_NOT_HONOURED'):validate_kernel(r)


def test_shipped_forced_linux_pin_has_two_attributed_kernel_witnesses():
    r=runtime('Linux','x86_64')
    validate_kernel(r)
    selected=select_pin(r,CI/'replay-pins.json')
    pin=selected['pin']
    assert pin['id']=='linux-x86_64-haswell-v1'
    provenance=pin['attribution']
    assert provenance['source_head']=='7db636a7d5924bfa2fe1b369241319ead9782fba'
    assert provenance['github_run_id']=='34558935924'
    witness=provenance['corroboration']
    assert witness['source_head']=='d0f5dae8b4b57670616298d6f445446a4a842be7'
    assert witness['github_run_id']=='34560601079'
    for run in (provenance,witness):
        validate_kernel(run['runtime'])
        assert run['requested_kernel']=='Haswell'
        assert run['run_attempt']=='1'
        assert len(run['receipt_sha256'])==len(run['replay_sha256'])==64
        assert set(run['witness_sha256'])==set(pin['witnesses'])
    assert witness['six_witnesses_byte_identical']
    assert witness['replay_checkpoints_identical']
    assert len(provenance['dependency_review_sha256'])==64
    reg=json.loads((CI/'replay-pins.json').read_text())
    assert reg['retired_pins'][0]['forced_kernel']=='not-forced'
    assert reg['retired_pins'][0]['attribution']['github_run_id'] not in {
        provenance['github_run_id'],witness['github_run_id']}


def test_kernel_is_part_of_registry_key_and_receipt(tmp_path):
    selected=select_pin(runtime('Linux','x86_64'),fixture_registry(tmp_path))
    assert selected['key_fields']==['system','machine','forced_kernel']
    assert selected['pin']['forced_kernel']=='Haswell'
    assert selected['runtime']['blas'][1]['architecture']=='Haswell'


def test_historical_refusal_occurs_after_fresh_artifacts_and_before_pass():
    import ast
    tree=ast.parse((CI/'run.py').read_text())
    calls={}
    for node in ast.walk(tree):
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Name):calls.setdefault(node.func.id,[]).append(node.lineno)
    assert min(calls['validate_kernel']) < min(calls['select_pin'])
    assert max(calls['stage_audit']) < min(calls['select_pin']) < min(calls['comparisons'])
    assert max(calls['stage_audit']) < min(calls['child_runtimes']) < min(calls['select_pin'])
    for node in ast.walk(tree):
        if (isinstance(node,ast.Assign) and isinstance(node.value,ast.Constant) and node.value.value=='PASS'
                and any(isinstance(t,ast.Subscript) and isinstance(t.slice,ast.Constant)
                        and t.slice.value=='candidate_gate' for t in node.targets)):
            assert node.lineno > min(calls['comparisons'])


@pytest.mark.parametrize('mutation', ['none', 'missing-all', 'missing-case', 'duplicate',
    'parent-only', 'requested', 'child-requested', 'numpy-kernel', 'scipy-kernel', 'threads', 'missing-library'])
def test_campaign_requires_actual_child_kernel_observations(tmp_path, mutation):
    parent = runtime('Linux', 'x86_64')
    for index, (case, count) in enumerate(REQUIRED_WORKERS.items()):
        observations = []
        for worker in range(count):
            pid = 100 + index * 10 + worker
            value = runtime('Linux', 'x86_64')
            value.update(worker_pid=pid, blas_observed=True)
            observations.append({'worker_pid': pid, 'runtime': value})
        record = {'schema': 'polis-worker-runtime-observation/1', 'test_case': case,
                  'parent_pid': index + 1, 'requested_kernel': 'Haswell', 'observations': observations}
        (tmp_path / f'{index}.json').write_text(json.dumps(record))
    path = tmp_path / '0.json'
    record = json.loads(path.read_text())
    child = record['observations'][0]['runtime']
    if mutation == 'missing-all':
        for p in tmp_path.iterdir(): p.unlink()
    elif mutation == 'missing-case': path.unlink()
    else:
        if mutation == 'duplicate': record['observations'].append(copy.deepcopy(record['observations'][0]))
        elif mutation == 'parent-only': child['worker_pid'] = record['parent_pid']
        elif mutation == 'requested': record['requested_kernel'] = 'not-forced'
        elif mutation == 'child-requested': child['forced_kernel'] = 'not-forced'
        elif mutation == 'numpy-kernel': child['blas'][0]['architecture'] = 'Cooperlake'
        elif mutation == 'scipy-kernel': child['blas'][1]['architecture'] = 'Cooperlake'
        elif mutation == 'threads': child['blas'][0]['num_threads'] = 2
        elif mutation == 'missing-library': child['blas'].pop()
        path.write_text(json.dumps(record))
    if mutation == 'none':
        result = child_runtimes(tmp_path, parent)
        assert result['workers'] == 7 and result['required_cases'] == REQUIRED_WORKERS
    else:
        with pytest.raises(ValueError, match='REPLAY_(CHILD_KERNEL|KERNEL_NOT_HONOURED)'):
            child_runtimes(tmp_path, parent)
