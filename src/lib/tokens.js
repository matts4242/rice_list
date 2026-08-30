'use strict';

const crypto = require('node:crypto');

// Unambiguous alphabet: no 0/O/1/I/l, so tokens survive being read aloud or
// copied out of an email.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomId(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenMatches(token, expectedHash) {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(String(expectedHash));
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { randomId, hashToken, tokenMatches };
