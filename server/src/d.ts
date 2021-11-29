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
