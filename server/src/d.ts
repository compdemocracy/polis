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
  stripeCustomerId?: any;
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
  owner_sees_participation_stats?: any;
  lti_users_only?: any;
  link_url?: any;
};

export type TwitterParameters = {
  [key: string]: any;
  user_id?: any;
  screen_name?: any;
};

export type ParticipantSocialNetworkInfo = {
  [key: string]: any;
  facebook?: any;
  twitter?: any;
};
