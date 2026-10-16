-- Invoice emails. Each owner is emailed their invoice on the date it is scheduled to go out.
-- The switch is off until a board admin turns it on. Invoices issued before that date are not emailed.
-- A sent invoice is recorded so the daily job does not send it again. A failed send is left unmarked and retries the next day.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0023_late_fees.sql.
-- Deploy does not apply this file. Until it is applied, invoice emails stay off.
-- If the console says invoice_emails_migration already exists, this file was already applied. Stop.

CREATE TABLE invoice_emails_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO invoice_emails_migration (id) VALUES (1);

-- enabled_on is the association-local date the switch was last turned on.
-- Only invoices with issued_on on or after that date are emailed.
CREATE TABLE invoice_email_settings (
  association_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enabled_on TEXT,
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

-- Set when every current owner linked to the invoice has been emailed.
ALTER TABLE invoices ADD COLUMN emailed_at TEXT;

-- One row per owner who was emailed this invoice. A retry skips owners already listed.
CREATE TABLE invoice_email_events (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE (invoice_id, user_id),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX invoice_email_events_association ON invoice_email_events (association_id, invoice_id);
