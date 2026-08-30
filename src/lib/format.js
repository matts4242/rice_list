'use strict';

const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

function formatPrice(cents) {
  if (cents === null || cents === undefined) return 'Contact for price';
  if (cents === 0) return 'Free';
  return priceFormatter.format(cents / 100);
}

/** SQLite stores UTC strings without a zone marker; make that explicit. */
function parseSqliteDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseSqliteDate(value);
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function timeAgo(value) {
  const date = parseSqliteDate(value);
  if (!date) return '';

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const steps = [
    ['minute', 60],
    ['hour', 60],
    ['day', 24],
    ['month', 30],
    ['year', 12],
  ];

  let amount = seconds;
  let unit = 'second';
  for (const [nextUnit, size] of steps) {
    if (amount < size) break;
    amount = Math.floor(amount / size);
    unit = nextUnit;
  }
  return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
}

/** Escape then linkify newlines, for rendering user text as safe HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphs(value) {
  return String(value ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

module.exports = { formatPrice, formatDate, timeAgo, escapeHtml, paragraphs };
