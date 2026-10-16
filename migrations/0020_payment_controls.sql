-- Payment controls after online dues payments.
-- Refunds and disputes, and an append-only activity log.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0019_online_payments.sql.
-- Deploy does not apply this file. Until it is applied, balances ignore refunds and the activity log can still be edited in D1.
-- If the console says payment_controls_migration already exists, this file was already applied. Stop.

CREATE TABLE payment_controls_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO payment_controls_migration (id) VALUES (1);

-- A refund or an open or lost dispute reduces what the lot has paid.
-- status won means a dispute the association won, and that row no longer reduces the balance.
CREATE TABLE payment_reversals (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  payment_id TEXT,
  property_id TEXT NOT NULL,
  invoice_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'dispute')),
  status TEXT NOT NULL CHECK (status IN ('refunded', 'open', 'lost', 'won')),
  stripe_payment_id TEXT NOT NULL,
  stripe_object_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (payment_id) REFERENCES payments (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id)
);

CREATE INDEX payment_reversals_invoice ON payment_reversals (association_id, invoice_id, status);
CREATE INDEX payment_reversals_stripe ON payment_reversals (association_id, stripe_payment_id, kind);

-- One row per Stripe refund or dispute event so retries do not double-post.
CREATE TABLE stripe_adjustment_events (
  association_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  stripe_payment_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (association_id, event_id),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

-- Activity rows stay. The app may clear actor_user_id when an account is deleted.
-- It may not change the action, the detail, or the time, and it may not delete a row.
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE OF id, association_id, action, entity_type, entity_id, detail, created_at ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
