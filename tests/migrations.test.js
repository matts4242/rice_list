'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment } = require('./helpers');
useTempEnvironment('migrations');

const Database = require('better-sqlite3');

// A flags table as databases created before reporter keys have it. schema.sql
// uses CREATE TABLE IF NOT EXISTS, so on its own it would leave this as is.
const LEGACY_FLAGS = `
  CREATE TABLE flags (
    id         INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    resolved   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO flags (listing_id, reason, note) VALUES (1, 'spam', 'from before');
`;

const legacy = new Database(process.env.DATABASE_PATH);
legacy.exec(LEGACY_FLAGS);
legacy.close();

const { getDb, closeDb } = require('../src/db');

test.after(() => closeDb());

test('an existing database gains the reporter_key column on boot', () => {
  const columns = getDb()
    .prepare('PRAGMA table_info(flags)')
    .all()
    .map((column) => column.name);
  assert.ok(columns.includes('reporter_key'));

  const old = getDb().prepare('SELECT * FROM flags').get();
  assert.equal(old.note, 'from before', 'existing reports are kept');
  assert.equal(old.reporter_key, '');
});

test('booting again is a no-op', () => {
  closeDb();
  assert.doesNotThrow(() => getDb());
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM flags').get().n, 1);
});
