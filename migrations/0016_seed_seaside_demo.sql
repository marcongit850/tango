-- Read-only public demo association. People, lots, and balances below are fictional.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0015_rename_display_name.sql. Deploy does not apply D1 migrations.
-- Safe to paste again: each insert is skipped when that id already exists.
-- This file does not read or update Tang-O-Mar rows.

INSERT INTO associations (
  id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone, created_at
)
SELECT
  'assoc_seaside_demo',
  'seaside-demo',
  'Seaside Demo HOA',
  'Seaside Demo Homeowners Association, Inc.',
  '18 Dune Lane',
  'Sample Harbor',
  'FL',
  '33021',
  'Sample County',
  'America/Chicago',
  '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM associations WHERE id = 'assoc_seaside_demo');

INSERT INTO users (id, email, name, phone, created_at)
SELECT 'user_demo_owner', 'riley.coast@example.com', 'Riley Coast', '850-555-2101', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'user_demo_owner');

INSERT INTO users (id, email, name, phone, created_at)
SELECT 'user_demo_admin', 'quinn.harbor@example.com', 'Quinn Harbor', '850-555-2102', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'user_demo_admin');

INSERT INTO users (id, email, name, phone, created_at)
SELECT 'user_demo_neighbor', 'alex.marsh@example.com', 'Alex Marsh', '850-555-2103', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'user_demo_neighbor');

INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, is_master, created_at)
SELECT 'mem_demo_owner', 'assoc_seaside_demo', 'user_demo_owner', 'homeowner', 'active', 0, 0, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE id = 'mem_demo_owner');

INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, is_master, created_at)
SELECT 'mem_demo_admin', 'assoc_seaside_demo', 'user_demo_admin', 'board', 'active', 1, 1, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE id = 'mem_demo_admin');

INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, is_master, created_at)
SELECT 'mem_demo_neighbor', 'assoc_seaside_demo', 'user_demo_neighbor', 'homeowner', 'active', 0, 0, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE id = 'mem_demo_neighbor');

INSERT INTO properties (
  id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type,
  house_name, mailing_street, mailing_city, mailing_state, mailing_postal_code, admin_notes, created_at
)
SELECT
  'prop_demo_4', 'assoc_seaside_demo', '4', '4 Dune Lane', 'Sample Harbor', 'FL', '33021', 'active', 'improved',
  'Harbor House', '', '', '', '', '', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM properties WHERE id = 'prop_demo_4');

INSERT INTO properties (
  id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type,
  house_name, mailing_street, mailing_city, mailing_state, mailing_postal_code, admin_notes, created_at
)
SELECT
  'prop_demo_12', 'assoc_seaside_demo', '12', '12 Dune Lane', 'Sample Harbor', 'FL', '33021', 'active', 'improved',
  'Coast Cottage', '500 Inland Road', 'Sample Harbor', 'FL', '33021', '', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM properties WHERE id = 'prop_demo_12');

INSERT INTO properties (
  id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type,
  house_name, mailing_street, mailing_city, mailing_state, mailing_postal_code, admin_notes, created_at
)
SELECT
  'prop_demo_21', 'assoc_seaside_demo', '21', '21 Dune Lane', 'Sample Harbor', 'FL', '33021', 'active', 'improved',
  'Marsh Lookout', '', '', '', '', 'Sample note: past due. Fictional.', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM properties WHERE id = 'prop_demo_21');

INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
SELECT 'own_demo_admin', 'assoc_seaside_demo', 'prop_demo_4', 'user_demo_admin', 1, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM property_owners WHERE id = 'own_demo_admin');

INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
SELECT 'own_demo_owner', 'assoc_seaside_demo', 'prop_demo_12', 'user_demo_owner', 1, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM property_owners WHERE id = 'own_demo_owner');

INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
SELECT 'own_demo_neighbor', 'assoc_seaside_demo', 'prop_demo_21', 'user_demo_neighbor', 1, '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM property_owners WHERE id = 'own_demo_neighbor');

INSERT INTO assessments (
  id, association_id, name, description, amount_cents, due_on, created_at, opens_on, lot_type
)
SELECT
  'assessment_demo_2026',
  'assoc_seaside_demo',
  '2026 annual assessment',
  'Sample yearly dues for Seaside Demo HOA.',
  90000,
  '2026-03-01',
  '2026-01-10T15:00:00Z',
  '2026-01-15',
  NULL
WHERE NOT EXISTS (SELECT 1 FROM assessments WHERE id = 'assessment_demo_2026');

INSERT INTO assessments (
  id, association_id, name, description, amount_cents, due_on, created_at, opens_on, lot_type
)
SELECT
  'assessment_demo_2027',
  'assoc_seaside_demo',
  '2027 annual assessment',
  'Sample dues for the coming year. Not invoiced yet.',
  95000,
  '2027-03-01',
  '2026-10-01T15:00:00Z',
  '2027-01-15',
  NULL
WHERE NOT EXISTS (SELECT 1 FROM assessments WHERE id = 'assessment_demo_2027');

INSERT INTO invoices (
  id, association_id, property_id, assessment_id, invoice_number, description,
  amount_cents, late_fee_cents, issued_on, due_on, status, created_at
)
SELECT
  'invoice_demo_quinn', 'assoc_seaside_demo', 'prop_demo_4', 'assessment_demo_2026',
  '2026-4-ANNUAL', '2026 annual assessment', 90000, 0, '2026-01-15', '2026-03-01', 'paid', '2026-01-15T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE id = 'invoice_demo_quinn');

INSERT INTO invoices (
  id, association_id, property_id, assessment_id, invoice_number, description,
  amount_cents, late_fee_cents, issued_on, due_on, status, created_at
)
SELECT
  'invoice_demo_riley', 'assoc_seaside_demo', 'prop_demo_12', 'assessment_demo_2026',
  '2026-12-ANNUAL', '2026 annual assessment', 90000, 0, '2026-01-15', '2026-03-01', 'partial', '2026-01-15T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE id = 'invoice_demo_riley');

INSERT INTO invoices (
  id, association_id, property_id, assessment_id, invoice_number, description,
  amount_cents, late_fee_cents, issued_on, due_on, status, created_at
)
SELECT
  'invoice_demo_alex', 'assoc_seaside_demo', 'prop_demo_21', 'assessment_demo_2026',
  '2026-21-ANNUAL', '2026 annual assessment', 90000, 2500, '2026-01-15', '2026-03-01', 'open', '2026-01-15T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE id = 'invoice_demo_alex');

INSERT INTO payments (
  id, association_id, property_id, invoice_id, amount_cents, method, reference,
  paid_on, notes, recorded_by_user_id, created_at
)
SELECT
  'payment_demo_quinn', 'assoc_seaside_demo', 'prop_demo_4', 'invoice_demo_quinn',
  90000, 'check', '2201', '2026-02-12', 'Sample check. Fictional.', 'user_demo_admin', '2026-02-12T18:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM payments WHERE id = 'payment_demo_quinn');

INSERT INTO payments (
  id, association_id, property_id, invoice_id, amount_cents, method, reference,
  paid_on, notes, recorded_by_user_id, created_at
)
SELECT
  'payment_demo_riley', 'assoc_seaside_demo', 'prop_demo_12', 'invoice_demo_riley',
  60000, 'check', '2202', '2026-02-18', 'Sample partial payment. Fictional.', 'user_demo_admin', '2026-02-18T18:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM payments WHERE id = 'payment_demo_riley');

INSERT INTO documents (
  id, association_id, category, title, visibility, current_version_id, folder, document_date, created_at
)
SELECT
  'doc_demo_covenants', 'assoc_seaside_demo', 'covenants', 'Seaside Demo covenants (sample)',
  'residents', 'docver_demo_covenants_1', '', '', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM documents WHERE id = 'doc_demo_covenants');

INSERT INTO documents (
  id, association_id, category, title, visibility, current_version_id, folder, document_date, created_at
)
SELECT
  'doc_demo_budget', 'assoc_seaside_demo', 'budgets', '2026 budget (sample)',
  'board', 'docver_demo_budget_1', '2026', '2026-01-10', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM documents WHERE id = 'doc_demo_budget');

INSERT INTO documents (
  id, association_id, category, title, visibility, current_version_id, folder, document_date, created_at
)
SELECT
  'doc_demo_minutes', 'assoc_seaside_demo', 'minutes', 'October 2026 meeting minutes (sample)',
  'residents', 'docver_demo_minutes_1', '2026', '2026-10-02', '2026-10-02T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM documents WHERE id = 'doc_demo_minutes');

INSERT INTO document_versions (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
)
SELECT
  'docver_demo_covenants_1', 'assoc_seaside_demo', 'doc_demo_covenants', 1,
  'seed/seaside-demo/covenants.txt', 'seaside-demo-covenants-sample.txt', 'text/plain; charset=utf-8',
  0, 'Sample placeholder for the read-only demo.', 'user_demo_admin', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM document_versions WHERE id = 'docver_demo_covenants_1');

INSERT INTO document_versions (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
)
SELECT
  'docver_demo_budget_1', 'assoc_seaside_demo', 'doc_demo_budget', 1,
  'seed/seaside-demo/budget-2026.txt', 'seaside-demo-2026-budget-sample.txt', 'text/plain; charset=utf-8',
  0, 'Board-only sample. Owners do not see this file.', 'user_demo_admin', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM document_versions WHERE id = 'docver_demo_budget_1');

INSERT INTO document_versions (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
)
SELECT
  'docver_demo_minutes_1', 'assoc_seaside_demo', 'doc_demo_minutes', 1,
  'seed/seaside-demo/minutes-2026-10.txt', 'seaside-demo-minutes-2026-10-sample.txt', 'text/plain; charset=utf-8',
  0, 'Sample minutes for the read-only demo.', 'user_demo_admin', '2026-10-02T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM document_versions WHERE id = 'docver_demo_minutes_1');

INSERT INTO announcements (
  id, association_id, kind, title, body, pinned, published_at, expires_at, created_by_user_id, created_at
)
SELECT
  'ann_demo_pool', 'assoc_seaside_demo', 'news', 'Sample pool hours',
  'The sample pool is open from 8:00 a.m. to 8:00 p.m. through October. This announcement is fictional.',
  1, '2026-10-01T15:00:00Z', NULL, 'user_demo_admin', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE id = 'ann_demo_pool');

INSERT INTO announcements (
  id, association_id, kind, title, body, pinned, published_at, expires_at, created_by_user_id, created_at
)
SELECT
  'ann_demo_storm', 'assoc_seaside_demo', 'emergency', 'Sample storm watch',
  'Sample storm watch for Seaside Demo HOA. Stay off the sample dock until the board posts an all clear. This is fictional.',
  1, '2026-10-05T13:00:00Z', '2027-06-01T23:00:00Z', 'user_demo_admin', '2026-10-05T13:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE id = 'ann_demo_storm');

INSERT INTO announcements (
  id, association_id, kind, title, body, pinned, published_at, expires_at, created_by_user_id, created_at
)
SELECT
  'ann_demo_meeting', 'assoc_seaside_demo', 'meeting', 'Sample annual meeting',
  'The sample annual meeting is Thursday, November 12, 2026 at 6:00 p.m. Central Time at the Seaside Demo clubhouse, 18 Dune Lane, Sample Harbor.',
  0, '2026-10-03T15:00:00Z', NULL, 'user_demo_admin', '2026-10-03T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE id = 'ann_demo_meeting');

INSERT INTO events (
  id, association_id, title, description, location, starts_at, ends_at, kind, created_by_user_id, created_at
)
SELECT
  'event_demo_meeting', 'assoc_seaside_demo', 'Sample annual meeting',
  'Budget review for the fictional association. This portal does not collect proxies.',
  'Seaside Demo clubhouse, 18 Dune Lane, Sample Harbor',
  '2026-11-12T23:00:00Z', '2026-11-13T00:30:00Z', 'meeting', 'user_demo_admin', '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = 'event_demo_meeting');

INSERT INTO faqs (id, association_id, question, answer, sort_order)
SELECT
  'faq_demo_pay', 'assoc_seaside_demo', 'Where do I pay dues?',
  'Online card and ACH payments are not part of this demo. Mail a check to Seaside Demo HOA, 18 Dune Lane, Sample Harbor, FL 33021. Nothing is charged from this read-only demo.',
  1
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE id = 'faq_demo_pay');

INSERT INTO faqs (id, association_id, question, answer, sort_order)
SELECT
  'faq_demo_docs', 'assoc_seaside_demo', 'Where are the covenants?',
  'Open Documents and download the current sample covenants file. The file shipped with this demo is a placeholder.',
  2
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE id = 'faq_demo_docs');

INSERT INTO faqs (id, association_id, question, answer, sort_order)
SELECT
  'faq_demo_balance', 'assoc_seaside_demo', 'Who can see my balance?',
  'You can see the lots linked to this sample login. Other sample residents cannot. People with admin access in this demo can see ledgers for Seaside Demo HOA only.',
  3
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE id = 'faq_demo_balance');

INSERT INTO board_contacts (id, association_id, name, role_title, email, phone, sort_order, visible)
SELECT 'contact_demo_president', 'assoc_seaside_demo', 'Quinn Harbor', 'President', 'quinn.harbor@example.com', '850-555-2102', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM board_contacts WHERE id = 'contact_demo_president');

INSERT INTO board_contacts (id, association_id, name, role_title, email, phone, sort_order, visible)
SELECT 'contact_demo_treasurer', 'assoc_seaside_demo', 'Dana Blake', 'Treasurer', 'treasurer@example.com', '850-555-2110', 2, 1
WHERE NOT EXISTS (SELECT 1 FROM board_contacts WHERE id = 'contact_demo_treasurer');

INSERT INTO board_contacts (id, association_id, name, role_title, email, phone, sort_order, visible)
SELECT 'contact_demo_secretary', 'assoc_seaside_demo', 'Chris Okonkwo', 'Secretary', 'secretary@example.com', '850-555-2111', 3, 1
WHERE NOT EXISTS (SELECT 1 FROM board_contacts WHERE id = 'contact_demo_secretary');

INSERT INTO messages (
  id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at
)
SELECT
  'msg_demo_alex', 'assoc_seaside_demo', 'msg_demo_alex', NULL, 'user_demo_neighbor', 'prop_demo_21',
  'Dock lights', 'The sample dock lights were out on Tuesday night. This message is fictional.',
  '2026-10-04T18:30:00Z'
WHERE NOT EXISTS (SELECT 1 FROM messages WHERE id = 'msg_demo_alex');

INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
SELECT
  'note_demo_riley', 'assoc_seaside_demo', 'user_demo_owner', 'account', 'Sample balance notice',
  'Your sample ledger shows a remaining balance on the 2026 annual assessment. This notice is fictional.',
  '/a/seaside-demo/invoices', '2026-09-15T14:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE id = 'note_demo_riley');

INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
SELECT
  'note_demo_quinn', 'assoc_seaside_demo', 'user_demo_admin', 'message', 'New message from Alex Marsh',
  'Dock lights', '/a/seaside-demo/messages/msg_demo_alex', '2026-10-04T18:30:00Z'
WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE id = 'note_demo_quinn');

INSERT INTO join_requests (id, association_id, name, email, address, note, status, created_at, property_id)
SELECT
  'join_demo_sam', 'assoc_seaside_demo', 'Sam Ellis', 'sam.ellis@example.com', '8 Dune Lane',
  'Sample request to join. Fictional.', 'pending', '2026-10-06T15:00:00Z', ''
WHERE NOT EXISTS (SELECT 1 FROM join_requests WHERE id = 'join_demo_sam');

INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at)
SELECT
  'audit_demo_seed', 'assoc_seaside_demo', NULL, 'seed', 'association', 'assoc_seaside_demo',
  'Loaded the Seaside Demo HOA sample roster, ledger, and neighborhood content.',
  '2026-10-01T15:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE id = 'audit_demo_seed');
