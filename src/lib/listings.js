'use strict';

const { getDb } = require('../db');
const config = require('../config');
const { randomId, hashToken, tokenMatches } = require('./tokens');

const LISTING_COLUMNS = `
  l.id, l.public_id, l.title, l.description, l.price_cents, l.location,
  l.contact_email, l.contact_phone, l.show_phone, l.status, l.removed_reason,
  l.flag_count, l.view_count, l.created_at, l.updated_at, l.expires_at,
  c.slug AS category_slug, c.name AS category_name
`;

function allCategories() {
  return getDb()
    .prepare('SELECT * FROM categories ORDER BY sort_order, name')
    .all();
}

function categoryBySlug(slug) {
  return getDb().prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
}

function attachImages(listings) {
  if (listings.length === 0) return listings;

  const ids = listings.map((listing) => listing.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT listing_id, filename FROM listing_images
        WHERE listing_id IN (${placeholders})
        ORDER BY listing_id, position, id`
    )
    .all(...ids);

  const byListing = new Map(ids.map((id) => [id, []]));
  for (const row of rows) byListing.get(row.listing_id).push(row.filename);
  for (const listing of listings) listing.images = byListing.get(listing.id) || [];
  return listings;
}

/**
 * FTS5 treats plenty of punctuation as syntax. Users type search boxes, not
 * query languages, so quote each term and prefix-match the last one.
 */
function toFtsQuery(search) {
  const terms = String(search)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((term, i) => {
    const quoted = `"${term.replace(/"/g, '')}"`;
    return i === terms.length - 1 ? `${quoted}*` : quoted;
  }).join(' AND ');
}

/**
 * Browse listings with optional category filter and full-text search.
 * Only ever returns active listings — moderation and expiry are enforced here
 * rather than in each caller.
 */
function browse({ categorySlug = null, search = '', page = 1, perPage = config.listings.perPage } = {}) {
  const where = ["l.status = 'active'"];
  const params = {};

  if (categorySlug) {
    where.push('c.slug = @categorySlug');
    params.categorySlug = categorySlug;
  }

  const ftsQuery = search ? toFtsQuery(search) : null;
  if (ftsQuery) {
    where.push('l.id IN (SELECT rowid FROM listings_fts WHERE listings_fts MATCH @ftsQuery)');
    params.ftsQuery = ftsQuery;
  }

  const whereSql = where.join(' AND ');
  const total = getDb()
    .prepare(
      `SELECT count(*) AS total
         FROM listings l JOIN categories c ON c.id = l.category_id
        WHERE ${whereSql}`
    )
    .get(params).total;

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), pageCount);

  const rows = getDb()
    .prepare(
      `SELECT ${LISTING_COLUMNS}
         FROM listings l JOIN categories c ON c.id = l.category_id
        WHERE ${whereSql}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: perPage, offset: (currentPage - 1) * perPage });

  return {
    listings: attachImages(rows),
    total,
    page: currentPage,
    pageCount,
    perPage,
  };
}

function byPublicId(publicId) {
  const listing = getDb()
    .prepare(
      `SELECT ${LISTING_COLUMNS}
         FROM listings l JOIN categories c ON c.id = l.category_id
        WHERE l.public_id = ?`
    )
    .get(publicId);
  if (!listing) return null;
  attachImages([listing]);
  return listing;
}

function recordView(listingId) {
  getDb()
    .prepare('UPDATE listings SET view_count = view_count + 1 WHERE id = ?')
    .run(listingId);
}

function similarListings(listing, limit = 4) {
  const rows = getDb()
    .prepare(
      `SELECT ${LISTING_COLUMNS}
         FROM listings l JOIN categories c ON c.id = l.category_id
        WHERE l.status = 'active' AND c.slug = ? AND l.id != ?
        ORDER BY l.created_at DESC
        LIMIT ?`
    )
    .all(listing.category_slug, listing.id, limit);
  return attachImages(rows);
}

function generatePublicId() {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM listings WHERE public_id = ?');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomId(10);
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique listing id');
}

/**
 * Create a listing and return it alongside the plaintext manage token, which
 * is the only time that token is ever available.
 */
function create(values, imageFilenames = []) {
  const db = getDb();
  const category = categoryBySlug(values.category);
  if (!category) throw new Error(`Unknown category: ${values.category}`);

  const publicId = generatePublicId();
  const manageToken = randomId(24);

  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO listings (
           public_id, manage_token_hash, title, description, price_cents,
           category_id, location, contact_email, contact_phone, show_phone,
           expires_at
         ) VALUES (
           @publicId, @manageTokenHash, @title, @description, @priceCents,
           @categoryId, @location, @contactEmail, @contactPhone, @showPhone,
           datetime('now', @expiry)
         )`
      )
      .run({
        publicId,
        manageTokenHash: hashToken(manageToken),
        title: values.title,
        description: values.description,
        priceCents: values.priceCents ?? null,
        categoryId: category.id,
        location: values.location,
        contactEmail: values.contactEmail,
        contactPhone: values.contactPhone,
        showPhone: values.showPhone ? 1 : 0,
        expiry: `+${config.listings.expiryDays} days`,
      });

    const listingId = result.lastInsertRowid;
    const addImage = db.prepare(
      'INSERT INTO listing_images (listing_id, filename, position) VALUES (?, ?, ?)'
    );
    imageFilenames.forEach((filename, index) => addImage.run(listingId, filename, index));
    return listingId;
  });

  insert();
  return { listing: byPublicId(publicId), manageToken };
}

function update(listingId, values) {
  const category = categoryBySlug(values.category);
  if (!category) throw new Error(`Unknown category: ${values.category}`);

  getDb()
    .prepare(
      `UPDATE listings
          SET title = @title, description = @description, price_cents = @priceCents,
              category_id = @categoryId, location = @location,
              contact_email = @contactEmail, contact_phone = @contactPhone,
              show_phone = @showPhone, updated_at = datetime('now')
        WHERE id = @id`
    )
    .run({
      id: listingId,
      title: values.title,
      description: values.description,
      priceCents: values.priceCents ?? null,
      categoryId: category.id,
      location: values.location,
      contactEmail: values.contactEmail,
      contactPhone: values.contactPhone,
      showPhone: values.showPhone ? 1 : 0,
    });
}

function setStatus(listingId, status, reason = '') {
  getDb()
    .prepare(
      `UPDATE listings
          SET status = ?, removed_reason = ?, updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(status, reason, listingId);
}

function renew(listingId) {
  getDb()
    .prepare(
      `UPDATE listings
          SET status = 'active', expires_at = datetime('now', ?), updated_at = datetime('now')
        WHERE id = ?`
    )
    .run(`+${config.listings.expiryDays} days`, listingId);
}

function remove(listingId) {
  getDb().prepare('DELETE FROM listings WHERE id = ?').run(listingId);
}

/**
 * byPublicId deliberately never selects the token hash, so this reads it
 * directly rather than trusting a caller-supplied listing object.
 */
function authenticateManageToken(publicId, token) {
  if (!publicId || !token) return false;
  const row = getDb()
    .prepare('SELECT manage_token_hash FROM listings WHERE public_id = ?')
    .get(publicId);
  if (!row) return false;
  return tokenMatches(token, row.manage_token_hash);
}

function replaceImages(listingId, filenames) {
  const db = getDb();
  const swap = db.transaction(() => {
    db.prepare('DELETE FROM listing_images WHERE listing_id = ?').run(listingId);
    const addImage = db.prepare(
      'INSERT INTO listing_images (listing_id, filename, position) VALUES (?, ?, ?)'
    );
    filenames.forEach((filename, index) => addImage.run(listingId, filename, index));
  });
  swap();
}

function imagesFor(listingId) {
  return getDb()
    .prepare('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY position, id')
    .all(listingId);
}

module.exports = {
  allCategories,
  categoryBySlug,
  browse,
  byPublicId,
  recordView,
  similarListings,
  create,
  update,
  setStatus,
  renew,
  remove,
  authenticateManageToken,
  replaceImages,
  imagesFor,
  toFtsQuery,
};
