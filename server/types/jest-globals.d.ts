import type { Server } from "http";
import type { Agent } from "supertest";

declare global {
  // Server and config related globals
  var __SERVER__: Server | null;
  var __SERVER_PORT__: number | null;
  var __API_URL__: string | null;
  var __API_PREFIX__: string | null;

  // Test agents
  var __TEST_AGENT__: Agent | null;
  var __TEXT_AGENT__: Agent | null;
}
