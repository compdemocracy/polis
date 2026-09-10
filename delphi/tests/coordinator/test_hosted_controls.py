"""Real slow-runner latch witness; normal publication lock budgets stay intact."""
import json

import pytest

from coordinator.conftest import ARTIFACTS, assert_coherent, connect, seed, wait


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
