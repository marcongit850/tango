-- Document date, used to file Meeting Minutes, Budgets, and Insurance into a year folder.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0009_master_admin.sql. Details are in the README under Document date.
-- If the console says a column already exists, this file was already applied. Stop. Do not paste it again.

ALTER TABLE documents ADD COLUMN document_date TEXT NOT NULL DEFAULT '';
