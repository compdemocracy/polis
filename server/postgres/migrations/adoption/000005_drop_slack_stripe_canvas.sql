-- Catalog postconditions only; this file never replays migration DDL.
SELECT to_regclass('public.slack_oauth_access_tokens') IS NULL
 AND to_regclass('public.slack_users') IS NULL
 AND to_regclass('public.slack_user_invites') IS NULL
 AND to_regclass('public.slack_bot_events') IS NULL
 AND to_regclass('public.stripe_accounts') IS NULL
 AND to_regclass('public.stripe_subscriptions') IS NULL
 AND to_regclass('public.coupons_for_free_upgrades') IS NULL
 AND to_regclass('public.lti_users') IS NULL
 AND to_regclass('public.lti_context_memberships') IS NULL
 AND to_regclass('public.canvas_assignment_callback_info') IS NULL
 AND to_regclass('public.canvas_assignment_conversation_info') IS NULL
 AND to_regclass('public.lti_oauthv1_credentials') IS NULL
 AND pg_temp.absent_column('conversations','is_slack')
 AND pg_temp.absent_column('conversations','lti_users_only')
 AND pg_temp.absent_column('users','plan');
