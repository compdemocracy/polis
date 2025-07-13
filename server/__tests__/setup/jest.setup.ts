import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "util";
import { beforeAll } from "@jest/globals";
import dotenv from "dotenv";

// Use CommonJS __dirname and __filename
const execAsync = promisify(exec);

// Load environment variables from .env file but don't override command-line vars
dotenv.config({ override: false });

/**
 * Secondary safety check to prevent tests from running against production databases
 * This is a redundant check in case db-test-helpers.ts is not loaded first
 */
function preventProductionDatabaseTesting(): void {
  const dbUrl = process.env.DATABASE_URL || "";

  if (
    dbUrl.toLowerCase().includes("amazonaws") ||
    dbUrl.toLowerCase().includes("prod")
  ) {
    console.error("\x1b[31m%s\x1b[0m", "❌ CRITICAL SECURITY WARNING ❌");
    console.error(
      "\x1b[31m%s\x1b[0m",
      "Tests appear to be targeting a PRODUCTION database!"
    );
    console.error(
      "\x1b[31m%s\x1b[0m",
      "Tests are being aborted to prevent data loss or corruption."
    );
    process.exit(1);
  }
}

/**
 * Reset the database by running the db-reset.js script
 * This will be used when the RESET_DB_BEFORE_TESTS environment variable is set
 */
async function resetDatabase(): Promise<void> {
  console.log("\n🔄 Resetting database before tests...");

  try {
    const resetScript = path.join(__dirname, "..", "..", "bin", "db-reset.js");
    const { stderr } = await execAsync(`node ${resetScript}`, {
      env: { ...process.env, SKIP_CONFIRM: "true" },
    });

    console.log("\n✅ Database reset complete!");

    if (stderr) {
      console.error("stderr:", stderr);
    }
  } catch (error) {
    console.error("\n❌ Failed to reset database:", error);
    throw error;
  }
}

// Run the safety check before any tests
preventProductionDatabaseTesting();

// Increase timeout for all tests
jest.setTimeout(60000);

// Keep the reset logic if needed, but maybe move it to globalSetup?
// For now, let's assume the check in globalSetup handles DB readiness implicitly via app load.
// If RESET_DB_BEFORE_TESTS is needed, globalSetup might be a better place.
if (process.env.RESET_DB_BEFORE_TESTS === "true") {
  beforeAll(async () => {
    console.log("RESET_DB_BEFORE_TESTS=true detected in jest.setup.ts");
    await resetDatabase();
  }, 60000); // Give reset more time if needed
}
