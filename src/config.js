'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config();

const rootDir = path.join(__dirname, '..');

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

// A missing secret is fatal in production; elsewhere we generate an ephemeral
// one so `npm start` works with no configuration at all.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) {
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
  }
  return crypto.randomBytes(32).toString('hex');
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(rootDir, process.env.DATA_DIR)
  : path.join(rootDir, 'data');

module.exports = {
  env,
  isProduction,
  rootDir,
  dataDir,
  port: int(process.env.PORT, 3000),
  // Interface to bind. Behind a reverse proxy this should be 127.0.0.1: with
  // trustProxy on, anything that can reach the port directly sets its own
  // X-Forwarded-For, and so picks its own identity for rate limiting.
  host: process.env.HOST || '0.0.0.0',
  siteName: process.env.SITE_NAME || 'Rice List',
  siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(rootDir, process.env.DATABASE_PATH)
    : path.join(dataDir, 'rice-list.db'),
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(rootDir, process.env.UPLOAD_DIR)
    : path.join(dataDir, 'uploads'),
  sessionSecret: sessionSecret(),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  listings: {
    perPage: int(process.env.LISTINGS_PER_PAGE, 24),
    expiryDays: int(process.env.LISTING_EXPIRY_DAYS, 45),
    maxImages: int(process.env.MAX_IMAGES_PER_LISTING, 6),
    maxImageBytes: int(process.env.MAX_IMAGE_BYTES, 8 * 1024 * 1024),
    // Ads posted per hour from a single address before we start rejecting.
    postsPerHour: int(process.env.POSTS_PER_HOUR, 5),
    messagesPerHour: int(process.env.MESSAGES_PER_HOUR, 10),
    // Edits buffer their uploads before the manage token can be checked — the
    // token arrives in the body multer is still parsing — so this is the only
    // thing standing between an anonymous caller and repeated multi-megabyte
    // allocations on someone else's listing.
    editsPerHour: int(process.env.EDITS_PER_HOUR, 30),
    // A listing hidden from browse once this many people report it.
    autoHideFlagCount: int(process.env.AUTO_HIDE_FLAG_COUNT, 5),
  },

  admin: {
    // Password is compared against this value; see src/lib/passwords.js for
    // how to generate a hash with `node src/scripts/hash-password.js`.
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    plainPassword: process.env.ADMIN_PASSWORD || '',
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Rice List <no-reply@localhost>',
  },
};
