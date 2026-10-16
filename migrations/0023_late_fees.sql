-- Automatic late fees, configured per association.
-- Default is off. This file does not change settings for any association except the demo.
-- Seaside Demo HOA (assoc_seaside_demo) is turned on with sample settings so the demo page can show them.
-- Existing invoice late fees, including a fee an admin already typed, are not changed.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0022_bank_transfer_fee.sql.
-- Deploy does not apply this file. Until it is applied, late fees stay a manual amount on each invoice and the daily job adds none.
-- If the console says late_fees_migration already exists, this file was already applied. Stop.

CREATE TABLE late_fees_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO late_fees_migration (id) VALUES (1);

-- One row per association. No row means late fees are off.
-- fee_type flat uses flat_cents. fee_type percent uses percent_bps (500 is 5.00%).
-- count_from issued_on is the invoice date. count_from due_on is the due date.
CREATE TABLE late_fee_settings (
  association_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  fee_type TEXT NOT NULL DEFAULT 'flat' CHECK (fee_type IN ('flat', 'percent')),
  flat_cents INTEGER NOT NULL DEFAULT 0 CHECK (flat_cents >= 0 AND flat_cents <= 10000000),
  percent_bps INTEGER NOT NULL DEFAULT 0 CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  days_to_wait INTEGER NOT NULL DEFAULT 15 CHECK (days_to_wait >= 1 AND days_to_wait <= 365),
  count_from TEXT NOT NULL DEFAULT 'due_on' CHECK (count_from IN ('issued_on', 'due_on')),
  updated_at TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users (id)
);

-- late_fee_applied_at is set when the daily job adds the fee. A later run will not add it again.
-- late_fee_waived_at is set when an admin waives the fee. The job will not add it again.
-- A late_fee_cents value already stored, with both of these still empty, is a manual fee and is left alone.
ALTER TABLE invoices ADD COLUMN late_fee_applied_at TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_waived_at TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_waived_by_user_id TEXT;

-- Sample settings for the public demo only. Other associations are not inserted and stay off.
INSERT INTO late_fee_settings (
  association_id, enabled, fee_type, flat_cents, percent_bps, days_to_wait, count_from, updated_at, updated_by_user_id
)
SELECT
  'assoc_seaside_demo', 1, 'flat', 2500, 500, 15, 'due_on', '2026-10-16T12:00:00.000Z', NULL
WHERE EXISTS (SELECT 1 FROM associations WHERE id = 'assoc_seaside_demo')
  AND NOT EXISTS (SELECT 1 FROM late_fee_settings WHERE association_id = 'assoc_seaside_demo');
