#!/bin/bash

# Script to extract PostgreSQL database schema to a local schema.sql file
# This script uses environment variables from your .env file or Docker setup

set -e  # Exit on any error

# Load environment variables from .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    source .env
fi

# Set default values if environment variables are not set
POSTGRES_DB=${POSTGRES_DB:-polis-dev}
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-oiPorg3Nrz0yqDLE}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}

# Output file
SCHEMA_FILE="schema.sql"

echo "Extracting database schema..."
echo "Database: $POSTGRES_DB"
echo "Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo "User: $POSTGRES_USER"
echo "Output file: $SCHEMA_FILE"

# Check if we're running with Docker
if command -v docker-compose >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    echo "Docker Compose detected. Attempting to extract schema from Docker container..."
    
    # Try to extract schema using docker-compose exec
    if docker-compose ps postgres | grep -q "Up"; then
        echo "PostgreSQL container is running. Extracting schema..."
        docker-compose exec -T postgres pg_dump \
            --host=localhost \
            --port=5432 \
            --username="$POSTGRES_USER" \
            --dbname="$POSTGRES_DB" \
            --schema-only \
            --no-owner \
            --no-privileges \
            --clean \
            --if-exists \
            > "$SCHEMA_FILE"
    else
        echo "PostgreSQL container is not running. Please start it with:"
        echo "docker-compose --profile postgres up -d"
        exit 1
    fi
else
    # Direct connection to PostgreSQL (not using Docker)
    echo "Connecting directly to PostgreSQL..."
    
    # Export password to avoid prompt
    export PGPASSWORD="$POSTGRES_PASSWORD"
    
    # Extract schema using pg_dump
    pg_dump \
        --host="$POSTGRES_HOST" \
        --port="$POSTGRES_PORT" \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" \
        --schema-only \
        --no-owner \
        --no-privileges \
        --clean \
        --if-exists \
        > "$SCHEMA_FILE"
    
    # Unset password
    unset PGPASSWORD
fi

if [ -f "$SCHEMA_FILE" ] && [ -s "$SCHEMA_FILE" ]; then
    echo "✅ Schema successfully extracted to $SCHEMA_FILE"
    echo "File size: $(du -h "$SCHEMA_FILE" | cut -f1)"
    echo "Tables found: $(grep -c "CREATE TABLE" "$SCHEMA_FILE" || echo "0")"
else
    echo "❌ Failed to extract schema or file is empty"
    exit 1
fi

