-- Tango owner portal schema. One database, many associations.
-- Tenant-owned rows carry association_id. Financial rows are also tied to a property.

CREATE TABLE associations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  address_line1 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  county TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

-- public is the logged-out visitor. It is not stored on memberships.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (association_id, user_id),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (role_id) REFERENCES roles (id)
);

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  lot_number TEXT NOT NULL,
  street_address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (association_id, lot_number),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE property_owners (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (property_id, user_id),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  due_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  assessment_id TEXT,
  invoice_number TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  late_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (late_fee_cents >= 0),
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'paid', 'void')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (association_id, invoice_number),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (assessment_id) REFERENCES assessments (id)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  invoice_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('check', 'cash', 'ach_recorded', 'other')),
  reference TEXT NOT NULL DEFAULT '',
  paid_on TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (property_id) REFERENCES properties (id),
  FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  FOREIGN KEY (recorded_by_user_id) REFERENCES users (id)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'covenants', 'bylaws', 'guidelines', 'rules', 'minutes', 'budgets', 'forms', 'insurance'
  )),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'residents' CHECK (visibility IN ('residents', 'board')),
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  uploaded_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id, version_number),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (document_id) REFERENCES documents (id),
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id)
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('news', 'emergency', 'meeting')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  published_at TEXT NOT NULL,
  expires_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (created_by_user_id) REFERENCES users (id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('meeting', 'event', 'emergency')),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (created_by_user_id) REFERENCES users (id)
);

CREATE TABLE faqs (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE board_contacts (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role_title TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_id TEXT,
  from_user_id TEXT NOT NULL,
  property_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (from_user_id) REFERENCES users (id),
  FOREIGN KEY (property_id) REFERENCES properties (id)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id),
  FOREIGN KEY (actor_user_id) REFERENCES users (id)
);

CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  association_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  redirect_path TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_memberships_association ON memberships (association_id, user_id);
CREATE INDEX idx_properties_association ON properties (association_id);
CREATE INDEX idx_property_owners_user ON property_owners (association_id, user_id);
CREATE INDEX idx_invoices_property ON invoices (association_id, property_id, due_on);
CREATE INDEX idx_payments_property ON payments (association_id, property_id, paid_on);
CREATE INDEX idx_documents_association ON documents (association_id, category);
CREATE INDEX idx_announcements_association ON announcements (association_id, published_at);
CREATE INDEX idx_events_association ON events (association_id, starts_at);
CREATE INDEX idx_messages_thread ON messages (association_id, thread_id, created_at);
CREATE INDEX idx_notifications_user ON notifications (association_id, user_id, read_at);
CREATE INDEX idx_audit_association ON audit_log (association_id, created_at);

INSERT INTO roles (id, label, description) VALUES
  ('homeowner', 'Homeowner', 'Resident owner. Sees only their own lots, balances, and messages.'),
  ('board', 'Board member', 'Administers this association. Sees ledgers for this association only.'),
  ('officer', 'Officer / manager', 'Board officer or manager. Same admin tools as the board in this phase.'),
  ('public', 'Public', 'Logged-out visitor. No financial data and no resident documents.');
