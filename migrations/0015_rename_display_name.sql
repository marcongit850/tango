-- Rename the stored community display name from Tango Mar to Tang-O-Mar.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0014_email_preferences.sql. Deploy does not apply D1 migrations.
-- Slug, email addresses, file names, and object keys stay as they are.
-- Safe to paste again: it only rewrites the old display phrases.

UPDATE associations
SET
  name = REPLACE(REPLACE(name, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  legal_name = REPLACE(REPLACE(legal_name, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar';

UPDATE assessments
SET
  name = REPLACE(REPLACE(name, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  description = REPLACE(REPLACE(description, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE invoices
SET description = REPLACE(REPLACE(description, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE payments
SET notes = REPLACE(REPLACE(notes, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE documents
SET title = REPLACE(REPLACE(title, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE document_versions
SET notes = REPLACE(REPLACE(notes, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE announcements
SET
  title = REPLACE(REPLACE(title, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  body = REPLACE(REPLACE(body, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE events
SET
  title = REPLACE(REPLACE(title, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  description = REPLACE(REPLACE(description, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  location = REPLACE(REPLACE(location, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE faqs
SET
  question = REPLACE(REPLACE(question, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  answer = REPLACE(REPLACE(answer, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE messages
SET
  subject = REPLACE(REPLACE(subject, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  body = REPLACE(REPLACE(body, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE notifications
SET
  title = REPLACE(REPLACE(title, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  body = REPLACE(REPLACE(body, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE audit_log
SET detail = REPLACE(REPLACE(detail, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE join_requests
SET
  address = REPLACE(REPLACE(address, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  note = REPLACE(REPLACE(note, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE properties
SET
  house_name = REPLACE(REPLACE(house_name, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar'),
  admin_notes = REPLACE(REPLACE(admin_notes, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');

UPDATE board_contacts
SET role_title = REPLACE(REPLACE(role_title, 'TANGO MAR', 'TANG-O-MAR'), 'Tango Mar', 'Tang-O-Mar')
WHERE association_id IN (SELECT id FROM associations WHERE slug = 'tango-mar' OR id = 'assoc_tango_mar');
