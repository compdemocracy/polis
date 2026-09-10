"""Synthetic-only snapshot selection, disclosure boundary and extraction wiring.

Selection-only and whole-config extraction have separate completion contracts.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import stat

from click.testing import CliRunner
import pytest

from polismath.replay import fixture_config as fc
from polismath.replay import fixture_extract as fx
from polismath.replay import fixture_generate as fg
from polismath.replay import fixture_selection as sel
from polismath.replay import fixture_survey as fs

SEED = "01" * 32


def metric(index, p=1, v=3):
    return {"zid": 910000000 + index, "P": p, "V": v, "C": int(v > 0),
            "U": p, "matrix_area": p, "registered_participants": p + 1,
            "all_comments": 1}


def configured():
    config = fc.load_config()
    config["config_version"] = "synthetic-representative-v1"
    config["representative_selection"] = dict(algorithm=sel.VERSION, target=20, seed=SEED)
    return config


def _cli():
    path = Path(__file__).resolve().parents[1] / "scripts/prodclone_extract.py"
    spec = importlib.util.spec_from_file_location("synthetic_selection_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def chosen(result):
    return [row["zid"] for row in result.provenance]


@pytest.mark.parametrize("n", [0, 1, 19, 20, 21, 45])
def test_population_shortfall_is_reported_without_duplicates(n):
    result = sel.select_representative([metric(i) for i in range(n)], SEED)
    counts = result.report["bucket_counts"]
    assert counts["population"] == n
    assert counts["selected"] == min(n, 20)
    assert counts["shortfall"] == max(0, 20-n)
    assert len(set(chosen(result))) == min(n, 20)
    if n < 20:
        assert set(chosen(result)) == {metric(i)["zid"] for i in range(n)}
    assert counts["uncovered"] == 0
    sel.validate_report(result.report)


@pytest.mark.parametrize("count,expected", [(0,0),(1,1),(9,1),(10,2),(99,2),(100,3),(999,3),(1000,4),(2**63-1,19)])
def test_integer_log_boundaries(count, expected):
    assert sel.log_bin(count) == expected


@pytest.mark.parametrize("value", [-1, True, None, 1.0, "10", 2**63])
def test_invalid_numeric_counts_fail_closed(value):
    rows = [metric(1)]
    rows[0]["V"] = value
    with pytest.raises(sel.SelectionError):
        sel.select_representative(rows, SEED)


@pytest.mark.parametrize("change", [dict(P=4),dict(U=0),dict(matrix_area=2),dict(V=0),dict(C=3)])
def test_inconsistent_population_fails_before_reporting(change):
    row = metric(1)
    row.update(change)
    with pytest.raises(sel.SelectionError, match="INCONSISTENT_METRICS"):
        sel.select_representative([row], SEED)


def test_duplicate_or_missing_identity_refused_without_rendering_it():
    row = metric(123)
    for rows in [[row, row], [{k:v for k,v in row.items() if k != "zid"}]]:
        with pytest.raises(sel.SelectionError) as exc:
            sel.select_representative(rows, SEED)
        assert str(exc.value) == "INVALID_IDENTITY_CENSUS"
        assert str(row["zid"]) not in str(exc.value)


def test_permuted_population_and_unrelated_outcomes_do_not_change_selection():
    rows = [metric(i, 10**(i % 4), 10**(i % 4 + 1)) for i in range(120)]
    before = copy.deepcopy(rows)
    expected = sel.select_representative(rows, SEED)
    variant = [dict(row, outcome="FAIL", topic="SYNTHETIC_PRIVATE_TEXT") for row in reversed(rows)]
    assert sel.select_representative(variant, SEED) == expected
    assert rows == before
    assert "SYNTHETIC_PRIVATE_TEXT" not in json.dumps(expected.report)
    assert "910000" not in repr(expected)
    assert chosen(sel.select_representative(rows, "02"*32)) != chosen(expected)


def test_tails_dense_middle_and_full_rectangular_grid_are_present():
    rows = [metric(0,0,0), metric(1,100000,1000000)]
    rows += [metric(i+2,100,10000) for i in range(100)]
    result = sel.select_representative(rows, SEED)
    assert {metric(0)["zid"], metric(1)["zid"]} <= set(chosen(result))
    assert sum(s["P"] == 100 for s in result.report["chosen_entry_sizes"]) == 18
    counts = result.report["bucket_counts"]
    assert len(counts["cells"]) == 7 * 8
    assert any(r["population"] == r["selected"] == 0 for r in counts["cells"])
    assert counts["covered"] == counts["occupied"] == 3


def test_more_than_twenty_occupied_cells_reports_uncovered_cells():
    rows = [metric(0,0,0)]
    rows += [metric(i+1,10**p,10**v) for i,(p,v) in enumerate(
        (p,v) for p in range(6) for v in range(p,7))]
    report = sel.select_representative(rows, SEED).report
    counts = report["bucket_counts"]
    assert counts["population"] == counts["occupied"] == 28
    assert counts["covered"] == 20 and counts["uncovered"] == 8
    assert len([r for r in counts["cells"] if r["population"] and not r["selected"]]) == 8
    assert counts["shortfall"] == 0


def test_exhausted_tail_cell_is_not_reused_for_remaining_quota():
    rows = [metric(0,0,0)] + [metric(i+1,100,1000) for i in range(30)]
    report = sel.select_representative(rows, SEED).report
    assert sum(r["P"] == 0 for r in report["chosen_entry_sizes"]) == 1
    assert sum(r["P"] == 100 for r in report["chosen_entry_sizes"]) == 19


def test_allocator_mutant_omitting_upper_tail_hits_independent_oracle(monkeypatch):
    rows = [metric(i) for i in range(30)] + [metric(50,100,1000)]
    monkeypatch.setattr(sel, "_allocate", lambda cells, seed: {c:20 if c==(1,1) else 0 for c in cells})
    with pytest.raises(sel.SelectionError, match="TAIL_NOT_COVERED"):
        sel.select_representative(rows, SEED)


@pytest.mark.parametrize("level", ["root","counts","cell","size"])
@pytest.mark.parametrize("forbidden", ["zid","path","rank","topic"])
def test_report_allowlist_rejects_every_unknown_field(level, forbidden):
    report = sel.select_representative([metric(1)],SEED).report
    target = {"root":report,"counts":report["bucket_counts"],
              "cell":report["bucket_counts"]["cells"][0],"size":report["chosen_entry_sizes"][0]}[level]
    target[forbidden] = "SYNTHETIC_PRIVATE_VALUE"
    with pytest.raises(sel.SelectionError) as exc:
        sel.validate_report(report)
    assert "SYNTHETIC_PRIVATE_VALUE" not in str(exc.value)


@pytest.mark.parametrize("change", ["wrong_total","missing_cell","wrong_bin","bool_count","missing_size"])
def test_report_rejects_tampered_census(change):
    report = sel.select_representative([metric(1)],SEED).report
    if change=="wrong_total": report["bucket_counts"]["population"]+=1
    if change=="missing_cell": report["bucket_counts"]["cells"].pop(0)
    if change=="wrong_bin": report["chosen_entry_sizes"][0]["p_bin"]+=1
    if change=="bool_count": report["chosen_entry_sizes"][0]["V"]=True
    if change=="missing_size": report["chosen_entry_sizes"].clear()
    with pytest.raises(sel.SelectionError):sel.validate_report(report)


@pytest.mark.parametrize("block", [None,{},dict(algorithm=sel.VERSION,target=19,seed=SEED),
    dict(algorithm="unknown",target=20,seed=SEED),dict(algorithm=sel.VERSION,target=True,seed=SEED),
    dict(algorithm=sel.VERSION,target=20,seed="A"*64),dict(algorithm=sel.VERSION,target=20,seed="01"),
    dict(algorithm=sel.VERSION,target=20,seed=SEED+"\n"),
    dict(algorithm=sel.VERSION,target=20,seed=SEED,ids=[1])])
def test_config_refuses_bad_selection_declarations(block):
    config=configured();config["representative_selection"]=block
    with pytest.raises(fc.ConfigError):fc.validate_config(config)
    with pytest.raises(fc.ConfigError):fc.representative_seed(config)


def test_opt_in_leaves_original_roles_battery_and_config_unchanged():
    original=fc.load_config();config=configured()
    fc.validate_config(config)
    assert fc.representative_seed(original) is None
    assert fc.representative_seed(config)==SEED
    for key in original.keys()-{"config_version"}:assert config[key]==original[key]
    assert "representative_selection" not in json.loads(fc.DEFAULT_CONFIG_PATH.read_text())
    battery=json.loads((fc.SCRIPTS_DIR/'certify_battery.json').read_text())
    assert len([r for r in battery if r['dataset'] in original['coverage_role_map']])==14


def mock_snapshot(monkeypatch, rows):
    calls=[]
    def opened(conn,**kw):
        calls.append(('open',kw))
        return dict(isolation_level='repeatable read',access_mode='read only',single_transaction=True,
                    imported_snapshot_id=kw['snapshot_id'])
    def fetch(conn):
        assert len(calls)==1
        calls.append(('fetch',None))
        return rows
    monkeypatch.setattr(fs,'open_readonly_repeatable_read',opened)
    monkeypatch.setattr(fs,'fetch_metrics',fetch)
    return calls


def test_selection_only_reads_one_snapshot_without_resolving_recipes(monkeypatch):
    rows=[metric(i) for i in range(22)]
    calls=mock_snapshot(monkeypatch,rows)
    monkeypatch.setattr(fs,'resolve_roles',lambda *a,**kw:pytest.fail('selection-only resolved recipes'))
    result=fx.select_representative_from_config(object(),config=configured(),snapshot_id='synthetic-snapshot',writers_disabled=True)
    assert calls==[('open',{'snapshot_id':'synthetic-snapshot','writers_disabled':True}),('fetch',None)]
    assert len(result['provenance_rows'])==20
    assert result['report']['bucket_counts']['population']==22
    assert result['transaction_guarantee']['imported_snapshot_id']=='synthetic-snapshot'


def test_missing_opt_in_refuses_before_database_access(monkeypatch):
    monkeypatch.setattr(fs,'open_readonly_repeatable_read',lambda *a,**kw:pytest.fail('unconfigured DB access'))
    with pytest.raises(sel.SelectionError,match='SELECTION_NOT_CONFIGURED'):
        fx.select_representative_from_config(object(),config=fc.load_config())


@pytest.mark.parametrize('enabled',[False,True])
def test_whole_extraction_shares_census_and_preserves_existing_recipe_resolution(tmp_path,monkeypatch,enabled):
    rows=[metric(i) for i in range(25)]
    calls=mock_snapshot(monkeypatch,rows)
    config=configured() if enabled else fc.load_config()
    seen=[]
    monkeypatch.setattr(fs,'coverage_report',lambda cfg,r: seen.append(('coverage',cfg,r)) or {'unchanged':True})
    monkeypatch.setattr(fs,'resolve_roles',lambda cfg,r,**kw:seen.append(('roles',cfg,r)) or [])
    monkeypatch.setattr(fx,'detect_tie_key',lambda conn:{'guarantee':'synthetic'})
    monkeypatch.setattr(fg,'write_all',lambda *a,**kw:[])
    captured=[]
    def capture(conn,**kw):
        captured.append(kw)
        return dict(slug=kw['slug'],role=kw['role'],dir=kw['dir_name'],measured_metrics=kw['measured'])
    monkeypatch.setattr(fx,'extract_conversation',capture)
    result=fx.extract_from_config(object(),config=config,payload_root=tmp_path,guard_root=tmp_path,snapshot_id='synthetic')
    assert len(calls)==2 and all(cfg is config and r is rows for _,cfg,r in seen)
    assert result['generated']==[]
    assert len(result['roles'])==len(result['provenance_rows'])==len(captured)==(20 if enabled else 0)
    assert not list(tmp_path.iterdir())
    assert ('representative_selection' in result)==enabled
    assert ('representative_provenance' in result)==enabled
    if enabled:
        assert len(result['representative_provenance'])==20
        assert result['representative_selection']==sel.select_representative(rows,SEED).report


@pytest.mark.parametrize('n',[0,1,19,25])
def test_selection_cli_outputs_only_report_and_stores_private_mapping(tmp_path,monkeypatch,n):
    cli=_cli();config_path=tmp_path/'config.json';config_path.write_text(json.dumps(configured()))
    rows=[metric(i) for i in range(n)];mock_snapshot(monkeypatch,rows)
    class Conn:
        closed=False
        def close(self):self.closed=True
    conn=Conn();monkeypatch.setattr(cli.psycopg2,'connect',lambda *a:conn)
    output=tmp_path/'real_data/.local/selection.private.json'
    result=CliRunner().invoke(cli.cli,['select-representative','--database-url','synthetic',
        '--from-config',str(config_path),'--out',str(output),'--snapshot-id','synthetic-snapshot'])
    assert result.exit_code==(2 if n==0 else 0),result.output
    report=json.loads(result.stdout);sel.validate_report(report)
    private=json.loads(output.read_text())
    assert report==private['report']
    assert len(private['provenance_rows'])==min(n,20)
    assert stat.S_IMODE(output.stat().st_mode)==0o600
    assert conn.closed
    assert 'zid' not in result.output and 'synthetic-snapshot' not in result.output and str(tmp_path) not in result.output
    assert '910000' not in result.output


@pytest.mark.parametrize('failure',['database','outside_path','forged_report'])
def test_cli_errors_never_render_private_details(tmp_path,monkeypatch,failure):
    cli=_cli();config_path=tmp_path/'config.json';config_path.write_text(json.dumps(configured()))
    output=tmp_path/'.local/selection.private.json'
    class Conn:
        def close(self):pass
    monkeypatch.setattr(cli.psycopg2,'connect',lambda *a:Conn())
    if failure=='database':
        def explode(*a):raise RuntimeError('SYNTHETIC_PRIVATE_CONNECTION')
        monkeypatch.setattr(cli.psycopg2,'connect',explode)
    if failure=='outside_path':output=tmp_path/'SYNTHETIC_PRIVATE_PATH'
    if failure=='forged_report':
        report=sel.select_representative([metric(1)],SEED).report
        report['topic']='SYNTHETIC_PRIVATE_TEXT'
        monkeypatch.setattr(fx,'select_representative_from_config',lambda *a,**kw:{'report':report})
    result=CliRunner().invoke(cli.cli,['select-representative','--database-url','synthetic',
        '--from-config',str(config_path),'--out',str(output)])
    assert result.exit_code==1 and 'REPRESENTATIVE_SELECTION_FAILED' in result.output
    assert 'SYNTHETIC_PRIVATE' not in result.output and str(tmp_path) not in result.output
    assert not output.exists()


def test_from_config_cli_confines_selection_identity_to_its_private_sidecar(tmp_path,monkeypatch):
    cli=_cli();config=configured();config_path=tmp_path/'config.json';config_path.write_text(json.dumps(config))
    selection=sel.select_representative([metric(i) for i in range(25)],SEED)
    result={'survey':{'private_zid':910000001,'n_conversations':25},
            'provenance_rows':[{'zid':910000002,'role':'synthetic-old-role'}],
            'roles':[], 'generated':[], 'dir_names':{}, 'coverage_report':{},
            'transaction_guarantee':{'imported_snapshot_id':'synthetic-private-snapshot'},
            'tie_key':{},'representative_selection':selection.report,
            'representative_provenance':list(selection.provenance)}
    class Conn:
        def close(self):pass
    monkeypatch.setattr(cli.psycopg2,'connect',lambda *a:Conn())
    monkeypatch.setattr(fx,'extract_from_config',lambda *a,**kw:result)
    payload=tmp_path/'real_data/.local/payload'
    output=CliRunner().invoke(cli.cli,['from-config','--database-url','synthetic',
        '--from-config',str(config_path),'--out',str(payload)])
    assert output.exit_code==0,output.output
    assert json.loads(output.stdout)==selection.report
    assert not list(payload.iterdir())
    sidecar=payload.with_name('payload.private')
    extracted=json.loads((sidecar/'certify_extract.json').read_text())
    assert 'representative_provenance' not in extracted
    private=json.loads((sidecar/'representative_selection.private.json').read_text())
    assert private['provenance_rows']==list(selection.provenance)
    assert stat.S_IMODE((sidecar/'representative_selection.private.json').stat().st_mode)==0o600
    assert '910000' not in output.output and str(tmp_path) not in output.output
    assert 'synthetic-private-snapshot' not in output.output


@pytest.mark.parametrize('failure',['path','database','role','write','report','missing_report'])
def test_from_config_selection_failure_is_fixed_text(tmp_path,monkeypatch,failure):
    cli=_cli();config_path=tmp_path/'config.json';config_path.write_text(json.dumps(configured()))
    payload=tmp_path/'real_data/.local/payload'
    class Conn:
        def close(self):pass
    monkeypatch.setattr(cli.psycopg2,'connect',lambda *a:Conn())
    def explode(*a,**kw):raise ValueError('SYNTHETIC_PRIVATE_DETAIL')
    if failure=='path':payload=tmp_path/'SYNTHETIC_PRIVATE_PATH'
    if failure=='database':monkeypatch.setattr(cli.psycopg2,'connect',explode)
    if failure=='role':monkeypatch.setattr(fx,'extract_from_config',explode)
    if failure=='missing_report':
        monkeypatch.setattr(fx,'extract_from_config',lambda *a,**kw:{})
    if failure in ('write','report'):
        result={'representative_selection':sel.select_representative([metric(1)],SEED).report,
                'survey':{},'provenance_rows':[]}
        if failure=='report':result['representative_selection']['path']='SYNTHETIC_PRIVATE_DETAIL'
        monkeypatch.setattr(fx,'extract_from_config',lambda *a,**kw:result)
        if failure=='write':monkeypatch.setattr(cli.fb,'os_umask_safe_write',explode)
    output=CliRunner().invoke(cli.cli,['from-config','--database-url','synthetic',
        '--from-config',str(config_path),'--out',str(payload)])
    assert output.exit_code==1 and 'REPRESENTATIVE_EXTRACTION_FAILED' in output.output
    assert 'SYNTHETIC_PRIVATE' not in output.output and str(tmp_path) not in output.output
