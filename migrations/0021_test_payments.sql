-- Test-mode Stripe payments are stored so the board can see them.
-- They do not change invoice status or lot balances.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0020_payment_controls.sql.
-- Deploy does not apply this file. Until it is applied, a test-mode webhook is not recorded and does not mark an invoice paid.
-- If the console says test_payments_migration already exists, this file was already applied. Stop.

CREATE TABLE test_payments_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO test_payments_migration (id) VALUES (1);

ALTER TABLE payments ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));
