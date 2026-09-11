"""Pinned #2704 poller, one explicitly scheduled cold/rebuild checkpoint.

Reads the same local DB; the parent controls visibility cuts. The static comment
snapshot is read by load-or-init; there is no second moderation-triggered compute.
"""
import importlib
import logging
import os
from pathlib import Path
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[3]
REF="b3262008f"
sys.path.insert(0,str(ROOT/"coordinator-rs/ci"))
from reference_assets import load_asset
logging.disable(logging.CRITICAL)
with tempfile.TemporaryDirectory(prefix="p026-reference-") as tmp:
    tmp=Path(tmp)
    import polismath.database
    import polismath.poller
    for folder,names in [("database",["postgres.py"]),("poller",["service.py","worker_pool.py","math_writer.py"])]:
        dest=tmp/folder;dest.mkdir()
        for name in names:
            (dest/name).write_bytes(load_asset(ROOT,REF,f"delphi/polismath/{folder}/{name}"))
        getattr(polismath,folder).__path__.insert(0,str(dest))
    for name in ("polismath.database.postgres", "polismath.poller.worker_pool", "polismath.poller.math_writer", "polismath.poller.service"):
        sys.modules.pop(name,None)
    from polismath.database.postgres import PostgresClient,PostgresConfig
    from polismath.poller.service import MathPollerService,PollerConfig
    assert str(tmp) in sys.modules["polismath.poller.math_writer"].__file__
    assert str(tmp) in sys.modules["polismath.database.postgres"].__file__
    pg=PostgresClient(PostgresConfig(url=os.environ["DATABASE_URL"],math_env="python",ssl_mode="disable"))
    svc=MathPollerService(pg,PollerConfig(math_env="python",worker_pool_size=1,retry_cap=0,allowlist=[1]))
    svc._ensure_runtime()
    svc._vote_wm=0
    svc._mod_wm=2**63-1
    svc.poll_once()
    assert svc._pool.join(timeout=120)
    assert not svc._pool.parked_zids(), "reference failed/parked"
    if "--warm-boundary" in sys.argv:
        import sqlalchemy as sa
        t=svc._vote_wm
        with pg.engine.begin() as conn:
            conn.execute(sa.text("INSERT INTO votes(zid,pid,tid,vote,created) VALUES(1,0,0,1,:t),(1,2,2,-1,:later)"),{"t":t,"later":t+1000})
        svc.poll_once()
        assert not svc._pool.parked_zids()
    svc.stop();pg.shutdown()
print("DONE")
