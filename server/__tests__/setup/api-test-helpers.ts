import crypto from 'crypto';
import dotenv from 'dotenv';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Express } from 'express';
import type { 
  TestUser,
  AuthData,
  ConvoData, 
  ParticipantData,
  VoteData,
  VoteResponse,
  ConversationOptions,
  CommentOptions,
  ValidationOptions
} from '../../types/test-helpers';

// Import the Express app via our controlled loader
import { getApp } from '../app-loader';

// Async version for more reliable initialization
async function getAppInstance(): Promise<Express> {
  return await getApp();
}

// Use { override: false } to prevent dotenv from overriding command-line env vars
dotenv.config({ override: false });

// Set environment variables for testing
process.env.NODE_ENV = 'test';
process.env.TESTING = 'true';

// ASYNC getter functions
async function getTestAgent(): Promise<ReturnType<typeof request.agent>> {
  // Use type assertion for global access
  if (!(globalThis as any).__TEST_AGENT__) {
    const app = await getAppInstance();
    (globalThis as any).__TEST_AGENT__ = request.agent(app);
  }
  // Ensure it's not null before returning
  if (!(globalThis as any).__TEST_AGENT__) {
      throw new Error('Failed to initialize __TEST_AGENT__');
  }
  return (globalThis as any).__TEST_AGENT__;
}

// ASYNC getter functions
async function getTextAgent(): Promise<ReturnType<typeof request.agent>> {
  // Use type assertion for global access
  if (!(globalThis as any).__TEXT_AGENT__) {
    const app = await getAppInstance();
    (globalThis as any).__TEXT_AGENT__ = createTextAgent(app);
  }
   // Ensure it's not null before returning
  if (!(globalThis as any).__TEXT_AGENT__) {
      throw new Error('Failed to initialize __TEXT_AGENT__');
  }
  return (globalThis as any).__TEXT_AGENT__;
}

// ASYNC newAgent function
async function newAgent(): Promise<ReturnType<typeof request.agent>> {
  const app = await getAppInstance();
  return request.agent(app);
}

// ASYNC newTextAgent function
async function newTextAgent(): Promise<ReturnType<typeof request.agent>> {
  const app = await getAppInstance();
  return createTextAgent(app);
}

/**
 * Create an agent that handles text responses properly
 * Use this when you need to maintain cookies across requests but still handle text responses
 *
 * @param app - Express app instance
 * @returns Supertest agent with custom parser
 */
function createTextAgent(app: Express): ReturnType<typeof request.agent> {
  const agent = request.agent(app);
  agent.parse((res, fn) => {
    res.setEncoding('utf8');
    res.text = '';
    res.on('data', (chunk) => {
      res.text += chunk;
    });
    res.on('end', () => {
      fn(null, res.text);
    });
  });
  return agent;
}

/**
 * Helper to generate random test user data
 * @returns Random user data for registration
 */
function generateTestUser(): TestUser {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 10000);

  return {
    email: `test.user.${timestamp}.${randomSuffix}@example.com`,
    password: `TestPassword${randomSuffix}!`,
    hname: `Test User ${timestamp}`
  };
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
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    ...options
  };

  const response = await agent.post('/api/v3/conversations').send(defaultOptions);

  // Validate response
  if (response.status !== 200) {
    throw new Error(`Failed to create conversation: ${response.status} ${response.text}`);
  }

  try {
    // Try to parse the response text as JSON
    const jsonData = JSON.parse(response.text);
    return jsonData.conversation_id;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse conversation response: ${error.message}, Response: ${response.text}`);
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
  if (!conversationId) {
    throw new Error('Conversation ID is required to create a comment');
  }

  const defaultOptions = {
    agid: 1,
    is_active: true,
    pid: 'mypid',
    ...options,
    conversation_id: options.conversation_id || conversationId,
    txt: options.txt || `This is a test comment created at ${Date.now()}`
  };

  const response = await agent.post('/api/v3/comments').send(defaultOptions);

  // Validate response
  if (response.status !== 200) {
    throw new Error(`Failed to create comment: ${response.status} ${response.text}`);
  }

  const responseBody = parseResponseJSON(response);
  const commentId = responseBody.tid;
  const cookies = response.headers['set-cookie'] || [];
  authenticateAgent(agent, cookies);

  await wait(500); // Wait for comment to be created

  return commentId;
}

/**
 * Helper function to extract a specific cookie value from a cookie array
 * @param cookies - Array of cookies from response
 * @param cookieName - Name of the cookie to extract
 * @returns Cookie value or null if not found
 */
function extractCookieValue(cookies: string[] | string | undefined, cookieName: string): string | null {
  if (!cookies) {
    return null;
  }
  
  // Handle string array
  if (Array.isArray(cookies)) {
    if (cookies.length === 0) {
      return null;
    }
    
    for (const cookie of cookies) {
      if (cookie.startsWith(`${cookieName}=`)) {
        return cookie.split(`${cookieName}=`)[1].split(';')[0];
      }
    }
  } 
  // Handle single cookie string
  else if (typeof cookies === 'string') {
    const cookieParts = cookies.split(';');
    for (const part of cookieParts) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${cookieName}=`)) {
        return trimmed.split(`${cookieName}=`)[1];
      }
    }
  }

  return null;
}

/**
 * Enhanced registerAndLoginUser that works with supertest agents
 * Maintains the same API as the original function but uses agents internally
 *
 * @param userData - User data for registration
 * @returns Object containing authToken and userId
 */
async function registerAndLoginUser(userData: TestUser | null = null): Promise<AuthData> {
  // Use async agent getting to ensure app is initialized
  const agent = await getTestAgent();
  const textAgent = await getTextAgent();

  // Generate user data if not provided
  const testUser = userData || generateTestUser();

  // Register the user
  const registerResponse = await textAgent.post('/api/v3/auth/new').send({
    ...testUser,
    password2: testUser.password,
    gatekeeperTosPrivacy: true
  });

  // Validate registration response
  if (registerResponse.status !== 200) {
    throw new Error(`Failed to register user: ${registerResponse.status} ${registerResponse.text}`);
  }

  // Login with the user
  const loginResponse = await agent.post('/api/v3/auth/login').send({
    email: testUser.email,
    password: testUser.password
  });

  // Validate login response
  if (loginResponse.status !== 200) {
    throw new Error(`Failed to login user: ${loginResponse.status} ${loginResponse.text}`);
  }

  const loginBody = parseResponseJSON(loginResponse);

  // Get cookies for API compatibility
  const loginCookies = loginResponse.headers['set-cookie'] || [];
  authenticateGlobalAgents(loginCookies);

  // For compatibility with existing tests
  return {
    cookies: loginCookies,
    userId: loginBody.uid,
    agent, // Return the authenticated agent
    textAgent, // Return the text agent for error cases
    testUser
  };
}

/**
 * Enhanced setupAuthAndConvo that works with supertest agents
 * Maintains the same API as the original function but uses agents internally
 *
 * @param options - Options for setup
 * @returns Object containing auth token, userId, and conversation info
 */
async function setupAuthAndConvo(options: {
  createConvo?: boolean;
  commentCount?: number;
  conversationOptions?: ConversationOptions;
  commentOptions?: CommentOptions;
  userData?: TestUser;
} = {}): Promise<ConvoData> {
  const { createConvo = true, commentCount = 1, conversationOptions = {}, commentOptions = {} } = options;
  
  // Use async agent getting to ensure app is initialized
  const agent = await getTestAgent();

  // Register and login
  const testUser = options.userData || generateTestUser();
  const { userId } = await registerAndLoginUser(testUser);

  const commentIds: number[] = [];
  let conversationId = '';

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
      ...conversationOptions
    };

    conversationId = await createConversation(agent, convoOptions);

    if (conversationId === null || conversationId === undefined) {
      throw new Error('Failed to create conversation');
    }

    // Create test comments if commentCount is specified
    if (commentCount > 0) {
      for (let i = 0; i < commentCount; i++) {
        const commentData = {
          conversation_id: conversationId,
          txt: `Test comment ${i + 1}`,
          ...commentOptions
        };

        const commentId = await createComment(agent, conversationId, commentData);

        if (commentId == null || commentId === undefined) {
          throw new Error('Failed to create comment');
        }

        commentIds.push(commentId);
      }
    }
  }

  return {
    userId,
    testUser,
    conversationId,
    commentIds
  };
}

/**
 * Enhanced helper to initialize a participant with better cookie handling using supertest agents
 *
 * @param conversationId - Conversation zinvite
 * @returns Participant data with cookies, body, status and agent
 */
async function initializeParticipant(conversationId: string): Promise<ParticipantData> {
  // Use async agent creation to ensure app is initialized
  const participantAgent = await newAgent();

  const response = await participantAgent.get(
    `/api/v3/participationInit?conversation_id=${conversationId}&pid=mypid&lang=en`
  );

  if (response.status !== 200) {
    throw new Error(`Failed to initialize anonymous participant. Status: ${response.status}`);
  }

  // Extract cookies
  const cookies = response.headers['set-cookie'] || [];
  authenticateAgent(participantAgent, cookies);

  return {
    cookies,
    body: parseResponseJSON(response),
    status: response.status,
    agent: participantAgent // Return an authenticated agent for the participant
  };
}

/**
 * Enhanced initializeParticipantWithXid using supertest agents
 *
 * @param conversationId - Conversation zinvite
 * @param xid - External ID (generated or provided)
 * @returns Participant data including cookies, body, status and agent
 */
async function initializeParticipantWithXid(conversationId: string, xid: string | null = null): Promise<ParticipantData> {
  // Use async agent creation to ensure app is initialized
  const participantAgent = await newAgent();

  // Generate XID if not provided
  const participantXid = xid || generateRandomXid();

  const response = await participantAgent.get(
    `/api/v3/participationInit?conversation_id=${conversationId}&xid=${participantXid}&pid=mypid&lang=en`
  );

  if (response.status !== 200) {
    throw new Error(`Failed to initialize participant with XID. Status: ${response.status}`);
  }

  // Extract cookies
  const cookies = response.headers['set-cookie'] || [];
  authenticateAgent(participantAgent, cookies);

  return {
    cookies,
    body: parseResponseJSON(response),
    status: response.status,
    agent: participantAgent, // Return an authenticated agent for the participant
    xid: participantXid // Return the XID that was used
  };
}

/**
 * Enhanced submitVote using supertest agents
 *
 * @param agent - Supertest agent
 * @param options - Vote options
 * @returns Vote response
 */
async function submitVote(
  agent: ReturnType<typeof request.agent> | null, 
  options: VoteData = {} as VoteData
): Promise<VoteResponse> {
  // Error if options does not have tid or conversation_id
  // NOTE: 0 is a valid value for tid or conversation_id
  if (options.tid === undefined || options.conversation_id === undefined) {
    throw new Error('Options must have tid or conversation_id to vote');
  }
  // Ensure agent is initialized if not provided
  const voterAgent = agent || await getTestAgent();

  // Create vote payload
  const voteData = {
    agid: 1,
    high_priority: false,
    lang: 'en',
    pid: 'mypid',
    ...options,
    vote: options.vote !== undefined ? options.vote : 0
  };

  const response = await voterAgent.post('/api/v3/votes').send(voteData);

  await wait(500); // Wait for vote to be processed

  const cookies = response.headers['set-cookie'] || [];
  authenticateAgent(voterAgent, cookies);

  return {
    cookies,
    body: parseResponseJSON(response),
    text: response.text,
    status: response.status,
    agent: voterAgent // Return the agent for chaining
  };
}

/**
 * Retrieves votes for a conversation
 * @param agent - Supertest agent
 * @param conversationId - Conversation ID
 * @param pid - Participant ID
 * @returns - Array of votes
 */
async function getVotes(
  agent: ReturnType<typeof request.agent>, 
  conversationId: string, 
  pid: string
): Promise<any[]> {
  // Get votes for the conversation
  const response = await agent.get(`/api/v3/votes?conversation_id=${conversationId}&pid=${pid}`);

  // Validate response
  validateResponse(response, {
    expectedStatus: 200,
    errorPrefix: 'Failed to get votes'
  });

  return response.body;
}

/**
 * Retrieves votes for the current participant in a conversation
 * @param agent - Supertest agent
 * @param conversationId - Conversation ID
 * @param pid - Participant ID
 * @returns - Array of votes
 */
async function getMyVotes(
  agent: ReturnType<typeof request.agent>, 
  conversationId: string, 
  pid: string
): Promise<any[]> {
  // Get votes for the participant
  const response = await agent.get(`/api/v3/votes/me?conversation_id=${conversationId}&pid=${pid}`);

  // Validate response
  validateResponse(response, {
    expectedStatus: 200,
    errorPrefix: 'Failed to get my votes'
  });

  // NOTE: This endpoint seems to return a 200 status with an empty array.
  return response.body;
}

/**
 * Updates a conversation using query params
 * @param agent - Supertest agent
 * @param params - Update parameters
 * @returns - API response
 */
async function updateConversation(
  agent: ReturnType<typeof request.agent>, 
  params: { conversation_id: string; [key: string]: any } = { conversation_id: '' }
): Promise<Response> {
  if (params.conversation_id === undefined) {
    throw new Error('conversation_id is required to update a conversation');
  }

  return agent.put('/api/v3/conversations').send(params);
}

/**
 * Helper function to safely check for response properties, handling falsy values correctly
 * @param response - API response object
 * @param propertyPath - Dot-notation path to property (e.g., 'body.tid')
 * @returns - True if property exists and is not undefined/null
 */
function hasResponseProperty(response: any, propertyPath: string): boolean {
  if (!response) return false;

  const parts = propertyPath.split('.');
  let current = response;

  for (const part of parts) {
    // 0, false, and empty string are valid values
    if (current[part] === undefined || current[part] === null) {
      return false;
    }
    current = current[part];
  }

  return true;
}

/**
 * Formats an error message from a response
 * @param response - The API response
 * @param prefix - Error message prefix
 * @returns - Formatted error message
 */
function formatErrorMessage(response: Response, prefix = 'API error'): string {
  const errorMessage =
    typeof response.body === 'string' ? response.body : response.text || JSON.stringify(response.body);
  return `${prefix}: ${response.status} ${errorMessage}`;
}

/**
 * Validates a response and throws an error if invalid
 * @param response - The API response
 * @param options - Validation options
 * @returns - The response if valid
 * @throws - If response is invalid
 */
function validateResponse(response: Response, options: ValidationOptions = {}): Response {
  const { expectedStatus = 200, errorPrefix = 'API error', requiredProperties = [] } = options;

  // Check status
  if (response.status !== expectedStatus) {
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
 * Helper function to authenticate a supertest agent with a token
 * @param agent - The supertest agent to authenticate
 * @param token - Auth token or cookie array
 * @returns - The authenticated agent (for chaining)
 */
function authenticateAgent(
  agent: ReturnType<typeof request.agent>, 
  token: string[] | string | undefined
): ReturnType<typeof request.agent> {
  if (!token || (Array.isArray(token) && token.length === 0)) {
    return agent;
  }

  if (Array.isArray(token)) {
    // Handle cookie array
    const cookieString = token.map((c) => c.split(';')[0]).join('; ');
    agent.set('Cookie', cookieString);
  } else if (typeof token === 'string' && (token.includes(';') || token.startsWith('token2='))) {
    // Handle cookie string
    agent.set('Cookie', token);
  } else if (typeof token === 'string') {
    // Handle x-polis token
    agent.set('x-polis', token);
  }

  return agent;
}

/**
 * Helper function to authenticate both global agents with the same token
 * Use this when you need to maintain the same auth state across both agents
 *
 * @param token - Auth token or cookie array
 * @returns - Object containing both authenticated agents
 */
function authenticateGlobalAgents(token: string[] | string | undefined): {
  agent: ReturnType<typeof request.agent>;
  textAgent: ReturnType<typeof request.agent>;
} {
  // Use type assertion for global access
  if (!(globalThis as any).__TEST_AGENT__ || !(globalThis as any).__TEXT_AGENT__) {
     // This might happen if called very early, before globalSetup or async getters run.
     // Depending on usage, might need to make this function async and await getTestAgent()/getTextAgent().
     // For now, throw error to highlight the potential issue.
     throw new Error('Global agents not initialized. Cannot authenticate synchronously.'); 
  }
  const agent = (globalThis as any).__TEST_AGENT__; // Access directly AFTER ensuring they exist
  const textAgent = (globalThis as any).__TEXT_AGENT__; // Access directly AFTER ensuring they exist

  if (!token || (Array.isArray(token) && token.length === 0)) {
    return { agent, textAgent };
  }

  if (Array.isArray(token)) {
    // Handle cookie array
    const cookieString = token.map((c) => c.split(';')[0]).join('; ');
    agent.set('Cookie', cookieString);
    textAgent.set('Cookie', cookieString);
  } else if (typeof token === 'string' && (token.includes(';') || token.startsWith('token2='))) {
    // Handle cookie string
    agent.set('Cookie', token);
    textAgent.set('Cookie', token);
  } else if (typeof token === 'string') {
    // Handle x-polis token
    agent.set('x-polis', token);
    textAgent.set('x-polis', token);
  }

  return { agent, textAgent };
}

/**
 * Helper to parse response text safely
 *
 * @param response - Response object
 * @returns Parsed JSON or empty object
 */
function parseResponseJSON(response: Response): any {
  try {
    if (response?.text) {
      return JSON.parse(response.text);
    }
    return {};
  } catch (e) {
    console.error('Error parsing JSON response:', e);
    return {};
  }
}

// Utility function to create HMAC signature for email verification
function createHmacSignature(email: string, conversationId: string, path = 'api/v3/notifications/subscribe'): string {
  // This should match the server's HMAC generation logic
  const serverKey = 'G7f387ylIll8yuskuf2373rNBmcxqWYFfHhdsd78f3uekfs77EOLR8wofw';
  const hmac = crypto.createHmac('sha1', serverKey);
  hmac.setEncoding('hex');

  // Create params object
  const params = {
    conversation_id: conversationId,
    email: email
  };

  // Create the full string exactly as the server does
  path = path.replace(/\/$/, ''); // Remove trailing slash if present
  const paramString = Object.entries(params)
    .sort(([a], [b]) => a > b ? 1 : -1)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const fullString = `${path}?${paramString}`;

  // Write the full string and get the hash exactly as the server does
  hmac.write(fullString);
  hmac.end();
  const hash = hmac.read();

  return hash.toString();
}

/**
 * Populates a conversation with participants, comments, and votes
 * Creates a rich dataset suitable for testing math/analysis features
 *
 * @param options - Configuration options
 * @returns Object containing arrays of created participants, comments, and votes
 */
async function populateConversationWithVotes(options: {
  conversationId: string;
  numParticipants?: number;
  numComments?: number;
} = { conversationId: '' }): Promise<{
  participants: ReturnType<typeof request.agent>[];
  comments: number[];
  votes: { participantIndex: number; commentId: number; vote: number; pid: string }[];
  stats: { numParticipants: number; numComments: number; totalVotes: number };
}> {
  const { conversationId, numParticipants = 3, numComments = 3 } = options;

  if (!conversationId) {
    throw new Error('conversationId is required');
  }

  const participants: ReturnType<typeof request.agent>[] = [];
  const comments: number[] = [];
  const votes: { participantIndex: number; commentId: number; vote: number; pid: string }[] = [];

  const voteGenerator = () => ([-1, 1, 0][Math.floor(Math.random() * 3)] as -1 | 0 | 1);

  // Create comments first
  for (let i = 0; i < numComments; i++) {
    // Pass the result of the async getter
    const commentId = await createComment(await getTestAgent(), conversationId, {
      conversation_id: conversationId,
      txt: `Test comment ${i + 1} created for data analysis`
    });
    comments.push(commentId);
  }

  // Create participants and their votes
  for (let i = 0; i < numParticipants; i++) {
    // Initialize participant
    const { agent: participantAgent } = await initializeParticipant(conversationId);
    participants.push(participantAgent);

    let pid = 'mypid';

    // Have each participant vote on all comments
    for (let j = 0; j < comments.length; j++) {
      const vote = voteGenerator();

      const response = await submitVote(participantAgent, {
        tid: comments[j],
        conversation_id: conversationId,
        vote: vote,
        pid: pid
      });

      // Update pid for next vote
      pid = response.body.currentPid || pid;

      votes.push({
        participantIndex: i,
        commentId: comments[j],
        vote: vote,
        pid: pid
      });
    }
  }

  // Wait for data to be processed
  await wait(2000);

  return {
    participants,
    comments,
    votes,
    stats: {
      numParticipants,
      numComments,
      totalVotes: votes.length
    }
  };
}

// Export API constants along with helper functions
export {
  authenticateAgent,
  createComment,
  createConversation,
  createHmacSignature,
  extractCookieValue,
  generateRandomXid,
  generateTestUser,
  getMyVotes,
  getTestAgent,
  getTextAgent,
  getVotes,
  initializeParticipant,
  initializeParticipantWithXid,
  newAgent,
  newTextAgent,
  populateConversationWithVotes,
  registerAndLoginUser,
  setupAuthAndConvo,
  submitVote,
  updateConversation,
  wait,
  // Export Types needed by tests
  AuthData,
  CommentOptions,
  ConversationOptions,
  ConvoData,
  ParticipantData,
  TestUser,
  ValidationOptions,
  VoteData,
  VoteResponse
};