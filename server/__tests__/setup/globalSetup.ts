/**
 * The OIDC simulator must be running in Docker before running tests.
 * Global setup for Jest tests
 * This file is executed once before any test files are loaded
 *
 * Note: This setup is now optional - individual tests can create their own
 * app instances using createAppInstance() for parallel execution.
 */
import "dotenv/config";
import request from "supertest";
import { syncAllPooledUsers } from "./api-test-helpers";

/**
 * Global test setup that runs once before all test suites
 */
async function globalSetup() {
  console.log("Starting global test setup...");

  // Set necessary environment variables for tests
  process.env.NODE_ENV = "test";
  process.env.TESTING = "true";

  try {
    // Import and store app instance globally (optional - for backwards compatibility)
    const { getApp } = await import("../app-loader");
    const app = await getApp();
    (globalThis as any).__APP_INSTANCE__ = app;

    // Start server on dynamic port (0 = OS assigns available port)
    // This is optional - individual tests can create their own servers
    const server = app.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        console.log(`Global test server started on dynamic port: ${port}`);

        // Store the dynamic port and server URL globally
        process.env.TEST_SERVER_PORT = port.toString();
        process.env.TEST_SERVER_URL = `http://localhost:${port}`;

        // Store server instance and port for cleanup
        (globalThis as any).__TEST_SERVER__ = server;
        (globalThis as any).__TEST_SERVER_PORT__ = port;
      }
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => {
        const address = server.address();
        const port =
          address && typeof address === "object" ? address.port : "unknown";
        console.log(`Global test server listening on port: ${port}`);
        resolve();
      });

      server.once("error", (error: Error) => {
        console.error("Error starting global test server:", error);
        reject(error);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        reject(
          new Error("Global test server failed to start within 10 seconds")
        );
      }, 10000);
    });

    // Create and store global agent instances (optional)
    if ((globalThis as any).__APP_INSTANCE__) {
      (globalThis as any).__TEST_AGENT__ = request.agent(
        (globalThis as any).__APP_INSTANCE__
      );
      console.log("Created global test agent");
    }

    // Sync pooled users with the database
    // This ensures test users exist in both OIDC simulator and local database
    await syncAllPooledUsers();

    console.log("Global test setup completed successfully");
  } catch (error) {
    console.error("Error in global test setup:", error);
    console.log("Tests will fall back to creating individual app instances");
    // Don't throw - allow tests to create their own app instances
  }
}

export default globalSetup;
