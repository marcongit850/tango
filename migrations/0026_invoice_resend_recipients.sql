-- One row per owner a manual invoice resend reached, so Email history can list those addresses.
-- This does not change invoices.emailed_at and it does not send email.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0025_invoice_resend.sql.
-- Deploy does not apply this file. Until it is applied, Email history shows how many owners a resend reached.
-- If the console says invoice_resend_recipients_migration already exists, this file was already applied. Stop.

CREATE TABLE invoice_resend_recipients_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO invoice_resend_recipients_migration (id) VALUES (1);

-- email is the address used at send time, kept if that account is later removed.
CREATE TABLE invoice_resend_recipients (
  id TEXT PRIMARY KEY,
  resend_id TEXT NOT NULL,
  association_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL,
  FOREIGN KEY (resend_id) REFERENCES invoice_resends (id) ON DELETE CASCADE,
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX invoice_resend_recipients_resend ON invoice_resend_recipients (resend_id);
