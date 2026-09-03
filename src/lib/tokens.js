'use strict';

const crypto = require('node:crypto');

// Unambiguous alphabet: no 0/O/1/I/l, so tokens survive being read aloud or
// copied out of an email.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// 256 is not a multiple of the alphabet size, so plain `byte % length` would
// favour the first 256 % length characters. Reject the bytes in that ragged
// tail and draw again: every character then comes out equally likely, which
// is what the manage token's security rests on.
const CEILING = 256 - (256 % ALPHABET.length);

function randomId(length = 10) {
  let out = '';
  while (out.length < length) {
    // Over-draw so the common case needs a single call to the CSPRNG.
    for (const byte of crypto.randomBytes(length - out.length + 8)) {
      if (byte >= CEILING) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
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
