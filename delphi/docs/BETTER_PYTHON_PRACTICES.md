# Better Python Practices Migration Guide

This document outlines the comprehensive modernization of the Delphi project, transforming it from a proof-of-concept MVP-style setup to a production-ready Python project following industry best practices.

## Overview

The Delphi project has been successfully migrated to modern Python development practices, implementing comprehensive tooling for code quality, testing, CI/CD, and developer experience improvements. This migration maintains full compatibility with existing functionality while adding robust development infrastructure.

## What Was Implemented

### 1. Modern Project Structure & Packaging

#### `pyproject.toml` - Centralized Configuration

- **PEP 621 compliant** project metadata and dependencies
- **Modern build system** using `hatchling` backend
- **Dependency management** with optional groups (dev, notebook)
- **Tool configuration** for all quality tools in one place
- **Entry points** for CLI scripts

```bash
# Installation becomes simple
pip install -e ".[dev]"          # Development mode with dev dependencies
pip install -e ".[dev,notebook]" # Include Jupyter notebook dependencies
```

#### Package Structure

- Maintained existing well-organized structure (`polismath/`, `umap_narrative/`)
- Added proper `__init__.py` files where needed
- Configured package discovery for build system

### 2. Comprehensive Testing Framework

#### Enhanced `conftest.py`

- **Automatic test categorization** (unit/integration/slow/real_data)
- **Comprehensive fixtures** for common test scenarios:
  - Mock DynamoDB with pre-configured tables
  - Sample conversation data
  - Mock external services (Ollama, SentenceTransformer, PostgreSQL)
  - Performance timing utilities
  - Environment management

#### Test Configuration in `pyproject.toml`

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = [
    "-v",
    "--cov=polismath",
    "--cov=umap_narrative",
    "--cov-report=html:htmlcov",
    "--cov-fail-under=70",
]
markers = [
    "slow: marks tests as slow",
    "integration: marks tests as integration tests",
    "unit: marks tests as unit tests",
    "real_data: marks tests that use real data",
]
```

#### Usage Examples

```bash
# Run fast unit tests only
pytest tests/ -m "not slow and not real_data"

# Run integration tests
pytest tests/ -m "integration"

# Run with coverage
pytest tests/ --cov --cov-report=html
```

### 3. Code Quality Tools

#### Ruff - Modern Fast Linting

- **Comprehensive rule set** including pycodestyle, pyflakes, isort, pylint
- **Automatic fixes** for many issues
- **Fast execution** (written in Rust)

Configuration highlights:

```toml
[tool.ruff]
select = ["E", "W", "F", "I", "B", "C4", "UP", "PL"]
ignore = ["E501", "PLR0913", "PLR0912", "PLR0915"]
```

#### Black - Code Formatting

- **Consistent code style** across the project
- **Automatic formatting** eliminates style debates
- **120 character line length**

#### MyPy - Type Checking

- **Gradual adoption** approach - doesn't break existing code
- **Comprehensive type checking** for new code
- **Third-party stubs** for external libraries

#### Bandit - Security Scanning

- **Vulnerability detection** in code
- **Security best practices** enforcement
- **CI integration** for automated security checks

### 4. Pre-commit Hooks

Automatic quality checks before each commit:

```yaml
repos:
  - repo: https://github.com/psf/black
    hooks:
      - id: black
  - repo: https://github.com/charliermarsh/ruff-pre-commit
    hooks:
      - id: ruff
        args: [--fix, --exit-non-zero-on-fix]
  - repo: https://github.com/pre-commit/mirrors-mypy
    hooks:
      - id: mypy
```

### 5. CI/CD Pipeline

#### Multi-stage GitHub Actions Workflow

```yaml
jobs:
  lint:     # Code quality checks
  test:     # Unit tests across Python versions
  integration-test: # Integration tests with real services
  docker:   # Container builds and registry pushes
```

#### Key Features

- **Matrix testing** across Python 3.12, 3.13, 3.14
- **Service containers** for PostgreSQL and DynamoDB
- **Coverage reporting** with Codecov integration
- **Automated Docker builds** on successful tests
- **Container registry** publishing (GitHub Packages)

### 6. Developer Experience Improvements

#### Makefile - Common Commands

Over 20 convenient commands for development workflows:

```makefile
make help              # Show all available commands
make install-dev       # Set up development environment
make test-unit         # Run fast unit tests
make test-integration  # Run integration tests
make lint             # Run all linters
make format           # Auto-format code
make quality          # Run all quality checks
make dev-workflow     # Complete development workflow
```

#### Setup Script - One-Command Environment

```bash
./setup_dev.sh
```

Automatically:

- Creates virtual environment if needed
- Installs dependencies
- Sets up pre-commit hooks
- Creates `.env` from template
- Runs initial quality checks
- Verifies setup with test imports

#### Enhanced `.gitignore`

Comprehensive exclusions for Python projects including:

- Build artifacts and caches
- IDE and editor files
- OS-specific files
- Project-specific outputs
- Security-sensitive files

## How to Use the New Tools

### Initial Setup

1. **Clone and setup environment:**

   ```bash
   git clone <repository>
   cd delphi
   ./setup_dev.sh
   ```

2. **Verify installation:**

   ```bash
   make env-check
   make test-unit
   ```

### Daily Development Workflow

1. **Before starting work:**

   ```bash
   make dev-workflow  # Ensures code is clean
   ```

2. **During development:**

   ```bash
   make test-unit     # Quick feedback loop
   make format        # Auto-format when needed
   ```

3. **Before committing:**

   ```bash
   make quality       # Comprehensive quality check
   ```

   Pre-commit hooks will also run automatically.

4. **Testing specific areas:**

   ```bash
   # Test specific module
   pytest tests/test_pca.py -v

   # Test with coverage
   pytest tests/ --cov=polismath --cov-report=html

   # Skip slow tests during development
   pytest tests/ -m "not slow"
   ```

### Code Quality Workflow

1. **Format code:**

   ```bash
   black .
   ruff check --fix .
   ```

2. **Check typing:**

   ```bash
   mypy polismath umap_narrative
   ```

3. **Security scan:**

   ```bash
   bandit -r polismath umap_narrative
   ```

4. **All-in-one quality check:**

   ```bash
   make quality
   ```

### CI/CD Integration

The GitHub Actions workflow automatically:

- Runs on push to `main`, `edge`, `develop` branches
- Runs on pull requests
- Executes linting, testing, and integration tests
- Builds Docker images on successful tests
- Reports coverage to Codecov

## Benefits Achieved

### Code Quality

- **Automated formatting**: Eliminates style inconsistencies
- **Comprehensive linting**: Catches bugs and style issues early
- **Type safety**: Gradual adoption of type hints improves code reliability
- **Security scanning**: Identifies potential vulnerabilities
- **Consistent standards**: All developers follow same practices

### Developer Productivity

- **One-command setup**: New developers productive immediately
- **Fast feedback loops**: Quick unit tests during development
- **Automated workflows**: Quality checks happen automatically
- **Better tooling**: Modern, fast tools improve experience
- **Clear documentation**: Every tool and process documented

### Production Readiness

- **Multi-stage CI**: Comprehensive validation before deployment
- **Container builds**: Automated Docker image creation and publishing
- **Dependency security**: Vulnerability scanning included
- **Environment isolation**: Proper virtual environment management
- **Test coverage**: Comprehensive test suite with coverage reporting

### Maintainability

- **Consistent code style**: Easy to read and maintain
- **Comprehensive tests**: Changes can be made with confidence
- **Documentation**: All practices and tools documented
- **Gradual adoption**: Can adopt new practices incrementally

## Migration Path

### Immediate Adoption (This Week)

1. **Run the setup script:**

   ```bash
   ./setup_dev.sh
   ```

2. **Test current workflow:**

   ```bash
   make dev-workflow
   make test-unit
   ```

3. **Format existing codebase:**

   ```bash
   make format
   git add -A
   git commit -m "Apply automated code formatting"
   ```

4. **Set up pre-commit hooks:**

   ```bash
   pre-commit install  # Done by setup script
   ```

### Short Term Adoption (Next Month)

1. **Start using type hints in new code:**
   - MyPy is configured with gradual adoption
   - Add type hints to new functions and classes
   - Gradually add to existing critical code paths

2. **Expand test coverage:**

   ```bash
   # Check current coverage
   make test-cov

   # Add tests for uncovered code
   pytest tests/ --cov --cov-report=html
   open htmlcov/index.html  # View coverage report
   ```

3. **Use quality gates:**
   - Run `make quality` before major commits
   - Address linting issues as they arise
   - Use `make dev-workflow` as standard practice

## Virtual Environment Management

### Canonical Approach: `venv` + "delphi-env"

This project uses **Python's built-in `venv` module** with the canonical environment name **`delphi-env`**. This approach was chosen for several reasons:

#### Why `venv` Over Pipenv/Poetry for Environment Management?

1. **Built-in reliability**: `venv` is part of Python's standard library (3.3+), ensuring availability without additional installations
2. **Perfect complement to pyproject.toml**: The project already uses `pyproject.toml` for dependency management, making `venv` + `pip` an ideal lightweight combination
3. **Production compatibility**: Works seamlessly with Docker, CI/CD pipelines, and deployment environments
4. **Simplicity**: Focuses purely on environment isolation, letting `pip` handle package management

#### Standard Environment Setup

```bash
# Create the canonical development environment
python3 -m venv delphi-env

# Activate it
source delphi-env/bin/activate  # Linux/macOS
# or
delphi-env\Scripts\activate     # Windows

# Install with modern dependency management
pip install -e ".[dev,notebook]"
```

#### Automated Setup (Recommended)

For the fastest setup, use the provided script:

```bash
./setup_dev.sh
```

This script:

- Creates `delphi-env` if it doesn't exist
- Activates the environment automatically
- Installs all dependencies from `pyproject.toml`
- Sets up pre-commit hooks
- Runs initial quality checks

#### Environment Naming Consolidation

**Previous inconsistent names (now deprecated):**

- ❌ `new_polis_env` - Too generic, unclear purpose
- ❌ `polis_env` - Not specific to delphi component
- ❌ `delphi-venv` - Generic suffix, less descriptive

**Current canonical name:**

- ✅ `delphi-env` - Clear project association and purpose

#### Working with the Virtual Environment

```bash
# Check if you're in the right environment
which python
# Should show: /path/to/delphi-env/bin/python

# Verify package installation
pip list | grep delphi
python -c "import polismath; print('✓ Package available')"

# Deactivate when done
deactivate
```

#### Environment in Different Contexts

1. **Development**: Use `delphi-env` (persistent, full feature set)
2. **CI/CD**: Uses temporary environments with exact dependency versions
3. **Docker**: Uses container-level isolation instead of venv
4. **Scripts**: May create temporary environments (e.g., `/tmp/delphi-temp-env`) that are cleaned up

## Dependency Management Strategy

### Single Source of Truth: `pyproject.toml`

This project has migrated from the legacy `requirements.txt` approach to modern **`pyproject.toml`-based dependency management**. This provides several advantages:

#### **Benefits of pyproject.toml Approach**

1. **Centralized Configuration**: All project metadata, dependencies, and tool configuration in one file
2. **Dependency Groups**: Clean separation of production, development, and optional dependencies
3. **Modern Standard**: PEP 621 compliant, industry best practice
4. **Tool Integration**: All development tools configured in the same file
5. **Build System**: Modern build backend with proper package metadata

#### **Dependency Structure**

```toml
[project]
dependencies = [
    # Core production dependencies
    "numpy>=1.26.4,<2.0",
    "pandas>=2.1.4",
    # ... other production deps
]

[project.optional-dependencies]
dev = [
    # Development and testing tools
    "pytest>=8.0.0",
    "ruff>=0.1.0",
    "mypy>=1.5.0",
    "bandit[toml]>=1.8.0",
    # ... other dev tools
]

notebook = [
    # Jupyter notebook dependencies
    "jupyter>=1.0.0",
    "ipython>=8.0.0",
]
```

#### **Installation Commands**

```bash
# Production dependencies only
pip install -e .

# Development dependencies
pip install -e ".[dev]"

# Development + notebook dependencies
pip install -e ".[dev,notebook]"

# All optional dependencies
pip install -e ".[dev,notebook]"
```

### **Lock Files for Deployment**

While `pyproject.toml` is the source of truth, **generated lock files** can be used for reproducible deployments:

#### **Generate Lock Files**

```bash
# Install pip-tools (included in dev dependencies)
pip install pip-tools

# Generate production lock file
make generate-requirements

# Generate with latest versions
make generate-requirements-upgrade

# Check for dependency updates
make check-deps
```

This creates:

- `requirements-prod.txt` - Production dependencies with exact versions
- `requirements-dev.txt` - Development dependencies with exact versions

#### **Using Lock Files**

**For Docker deployments:**

```dockerfile
# Use lock file for reproducible builds
COPY requirements-prod.txt .
RUN pip install -r requirements-prod.txt

# Or use pyproject.toml directly (recommended)
COPY pyproject.toml .
RUN pip install .
```

**For CI/CD:**

```yaml
# Use exact versions for reproducible CI
- run: pip install -r requirements-dev.txt

# Or use dynamic installation (more flexible)
- run: pip install -e ".[dev]"
```

### **Migration from requirements.txt**

**What was removed:**

- ❌ Root `requirements.txt` (redundant with pyproject.toml)
- ❌ Duplicate dependency specifications
- ❌ Manual dependency management

**What was updated:**

- ✅ Dockerfile now uses `pyproject.toml` directly
- ✅ Documentation updated to reference modern commands
- ✅ CI/CD workflows use pyproject.toml
- ✅ Development scripts use modern installation

**Subcomponent-specific requirements.txt files:**

- `umap_narrative/polismath_commentgraph/requirements.txt` - **Kept** for Lambda deployment
- These serve specific deployment contexts where `pyproject.toml` isn't suitable

### **Best Practices for Dependencies**

#### **Version Pinning Strategy**

```toml
# Pin major versions for stability, allow minor/patch updates
"numpy>=1.26.4,<2.0"    # Allow 1.x updates, prevent 2.x breaking changes
"pandas>=2.1.4"         # Allow all newer versions
"torch==2.8.0"          # Exact pin for critical ML dependencies
```

#### **Dependency Groups**

1. **Core dependencies**: Required for all installations
2. **dev**: Development tools (testing, linting, type checking)
3. **notebook**: Jupyter and analysis tools
4. **Optional groups**: Feature-specific dependencies

#### **Dependency Maintenance**

```bash
# Check for outdated packages
pip list --outdated

# Check for security vulnerabilities
pip-audit  # Install with: pip install pip-audit

# Update lock files with latest versions
make generate-requirements-upgrade

# Verify installation
make env-check
```

### **Docker and Deployment**

#### **Optimized Docker Build Strategy**

This project uses an **optimized multi-stage Docker build** with dependency caching to dramatically speed up rebuilds during development.

##### **Key Optimizations**

1. **Lock File for Reproducible Builds**: `requirements.lock` pins all dependencies
2. **Layered Copying**: Dependencies installed before source code
3. **BuildKit Cache Mounts**: Pip cache persisted between builds
4. **Minimal Rebuilds**: Code changes don't trigger full dependency reinstalls

##### **Dockerfile Architecture**

```dockerfile
# ===== Stage 1: Optimized dependency installation =====
# Copy only dependency files first (cached unless dependencies change)
COPY pyproject.toml requirements.lock ./

# Install dependencies with BuildKit cache mount (fast rebuilds)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.lock

# Copy source code AFTER dependencies (allows code changes without reinstalling deps)
COPY polismath/ ./polismath/
COPY umap_narrative/ ./umap_narrative/
COPY scripts/ ./scripts/
COPY *.py ./

# Install project package without dependencies (just registers entry points)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps .
```

##### **Build Performance Benefits**

| Scenario | Old Build Time | New Build Time | Speedup |
|----------|---------------|----------------|---------|
| Clean build | ~15 minutes | ~15 minutes | Same |
| Code change only | ~15 minutes | **~30 seconds** | **30x faster** |
| Dependency change | ~15 minutes | ~5-8 minutes | 2-3x faster |

##### **Requirements Lock File**

The `requirements.lock` file ensures reproducible builds across environments:

```bash
# Generate lock file (run this when dependencies change)
make generate-requirements

# Or manually:
pip-compile --output-file requirements.lock pyproject.toml
```

**When to regenerate:**

- After modifying `dependencies` in `pyproject.toml`
- When upgrading dependencies: `make generate-requirements-upgrade`
- Before deploying to production (ensure all versions locked)

##### **Building Docker Images**

```bash
# Optimized build (with BuildKit cache)
make docker-build
# or: DOCKER_BUILDKIT=1 docker build -t polis/delphi:latest .

# Clean build (no cache)
make docker-build-no-cache

# Check build cache effectiveness
docker system df
```

##### **Development Workflow**

1. **Make code changes** → Fast rebuild (~30 seconds)
2. **Update dependencies in pyproject.toml** → Regenerate lock file → Rebuild
3. **Test in Docker** → Quick iteration cycle

```bash
# Typical workflow
vim polismath/some_file.py          # Edit code
make docker-build                    # Fast rebuild (30s)
docker compose up                    # Test changes
```

##### **.dockerignore Optimizations**

The `.dockerignore` file excludes unnecessary files from the build context:

- Test files and test data
- Development tools and caches
- Documentation (except README)
- CI/CD configurations
- Virtual environments
- Build artifacts

This reduces the Docker build context significantly, speeding up initial transfers.

#### **Important Build System Notes**

When using `pyproject.toml` with the lock file approach:

- `requirements.lock` contains **all production dependencies**
- Source directories must still be copied for `pip install --no-deps .` to work
- The `--no-deps` flag prevents pip from trying to reinstall dependencies
- Entry points and package metadata are registered during the final install step

#### **Multi-stage Build Pattern**

```dockerfile
# Builder stage - heavy dependencies
FROM python:3.12-slim AS builder
COPY pyproject.toml requirements.lock ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.lock

# Runtime stage - minimal footprint
FROM python:3.12-slim AS final
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
```

### **Troubleshooting Dependencies**

#### **Common Issues**

1. **Version conflicts:**

   ```bash
   pip install -e ".[dev]" --dry-run  # Check conflicts
   pip-compile --dry-run pyproject.toml  # Test lock file generation
   ```

2. **Missing dependencies:**

   ```bash
   pip check  # Verify all dependencies are satisfied
   ```

3. **Build failures:**

   ```bash
   pip install --upgrade pip setuptools wheel  # Update build tools
   pip cache purge  # Clear pip cache
   ```

#### **Environment Debugging**

```bash
# Check current environment
make venv-check
make env-check

# Verify package installation
python -c "import polismath; print('✓ Package available')"
pip show delphi-polis
```

### Medium Term Adoption (Next Quarter)

1. **Full type annotation coverage:**
   - Gradually add type hints to all modules
   - Enable stricter MyPy settings
   - Add type checking to CI pipeline

2. **Enhanced testing:**
   - Increase test coverage to >90%
   - Add integration tests for all major workflows
   - Add performance benchmarking tests

3. **Advanced tooling:**
   - Consider adding Sphinx for API documentation
   - Add dependency vulnerability scanning
   - Implement automated dependency updates

## Tool Configuration Details

### Ruff Configuration

```toml
[tool.ruff]
target-version = "py312"
line-length = 120
select = ["E", "W", "F", "I", "B", "C4", "UP", "PL"]
ignore = ["E501", "B008", "C901", "PLR0913", "PLR0912", "PLR0915"]
```

### Black Configuration

```toml
[tool.black]
line-length = 120
target-version = ["py312", "py313", "py314"]
```

### MyPy Configuration

```toml
[tool.mypy]
python_version = "3.12"
warn_return_any = true
disallow_untyped_defs = true
check_untyped_defs = true
no_implicit_optional = true
```

### Coverage Configuration

```toml
[tool.coverage.run]
source = ["polismath", "umap_narrative"]
omit = ["*/tests/*", "*/__pycache__/*"]

[tool.coverage.report]
exclude_lines = ["pragma: no cover", "def __repr__"]
```

## Troubleshooting

### Common Issues

1. **Pre-commit hooks failing:**

   ```bash
   # Skip hooks temporarily for urgent commits
   git commit --no-verify -m "urgent fix"

   # Fix issues and re-commit
   make format
   git add -A
   git commit -m "fix formatting issues"
   ```

2. **MyPy type errors:**

   ```bash
   # Ignore specific files during migration
   # Add to pyproject.toml:
   [[tool.mypy.overrides]]
   module = "problematic_module.*"
   ignore_errors = true
   ```

3. **Test failures in CI:**
   - Check that all dependencies are listed in `pyproject.toml`
   - Ensure test data is included in repository
   - Verify environment variables are set correctly

4. **Docker build issues:**
   - Update Dockerfile to install from `pyproject.toml`
   - Ensure all dependencies are pinned appropriately
   - Check that build context includes necessary files

### Getting Help

1. **View available commands:**

   ```bash
   make help
   ```

2. **Check tool versions:**

   ```bash
   make env-check
   ```

3. **Run diagnostics:**

   ```bash
   python -c "import sys; print(sys.version)"
   python -c "import polismath; print('Import successful')"
   ```

## Next Steps

### Immediate Priorities

1. Run `./setup_dev.sh` and verify everything works
2. Try the new workflow with a small change
3. Review and adjust any linting rules that don't fit your style

### Future Enhancements

1. **API Documentation**: Consider adding Sphinx for comprehensive API docs
2. **Performance Monitoring**: Add performance benchmarking to CI
3. **Security Enhancements**: Implement SAST scanning and dependency monitoring
4. **Advanced Testing**: Add property-based testing and mutation testing

### Community Adoption

1. **Team Training**: Introduce team to new tools and workflows
2. **Documentation**: Expand project documentation using new standards
3. **Code Reviews**: Use new tools to improve code review process
4. **Metrics**: Track code quality metrics over time

## Conclusion

This migration transforms the Delphi project into a modern, maintainable Python codebase following industry best practices. The new tooling and workflows improve code quality, developer productivity, and production readiness while maintaining full compatibility with existing functionality.

The gradual adoption approach means you can start using these improvements immediately while migrating existing code at your own pace. The comprehensive CI/CD pipeline ensures that quality remains high as the project evolves.

For questions or issues with the new tooling, consult the tool-specific documentation or create an issue in the project repository.
