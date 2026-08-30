'use strict';

const { getDb } = require('../db');

function create(listingId, values) {
  const result = getDb()
    .prepare(
      `INSERT INTO messages (listing_id, sender_name, sender_email, body)
       VALUES (?, ?, ?, ?)`
    )
    .run(listingId, values.senderName, values.senderEmail, values.body);
  return result.lastInsertRowid;
}

function markRelayed(messageId, { relayed, error = '' }) {
  getDb()
    .prepare('UPDATE messages SET relayed = ?, relay_error = ? WHERE id = ?')
    .run(relayed ? 1 : 0, error, messageId);
}

function forListing(listingId) {
  return getDb()
    .prepare('SELECT * FROM messages WHERE listing_id = ? ORDER BY created_at DESC, id DESC')
    .all(listingId);
}

function countForListing(listingId) {
  return getDb()
    .prepare('SELECT count(*) AS total FROM messages WHERE listing_id = ?')
    .get(listingId).total;
}

module.exports = { create, markRelayed, forListing, countForListing };
