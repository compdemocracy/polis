"""The Delphi shadow's two report rules, siblings of participant_visible/1:
``all_comments/1`` (every comment, in each of the three moderation states:
unmoderated, moderated in, moderated out) and ``all_but_moderated_out/1``
(every comment but the moderated-out ones, whatever strict moderation says).

The rows are the selection goldens (tests/fixtures/selection/all_comments.json
and all_but_moderated_out.json), written by the Rust contract test from the
contract's own rules over the same rows as participant_visible.json: one
conversation holding comments in all three moderation states, with inactive
and muted ones among them. Here:

- the Python rules keep the same comments under the same digests as the Rust
  ones, open and under strict moderation;
- on that one conversation the three rules keep three different sets;
- a run that names either rule embeds every comment and gives the layout, the
  clustering, every stored family and the naming exactly what the rule keeps,
  through the input bundle a shadow run reads;
- the pipeline's entry points accept both names, alone, and pass them on.

The embedding model, the layout and the store are recorders (the fixture of
test_shadow_selection.py); the real run is the shadow rehearsal's.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from polismath import selection
from tests.test_run_delphi_exit_codes import app_dir  # noqa: F401  (fixture)
from tests.test_shadow_selection import ALL, GOLDEN as SHOWN_GOLDEN, ids_of, pipeline  # noqa: F401

DELPHI_ROOT = Path(__file__).resolve().parents[1]
GOLDENS = {
    name: json.loads((DELPHI_ROOT / f"tests/fixtures/selection/{name.split('/')[0]}.json").read_text("utf-8"))
    for name in (selection.ALL_COMMENTS, selection.ALL_BUT_MODERATED_OUT)
}
NOT_MODERATED_OUT = sorted(c["tid"] for c in SHOWN_GOLDEN["comments"] if c["mod"] != -1)


def expected(name, strict):
    return next(c for c in GOLDENS[name]["cases"] if c["strict_moderation"] is strict)


# --- the rules, in both languages ----------------------------------------------

def test_the_goldens_hold_one_conversation_in_all_three_moderation_states():
    for golden in GOLDENS.values():
        assert golden["comments"] == SHOWN_GOLDEN["comments"]
    assert {c["mod"] for c in SHOWN_GOLDEN["comments"]} == {-1, 0, 1}


@pytest.mark.parametrize("name", sorted(GOLDENS))
@pytest.mark.parametrize("strict", [False, True])
def test_python_keeps_what_the_rust_contract_keeps(name, strict):
    assert GOLDENS[name]["selection"] == name
    chosen = selection.select(name, GOLDENS[name]["comments"], strict)
    case = expected(name, strict)
    assert list(chosen.tids) == case["tids"]
    assert chosen.sha256 == case["sha256"]


def test_the_two_rules_are_every_comment_and_every_comment_not_moderated_out():
    for strict in (False, True):
        for active in (False, True):
            for velocity in (-1.0, 0.0, 0.25, 1.0):
                for mod in (-1, 0, 1):
                    assert selection.all_comments(active, velocity, mod, strict) is True
                    assert selection.all_but_moderated_out(active, velocity, mod, strict) is (mod != -1)


def test_three_rules_on_one_conversation_keep_three_sets():
    rows = SHOWN_GOLDEN["comments"]
    every = selection.select(selection.ALL_COMMENTS, rows, True)
    not_out = selection.select(selection.ALL_BUT_MODERATED_OUT, rows, True)
    shown = selection.select(selection.PARTICIPANT_VISIBLE, rows, True)
    assert list(every.tids) == ALL
    assert list(not_out.tids) == NOT_MODERATED_OUT
    assert list(shown.tids) == [0, 7]
    assert len({every.sha256, not_out.sha256, shown.sha256}) == 3
    # What each left out, by reason.
    assert every.left_out == {"inactive": 0, "muted": 0, "rejected": 0, "unaccepted": 0}
    assert not_out.left_out == {"inactive": 0, "muted": 0, "rejected": 2, "unaccepted": 0}


def test_the_rules_are_the_selections_in_the_contracts_order():
    assert selection.SELECTIONS == ("participant_visible/1", "all_comments/1", "all_but_moderated_out/1")
    assert tuple(selection.RULES) == selection.SELECTIONS


# --- the pipeline -------------------------------------------------------------

@pytest.mark.parametrize("name", sorted(GOLDENS))
@pytest.mark.parametrize("strict", [False, True])
def test_a_report_rule_run_embeds_every_comment_and_lays_out_what_its_rule_keeps(pipeline, name, strict):
    pipeline.use(strict)
    calls = pipeline.run(include_moderation=False, exclude_comment_selections=False, selection=name)
    kept = expected(name, strict)["tids"]
    texts = {c["tid"]: c["txt"] for c in SHOWN_GOLDEN["comments"]}
    assert calls["embeddings"] == ALL
    assert pipeline.seen["layout"] == [len(kept)]
    nodes, ends, clusters = ids_of(calls)
    assert nodes == set(kept) and ends <= set(kept)
    assert clusters == set(kept)
    assert calls["meta"].num_comments == len(kept)
    assert pipeline.seen["named"] == [[texts[t] for t in kept]]
    # The moderated-out comments are laid out under all_comments/1 and not
    # under all_but_moderated_out/1; the unmoderated ones under both.
    out = {c["tid"] for c in SHOWN_GOLDEN["comments"] if c["mod"] == -1}
    unmoderated = {c["tid"] for c in SHOWN_GOLDEN["comments"] if c["mod"] == 0}
    assert unmoderated <= clusters
    assert (out <= clusters) is (name == selection.ALL_COMMENTS)
    assert not (out & clusters) or name == selection.ALL_COMMENTS


def test_the_report_rules_counts_are_the_runs_facts(pipeline):
    pipeline.use(True)
    for name, selected, rejected in ((selection.ALL_COMMENTS, 9, 0), (selection.ALL_BUT_MODERATED_OUT, 7, 2)):
        facts = {}
        comments, _, kept = pipeline.module._read_selected_inputs(4242, name, facts)
        assert len(comments) == len(ALL) and len(kept) == selected
        assert facts == {"comments_read": 9, "selection": name, "strict_moderation": True,
                         "comments_embedded": 9, "comments_selected": selected, "comments_used": selected,
                         "left_out_inactive": 0, "left_out_muted": 0, "left_out_rejected": rejected,
                         "left_out_unaccepted": 0}


@pytest.mark.parametrize("name", sorted(GOLDENS))
def test_run_pipeline_takes_a_report_rule_only_alone(monkeypatch, name):
    import run_pipeline

    seen = {}
    monkeypatch.setattr(run_pipeline, "setup_environment", lambda **kw: None)
    monkeypatch.setattr(run_pipeline, "process_conversation", lambda zid, **kw: seen.update(kw) or True)
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", "--include_moderation=False",
                                      "--exclude_comment_selections=False", f"--selection={name}"])
    run_pipeline.main()
    assert seen["selection"] == name
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", f"--selection={name}"])
    with pytest.raises(SystemExit):
        run_pipeline.main()


@pytest.mark.parametrize("name", sorted(GOLDENS))
def test_run_delphi_passes_a_report_rule_by_name(app_dir, monkeypatch, name):  # noqa: F811
    argv_log = Path(os.environ["STAGE_LOG"]).with_name("argv.log")
    monkeypatch.setenv("ARGV_LOG", str(argv_log))
    stub = app_dir / "umap_narrative/run_pipeline.py"
    stub.write_text(
        "import json, os, sys\n"
        "open(os.environ['ARGV_LOG'], 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
    )
    flags = ["--include_moderation=False", "--exclude_comment_selections=False", f"--selection={name}"]
    result = subprocess.run([sys.executable, str(app_dir / "run_delphi.py"), "--zid=1", *flags],
                            cwd=app_dir, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    (argv,) = [json.loads(line) for line in argv_log.read_text().splitlines()]
    assert argv == ["--zid=1", "--include_moderation=False", "--exclude_comment_selections=False",
                    "--name-topics", f"--selection={name}"]
