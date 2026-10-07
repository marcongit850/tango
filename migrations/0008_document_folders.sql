-- Optional document subfolders, and the Insurance category.
-- Dashboard steps (no terminal): Cloudflare dashboard, D1 SQL database, open tango, Console, paste this whole file, Execute.
-- Run this once, after migrations/0007_message_reviewed.sql. Details are in the README under Document folders.
-- Existing documents stay in their categories. folder starts empty, so those files sit directly in the category.
-- If the console says documents_folder_migration already exists, this file was already applied. Stop. Do not paste it again.

CREATE TABLE documents_folder_migration (
  id INTEGER PRIMARY KEY
);

INSERT INTO documents_folder_migration (id) VALUES (1);

CREATE TABLE document_versions_hold (
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
  created_at TEXT NOT NULL,
  UNIQUE (document_id, version_number)
);

INSERT INTO document_versions_hold (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
)
SELECT
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
FROM document_versions;

DROP TABLE document_versions;

CREATE TABLE documents_next (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'covenants', 'bylaws', 'guidelines', 'rules', 'minutes', 'budgets', 'forms', 'insurance', 'insurance_docs'
  )),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'residents' CHECK (visibility IN ('residents', 'board')),
  current_version_id TEXT,
  folder TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (association_id) REFERENCES associations (id)
);

INSERT INTO documents_next (
  id, association_id, category, title, visibility, current_version_id, folder, created_at
)
SELECT
  id, association_id, category, title, visibility, current_version_id, '', created_at
FROM documents;

DROP TABLE documents;

ALTER TABLE documents_next RENAME TO documents;

CREATE INDEX idx_documents_association ON documents (association_id, category);

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

INSERT INTO document_versions (
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
)
SELECT
  id, association_id, document_id, version_number, r2_key, filename, content_type,
  byte_size, notes, uploaded_by_user_id, created_at
FROM document_versions_hold;

DROP TABLE document_versions_hold;
