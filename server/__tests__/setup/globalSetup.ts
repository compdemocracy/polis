/**
 * Global setup for Jest tests
 * This file is executed once before any test files are loaded
 */
import { AddressInfo } from "net";
import { getApp } from "../app-loader";
import { newAgent, newTextAgent } from "./api-test-helpers";
import { deleteAllEmails } from "./email-helpers";
import { jest } from "@jest/globals";

// --- Correctly Mocking fs/promises ---
// This mock now creates the deep object structure that your `analyzeComment` function expects.
jest.mock("fs/promises", () => ({
  readFile: jest.fn().mockImplementation((path) => {
    if ((path as string).endsWith("script.xml")) {
      return Promise.resolve(`
        <polis_moderation_rubric>
          <children></children> 
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children>
          <children></children> 
          <children>
            <task>
              <children></children> 
              <children>
                 
              </children>
            </task>
          </children>
        </polis_moderation_rubric>
      `);
    }
    if ((path as string).endsWith("system.xml")) {
      return Promise.resolve("<system_lore>System lore content</system_lore>");
    }
    return Promise.reject(new Error(`File not found in mock: ${path}`));
  }),
}));

//@ts-expect-error mock
const mockGenerateContent = jest.fn().mockResolvedValue({
  text: JSON.stringify({
    output: {
      base_score: "0.9",
      substance_level: "High",
      multiplier: "1.2",
      final_score: "1.08",
      decision: "APPROVE",
    },
  }),
});

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => {
      return {
        models: {
          generateContent: mockGenerateContent,
        },
      };
    }),
  };
});
/**
 * Create a simplified server object for testing
 * This avoids actually binding to a port while still providing the server interface needed for tests
 *
 * @param port - The port number to use in the server address info
 * @returns A minimal implementation of http.Server with just what we need for tests
 */
function createTestServer(port: number): import("http").Server {
  const server = {
    address: (): AddressInfo => ({
      port,
      family: "IPv4",
      address: "127.0.0.1",
    }),
    close: (callback?: (err?: Error) => void) => {
      if (callback) callback();
    },
  };
  return server as import("http").Server;
}

export default async (): Promise<void> => {
  console.log("Starting global test setup...");

  // Check if a server is already running and close it to avoid port conflicts
  // Use type assertion for global access
  if ((globalThis as any).__SERVER__) {
    try {
      await new Promise<void>((resolve, reject) => {
        // Add reject
        // Use type assertion for global access
        (globalThis as any).__SERVER__.close((err?: Error) => {
          // Handle potential error
          if (err) {
            console.warn(
              "Warning: Error closing existing server during setup:",
              err.message
            );
            // Decide whether to reject or resolve even if close fails
            // reject(err); // Option 1: Fail setup if closing fails
            resolve(); // Option 2: Continue setup even if closing fails (might leave previous server lingering)
          } else {
            // Use type assertion for global access
            console.log(
              `Closed existing test server on port ${
                (globalThis as any).__SERVER_PORT__
              }`
            );
            resolve();
          }
        });
      });
    } catch (err) {
      // Catch potential rejection from the promise
      console.warn(
        "Warning: Error closing existing server (caught promise rejection):",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // Use a test server since we're using the app instance directly
  const port = 5001; // Use a consistent port for tests
  const server = createTestServer(port);

  console.log(`Test server started on port ${port}`);

  // Store the server and port in global variables for tests to use
  // Use type assertion for global access
  (globalThis as any).__SERVER__ = server;
  (globalThis as any).__SERVER_PORT__ = port;

  // Create agents that use the app instance directly
  // Only create new agents if they don't already exist
  try {
    // Initialize the app asynchronously, ensuring it's fully loaded
    await getApp();

    // Use type assertion for global access
    if (!(globalThis as any).__TEST_AGENT__) {
      (globalThis as any).__TEST_AGENT__ = await newAgent();
      console.log("Created new global test agent");
    }

    // Use type assertion for global access
    if (!(globalThis as any).__TEXT_AGENT__) {
      (globalThis as any).__TEXT_AGENT__ = await newTextAgent();
      console.log("Created new global text agent");
    }
  } catch (err) {
    console.error("Error initializing app or agents:", err);
    throw err;
  }

  // Clear any existing emails
  await deleteAllEmails();

  // Store the API URL with the dynamic port
  // Use type assertion for global access
  (globalThis as any).__API_URL__ = `http://localhost:${port}`;
  (globalThis as any).__API_PREFIX__ = "/api/v3";

  console.log("Global test setup completed");
};
