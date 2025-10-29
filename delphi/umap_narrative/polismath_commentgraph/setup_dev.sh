#!/bin/bash
# Setup script for polismath_commentgraph Lambda development

set -e

echo "🚀 Setting up polismath_commentgraph development environment..."

# Check if we're in the right directory
if [[ ! -f "requirements.txt" ]] || [[ ! -f "pyproject.toml" ]]; then
    echo "❌ Error: Run this script from the umap_narrative/polismath_commentgraph/ directory"
    exit 1
fi

# Create virtual environment if it doesn't exist
if [[ ! -d ".venv" ]]; then
    echo "📦 Creating virtual environment..."
    python -m venv .venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source .venv/bin/activate

# Install in development mode using pyproject.toml
echo "📥 Installing dependencies from pyproject.toml..."
pip install -e "."

echo "✅ Setup complete!"
echo ""
echo "💡 Usage:"
echo "  source .venv/bin/activate  # Activate environment"
echo "  python -m polismath_commentgraph.cli test-evoc  # Test EVōC"
echo "  python -m polismath_commentgraph.cli test-postgres --help  # Test PostgreSQL"
echo "  docker build -t lambda-test .  # Build Lambda container"
echo ""
echo "🔍 IDE Support:"
echo "  - evoc import should now be resolved in your IDE"
echo "  - All dependencies are installed in .venv/"
echo "  - Deployment still uses requirements.txt (as intended)"
