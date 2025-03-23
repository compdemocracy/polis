import { any } from "underscore";

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
  xid?: any;
  uid?: any;
};

export type Query = { [x: string]: any };

export type AuthBody = {
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

export type AuthRequest = {
  body: AuthBody;
  query?: AuthQuery;
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
  zid: any;
  not_voted_by_pid: any;
  include_social?: any;
  withoutTids: any;
  tid?: any;
  translations?: any;
  txt?: any;
  include_voting_patterns: any;
  modIn: boolean;
  pid: any;
  tids: any;
  random: any;
  limit: any;
  moderation: any;
  strict_moderation: any;
  mod: ModerationState;
  mod_gt: any;
};

export type ParticipantFields = {
  show_translation_activated?: any;
};

export type ParticipantCommentModerationResult = {
  nextComment?: any;
  currentPid?: any;
};

// TODO rename this to User after converting
// TODO User import in server.ts to camelCase
// TODO in standalone change
export type UserType = {
  email?: any;
  hname?: any;
  uid?: any;
  pid?: any;
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
  is_active?: any;
  is_anon?: any;
  is_draft?: any;
  is_data_open?: any;
  profanity_filter?: any;
  spam_filter?: any;
  strict_moderation?: any;
  topic?: any;
  description?: any;
  vis_type?: any;
  help_type?: any;
  socialbtn_type?: any;
  bgcolor?: any;
  help_color?: any;
  help_bgcolor?: any;
  style_btn?: any;
  write_type?: any;
  importance_enabled?: any;
  owner_sees_participation_stats?: any;
  link_url?: any;
  course_invite?: any;
  course_id?: any;
  zid?: any;
  uid?: any;
  context?: any;
  xid?: any;
  include_all_conversations_i_am_in?: any;
  want_mod_url?: any;
  want_upvoted?: any;
  want_inbox_item_admin_url?: any;
  want_inbox_item_participant_url?: any;
  want_inbox_item_admin_html?: any;
  want_inbox_item_participant_html?: any;
  limit?: any;
};

export type ParticipantOption = {
  bidToPid?: any;
  asPOJO?: any;
  "group-clusters": any;
  "base-clusters": any;
};

export type Vote = {
  uid?: any;
  zid: any;
  pid: any;
  lang: any;
  tid: any;
  xid: any;
  vote: any;
  weight: any;
  starred: any;
  parent_url: any;
  high_priority: any;
};
