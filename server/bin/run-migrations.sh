#!/bin/bash
set -e

# Use DATABASE_URL from environment or from argument if provided
if [ -n "$1" ]; then
  DATABASE_URL="$1"
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL is not set. Please provide it as an environment variable or argument."
  echo "Usage: $0 [DATABASE_URL]"
  exit 1
fi

# Directory containing migration files
MIGRATIONS_DIR="$(dirname "$(dirname "$0")")/postgres/migrations"

echo "Running migrations from $MIGRATIONS_DIR"

# Get all migration files sorted by name (only from top-level directory)
for migration in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name "*.sql" | sort); do
  echo "Applying migration: $(basename "$migration")"
  PGPASSWORD=$(echo "$DATABASE_URL" | sed -E 's/.*:([^:]+)@.*/\1/') \
    psql "$DATABASE_URL" -f "$migration"
done

echo "All migrations completed successfully!"
