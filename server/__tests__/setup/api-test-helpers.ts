import { Express } from "express";
import crypto from "crypto";
import request from "supertest";
import _ from "underscore";
import { getPooledTestUser } from "./test-user-helpers";
import type { Response } from "supertest";
import type {
  CommentOptions,
  CommentResponse,
  ConversationOptions,
  ConvoData,
  JwtAuthData,
  ParticipantData,
  TestUser,
  ValidationOptions,
  VoteData,
  VoteResponse,
} from "../../types/test-helpers";

// App factory function that each test can use independently
async function createAppInstance(): Promise<Express> {
  const { getApp } = await import("../app-loader");
  return await getApp();
}

// ASYNC getter for the app instance (backwards compatibility)
async function getAppInstance(): Promise<Express> {
  // For backwards compatibility, try global first, then create new instance
  if ((globalThis as any).__APP_INSTANCE__) {
    return (globalThis as any).__APP_INSTANCE__;
  }

  // Create a new app instance for this worker
  return await createAppInstance();
}

// ASYNC getter for the test agent (backwards compatibility)
async function getTestAgent(): Promise<ReturnType<typeof request.agent>> {
  if ((globalThis as any).__TEST_AGENT__) {
    return (globalThis as any).__TEST_AGENT__;
  }

  // Create a new agent for this worker
  const app = await getAppInstance();
  return request.agent(app);
}

// ASYNC newAgent function - creates a fresh agent with its own app instance
async function newAgent(): Promise<ReturnType<typeof request.agent>> {
  const app = await createAppInstance();
  return request.agent(app);
}

/**
 * Helper to generate a random external ID
 * @returns Random XID
 */
function generateRandomXid(): string {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 10000);
  return `test-xid-${timestamp}-${randomSuffix}`;
}

/**
 * Helper function to wait/pause execution
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the specified time
 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Helper to get an access token from the OIDC simulator.
 * Assumes the simulator is running and configured.
 * @param user - User credentials (email, password)
 * @returns The access token string.
 */
export async function getOidcToken(
  user: Pick<TestUser, "email" | "password">
): Promise<string> {
  // Dynamically import axios only when needed for this function
  const axios = (await import("axios")).default;
  const https = await import("https");

  const httpsAgent = new https.Agent({
    rejectUnauthorized: false, // Necessary for self-signed certs used by the simulator
  });

  // Read the simulator URL dynamically when the function is called
  const simulatorUrl = process.env.AUTH_ISSUER || "https://localhost:3000";
  const audience = process.env.AUTH_AUDIENCE || "users";
  const clientId = process.env.AUTH_CLIENT_ID || "dev-client-id";

  try {
    // Properly construct the token URL to avoid double slashes
    const tokenUrl = simulatorUrl.endsWith("/")
      ? `${simulatorUrl}oauth/token`
      : `${simulatorUrl}/oauth/token`;

    console.log(`Attempting to get token from: ${tokenUrl}`);
    console.log(`Using audience: ${audience}, clientId: ${clientId}`);

    const tokenResponse = await axios.post(
      tokenUrl,
      {
        grant_type: "password",
        username: user.email,
        password: user.password,
        audience: audience,
        client_id: clientId,
        scope: "openid profile email",
      },
      {
        httpsAgent,
        timeout: 10000, // Increase timeout to 10 seconds for CI
      }
    );

    if (tokenResponse.data && tokenResponse.data.access_token) {
      return tokenResponse.data.access_token;
    } else {
      throw new Error("Failed to retrieve access_token from OIDC simulator.");
    }
  } catch (error: any) {
    // Avoid logging circular response objects
    if (error.response) {
      console.error("Error getting token from simulator:", {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
      });

      // If simulator is not available (404), provide helpful error message
      if (error.response.status === 404) {
        throw new Error(
          `OIDC simulator not available at ${simulatorUrl}. ` +
            `Please ensure the simulator is running.`
        );
      }
    } else if (error.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to OIDC simulator at ${simulatorUrl}. ` +
          `Please ensure the simulator is running.`
      );
    } else {
      console.error("Error getting token from simulator:", error.message);
    }
    throw error; // Re-throw the error to be handled by the caller
  }
}

/**
 * Creates a SuperTest agent authenticated with a JWT token from the OIDC simulator.
 * @param user - User credentials (email, password).
 * @returns A promise that resolves to JwtAuthData (agent, token, testUser).
 */
export async function getJwtAuthenticatedAgent(
  user: TestUser
): Promise<JwtAuthData> {
  const app = await getAppInstance();
  const agent = request.agent(app);
  const currentUser = user;

  // Note: This assumes the OIDC simulator has this user registered.
  // The auth-jwt.test.ts file handles simulator setup with users.
  // For other tests, ensure the user exists in the simulator's state.
  const token = await getOidcToken(currentUser);

  agent.set("Authorization", `Bearer ${token}`);

  // Also, we need to ensure that the user exists in the local Polis database.
  // The JWT middleware's extractUserFromJWT will attempt getOrCreateUserIDFromOidcSub.
  // For tests to pass consistently, this user (identified by 'sub' from the token)
  // might need to be pre-created or the getOrCreate logic should be robust.
  // This is an important consideration for test stability.
  // For now, we assume the getOrCreate path will handle it or tests will manage this setup.

  return { agent, token, testUser: currentUser };
}

/**
 * Helper function to set the Authorization header for an existing agent.
 * @param agent - The SuperTest agent to modify.
 * @param token - The JWT token.
 */
export function setAgentJwt(
  agent: ReturnType<typeof request.agent>,
  token: string
): void {
  agent.set("Authorization", `Bearer ${token}`);
}

/**
 * Helper to create a test conversation using a supertest agent
 * @param agent - Supertest agent to use for the request
 * @param options - Conversation options
 * @returns Created conversation ID (zinvite)
 */
async function createConversation(
  agent: ReturnType<typeof request.agent>,
  options: ConversationOptions = {}
): Promise<string> {
  const timestamp = Date.now();
  const defaultOptions = {
    topic: `Test Conversation ${timestamp}`,
    description: `This is a test conversation created at ${timestamp}`,
    is_active: true,
    is_anon: true,
    is_draft: false,
    strict_moderation: false,
    profanity_filter: false, // Disable profanity filter for testing
    ...options,
  };

  const response = await agent
    .post("/api/v3/conversations")
    .send(defaultOptions);

  // Validate response
  validateResponse(response, {
    errorPrefix: `Failed to create conversation`,
  });

  try {
    // Try to parse the response text as JSON
    const jsonData = JSON.parse(response.text);
    return jsonData.conversation_id;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to parse conversation response: ${error.message}, Response: ${response.text}`
      );
    }
    throw error;
  }
}

/**
 * Helper to create a test comment using a supertest agent
 * @param agent - Supertest agent to use for the request
 * @param conversationId - Conversation ID (zinvite)
 * @param options - Comment options
 * @returns Created comment ID
 */
async function createComment(
  agent: ReturnType<typeof request.agent>,
  conversationId: string,
  options: CommentOptions = {} as CommentOptions
): Promise<number> {
  // To ensure cookie-less auth, we must first establish the participant
  // and get a JWT. The reliable way to do this for any participant type
  // (anon, xid, or standard) is to perform an action that issues a token.
  // Voting is a lightweight way to do this.

  // First, get a comment to vote on. If there are no comments, create a seed one.
  const commentsResponse = await agent.get(
    `/api/v3/comments?conversation_id=${conversationId}&modIn=true`
  );
  const comments = commentsResponse.body;

  let targetCommentTid = comments[0]?.tid;

  if (!targetCommentTid) {
    // No comments exist, so create a placeholder comment to vote on
    // This requires an authenticated agent, which we assume the initial one is.
    const seedCommentResponse = await agent.post("/api/v3/comments").send({
      conversation_id: conversationId,
      txt: "Seed comment for auth " + Date.now(),
      is_seed: true,
    });
    validateResponse(seedCommentResponse, {
      errorPrefix: "Failed to create seed comment",
    });
    targetCommentTid = seedCommentResponse.body.tid;
  }

  // Now, submit a vote to ensure a JWT is issued and attached to the agent.
  const voteResponse = await submitVote(agent, {
    conversation_id: conversationId,
    tid: targetCommentTid,
    vote: 0, // 'skip' vote
  });

  // Check vote response status directly since VoteResponse doesn't extend Response
  if (voteResponse.status !== 200) {
    throw new Error(
      `Failed to submit vote for auth: ${voteResponse.status} ${voteResponse.text}`
    );
  }

  // Now that the agent is guaranteed to have a JWT, create the actual comment.
  const response = await agent.post("/api/v3/comments").send({
    conversation_id: conversationId,
    ...options,
  });

  validateResponse(response, {
    errorPrefix: "Failed to create comment",
    requiredProperties: ["body.tid"],
  });
  const responseBody = response.body;

  const commentId = responseBody.tid;

  return commentId;
}

/**
 * Enhanced setupAuthAndConvo that works with supertest agents
 * Maintains the same API as the original function but uses agents internally
 *
 * @param options - Options for setup
 * @returns Object containing auth token, userId, and conversation info
 */
async function setupAuthAndConvo(
  options: {
    createConvo?: boolean;
    commentCount?: number;
    conversationOptions?: ConversationOptions;
    commentOptions?: CommentOptions;
    userData?: TestUser;
  } = {}
): Promise<ConvoData> {
  const {
    createConvo = true,
    commentCount = 1,
    conversationOptions = {},
    commentOptions = {},
  } = options;

  // Use JWT-based authentication to set up the conversation
  const pooledUser = getPooledTestUser(1); // Use a default pooled user
  const testUser =
    options.userData ||
    ({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    } as TestUser);

  const { agent, token } = await getJwtAuthenticatedAgent(testUser);

  let userId: number | null = null;

  // Try to get user info if we have a valid JWT token
  if (token) {
    try {
      const userResponse = await agent.get("/api/v3/users");
      if (userResponse.status === 200) {
        userId = userResponse.body.uid;
      } else {
        console.warn(
          `Failed to get user info after JWT auth: ${userResponse.status} ${userResponse.text}`
        );
      }
    } catch (error) {
      console.warn("Error getting user info:", error);
    }
  }

  // Clear domain whitelist for test user
  // Empty string means no whitelist restrictions (all domains allowed)
  // This prevents domain validation errors during participant initialization
  // Note: We don't fail the test if this fails because:
  // 1. The user might not have a site_domain_whitelist record yet
  // 2. Some test users might not have permission to modify whitelist
  // 3. Tests can still pass if the conversation owner has no whitelist configured
  try {
    const allowListResponse = await agent
      .post("/api/v3/domainWhitelist")
      .send({ domain_whitelist: "" })
      .ok((res) => res.status < 500); // Don't throw on client errors

    if (allowListResponse.status !== 200) {
      console.warn(
        "Failed to clear domain whitelist:",
        allowListResponse.status,
        allowListResponse.text || allowListResponse.body
      );
    }
  } catch (err) {
    // Log but don't fail - the test might still work
    console.warn("Error clearing domain whitelist for test user:", err);
  }

  const commentIds: number[] = [];
  let conversationId = "";

  // Create test conversation if requested
  if (createConvo) {
    const timestamp = Date.now();
    const convoOptions = {
      topic: `Test Conversation ${timestamp}`,
      description: `This is a test conversation created at ${timestamp}`,
      is_active: true,
      is_anon: true,
      is_draft: false,
      strict_moderation: false,
      profanity_filter: false,
      ...conversationOptions,
    };

    conversationId = await createConversation(agent, convoOptions);

    if (conversationId === null || conversationId === undefined) {
      throw new Error("Failed to create conversation");
    }

    // Create test comments if commentCount is specified
    if (commentCount > 0) {
      for (let i = 0; i < commentCount; i++) {
        const commentData = {
          conversation_id: conversationId,
          txt: `Test comment ${i + 1}`,
          ...commentOptions,
        };

        const commentId = await createComment(
          agent,
          conversationId,
          commentData
        );

        if (commentId == null || commentId === undefined) {
          throw new Error("Failed to create comment");
        }

        commentIds.push(commentId);
      }
    }
  }

  return {
    userId: userId || -1, // Default to -1 if userId is null (for JWT-only tests)
    testUser,
    conversationId,
    commentIds,
  };
}

/**
 * Enhanced helper to initialize a participant with better auth handling using supertest agents
 *
 * @param conversationId - Conversation zinvite
 * @param options - Optional object with origin property to set Origin header (rarely needed)
 * @returns Participant data with auth, body, status and agent
 */
async function initializeParticipant(
  conversationId: string,
  options?: { origin?: string }
): Promise<ParticipantData> {
  // Use regular agent since API now returns JSON errors
  const participantAgent = await newAgent();

  // Build the request
  let req = participantAgent.get(
    `/api/v3/participationInit?conversation_id=${conversationId}&pid=-1&lang=en`
  );

  // Only set Origin/Referer headers if explicitly provided (for special test cases)
  if (options?.origin) {
    req = req.set("Origin", options.origin);
    req = req.set("Referer", options.origin);
  }

  const response = await req;

  validateResponse(response, {
    errorPrefix: `Failed to initialize anonymous participant`,
  });

  const responseBody = response.body;
  let token;

  // If JWT token is provided in response, use it for authentication
  if (responseBody.auth && responseBody.auth.token) {
    token = responseBody.auth.token;
    participantAgent.set("Authorization", `Bearer ${token}`);
  }

  await wait(500);

  return {
    body: responseBody,
    status: response.status,
    agent: participantAgent, // Return an authenticated agent for the participant
    token,
  };
}

/**
 * Enhanced initializeParticipantWithXid using supertest agents
 *
 * @param conversationId - Conversation zinvite
 * @param xid - External ID (generated or provided)
 * @param options - Optional object with origin property to set Origin header (rarely needed)
 * @returns Participant data including auth, body, status and agent
 */
async function initializeParticipantWithXid(
  conversationId: string,
  xid: string | null = null,
  options?: { origin?: string }
): Promise<ParticipantData> {
  // Use regular agent since API now returns JSON errors
  const participantAgent = await newAgent();

  // Generate XID if not provided
  if (!xid) {
    xid = generateRandomXid();
  }

  // Build the request
  let req = participantAgent.get(
    `/api/v3/participationInit?conversation_id=${conversationId}&xid=${xid}&pid=-1&lang=en&agid=1`
  );

  // Only set Origin/Referer headers if explicitly provided (for special test cases)
  if (options?.origin) {
    req = req.set("Origin", options.origin);
    req = req.set("Referer", options.origin);
  }

  const response = await req;

  validateResponse(response, {
    errorPrefix: `Failed to initialize XID participant`,
  });

  const responseBody = response.body;
  let token;

  // If JWT token is provided in response, use it for authentication
  if (responseBody.auth && responseBody.auth.token) {
    token = responseBody.auth.token;
    participantAgent.set("Authorization", `Bearer ${token}`);
  }

  return {
    body: responseBody,
    status: response.status,
    agent: participantAgent, // Return an authenticated agent for the participant
    token,
  };
}

/**
 * Enhanced submitVote using supertest agents
 *
 * @param agent - Supertest agent to use for the request
 * @param options - Vote data
 * @returns Vote response
 */
async function submitVote(
  agent: ReturnType<typeof request.agent> | null,
  options: VoteData = {} as VoteData
): Promise<VoteResponse> {
  // Create a new agent if none provided
  const voteAgent = agent || (await newAgent());

  // Submit vote
  const response = await voteAgent.post("/api/v3/votes").send(options);

  // Return response with body (could be parsed or text depending on content-type)
  let responseBody;
  try {
    responseBody = JSON.parse(response.text);
  } catch {
    responseBody = response.text;
  }

  // If the response includes a JWT token, set it on the agent for future requests
  if (
    responseBody &&
    typeof responseBody === "object" &&
    responseBody.auth?.token
  ) {
    setAgentJwt(voteAgent, responseBody.auth.token);
  }

  return {
    status: response.status,
    body: responseBody,
    text: response.text,
    headers: response.headers,
  };
}

/**
 * Enhanced submitComment using supertest agents
 *
 * @param agent - Supertest agent to use for the request
 * @param options - Comment options
 * @returns Comment response
 */
async function submitComment(
  agent: ReturnType<typeof request.agent> | null,
  options: CommentOptions = {} as CommentOptions
): Promise<CommentResponse> {
  // Create a new agent if none provided
  const commentAgent = agent || (await newAgent());

  // Submit comment
  const response = await commentAgent.post("/api/v3/comments").send(options);

  // Return response with body (could be parsed or text depending on content-type)
  let responseBody;
  try {
    responseBody = JSON.parse(response.text);
  } catch {
    responseBody = response.text;
  }

  return {
    status: response.status,
    body: responseBody,
    text: response.text,
    headers: response.headers,
  };
}

/**
 * Update conversation settings
 * @param agent - Supertest agent to use for the request
 * @param params - Conversation parameters including conversation_id
 * @returns Response object
 */
async function updateConversation(
  agent: ReturnType<typeof request.agent>,
  params: { conversation_id: string; [key: string]: any } = {
    conversation_id: "",
  }
): Promise<Response> {
  const response = await agent.put("/api/v3/conversations").send(params);

  return response;
}

/**
 * Helper to check if a response has a nested property
 * @param response - Response object
 * @param propertyPath - Dot-separated property path (e.g., "body.user.id")
 * @returns True if property exists
 */
function hasResponseProperty(response: any, propertyPath: string): boolean {
  const parts = propertyPath.split(".");
  let current = response;

  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return false;
    }
    current = current[part];
  }

  return true;
}

/**
 * Format error message with response details
 * @param response - Response object
 * @param prefix - Error message prefix
 * @returns Formatted error message
 */
function formatErrorMessage(response: Response, prefix = "API error"): string {
  const details: string[] = [];
  if (response.status) details.push(`status: ${response.status}`);
  if (response.text) details.push(`body: ${response.text}`);
  return `${prefix}: ${details.join(", ")}`;
}

/**
 * Validate response and throw descriptive error if invalid
 * @param response - Response to validate
 * @param options - Validation options
 * @returns The response if valid
 */
function validateResponse(
  response: Response,
  options: ValidationOptions = {}
): Response {
  const { errorPrefix = "API error", requiredProperties = [] } = options;

  if (!response || response.status >= 400) {
    throw new Error(formatErrorMessage(response, errorPrefix));
  }

  // Check required properties
  for (const prop of requiredProperties) {
    if (!hasResponseProperty(response, prop)) {
      throw new Error(`${errorPrefix}: Missing required property '${prop}'`);
    }
  }

  return response;
}

/**
 * Create HMAC signature for a user and conversation (for notification endpoints)
 * This matches the server's signature generation logic in src/routes/notify.ts
 * @param email - User email
 * @param conversationId - Conversation ID
 * @param path - API path
 * @returns HMAC signature
 */
function createHmacSignature(
  email: string,
  conversationId: string,
  path = "api/v3/notifications/subscribe"
): string {
  // Use the same hardcoded secret as the server
  const secret = "G7f387ylIll8yuskuf2373rNBmcxqWYFfHhdsd78f3uekfs77EOLR8wofw";

  // Create params object and sort by key name (same as server's paramsToStringSortedByName)
  const params = {
    conversation_id: conversationId,
    email: email,
  };

  // Sort parameters alphabetically by key and format as key=value&key=value
  const sortedPairs = Object.entries(params)
    .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
    .map(([key, value]) => `${key}=${value}`);

  const queryString = sortedPairs.join("&");

  // Trim trailing "/" from path and create message (same format as server)
  const trimmedPath = path.replace(/\/$/, "");
  const message = `${trimmedPath}?${queryString}`;

  // Use SHA1 (same as server)
  return crypto.createHmac("sha1", secret).update(message).digest("hex");
}

/**
 * Populate a conversation with participants and votes for testing
 * @param options - Configuration options
 * @returns Object containing participants, comments, votes, and stats
 */
async function populateConversationWithVotes(
  options: {
    conversationId: string;
    numParticipants?: number;
    numComments?: number;
    authenticatedAgent?: ReturnType<typeof request.agent>;
  } = { conversationId: "" }
): Promise<{
  participants: ReturnType<typeof request.agent>[];
  comments: number[];
  votes: {
    participantIndex: number;
    commentId: number;
    vote: number;
    pid: number;
  }[];
  stats: { numParticipants: number; numComments: number; totalVotes: number };
}> {
  const {
    conversationId,
    numParticipants = 3,
    numComments = 3,
    authenticatedAgent,
  } = options;

  // Create authenticated agent if not provided
  let agent: ReturnType<typeof request.agent>;
  if (authenticatedAgent) {
    agent = authenticatedAgent;
  } else {
    // Create a new authenticated agent
    const pooledUser = getPooledTestUser(1);
    const testUser: TestUser = {
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    };
    const jwtData = await getJwtAuthenticatedAgent(testUser);
    agent = jwtData.agent;
  }

  // Create comments
  const comments: number[] = [];
  for (let i = 0; i < numComments; i++) {
    const commentId = await createComment(agent, conversationId, {
      txt: `Test comment ${i + 1} for voting`,
      conversation_id: conversationId,
    });
    comments.push(commentId);
  }

  // Create participants
  const participants: ReturnType<typeof request.agent>[] = [];
  for (let i = 0; i < numParticipants; i++) {
    const { agent: participantAgent } = await initializeParticipant(
      conversationId
    );
    participants.push(participantAgent);
  }

  // Random vote generator: -1 (agree), 1 (disagree), 0 (pass)
  const voteGenerator = () =>
    [-1, 1, 0][Math.floor(Math.random() * 3)] as -1 | 0 | 1;

  // Submit votes from each participant
  const votes: {
    participantIndex: number;
    commentId: number;
    vote: number;
    pid: number;
  }[] = [];
  for (let pIndex = 0; pIndex < participants.length; pIndex++) {
    const participantAgent = participants[pIndex];

    for (const commentId of comments) {
      const vote = voteGenerator();
      const voteResponse = await submitVote(participantAgent, {
        conversation_id: conversationId,
        tid: commentId,
        vote,
      });

      if (voteResponse.status === 200) {
        const pid =
          voteResponse.body?.currentPid || voteResponse.body?.pid || pIndex + 1;
        votes.push({
          participantIndex: pIndex,
          commentId,
          vote,
          pid,
        });
      }
    }
  }

  return {
    participants,
    comments,
    votes,
    stats: {
      numParticipants,
      numComments,
      totalVotes: votes.length,
    },
  };
}

/**
 * Sync a single pooled user to the database by ensuring it has an OIDC mapping
 * @param pooledUser - Pooled user data
 */
async function syncPooledUserToDatabase(pooledUser: {
  email: string;
  name: string;
  password: string;
}): Promise<void> {
  const testUser: TestUser = {
    email: pooledUser.email,
    hname: pooledUser.name,
    password: pooledUser.password,
  };

  try {
    // Get OIDC token for the user
    const token = await getOidcToken(testUser);

    // Create an agent and authenticate it
    const agent = await newAgent();
    agent.set("Authorization", `Bearer ${token}`);

    // Make a request that will trigger user creation/mapping in the database
    const userInfoResponse = await agent.get("/api/v3/users");

    if (userInfoResponse.status === 200) {
      const uid = userInfoResponse.body.uid;

      // Update user profile to ensure it has the correct name
      await agent.put("/api/v3/users").send({
        uid: uid,
        hname: pooledUser.name,
      });
    } else {
      console.warn(
        `Failed to sync user ${pooledUser.email}: ${userInfoResponse.status}`
      );
    }
  } catch (error) {
    console.error(`Error syncing pooled user ${pooledUser.email}:`, error);
    throw error;
  }
}

/**
 * Sync all pooled users to ensure they exist in the database with OIDC mappings
 */
async function syncAllPooledUsers(): Promise<void> {
  // Get all pooled users (assuming we have 3 for now)
  for (let i = 1; i <= 3; i++) {
    const pooledUser = getPooledTestUser(i);
    await syncPooledUserToDatabase(pooledUser);
  }

  console.log("Pooled user synchronization complete");
}

// Export all enhanced helpers
export {
  createAppInstance,
  createComment,
  createConversation,
  createHmacSignature,
  formatErrorMessage,
  generateRandomXid,
  getTestAgent,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  populateConversationWithVotes,
  setupAuthAndConvo,
  submitComment,
  submitVote,
  syncAllPooledUsers,
  updateConversation,
  wait,
  type TestUser,
};
