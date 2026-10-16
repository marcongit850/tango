-- Mailed check details and an optional board note for invoice emails.
-- This does not send email and it does not change invoice amounts.
-- Dashboard steps: Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0026_invoice_resend_recipients.sql.
-- Deploy does not apply this file. Until it is applied, invoice emails leave out the check box and the board note.
-- If the console says invoice_mail_migration already exists, this file was already applied. Stop.

CREATE TABLE invoice_mail_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO invoice_mail_migration (id) VALUES (1);

-- payable_to is blank until an admin types one. A blank value uses the association name on the email.
-- mailing_address is one line per row, at most 5. A blank address hides the check box.
-- board_note is optional. A blank note is left off the email.
CREATE TABLE invoice_mail_settings (
  association_id TEXT PRIMARY KEY,
  payable_to TEXT NOT NULL DEFAULT '',
  mailing_address TEXT NOT NULL DEFAULT '',
  board_note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

-- Sample check details for the public demo only. No other association is changed.
INSERT INTO invoice_mail_settings (association_id, payable_to, mailing_address, board_note)
SELECT
  'assoc_seaside_demo',
  'Seaside Demo HOA',
  'Seaside Demo HOA
Attn: Treasurer
PO Box 123
Sample Harbor, FL 32550',
  'Thank you. Paying by the due date helps the board keep this sample neighborhood running.'
WHERE NOT EXISTS (SELECT 1 FROM invoice_mail_settings WHERE association_id = 'assoc_seaside_demo');
