export type Headers = {
  [key: string]: any;
  host?: string;
  referrer?: string;
  origin?: string;
  "x-request-id"?: string;
  "user-agent"?: string;
  authorization?: string;
  "x-polis"?: string;
  "accept-language"?: string;
  "Accept-Language"?: string;
};

export type DetectLanguageResult = {
  language: string;
  confidence: any;
};

export type Body = {
  [key: string]: any;
  agid?: any;
  xid?: string;
  uid?: number;
  polisApiKey?: any;
  ownerXid?: string;
  conversation_id?: string;
  x_profile_image_url?: any;
  x_name?: any;
  x_email?: any;
  answers?: any;
  suzinvite?: any;
  zid?: number;
  referrer?: any;
  parent_url?: any;
  password?: any;
  email?: any;
};

export type Query = { [x: string]: any };

export type AuthBody = Body & {
  x_profile_image_url?: any;
  x_name?: any;
  x_email?: any;
  agid?: any;
};

export type AuthQuery = {
  x_profile_image_url: any;
  x_name: any;
  x_email: any;
  agid: any;
};

export type ParticipantInfo = {
  parent_url?: string;
  referrer?: string;
};

export type PidReadyResult = {
  modOptions?: any;
  nextComment?: any;
  currentPid?: any;
  shouldMod?: any;
  auth?: {
    token: string;
    token_type: string;
    expires_in: number;
  };
};

export type CommentOptions = {
  currentPid?: any;
};

type ModerationState = -1 | 0 | 1;

export type GetCommentsParams = {
  zid: number;
  not_voted_by_pid?: number;
  withoutTids?: any;
  tid?: number;
  translations?: any;
  txt?: any;
  include_voting_patterns?: any;
  modIn?: boolean;
  pid?: number;
  tids?: any;
  random?: any;
  limit?: any;
  offset?: any;
  moderation?: any;
  strict_moderation?: any;
  mod?: ModerationState;
  mod_gt?: any;
  currentPid?: any;
  remaining?: number;
  total?: number;
};

export type ParticipantFields = {
  show_translation_activated?: any;
};

export type ParticipantCommentModerationResult = {
  nextComment?: any;
  currentPid?: any;
};

// Express-style Response interface
export type ExpressResponse = {
  redirect?: (url: string) => void;
  status?: (code: number) => ExpressResponse | { json: (data: any) => void };
  header?: (name: string, value: any) => void;
  set?: (headers: any) => void;
  json?: (data: any) => void;
  send?: (data: any) => void;
  _headers?: { [key: string]: any };
  [key: string]: any;
};

// Express-style Request interface
export type ExpressRequest = {
  path: string;
  body: Body;
  query?: Query;
  headers?: Headers;
  p?: { [key: string]: any };
  [key: string]: any;
};

// Consolidated UserInfo type that matches actual database schema and usage
export interface UserInfo {
  uid: number;
  email?: string;
  hname?: string;
  site_id?: number;
  created?: number;
  tut?: boolean;
  [key: string]: any;
}

// Consolidated ConversationInfo type that includes all properties used across the codebase
export interface ConversationInfo {
  zid: number;
  owner: number;
  org_id?: number;
  use_xid_whitelist?: boolean;
  is_active?: boolean;
  is_anon?: boolean;
  is_draft?: boolean;
  is_data_open?: boolean;
  profanity_filter?: boolean;
  spam_filter?: boolean;
  strict_moderation?: boolean;
  prioritize_seed?: boolean;
  topic?: string;
  description?: string;
  vis_type?: number;
  help_type?: number;
  bgcolor?: string | null;
  help_color?: string;
  help_bgcolor?: string;
  style_btn?: string;
  write_type?: number;
  importance_enabled?: boolean;
  owner_sees_participation_stats?: boolean;
  link_url?: string;
  context?: string;
  auth_opt_allow_3rdparty?: boolean;
  created?: number;
  modified?: number;
  [key: string]: any;
}

export interface XidRecord {
  created?: number;
  modified?: number;
  owner: number;
  pid?: number;
  uid: number;
  x_email?: string;
  x_name?: string;
  x_profile_image_url?: string;
  xid: string;
  zid?: number;
  vote_count?: number;
}

// TODO rename this to User after converting
// TODO User import in server.ts to camelCase
// TODO in standalone change
export type UserType = {
  email?: any;
  hname?: any;
  uid?: number;
  pid?: number;
  id?: any;
  screen_name?: any;
  name?: any;
  followers_count?: number;
  friends_count?: number;
  verified?: any;
  profile_image_url_https?: string;
  location?: any;
  context_id?: any;
  user_id?: any;
  user_image?: any;
  tool_consumer_instance_guid?: any;
  lis_person_contact_email_primary?: any;
  lis_person_name_full?: any;
};

// TODO rename this to Conversation after converting
// TODO User import in server.ts to camelCase
// TODO in standalone change
export type ConversationType = {
  is_active?: boolean;
  is_anon?: boolean;
  is_draft?: boolean;
  is_data_open?: boolean;
  profanity_filter?: boolean;
  spam_filter?: boolean;
  strict_moderation?: boolean;
  topic?: string;
  description?: string;
  vis_type?: number;
  help_type?: number;
  bgcolor?: string | null;
  help_color?: string;
  help_bgcolor?: string;
  style_btn?: string;
  write_type?: number;
  importance_enabled?: boolean;
  owner_sees_participation_stats?: boolean;
  link_url?: string;
  zid?: number;
  use_xid_whitelist?: boolean;
  xid_required?: boolean;
  uid?: number;
  context?: string;
  xid?: string;
  include_all_conversations_i_am_in?: boolean;
  limit?: number;
  parent_url?: string;
  auth_opt_allow_3rdparty?: boolean;
};

export type ParticipantOption = {
  bidToPid?: any;
  asPOJO?: any;
  "group-clusters": any;
  "base-clusters": any;
};

// Centralized request type for routes that use the 'p' parameter pattern
export interface RequestWithP extends Omit<ExpressRequest, "p"> {
  p: {
    // User and participant identifiers
    uid?: number;
    pid?: number;
    zid?: number;
    xid?: string;
    conversation_id?: string;

    // Authentication-related
    oidc_sub?: string;
    oidcUser?: any;
    jwt_conversation_mismatch?: boolean;
    jwt_conversation_id?: string;
    jwt_xid?: string;
    requested_conversation_id?: string;
    anonymous_participant?: boolean;
    xid_participant?: boolean;
    standard_user_participant?: boolean;

    // Participant info (added by middleware)
    participantInfo?: {
      uid: number;
      pid: number;
      isNewlyCreatedUser: boolean;
      isNewlyCreatedParticipant: boolean;
      needsNewJWT: boolean;
      token?: string;
      conversationId?: string;
    } | null;

    // Auth token (added by middleware)
    authToken?: {
      token: string;
      token_type: string;
      expires_in: number;
    };

    // Common request parameters
    parent_url?: string;
    referrer?: string;
    answers?: any;
    suzinvite?: string;

    // Action-specific parameters
    tid?: number;
    txt?: string;
    vote?: any;
    weight?: any;
    starred?: any;
    high_priority?: any;
    is_seed?: boolean;
    lang?: string;

    // Allow additional properties
    [key: string]: any;
  };

  // Headers with common fields
  headers: Headers;

  // HTTP method
  method: string;

  // Cookies (optional in Express)
  cookies?: {
    pc?: string;
    [key: string]: string | undefined;
  };
}
