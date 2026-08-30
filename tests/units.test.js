'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment } = require('./helpers');
useTempEnvironment('units');

const { parsePrice, validateListing, validateMessage } = require('../src/lib/validate');
const { formatPrice, paragraphs, escapeHtml } = require('../src/lib/format');
const { hashPassword, verifyPassword } = require('../src/lib/passwords');
const { randomId, hashToken, tokenMatches } = require('../src/lib/tokens');
const { toFtsQuery } = require('../src/lib/listings');

test('parsePrice accepts money written the way people type it', () => {
  assert.deepEqual(parsePrice('40'), { ok: true, cents: 4000 });
  assert.deepEqual(parsePrice('39.99'), { ok: true, cents: 3999 });
  assert.deepEqual(parsePrice('$1,299.50'), { ok: true, cents: 129950 });
  assert.deepEqual(parsePrice('0'), { ok: true, cents: 0 });
});

test('parsePrice treats a blank price as "contact for price"', () => {
  assert.deepEqual(parsePrice(''), { ok: true, cents: null });
  assert.deepEqual(parsePrice('   '), { ok: true, cents: null });
  assert.deepEqual(parsePrice(undefined), { ok: true, cents: null });
});

test('parsePrice rejects nonsense and out-of-range values', () => {
  assert.equal(parsePrice('abc').ok, false);
  assert.equal(parsePrice('12.345').ok, false);
  assert.equal(parsePrice('-5').ok, false);
  assert.equal(parsePrice('999999999999').ok, false);
});

test('formatPrice distinguishes free from unpriced', () => {
  assert.equal(formatPrice(0), 'Free');
  assert.equal(formatPrice(null), 'Contact for price');
  assert.equal(formatPrice(129999), '$1,299.99');
});

test('listing validation reports every bad field at once', () => {
  const result = validateListing(
    { title: 'ab', description: 'short', category: 'nope', contact_email: 'bad' },
    ['for-sale']
  );
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), [
    'category',
    'contact_email',
    'description',
    'title',
  ]);
});

test('listing validation requires a phone number when showing one publicly', () => {
  const result = validateListing(
    {
      title: 'A perfectly reasonable listing title',
      description: 'A description that is comfortably long enough to pass.',
      category: 'for-sale',
      contact_email: 'seller@example.com',
      show_phone: 'on',
      contact_phone: '',
    },
    ['for-sale']
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.contact_phone, /phone number/i);
});

test('message validation requires a usable reply address', () => {
  const result = validateMessage({
    sender_name: 'Dana',
    sender_email: 'not-an-email',
    body: 'Is this still available for collection this weekend?',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.sender_email);
});

test('user text is escaped when rendered as HTML', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  const html = paragraphs('Hello <b>there</b>\n\nsecond');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
  assert.equal(html.match(/<p>/g).length, 2);
});

test('passwords verify only against their own hash', () => {
  const hash = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', hash), true);
  assert.equal(verifyPassword('wrong horse', hash), false);
  assert.equal(verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(verifyPassword('anything', undefined), false);
});

test('manage tokens are unguessable and compared by hash', () => {
  const token = randomId(24);
  assert.equal(token.length, 24);
  assert.equal(tokenMatches(token, hashToken(token)), true);
  assert.equal(tokenMatches('something-else', hashToken(token)), false);
  assert.notEqual(randomId(24), randomId(24));
});

test('search queries survive punctuation users actually type', () => {
  assert.equal(toFtsQuery('red bike'), '"red" AND "bike"*');
  assert.equal(toFtsQuery('  "quoted" -- junk!  '), '"quoted" AND "junk"*');
  assert.equal(toFtsQuery('!!!'), null);
  assert.equal(toFtsQuery(''), null);
});
