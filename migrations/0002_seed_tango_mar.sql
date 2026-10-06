-- Demo association: Tango Mar, a beach neighborhood in Miramar Beach, Walton County, Florida.
-- People below are fictional. Lot labels are examples, not a statement about who owns a house.
-- Association mailing address is the published principal address of the Tang-O-Mar POA.

INSERT INTO associations (
  id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone, created_at
) VALUES (
  'assoc_tango_mar',
  'tango-mar',
  'Tango Mar',
  'Tango Mar Property Owners Association',
  '31 Tang O Mar Drive',
  'Miramar Beach',
  'FL',
  '32550',
  'Walton County',
  'America/Chicago',
  '2026-10-01T15:00:00Z'
);

INSERT INTO users (id, email, name, phone, created_at) VALUES
  ('user_jordan', 'jordan.lee@example.com', 'Jordan Lee', '850-555-0101', '2026-10-01T15:00:00Z'),
  ('user_sam', 'sam.rivera@example.com', 'Sam Rivera', '850-555-0102', '2026-10-01T15:00:00Z'),
  ('user_casey', 'casey.nguyen@example.com', 'Casey Nguyen', '850-555-0142', '2026-10-01T15:00:00Z');

INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at) VALUES
  ('mem_jordan', 'assoc_tango_mar', 'user_jordan', 'officer', 'active', '2026-10-01T15:00:00Z'),
  ('mem_sam', 'assoc_tango_mar', 'user_sam', 'homeowner', 'active', '2026-10-01T15:00:00Z'),
  ('mem_casey', 'assoc_tango_mar', 'user_casey', 'homeowner', 'active', '2026-10-01T15:00:00Z');

INSERT INTO properties (
  id, association_id, lot_number, street_address, city, state, postal_code, status, created_at
) VALUES
  ('prop_3', 'assoc_tango_mar', '3', 'Lot 3, Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', '2026-10-01T15:00:00Z'),
  ('prop_14', 'assoc_tango_mar', '14', 'Lot 14, Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', '2026-10-01T15:00:00Z'),
  ('prop_27', 'assoc_tango_mar', '27', 'Lot 27, Tang O Mar Drive', 'Miramar Beach', 'FL', '32550', 'active', '2026-10-01T15:00:00Z');

INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at) VALUES
  ('own_jordan', 'assoc_tango_mar', 'prop_3', 'user_jordan', 1, '2026-10-01T15:00:00Z'),
  ('own_sam', 'assoc_tango_mar', 'prop_14', 'user_sam', 1, '2026-10-01T15:00:00Z'),
  ('own_casey', 'assoc_tango_mar', 'prop_27', 'user_casey', 1, '2026-10-01T15:00:00Z');

INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, created_at) VALUES
  (
    'assessment_2026_annual',
    'assoc_tango_mar',
    '2026 annual assessment',
    'Yearly dues for Tango Mar operating costs.',
    120000,
    '2026-03-01',
    '2026-01-10T15:00:00Z'
  ),
  (
    'assessment_2026_walkway',
    'assoc_tango_mar',
    '2026 fall walkway maintenance',
    'Rinse and repair of the beach walkway.',
    15000,
    '2026-11-15',
    '2026-09-01T15:00:00Z'
  ),
  (
    'assessment_2027_annual',
    'assoc_tango_mar',
    '2027 annual assessment',
    'Yearly dues for the coming year. Not invoiced yet.',
    125000,
    '2027-03-01',
    '2026-10-01T15:00:00Z'
  );

INSERT INTO invoices (
  id, association_id, property_id, assessment_id, invoice_number, description,
  amount_cents, late_fee_cents, issued_on, due_on, status, created_at
) VALUES
  (
    'invoice_sam_2026',
    'assoc_tango_mar',
    'prop_14',
    'assessment_2026_annual',
    '2026-14-ANNUAL',
    '2026 annual assessment',
    120000,
    0,
    '2026-01-15',
    '2026-03-01',
    'paid',
    '2026-01-15T15:00:00Z'
  ),
  (
    'invoice_casey_open',
    'assoc_tango_mar',
    'prop_27',
    NULL,
    'OPEN-27',
    'Opening balance (CSV import)',
    37550,
    2500,
    '2026-01-15',
    '2026-01-15',
    'open',
    '2026-01-15T15:00:00Z'
  ),
  (
    'invoice_casey_2026',
    'assoc_tango_mar',
    'prop_27',
    'assessment_2026_annual',
    '2026-27-ANNUAL',
    '2026 annual assessment',
    120000,
    0,
    '2026-01-15',
    '2026-03-01',
    'open',
    '2026-01-15T15:00:00Z'
  );

INSERT INTO payments (
  id, association_id, property_id, invoice_id, amount_cents, method, reference,
  paid_on, notes, recorded_by_user_id, created_at
) VALUES (
  'payment_sam_2026',
  'assoc_tango_mar',
  'prop_14',
  'invoice_sam_2026',
  120000,
  'check',
  '1042',
  '2026-02-20',
  'Recorded from the January dues mailing.',
  'user_jordan',
  '2026-02-20T18:00:00Z'
);

INSERT INTO documents (
  id, association_id, category, title, visibility, current_version_id, created_at
) VALUES
  (
    'doc_covenants',
    'assoc_tango_mar',
    'covenants',
    'Tango Mar covenants (sample)',
    'residents',
    'docver_covenants_1',
    '2026-10-01T15:00:00Z'
  ),
  (
    'doc_budget',
    'assoc_tango_mar',
    'budgets',
    '2026 budget (sample)',
    'board',
    'docver_budget_1',
    '2026-10-01T15:00:00Z'
  );

INSERT INTO document_versions (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
) VALUES
  (
    'docver_covenants_1',
    'assoc_tango_mar',
    'doc_covenants',
    1,
    'seed/tango-mar/covenants.txt',
    'tango-mar-covenants-sample.txt',
    'text/plain; charset=utf-8',
    0,
    'Sample placeholder so residents can see the current version. Replace with the recorded covenants.',
    'user_jordan',
    '2026-10-01T15:00:00Z'
  ),
  (
    'docver_budget_1',
    'assoc_tango_mar',
    'doc_budget',
    1,
    'seed/tango-mar/budget-2026.txt',
    'tango-mar-2026-budget-sample.txt',
    'text/plain; charset=utf-8',
    0,
    'Board-only sample. Residents do not see this file.',
    'user_jordan',
    '2026-10-01T15:00:00Z'
  );

INSERT INTO announcements (
  id, association_id, kind, title, body, pinned, published_at, expires_at, created_by_user_id, created_at
) VALUES
  (
    'ann_walkway',
    'assoc_tango_mar',
    'news',
    'Beach walkway washdown',
    'The beach walkway will be rinsed on weekday mornings through October. Please keep the gate latched when you leave the beach.',
    1,
    '2026-10-01T15:00:00Z',
    NULL,
    'user_jordan',
    '2026-10-01T15:00:00Z'
  ),
  (
    'ann_rip',
    'assoc_tango_mar',
    'emergency',
    'Sample emergency: high surf on the Tango Mar beach',
    'This is sample emergency copy for the portal review. Red flags mean stay out of the water. The Walton County beach safety crew posts the live flags.',
    1,
    '2026-10-05T13:00:00Z',
    '2026-12-31T23:00:00Z',
    'user_jordan',
    '2026-10-05T13:00:00Z'
  ),
  (
    'ann_meeting',
    'assoc_tango_mar',
    'meeting',
    'Annual members meeting',
    'The annual members meeting is Sunday, November 8, 2026 at 10:00 a.m. Central Time at the Tango Mar beach pavilion, 31 Tang O Mar Drive, Miramar Beach.',
    0,
    '2026-10-03T15:00:00Z',
    NULL,
    'user_jordan',
    '2026-10-03T15:00:00Z'
  );

INSERT INTO events (
  id, association_id, title, description, location, starts_at, ends_at, kind, created_by_user_id, created_at
) VALUES
  (
    'event_meeting',
    'assoc_tango_mar',
    'Annual members meeting',
    'Budget review and board elections discussion. This portal does not collect proxies.',
    'Tango Mar beach pavilion, 31 Tang O Mar Drive, Miramar Beach',
    '2026-11-08T16:00:00Z',
    '2026-11-08T17:30:00Z',
    'meeting',
    'user_jordan',
    '2026-10-01T15:00:00Z'
  ),
  (
    'event_dunes',
    'assoc_tango_mar',
    'Dune grass planting',
    'Bring gloves. The board will have plants and water.',
    'Dune crossing at the beach walkway, Tang O Mar Drive, Miramar Beach',
    '2026-10-18T14:00:00Z',
    '2026-10-18T16:00:00Z',
    'event',
    'user_jordan',
    '2026-10-01T15:00:00Z'
  );

INSERT INTO faqs (id, association_id, question, answer, sort_order) VALUES
  (
    'faq_pay',
    'assoc_tango_mar',
    'Where do I pay dues?',
    'Online card and ACH payments are not part of this portal. Mail a check to Tango Mar Property Owners Association, 31 Tang O Mar Drive, Miramar Beach, FL 32550. The board records the check on your ledger.',
    1
  ),
  (
    'faq_covenants',
    'assoc_tango_mar',
    'Where are the covenants?',
    'Open Documents and download the current covenants file. Residents always see the version the board has marked current. The sample file shipped with this portal is a placeholder, not the recorded covenants.',
    2
  ),
  (
    'faq_balance',
    'assoc_tango_mar',
    'Who can see my balance?',
    'You can see the lots linked to your login. Other residents cannot. People with admin access can see ledgers for this association only, not for any other association on this deployment.',
    3
  );

INSERT INTO board_contacts (id, association_id, name, role_title, email, phone, sort_order, visible) VALUES
  ('contact_president', 'assoc_tango_mar', 'Riley Chen', 'President', 'president@example.com', '850-555-0110', 1, 1),
  ('contact_treasurer', 'assoc_tango_mar', 'Avery Brooks', 'Treasurer', 'treasurer@example.com', '850-555-0111', 2, 1),
  ('contact_secretary', 'assoc_tango_mar', 'Morgan Patel', 'Secretary', 'secretary@example.com', '850-555-0112', 3, 1);

INSERT INTO messages (
  id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at
) VALUES (
  'msg_casey_1',
  'assoc_tango_mar',
  'msg_casey_1',
  NULL,
  'user_casey',
  'prop_27',
  'Walkway assessment',
  'Is the fall walkway charge included in the annual dues, or will it be billed separately?',
  '2026-10-02T18:30:00Z'
);

INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at) VALUES
  (
    'note_casey_past_due',
    'assoc_tango_mar',
    'user_casey',
    'account',
    'Past-due balance',
    'Your ledger shows an unpaid opening balance and the 2026 annual dues. Contact the board if a payment was already mailed.',
    '/a/tango-mar/invoices',
    '2026-09-15T14:00:00Z'
  ),
  (
    'note_jordan_message',
    'assoc_tango_mar',
    'user_jordan',
    'message',
    'New message from Casey Nguyen',
    'Walkway assessment',
    '/a/tango-mar/messages/msg_casey_1',
    '2026-10-02T18:30:00Z'
  );

INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at) VALUES (
  'audit_seed',
  'assoc_tango_mar',
  NULL,
  'seed',
  'association',
  'assoc_tango_mar',
  'Loaded the Tango Mar demo roster, ledger, and neighborhood content.',
  '2026-10-01T15:00:00Z'
);
