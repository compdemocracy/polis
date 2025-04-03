/**
 * Global teardown for Jest tests
 * This file is executed once after all test files have been run
 */

// Types are defined in types/jest-globals.d.ts, don't redeclare them here
// Just use (globalThis as any).__SERVER__ etc. for typechecking

export default async (): Promise<void> => {
  console.log('Starting global test teardown...');

  // Close the server if it exists
  // Use type assertion for global access
  if ((globalThis as any).__SERVER__) {
    try {
      // Using a promise to ensure server is closed before continuing
      await new Promise<void>((resolve, reject) => { // Add reject
         // Use type assertion for global access
        (globalThis as any).__SERVER__.close((err?: Error) => { // Handle potential error
          if (err) {
            console.warn('Warning: Error closing server during teardown:', err.message);
            // Decide whether to reject or resolve even if close fails
            // reject(err); // Option 1: Fail teardown if closing fails
            resolve(); // Option 2: Continue teardown even if closing fails
          } else {
            // Use type assertion for global access
            console.log(`Test server on port ${(globalThis as any).__SERVER_PORT__} shut down`);
            resolve();
          }
        });
      });
       // Use type assertion for global access
      (globalThis as any).__SERVER__ = null;
      (globalThis as any).__SERVER_PORT__ = null;
    } catch (err) {
      // Catch potential rejection from the promise
      console.warn('Warning: Error during server cleanup (caught promise rejection):', err instanceof Error ? err.message : String(err));
    }
  }

  // Clean up API URL globals
  // Use type assertion for global access
  (globalThis as any).__API_URL__ = null;
  (globalThis as any).__API_PREFIX__ = null;

  // Note: We're deliberately NOT clearing the agent instances
  // This allows them to be reused across test suites
  // global.__TEST_AGENT__ = null;
  // global.__TEXT_AGENT__ = null;

  // Close the database connection pool globally
  try {
    // Dynamically require db-test-helpers to avoid import issues if it uses the pool early
    const dbHelpers = require('./db-test-helpers'); 
    await dbHelpers.closePool();
    console.log('Database connection pool closed globally.');
  } catch (err) {
    console.warn('Warning: Error closing database pool globally:', err instanceof Error ? err.message : String(err));
  }

  console.log('Global test teardown completed');
};