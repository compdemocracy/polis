import { Response } from "supertest";

// Augment supertest's Response type
declare module "supertest" {
  interface Response {
    text: string;
  }
}

// Test user data for registration and authentication
export interface TestUser {
  email: string;
  password: string;
  hname: string;
}

// Data returned after user registration and login
export interface AuthData {
  userId: number;
  agent: any; // SuperTest agent
  testUser?: TestUser;
}

// JWT authentication data
export interface JwtAuthData {
  agent: any; // SuperTest agent
  token: string;
  testUser: TestUser;
}

// Data returned after setting up a test conversation
export interface ConvoData {
  userId: number;
  testUser: TestUser;
  conversationId: string;
  commentIds: number[];
}

// Data returned after initializing a participant
export interface ParticipantData {
  body: any;
  status: number;
  agent: any; // SuperTest agent
  token?: string;
}

// Vote data structure
export interface VoteData {
  tid: number;
  conversation_id: string;
  vote: -1 | 0 | 1;
  pid?: number;
  xid?: string;
  high_priority?: boolean;
  lang?: string;
}

// Vote response data
export interface VoteResponse extends Partial<Response> {
  body: {
    currentPid?: string;
    [key: string]: any;
  };
  text: string;
  status: number;
  headers: any;
}

// Comment response data
export interface CommentResponse extends Partial<Response> {
  body: {
    tid?: number;
    currentPid?: number;
    auth?: {
      token: string;
      token_type: string;
      expires_in: number;
    };
    [key: string]: any;
  };
  text: string;
  status: number;
  headers: any;
}

// Conversation options
export interface ConversationOptions {
  topic?: string;
  description?: string;
  is_active?: boolean;
  is_anon?: boolean;
  is_draft?: boolean;
  strict_moderation?: boolean;
  profanity_filter?: boolean;
  [key: string]: any;
}

// Comment options
export interface CommentOptions {
  conversation_id?: string;
  txt: string;
  pid?: number;
  [key: string]: any;
}

// Response validation options
export interface ValidationOptions {
  expectedStatus?: number;
  errorPrefix?: string;
  requiredProperties?: string[];
}
