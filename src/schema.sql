-- Rice List schema. Applied idempotently at boot by src/db.js.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listings (
  id                INTEGER PRIMARY KEY,
  public_id         TEXT NOT NULL UNIQUE,
  manage_token_hash TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  -- NULL price means "contact for price"; 0 means free.
  price_cents       INTEGER,
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  location          TEXT NOT NULL DEFAULT '',
  contact_email     TEXT NOT NULL,
  contact_phone     TEXT NOT NULL DEFAULT '',
  -- Phone is only rendered publicly when the poster opts in.
  show_phone        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'removed', 'expired')),
  removed_reason    TEXT NOT NULL DEFAULT '',
  flag_count        INTEGER NOT NULL DEFAULT 0,
  view_count        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_browse
  ON listings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_category
  ON listings (category_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_expiry
  ON listings (status, expires_at);

CREATE TABLE IF NOT EXISTS listing_images (
  id         INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_images_listing
  ON listing_images (listing_id, position);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  listing_id   INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sender_name  TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  body         TEXT NOT NULL,
  relayed      INTEGER NOT NULL DEFAULT 0,
  relay_error  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_listing
  ON messages (listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flags (
  id         INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_flags_open
  ON flags (resolved, created_at DESC);

-- Full-text search over title/description/location, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5 (
  title,
  description,
  location,
  content = 'listings',
  content_rowid = 'id',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS listings_fts_insert AFTER INSERT ON listings BEGIN
  INSERT INTO listings_fts (rowid, title, description, location)
  VALUES (new.id, new.title, new.description, new.location);
END;

CREATE TRIGGER IF NOT EXISTS listings_fts_delete AFTER DELETE ON listings BEGIN
  INSERT INTO listings_fts (listings_fts, rowid, title, description, location)
  VALUES ('delete', old.id, old.title, old.description, old.location);
END;

-- Scoped to the indexed columns on purpose. An unscoped AFTER UPDATE fires on
-- every view-count bump, status change and expiry sweep, each one rewriting
-- the listing's FTS rows: the index bloats in proportion to traffic rather
-- than to content. The DROP migrates databases created before this was fixed,
-- since CREATE TRIGGER IF NOT EXISTS would keep the old one.
DROP TRIGGER IF EXISTS listings_fts_update;

CREATE TRIGGER IF NOT EXISTS listings_fts_update
AFTER UPDATE OF title, description, location ON listings BEGIN
  INSERT INTO listings_fts (listings_fts, rowid, title, description, location)
  VALUES ('delete', old.id, old.title, old.description, old.location);
  INSERT INTO listings_fts (rowid, title, description, location)
  VALUES (new.id, new.title, new.description, new.location);
END;

