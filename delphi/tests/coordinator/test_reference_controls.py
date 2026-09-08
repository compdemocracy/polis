"""Preserve C's original R12 SQL negative controls without changing assertions."""
import ast
import json
import pytest
import sqlalchemy as sa
from conftest import asset, seed


def controls():
    tree=ast.parse(asset('test_r12_publication_cursor.py'))
    selected=[]
    names={'allocate_and_write','Prefetcher','test_out_of_order_commits_of_equal_ticks_across_many_zids','TestNegativeControl'}
    for n in tree.body:
        if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names:selected.append(n)
        elif isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_WRITE_MAIN_SQL' for t in n.targets):selected.append(n)
    def seed_reference(engine,zid=1,n_ptpts=4,n_cmts=3):
        seed(engine.url.render_as_string(hide_password=False),zid,n_ptpts,n_cmts)
    scope={'sa':sa,'json':json,'MATH_ENV':'recovery','seed_conversation':seed_reference}
    exec(compile(ast.Module(body=selected,type_ignores=[]),'unchanged-r12-controls.py','exec'),scope)
    return scope


@pytest.mark.parametrize('case',['equal-ticks-many-zids','sequence-alone-sees-two'])
def test_original_r12_controls(db,case):
    scope=controls()
    engine=sa.create_engine(db,poolclass=sa.pool.NullPool)
    try:
        if case=='equal-ticks-many-zids':
            scope['test_out_of_order_commits_of_equal_ticks_across_many_zids'](engine,db)
        else:
            scope['TestNegativeControl']().test_a_sequence_allocated_cursor_is_unique(engine,db)
    finally:engine.dispose()
