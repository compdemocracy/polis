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
};

export type CommentOptions = {
  currentPid?: any;
};

type ModerationState = -1 | 0 | 1;

export type CommentType = {
  zid: number;
  not_voted_by_pid?: number;
  include_social?: any;
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
  socialbtn_type?: number;
  bgcolor?: string | null;
  help_color?: string;
  help_bgcolor?: string;
  style_btn?: string;
  write_type?: number;
  importance_enabled?: boolean;
  owner_sees_participation_stats?: boolean;
  link_url?: string;
  course_invite?: string;
  course_id?: string;
  context?: string;
  auth_opt_allow_3rdparty?: boolean;
  created?: number;
  modified?: number;
  [key: string]: any;
}

// XidInfo type for external ID records
export interface XidInfo {
  uid: number;
  owner: number;
  xid: string;
  x_profile_image_url?: string;
  x_name?: string;
  x_email?: string;
  created?: number;
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
  socialbtn_type?: number;
  bgcolor?: string | null;
  help_color?: string;
  help_bgcolor?: string;
  style_btn?: string;
  write_type?: number;
  importance_enabled?: boolean;
  owner_sees_participation_stats?: boolean;
  link_url?: string;
  course_invite?: string;
  course_id?: string;
  zid?: number;
  uid?: number;
  context?: string;
  xid?: string;
  include_all_conversations_i_am_in?: boolean;
  want_mod_url?: boolean;
  want_upvoted?: boolean;
  want_inbox_item_admin_url?: boolean;
  want_inbox_item_participant_url?: boolean;
  want_inbox_item_admin_html?: boolean;
  want_inbox_item_participant_html?: boolean;
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

export type Vote = {
  uid?: number;
  zid: number;
  pid: number;
  lang: any;
  tid: number;
  xid: string;
  vote: any;
  weight: any;
  starred: any;
  parent_url: any;
  high_priority: any;
};
