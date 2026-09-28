"""Real slow-runner latch witness; normal publication lock budgets stay intact."""
import json
import sys
import textwrap

import pytest

from coordinator.conftest import ROOT, ARTIFACTS, assert_coherent, connect, seed, wait


@pytest.mark.parametrize('requested_kernel', [None, 'Haswell'])
def test_actual_bridge_child_preserves_requested_kernel(db, launch, tmp_path, monkeypatch, requested_kernel):
    """Observe the process that computes/publishes, after Rust's env_clear.

    Parent-only BLAS observation missed this boundary on heterogeneous runners.
    The wrapper runs the real module in the same process, then records its loaded
    libraries. No input, engine function, or output is replaced.
    """
    monkeypatch.delenv('OPENBLAS_CORETYPE', raising=False)
    observation = tmp_path / 'worker-runtime.json'
    wrapper = tmp_path / 'observe-python'
    wrapper.write_text(f'#!{sys.executable}\n' + textwrap.dedent(f'''
        import json
        import os
        from pathlib import Path
        import runpy
        import sys

        assert sys.argv[1:] == ['-m', 'polismath.poller.coordinator_bridge']
        sys.argv = [sys.argv[2]]
        try:
            runpy.run_module('polismath.poller.coordinator_bridge', run_name='__main__', alter_sys=True)
        finally:
            sys.path.insert(0, {str(ROOT / 'coordinator-rs/ci')!r})
            from replay_pins import runtime_identity
            Path({str(observation)!r}).write_text(json.dumps({{
                'pid': os.getpid(), 'parent_pid': os.getppid(),
                'requested_kernel': os.environ.get('OPENBLAS_CORETYPE'),
                'unrelated_inherited': 'P026_UNRELATED_PARENT_SETTING' in os.environ,
                'runtime': runtime_identity(),
            }}, indent=2) + '\\n')
    '''))
    wrapper.chmod(0o700)
    extra = {'P026_PYTHON': str(wrapper), 'P026_UNRELATED_PARENT_SETTING': 'must-not-leak'}
    if requested_kernel is not None:
        extra['OPENBLAS_CORETYPE'] = requested_kernel
    seed(db)
    child = launch(db, extra=extra)
    child.done()
    actual = json.loads(observation.read_text())
    (ARTIFACTS / f'bridge-kernel-{requested_kernel}.json').write_text(json.dumps(actual, indent=2) + '\n')
    assert actual['pid'] != child.proc.pid
    assert actual['parent_pid'] == child.proc.pid
    assert actual['requested_kernel'] == requested_kernel
    assert actual['unrelated_inherited'] is False
    runtime = actual['runtime']
    assert runtime['blas_observed'] and runtime['blas']
    assert all(row['num_threads'] == 1 for row in runtime['blas'])
    records = list((ARTIFACTS / 'worker-runtimes').glob(f'{child.proc.pid}-*.json'))
    assert len(records) == 1
    production = json.loads(records[0].read_text())['observations']
    assert len(production) == 1
    assert production[0]['worker_pid'] == actual['pid']
    assert production[0]['runtime']['forced_kernel'] == (requested_kernel or 'not-forced')
    assert production[0]['runtime']['blas'] == runtime['blas']
    if requested_kernel and (runtime['system'], runtime['machine']) == ('Linux', 'x86_64'):
        from replay_pins import validate_kernel
        validate_kernel(runtime)
    assert_coherent(db)


@pytest.mark.parametrize('old_latch', [False, True])
def test_after_main_pause_outlives_normal_lock_budget(db, launch, tmp_path, old_latch):
    seed(db)
    connection = connect(db)
    with connection.cursor() as cur:
        cur.execute("SELECT pg_get_functiondef('p027_bridge_pause()'::regprocedure)")
        original = cur.fetchone()[0]
        if old_latch:
            # The exact old latch inherited the writer's five-second lock budget.
            mutant = original.replace("  PERFORM set_config('lock_timeout','120s',true);", '')
            assert mutant != original
            cur.execute(mutant)
        else:
            # This runs after p027_after in the actual main INSERT. The longer
            # budget must have ended with the deliberate advisory-lock pause.
            cur.execute("""CREATE FUNCTION p027_check_lock_budget() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN IF current_setting('lock_timeout')<>'5s' THEN
              RAISE EXCEPTION 'publication lock budget was not restored'; END IF; RETURN NEW; END $$;
              CREATE TRIGGER zz_p027_check_lock_budget AFTER INSERT ON math_main
              FOR EACH ROW EXECUTE FUNCTION p027_check_lock_budget();""")
    try:
        child = launch(db, stage='after_main', directory=tmp_path/'held')
        ack = child.ack()
        pid = ack['context']['backend_pid']
        with connection.cursor() as cur:
            cur.execute("SELECT clock_timestamp()+interval '6 seconds'")
            deadline = cur.fetchone()[0]

        def elapsed():
            with connection.cursor() as cur:
                cur.execute('SELECT clock_timestamp()>%s', (deadline,))
                return cur.fetchone()[0]

        wait(elapsed, alive=child, why='DB time exceeds the normal lock budget')
        with connection.cursor() as cur:
            cur.execute("SELECT EXISTS(SELECT FROM pg_locks WHERE pid=%s AND locktype='advisory' AND NOT granted)", (pid,))
            still_waiting = cur.fetchone()[0]
            cur.execute("SELECT state FROM pg_stat_activity WHERE pid=%s", (pid,))
            state = cur.fetchone()[0]
        assert still_waiting is not old_latch
        if old_latch:
            assert state == 'idle in transaction (aborted)', state
        child.release()
        _, stderr = child.done(code=1 if old_latch else 0)
        if old_latch:
            assert 'UNCERTAIN_COMMIT_LOST' in stderr
            with connection.cursor() as cur:
                cur.execute('SELECT count(*) FROM polis_coordinator_generations')
                assert cur.fetchone()[0] == 0
                cur.execute('SELECT state FROM polis_coordinator_operations')
                assert cur.fetchone()[0] == 'unresolved'
        else:
            assert 'UNCERTAIN_COMMIT_LOST' not in stderr
            assert_coherent(db)
        (ARTIFACTS/f'hosted-latch-{old_latch}.json').write_text(json.dumps({
            'old_latch':old_latch, 'past_normal_lock_budget':True,
            'actual_backend_still_on_advisory_lock':still_waiting,
            'backend_state':state, 'exit_code':child.proc.returncode,
            'production_lock_budget_seconds':5, 'latch_lock_budget_seconds':5 if old_latch else 120,
            'normal_lock_budget_restored':not old_latch,
        },indent=2)+'\n')
    finally:
        with connection.cursor() as cur:
            cur.execute(original)
        connection.close()
