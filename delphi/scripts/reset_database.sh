#!/bin/bash
# Reset Database Script
# This script deletes and recreates all DynamoDB tables with the correct schema

# Display header
echo "==============================================="
echo "Delphi DynamoDB Reset Script"
echo "==============================================="
echo ""

# Create and activate a temporary virtual environment
echo "Setting up Python environment..."
python3 -m venv /tmp/delphi-venv
source /tmp/delphi-venv/bin/activate

# Install boto3
echo "Installing boto3..."
pip install boto3

# Run the table creation script
echo "Deleting and recreating all tables with the Delphi_ naming scheme..."
cd "$(dirname "$0")"
python create_dynamodb_tables.py --delete-existing --endpoint-url http://localhost:8000

# Clean up
echo "Cleaning up..."
deactivate
rm -rf /tmp/delphi-venv

echo ""
echo "Database reset complete!"
echo "The tables have been recreated with the new Delphi_ naming scheme."
echo "Core Math tables use 'zid' as primary key, and UMAP tables use 'conversation_id' as primary key."
echo ""
echo "Now you can use the Delphi CLI with the new schema."
echo "==============================================="