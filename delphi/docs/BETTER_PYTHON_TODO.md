# Better Python Practices TODO list

[ ] Upgrade dependencies  
[ ] Audit & Improve Dockerfiles
[x] Set up Bandit
[x] Streamline code quality tools (removed flake8/isort conflicts with ruff)
[ ] Fix all type-check errors
[ ] Fix all lint errors
[x] Fix or remove `make build`
[ ] Audit and consolidate docs
[ ] Format all files
[ ] Establish shared vscode settings (linter, format, etc)
[ ] Audit and fix pytest tests
[ ] Establish delphi tests github workflow
[x] Refactor make docker commands to use docker directly without docker compose
[ ] Confirm or remove `configure_instance.py`
[ ] Confirm or remove `setup_minio_bucket.py` (likely remove)

## Tool Conflicts Resolved ✅

- Removed flake8 (replaced by ruff)
- Removed isort (replaced by ruff)  
- Fixed E704 conflicts between Black and linters
- Streamlined pre-commit hooks
- Updated Makefile for modern toolchain
