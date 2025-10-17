.PHONY: help install install-dev test test-unit test-integration test-slow lint format type-check security quality pre-commit clean build docs docker-build docker-run

# Default target
help: ## Show this help message
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install production dependencies
	pip install -e .

install-dev: ## Install development dependencies
	pip install -e ".[dev,notebook]"

# Setup and maintenance
setup-dev: install-dev ## Set up development environment
	@echo "Setting up development environment..."
	@if [ ! -f .env ]; then cp example.env .env; echo "Created .env from example.env"; fi
	@echo "Don't forget to:"
	@echo "1. Update .env with your specific configuration"
	@echo "2. Set up your database connection"
	@echo "3. Create DynamoDB tables: make setup-dynamodb"

venv: ## Create canonical virtual environment (delphi-env)
	@echo "Creating canonical virtual environment: delphi-env"
	@if [ ! -d "delphi-env" ]; then \
		python3 -m venv delphi-env; \
		echo "✓ Virtual environment created"; \
	else \
		echo "✓ Virtual environment already exists"; \
	fi
	@echo "To activate: source delphi-env/bin/activate"
	@echo "Then run: make install-dev"

venv-check: ## Check virtual environment status
	@echo "Virtual environment status:"
	@if [ -n "$$VIRTUAL_ENV" ]; then \
		echo "✓ Active virtual environment: $$VIRTUAL_ENV"; \
		python --version; \
		echo "Python location: $$(which python)"; \
	else \
		echo "❌ No virtual environment active"; \
		echo "Run: source delphi-env/bin/activate"; \
	fi

setup-dynamodb: ## Create local DynamoDB tables
	@echo "Creating DynamoDB tables..."
	python create_dynamodb_tables.py --endpoint-url http://localhost:8000

# Cleanup
clean: ## Clean build artifacts
	find . -type f -name "*.pyc" -delete
	find . -type d -name "__pycache__" -delete
	find . -type d -name "*.egg-info" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +
	find . -type d -name ".mypy_cache" -exec rm -rf {} +
	rm -rf build/
	rm -rf dist/
	rm -rf htmlcov/
	rm -f coverage.xml
	rm -f .coverage
	rm -f bandit-report.json

# Build
build: ## Build package
	python -m build

# Docker commands (see docs/DOCKER_BUILD_OPTIMIZATION.md for details)
docker-build: ## Build Docker image (with BuildKit cache - ~30s for code changes)
	@echo "Building with optimized layer caching (see docs/DOCKER_BUILD_OPTIMIZATION.md)"
	DOCKER_BUILDKIT=1 docker build -t polis/delphi:latest .

docker-build-no-cache: ## Build Docker image without cache (clean build)
	@echo "Building from scratch (no cache)..."
	DOCKER_BUILDKIT=1 docker build --no-cache -t polis/delphi:latest .

docker-run: ## Run Docker container
	docker run --rm --name polis-dev-delphi-1 --env-file .env polis/delphi:latest

docker-logs: ## Show Docker logs
	docker logs polis-dev-delphi-1

docker-stop: ## Stop Docker containers
	docker stop polis-dev-delphi-1

# Database operations
reset-db: ## Reset all DynamoDB tables
	./scripts/reset_database.sh

reset-conversation: ## Reset specific conversation (requires ZID=conversation_id, optional RID=report_id)
	@if [ -z "$(ZID)" ]; then echo "Usage: make reset-conversation ZID=12345 [RID=report_id]"; exit 1; fi
	@if [ -n "$(RID)" ]; then ./reset_conversation.sh $(ZID) $(RID); else ./reset_conversation.sh $(ZID); fi

# CLI helpers
cli: ## Run Delphi CLI in interactive mode
	./delphi

submit-job: ## Submit processing job (requires ZID=conversation_id)
	@if [ -z "$(ZID)" ]; then echo "Usage: make submit-job ZID=12345"; exit 1; fi
	./delphi submit --zid=$(ZID)

job-status: ## Show job queue status
	./delphi list

# Environment management
env-check: ## Check environment configuration
	@echo "Checking environment configuration..."
	@python -c "from dotenv import load_dotenv; import os; load_dotenv(); print('✓ Environment loaded successfully')"
	@python -c "import sys; print(f'Python version: {sys.version}')"
	@python -c "import torch; print(f'PyTorch version: {torch.__version__}')"

# Pipeline commands
process: ## Process conversation (requires ZID=conversation_id)
	@if [ -z "$(ZID)" ]; then echo "Usage: make process ZID=12345"; exit 1; fi
	./run_delphi.py --zid=$(ZID)

process-verbose: ## Process conversation with verbose output (requires ZID=conversation_id)
	@if [ -z "$(ZID)" ]; then echo "Usage: make process-verbose ZID=12345"; exit 1; fi
	./run_delphi.py --zid=$(ZID) --verbose

# Dependency management
generate-requirements: ## Generate requirements.lock from pyproject.toml for Docker builds
	@echo "Generating requirements.lock from pyproject.toml..."
	pip-compile --output-file requirements.lock pyproject.toml
	@echo "✓ Generated requirements.lock (production dependencies for Docker)"
	@echo "⚠️  Remember to rebuild Docker image after updating requirements.lock"

generate-requirements-upgrade: ## Generate requirements.lock with latest dependency versions
	@echo "Generating requirements.lock with latest versions..."
	pip-compile --upgrade --output-file requirements.lock pyproject.toml
	@echo "✓ Generated requirements.lock with upgraded dependencies"
	@echo "⚠️  Test thoroughly and rebuild Docker image"

check-deps: ## Check for dependency updates
	@echo "Checking for dependency updates..."
	@if command -v pip-compile >/dev/null 2>&1; then \
		pip-compile --dry-run --upgrade pyproject.toml; \
	else \
		echo "Install pip-tools first: pip install pip-tools"; \
	fi
