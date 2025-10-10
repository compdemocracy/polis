#!/bin/bash

# Script to create a compressed backup of the PostgreSQL database
# Uses pg_dump with performance optimizations and includes timestamp

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

# Timestamp format: YYYYMMDD_HHMMSS
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Backup filename with timestamp and "revised" in the name
BACKUP_FILE="polis_revised_${TIMESTAMP}.dump"

echo "Creating database backup..."
echo "Database: $POSTGRES_DB"
echo "Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo "User: $POSTGRES_USER"
echo "Backup file: $BACKUP_FILE"

# Export password to avoid prompt
export PGPASSWORD="$POSTGRES_PASSWORD"

# Perform the backup with performance optimizations
pg_dump \
    --host="$POSTGRES_HOST" \
    --port="$POSTGRES_PORT" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --no-owner \
    --no-privileges \
    --format=custom \
    --compress=9 \
    --verbose \
    --file="$BACKUP_FILE"

# Check if the backup was successful
if [ $? -eq 0 ]; then
    # Get file size for display
    FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "✅ Backup successful!"
    echo "📁 File: $BACKUP_FILE"
    echo "📊 Size: $FILE_SIZE"
else
    echo "❌ Backup failed!"
    unset PGPASSWORD
    exit 1
fi

# Unset password
unset PGPASSWORD

echo ""
echo "Backup completed successfully!"
echo "You can restore this backup using:"
echo "pg_restore --dbname=your_database --verbose $BACKUP_FILE"
