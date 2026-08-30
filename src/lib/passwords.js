'use strict';

const crypto = require('node:crypto');

const KEY_LENGTH = 64;

/** Produce a `scrypt$<salt>$<key>` string suitable for ADMIN_PASSWORD_HASH. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;

  let derived;
  try {
    derived = crypto.scryptSync(password, salt, KEY_LENGTH);
  } catch {
    return false;
  }
  const expected = Buffer.from(key, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
