'use strict';

const crypto = require('node:crypto');

const { getDb } = require('../db');
const config = require('../config');
const { clientKey } = require('./client-key');

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
 * Who a report counts as coming from: the client's address (an IPv6 one by
 * its prefix, see client-key.js), keyed with the session secret so the table
 * never holds a usable address.
 */
function reporterKeyFor(ip) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`report:${clientKey(ip)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Record a report and auto-hide the listing once enough different people
 * have reported it, so obvious spam disappears before a human gets to it.
 * A reporter who already has an open report on the listing is not counted
 * again: otherwise one visitor could hide any ad by reporting it repeatedly.
 */
function create(listingId, { reason, note = '', reporterKey = '' }) {
  const db = getDb();
  const submit = db.transaction(() => {
    if (reporterKey) {
      const already = db
        .prepare(
          'SELECT 1 FROM flags WHERE listing_id = ? AND reporter_key = ? AND resolved = 0'
        )
        .get(listingId, reporterKey);
      if (already) return { recorded: false, autoHidden: false };
    }

    db.prepare('INSERT INTO flags (listing_id, reason, note, reporter_key) VALUES (?, ?, ?, ?)')
      .run(listingId, reason, note, reporterKey);
    db.prepare('UPDATE listings SET flag_count = flag_count + 1 WHERE id = ?')
      .run(listingId);

    // Count only unresolved reports: once a moderator has reviewed and
    // restored a listing, its old reports must not immediately re-hide it.
    // Rows from before reporter keys existed count one each, as they did.
    const { status } = db
      .prepare('SELECT status FROM listings WHERE id = ?')
      .get(listingId);
    const reporters = db
      .prepare(
        `SELECT count(DISTINCT CASE WHEN reporter_key = '' THEN 'row:' || id
                                    ELSE reporter_key END) AS total
           FROM flags WHERE listing_id = ? AND resolved = 0`
      )
      .get(listingId).total;

    if (status === 'active' && reporters >= config.listings.autoHideFlagCount) {
      db.prepare(
        `UPDATE listings
            SET status = 'removed',
                removed_reason = 'Automatically hidden pending review',
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(listingId);
      return { recorded: true, autoHidden: true };
    }
    return { recorded: true, autoHidden: false };
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

module.exports = {
  REASONS,
  REASON_KEYS,
  labelFor,
  reporterKeyFor,
  create,
  forListing,
  openCount,
  resolveForListing,
};
