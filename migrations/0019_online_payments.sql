-- Online dues payments. Stripe secret keys are stored only as ciphertext.
-- The Worker secret PAYMENT_ENCRYPTION_KEY decrypts them. This file has no key values.
-- Card numbers are not stored. Card fees (about 2.9% + 30 cents) stay absorbed by the association.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0018_fee_schedule.sql. Details are in the README under Online payments.
-- If the console says online_payments_migration already exists, this file was already applied. Stop. Do not paste it again.
-- If a previous paste stopped halfway and payments_next exists while payments still exists:
--   DROP TABLE payments_next; DROP TABLE online_payments_migration;
--   then paste this file again. Do not drop payments.

CREATE TABLE online_payments_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO online_payments_migration (id) VALUES (1);

CREATE TABLE payments_next (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  invoice_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('check', 'cash', 'ach_recorded', 'other', 'stripe')),
  reference TEXT NOT NULL DEFAULT '',
  paid_on TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  FOREIGN KEY (recorded_by_user_id) REFERENCES users (id)
);

INSERT INTO payments_next (
  id, association_id, property_id, invoice_id, amount_cents, method, reference,
  paid_on, notes, recorded_by_user_id, created_at
)
SELECT
  id, association_id, property_id, invoice_id, amount_cents, method, reference,
  paid_on, notes, recorded_by_user_id, created_at
FROM payments;

DROP TABLE payments;

ALTER TABLE payments_next RENAME TO payments;

CREATE TABLE payment_settings (
  association_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  secret_key_ciphertext TEXT NOT NULL DEFAULT '',
  secret_key_last4 TEXT NOT NULL DEFAULT '',
  secret_key_mode TEXT NOT NULL DEFAULT '' CHECK (secret_key_mode IN ('', 'test', 'live')),
  webhook_secret_ciphertext TEXT NOT NULL DEFAULT '',
  webhook_secret_last4 TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users (id)
);

-- One row per Stripe event, and one row per Stripe payment, so retries do not double-post the ledger.
CREATE TABLE stripe_event_receipts (
  association_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  stripe_payment_id TEXT NOT NULL,
  receipt_emailed INTEGER NOT NULL DEFAULT 0 CHECK (receipt_emailed IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (association_id, event_id),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE UNIQUE INDEX stripe_event_payment ON stripe_event_receipts (association_id, stripe_payment_id);

-- Checkout links expire. This row is not a card and not a Stripe secret.
CREATE TABLE checkout_intents (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  allocation_json TEXT NOT NULL,
  lot_numbers TEXT NOT NULL DEFAULT '',
  stripe_session_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);
