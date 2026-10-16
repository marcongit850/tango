-- Bank transfer processing fee for online ACH payments.
-- Homeowners who pay online cover it. A mailed check stays fee-free.
-- The fee is stored on the checkout and the payment. It is not applied to invoices or balances.
-- Checkout status tracks a bank transfer that is still settling. A failed transfer applies nothing.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0021_test_payments.sql.
-- Deploy does not apply this file. Until it is applied, online payments do not add a processing fee and cannot record a processing, failed, or abandoned bank transfer.
-- If the console says bank_transfer_fee_migration already exists, this file was already applied. Stop.

CREATE TABLE bank_transfer_fee_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO bank_transfer_fee_migration (id) VALUES (1);

-- 80 is 0.80 percent, at most 1000 (10%). 500 is a $5.00 cap, at most 2500 ($25.00). The fee starts on.
-- Status abandoned is a stuck transfer the board cleared. It does not credit an invoice.
ALTER TABLE payment_settings ADD COLUMN processing_fee_enabled INTEGER NOT NULL DEFAULT 1 CHECK (processing_fee_enabled IN (0, 1));
ALTER TABLE payment_settings ADD COLUMN processing_fee_bps INTEGER NOT NULL DEFAULT 80 CHECK (processing_fee_bps >= 0 AND processing_fee_bps <= 1000);
ALTER TABLE payment_settings ADD COLUMN processing_fee_cap_cents INTEGER NOT NULL DEFAULT 500 CHECK (processing_fee_cap_cents >= 0 AND processing_fee_cap_cents <= 2500);

ALTER TABLE checkout_intents ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0 AND fee_cents <= 2500);
ALTER TABLE checkout_intents ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'succeeded', 'failed', 'abandoned'));
ALTER TABLE payments ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0 AND fee_cents <= 2500);
