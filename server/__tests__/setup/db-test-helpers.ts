import dotenv from 'dotenv';
import pg from 'pg';

// Load environment variables from .env file but don't override command-line vars
dotenv.config({ override: false });

/**
 * SECURITY CHECK: Prevent running tests against production databases
 * This function checks if the DATABASE_URL contains indicators of a production database
 * and will exit the process if a production database is detected.
 */
function preventProductionDatabaseTesting(): void {
  const dbUrl = process.env.DATABASE_URL || '';
  const productionIndicators = ['amazonaws', 'prod'];

  for (const indicator of productionIndicators) {
    if (dbUrl.toLowerCase().includes(indicator)) {
      console.error('\x1b[31m%s\x1b[0m', '❌ CRITICAL SECURITY WARNING ❌');
      console.error('\x1b[31m%s\x1b[0m', 'Tests appear to be targeting a PRODUCTION database!');
      console.error('\x1b[31m%s\x1b[0m', 'Tests are being aborted to prevent data loss or corruption.');
      // Exit with non-zero code to indicate error
      process.exit(1);
    }
  }
}

// Run the security check immediately
preventProductionDatabaseTesting();

const { Pool } = pg;

// Use host.docker.internal to connect to the host machine's PostgreSQL instance
// This works when running tests from the host machine
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@host.docker.internal:5432/polis-dev'
});

/**
 * Close the database pool
 */
async function closePool(): Promise<void> {
  await pool.end();
}

export {
  pool,
  closePool
};