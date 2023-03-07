DROP TABLE IF EXISTS slack_oauth_access_tokens CASCADE;
DROP TABLE IF EXISTS slack_users CASCADE;
DROP TABLE IF EXISTS slack_user_invites CASCADE;
DROP TABLE IF EXISTS slack_bot_events CASCADE;

DROP TABLE IF EXISTS stripe_accounts CASCADE;
DROP TABLE IF EXISTS stripe_subscriptions CASCADE;
DROP TABLE IF EXISTS coupons_for_free_upgrades CASCADE;

DROP TABLE IF EXISTS lti_users CASCADE;
DROP TABLE IF EXISTS lti_context_memberships CASCADE;
DROP TABLE IF EXISTS canvas_assignment_callback_info CASCADE;
DROP TABLE IF EXISTS canvas_assignment_conversation_info CASCADE;
DROP TABLE IF EXISTS lti_oauthv1_credentials CASCADE;

ALTER TABLE conversations DROP COLUMN IF EXISTS is_slack CASCADE;
ALTER TABLE conversations DROP COLUMN IF EXISTS lti_users_only CASCADE;

ALTER TABLE users DROP COLUMN IF EXISTS plan CASCADE;
