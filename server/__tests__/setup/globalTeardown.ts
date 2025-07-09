/**
 * Global teardown for Jest tests
 * This file is executed once after all test files have been run
 */

// Types are defined in types/jest-globals.d.ts, don't redeclare them here
// Just use (globalThis as any).__SERVER__ etc. for typechecking

import { closePool } from "./db-test-helpers";

export default async (): Promise<void> => {
  console.log("Starting global test teardown...");

  // Shut down the test server if it exists
  const server = (globalThis as any).__TEST_SERVER__;
  const port = (globalThis as any).__TEST_SERVER_PORT__ || "unknown";
  if (server && typeof server.close === "function") {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) {
          console.error("Error closing test server:", err);
          reject(err);
        } else {
          console.log(`Test server on port ${port} closed`);
          resolve();
        }
      });
    });
  }

  // Close database connection pool
  try {
    await closePool();
    console.log("Database connection pool closed globally.");
  } catch (error) {
    console.error("Error closing database connection pool:", error);
  }

  // Clean up all global variables
  delete (globalThis as any).__APP_INSTANCE__;
  delete (globalThis as any).__TEST_SERVER__;
  delete (globalThis as any).__TEST_AGENT__;
  delete (globalThis as any).__TEST_SERVER_PORT__;
  delete (globalThis as any).__API_URL__;
  delete (globalThis as any).__API_PREFIX__;

  console.log("Global test teardown completed");
};
