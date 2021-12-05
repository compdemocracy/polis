ALTER TABLE users DROP COLUMN plan CASCADE;

DROP TABLE stripe_accounts CASCADE;
DROP TABLE stripe_subscriptions CASCADE;
DROP TABLE coupons_for_free_upgrades CASCADE;
