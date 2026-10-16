-- Manual resend of one invoice email from the admin invoice page.
-- This does not change invoices.emailed_at. The daily job still emails an invoice on its issue date.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0024_invoice_emails.sql.
-- Deploy does not apply this file. Until it is applied, the Email this invoice button does not send.
-- If the console says invoice_resend_migration already exists, this file was already applied. Stop.

CREATE TABLE invoice_resend_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO invoice_resend_migration (id) VALUES (1);

-- One row each time an admin emails an invoice that already exists.
-- actor_name is the person who clicked, kept if that account is later removed.
-- recipient_count is how many owners the email went to.
CREATE TABLE invoice_resends (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK (recipient_count >= 1),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX invoice_resends_invoice ON invoice_resends (association_id, invoice_id, sent_at);
