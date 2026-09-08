"""Package marker, and it is load-bearing.

Without it these files are imported by pytest as top-level modules, so this
directory's `conftest.py` claims the module name `conftest` and shadows
`delphi/tests/conftest.py` for every sibling test module that does
`from conftest import ...`. In the Delphi CI layout (tests copied to
`/app/tests`) that broke four unrelated modules at collection. As a package the
modules here are `coordinator.*`, the parent conftest keeps the plain name, and
the imports below are explicit about which conftest they mean.
"""
