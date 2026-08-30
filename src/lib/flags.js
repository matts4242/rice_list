'use strict';

const { getDb } = require('../db');
const config = require('../config');

const REASONS = [
  ['spam', 'Spam or scam'],
  ['prohibited', 'Prohibited or illegal item'],
  ['miscategorized', 'Wrong category'],
  ['offensive', 'Offensive content'],
  ['duplicate', 'Duplicate posting'],
  ['other', 'Something else'],
];

const REASON_KEYS = REASONS.map(([key]) => key);

function labelFor(reason) {
  const match = REASONS.find(([key]) => key === reason);
  return match ? match[1] : reason;
}

/**
 * Record a report and auto-hide the listing once enough distinct reports
 * arrive, so obvious spam disappears before a human gets to it.
 */
function create(listingId, { reason, note = '' }) {
  const db = getDb();
  const submit = db.transaction(() => {
    db.prepare('INSERT INTO flags (listing_id, reason, note) VALUES (?, ?, ?)')
      .run(listingId, reason, note);
    db.prepare('UPDATE listings SET flag_count = flag_count + 1 WHERE id = ?')
      .run(listingId);

    // Count only unresolved reports: once a moderator has reviewed and
    // restored a listing, its old reports must not immediately re-hide it.
    const { status } = db
      .prepare('SELECT status FROM listings WHERE id = ?')
      .get(listingId);
    const openFlags = db
      .prepare('SELECT count(*) AS total FROM flags WHERE listing_id = ? AND resolved = 0')
      .get(listingId).total;

    if (status === 'active' && openFlags >= config.listings.autoHideFlagCount) {
      db.prepare(
        `UPDATE listings
            SET status = 'removed',
                removed_reason = 'Automatically hidden pending review',
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(listingId);
      return { autoHidden: true };
    }
    return { autoHidden: false };
  });
  return submit();
}

function forListing(listingId) {
  return getDb()
    .prepare('SELECT * FROM flags WHERE listing_id = ? ORDER BY created_at DESC')
    .all(listingId);
}

function openCount() {
  return getDb()
    .prepare('SELECT count(*) AS total FROM flags WHERE resolved = 0')
    .get().total;
}

function resolveForListing(listingId) {
  getDb().prepare('UPDATE flags SET resolved = 1 WHERE listing_id = ?').run(listingId);
}

module.exports = { REASONS, REASON_KEYS, labelFor, create, forListing, openCount, resolveForListing };
