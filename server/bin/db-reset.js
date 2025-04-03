#!/usr/bin/env node

/**
 * Database Reset Script
 *
 * This script will:
 * 1. Check that we're not targeting a production database
 * 2. Drop and recreate the database specified in DATABASE_URL
 * 3. Run all migrations on the fresh database
 *
 * IMPORTANT: This will delete all data in the target database!
 * Make sure your DATABASE_URL points to a test/development database.
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import dotenv from 'dotenv';
import pg from 'pg';

// Setup dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

// Load environment variables
dotenv.config();

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/polis-dev';
const skipConfirm = process.env.SKIP_CONFIRM === 'true';

/**
 * Safety check to prevent resetting production databases
 */
function isSafeDatabase(dbUrl) {
  if (!dbUrl) {
    console.error('\x1b[31m%s\x1b[0m', '❌ Error: No DATABASE_URL provided.');
    return false;
  }

  // Check for indicators of a production database
  const productionIndicators = ['amazonaws', 'prod'];
  const lowercaseUrl = dbUrl.toLowerCase();

  for (const indicator of productionIndicators) {
    if (lowercaseUrl.includes(indicator)) {
      console.error('\x1b[31m%s\x1b[0m', '❌ CRITICAL SECURITY WARNING ❌');
      console.error('\x1b[31m%s\x1b[0m', 'This script will NOT execute on a PRODUCTION database!');
      console.error(
        '\x1b[31m%s\x1b[0m',
        `DATABASE_URL contains "${indicator}", which suggests a production environment.`
      );
      console.error('\x1b[31m%s\x1b[0m', 'Please check your DATABASE_URL and try again with a development database.');
      return false;
    }
  }

  return true;
}

/**
 * Parse database connection info from URL
 */
function parseDatabaseUrl(dbUrl) {
  // Extract user, password, host, port, database from URL
  // Format: postgres://username:password@host:port/database
  const match = dbUrl.match(/postgres:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);

  if (!match) {
    throw new Error('Invalid DATABASE_URL format');
  }

  return {
    username: match[1],
    password: match[2],
    host: match[3],
    port: match[4],
    database: match[5]
  };
}

/**
 * Main function to reset the database
 */
async function resetDatabase() {
  console.log('\x1b[34m%s\x1b[0m', '🔄 Starting database reset process...');

  // Safety check
  if (!isSafeDatabase(databaseUrl)) {
    process.exit(1);
  }

  // Parse connection details
  const dbConfig = parseDatabaseUrl(databaseUrl);
  console.log(`📊 Target database: ${dbConfig.database} on ${dbConfig.host}`);

  try {
    // Setup connection to PostgreSQL server (not the target database)
    const connectionString = `postgres://${dbConfig.username}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/postgres`;
    const client = new pg.Client(connectionString);
    await client.connect();

    if (!skipConfirm) {
      console.log('\x1b[33m%s\x1b[0m', '⚠️  WARNING: All data in the database will be lost!');
      console.log('\x1b[33m%s\x1b[0m', '⚠️  DATABASE_URL:', databaseUrl);
      console.log('\x1b[33m%s\x1b[0m', '⚠️  You have 5 seconds to cancel (Ctrl+C)...');

      // Wait 5 seconds to give user a chance to cancel
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
      console.log('Skipping confirmation due to SKIP_CONFIRM=true');
    }

    // Drop database if it exists
    console.log(`🗑️  Dropping database "${dbConfig.database}" if it exists...`);
    await client.query(`DROP DATABASE IF EXISTS "${dbConfig.database}" WITH (FORCE);`);

    // Create fresh database
    console.log(`🆕 Creating new database "${dbConfig.database}"...`);
    await client.query(`CREATE DATABASE "${dbConfig.database}";`);

    // Close connection to postgres database
    await client.end();

    // Get list of migration files
    const migrationsDir = path.join(__dirname, '..', 'postgres', 'migrations');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !file.includes('archived'))
      .sort();

    // Apply each migration
    console.log('🔄 Applying migrations...');

    for (const migrationFile of migrationFiles) {
      console.log(`  ➡️  Applying ${migrationFile}...`);
      const migrationPath = path.join(migrationsDir, migrationFile);

      // Use psql to apply the migration
      const { _stdout, stderr } = await execAsync(
        `PGPASSWORD="${dbConfig.password}" psql -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.username} -d ${dbConfig.database} -f "${migrationPath}"`
      );

      if (stderr && !stderr.includes('NOTICE')) {
        console.warn(`    ⚠️  Warnings: ${stderr}`);
      }
    }

    console.log('\x1b[32m%s\x1b[0m', '✅ Database reset complete!');
    console.log(`📁 Applied ${migrationFiles.length} migrations`);
    console.log('\x1b[32m%s\x1b[0m', '✨ Your database is fresh and ready to use!');
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', '❌ Error resetting database:');
    console.error(error);
    process.exit(1);
  }
}

// Run the reset process
resetDatabase();
