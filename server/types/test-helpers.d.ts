import { Response } from 'supertest';
import { Express } from 'express';
import { 
  UserType, 
  ConversationType, 
  CommentType, 
  Vote 
} from '../src/d';

// Augment supertest's Response type
declare module 'supertest' {
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
  cookies: string[] | string | undefined;
  userId: number;
  agent: any; // SuperTest agent
  textAgent: any; // SuperTest text agent
  testUser?: TestUser;
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
  cookies: string[] | string | undefined;
  body: any;
  status: number;
  agent: any; // SuperTest agent
  xid?: string;
}

// Vote data structure
export interface VoteData {
  tid: number;
  conversation_id: string;
  vote: -1 | 0 | 1;
  pid?: string;
  xid?: string;
  high_priority?: boolean;
  lang?: string;
}

// Vote response data
export interface VoteResponse extends Partial<Response> {
  cookies: string[] | string | undefined;
  body: {
    currentPid?: string;
    [key: string]: any;
  };
  text: string;
  status: number;
  agent: any; // SuperTest agent
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
  pid?: string;
  [key: string]: any;
}

// Response validation options
export interface ValidationOptions {
  expectedStatus?: number;
  errorPrefix?: string;
  requiredProperties?: string[];
}