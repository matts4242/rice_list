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

test('parsePrice refuses a decimal comma rather than misreading it', () => {
  // Regression: commas were stripped wholesale, so "39,99" was listed as
  // $3,999.00 and "1,5" as $15.00.
  assert.equal(parsePrice('39,99').ok, false);
  assert.equal(parsePrice('1,5').ok, false);
  assert.equal(parsePrice('1,2345').ok, false);
  assert.equal(parsePrice(',').ok, false);
  assert.deepEqual(parsePrice('1,500'), { ok: true, cents: 150000 });
  assert.deepEqual(parsePrice('12,345,678.90'), { ok: true, cents: 1234567890 });
});

test('a developer\'s own .env does not leak into the test environment', () => {
  // Regression: dotenv loaded ./.env during tests, so after the README's
  // setup the suite failed, and could send mail through a real SMTP server.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-list-dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), 'SMTP_HOST=smtp.real.example\nPOSTS_PER_HOUR=999\n');
  const configPath = path.join(__dirname, '..', 'src', 'config');
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.SMTP_HOST;
  delete env.POSTS_PER_HOUR;

  const seen = execFileSync(
    process.execPath,
    ['-e', `const c = require(${JSON.stringify(configPath)}); console.log(JSON.stringify([c.smtp.host, c.listings.postsPerHour]))`],
    { cwd: dir, env, encoding: 'utf8' }
  );
  assert.deepEqual(JSON.parse(seen), ['', 5]);
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

test('passwords verify only against their own hash', async () => {
  const hash = hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', undefined), false);
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

test('search queries are bounded however long the input', () => {
  // Regression: every term became another ANDed FTS lookup, so "a a a …"
  // eight thousand times held the event loop for seconds per request.
  assert.equal(toFtsQuery('a '.repeat(8000)), '"a"*');

  const distinct = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  const terms = toFtsQuery(distinct).split(' AND ');
  assert.equal(terms.length, 8);
  assert.equal(terms.at(-1), '"word7"*', 'the prefix match goes on the last term kept');
});

test('search terms keep their accents and dotted capitals intact', () => {
  // Regression: lowercasing turned "İ" into "i" plus a combining dot, and
  // splitting on combining marks then broke the word in two.
  assert.equal(toFtsQuery('İstanbul'), '"İstanbul"*');
  assert.equal(toFtsQuery('naïve'), '"naïve"*', 'decomposed input is composed');
  assert.equal(toFtsQuery('bike ́'), '"bike"*', 'a stray mark is not a term');
});
