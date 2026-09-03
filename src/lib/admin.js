'use strict';

const { getDb } = require('../db');

const ADMIN_COLUMNS = `
  l.id, l.public_id, l.title, l.price_cents, l.location, l.contact_email,
  l.status, l.removed_reason, l.flag_count, l.view_count, l.created_at,
  l.updated_at, l.expires_at, c.name AS category_name, c.slug AS category_slug,
  (SELECT count(*) FROM flags f WHERE f.listing_id = l.id AND f.resolved = 0)
    AS open_flags,
  (SELECT count(*) FROM messages m WHERE m.listing_id = l.id) AS message_count
`;

const FILTERS = {
  // Anything with an unresolved report, most-reported first.
  flagged: {
    label: 'Reported',
    where: 'open_flags > 0',
    order: 'open_flags DESC, l.created_at DESC',
  },
  active: { label: 'Active', where: "l.status = 'active'", order: 'l.created_at DESC' },
  removed: { label: 'Removed', where: "l.status = 'removed'", order: 'l.updated_at DESC' },
  expired: { label: 'Expired', where: "l.status = 'expired'", order: 'l.expires_at DESC' },
  all: { label: 'All', where: '1 = 1', order: 'l.created_at DESC' },
};

function listFor(filterKey, { page = 1, perPage = 30, search = '' } = {}) {
  const filter = FILTERS[filterKey] || FILTERS.flagged;
  const conditions = [filter.where];
  const params = {};

  if (search) {
    conditions.push('(l.title LIKE @like OR l.contact_email LIKE @like OR l.public_id = @exact)');
    params.like = `%${search}%`;
    params.exact = search;
  }

  // open_flags is a select-list alias, so filtering on it needs a subquery.
  const base = `
    FROM (
      SELECT ${ADMIN_COLUMNS}
        FROM listings l JOIN categories c ON c.id = l.category_id
    ) AS l
    WHERE ${conditions.join(' AND ')}
  `;

  const total = getDb().prepare(`SELECT count(*) AS total ${base}`).get(params).total;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), pageCount);

  const rows = getDb()
    .prepare(
      `SELECT * ${base}
        ORDER BY ${filter.order}
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: perPage, offset: (currentPage - 1) * perPage });

  return { rows, total, page: currentPage, pageCount, filterKey: FILTERS[filterKey] ? filterKey : 'flagged' };
}

function stats() {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
         count(*) FILTER (WHERE status = 'active')  AS active,
         count(*) FILTER (WHERE status = 'removed') AS removed,
         count(*) FILTER (WHERE status = 'expired') AS expired,
         count(*)                                   AS total
       FROM listings`
    )
    .get();
  const openFlags = db
    .prepare('SELECT count(*) AS total FROM flags WHERE resolved = 0')
    .get().total;
  const messages = db.prepare('SELECT count(*) AS total FROM messages').get().total;
  return { ...counts, openFlags, messages };
}

module.exports = { FILTERS, listFor, stats };
