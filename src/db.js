'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const config = require('./config');

const DEFAULT_CATEGORIES = [
  ['for-sale', 'For Sale', 10],
  ['housing', 'Housing', 20],
  ['jobs', 'Jobs', 30],
  ['services', 'Services', 40],
  ['community', 'Community', 50],
  ['free', 'Free Stuff', 60],
  ['wanted', 'Wanted', 70],
];

let db = null;

function applySchema(connection) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  connection.exec(schema);
}

function seedCategories(connection) {
  const insert = connection.prepare(
    `INSERT INTO categories (slug, name, sort_order)
     VALUES (?, ?, ?)
     ON CONFLICT (slug) DO NOTHING`
  );
  const seed = connection.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });
  seed(DEFAULT_CATEGORIES);
}

function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });

  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  seedCategories(db);
  return db;
}

/**
 * Mark listings past their expiry as expired. Cheap enough to run on each
 * browse request, and it keeps the site correct without a cron job.
 */
function expireStaleListings() {
  return getDb()
    .prepare(
      `UPDATE listings
          SET status = 'expired', updated_at = datetime('now')
        WHERE status = 'active' AND expires_at <= datetime('now')`
    )
    .run().changes;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb, expireStaleListings, DEFAULT_CATEGORIES };
