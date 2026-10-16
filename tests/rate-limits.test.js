'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, tokenFor, validListing } = require('./helpers');
useTempEnvironment('rate-limits');

// The rest of the suite runs with throttling switched off. This file is the
// exception: the limits themselves are what is under test, so re-enable them
// and pick a small edit allowance before anything reads the configuration.
delete process.env.DISABLE_RATE_LIMIT;
process.env.EDITS_PER_HOUR = '2';
// Lets the tests below choose the client address the limiter sees.
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');
const config = require('../src/config');

const app = createApp();
const MULTIPART_TYPE = 'multipart/form-data; boundary=----x';

test.after(() => closeDb());

/** A multipart edit carrying a token that will not survive verification. */
function forgedEdit(publicId) {
  return request(app)
    .post(`/listing/${publicId}/manage`)
    .set('content-type', MULTIPART_TYPE)
    .send(
      '------x\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\nwrong\r\n------x--\r\n'
    );
}

test('the edit allowance is configurable', () => {
  assert.equal(config.listings.editsPerHour, 2);
});

test('edits are throttled before the upload parser allocates', async () => {
  // The manage token lives in the body multer is still parsing, so an
  // anonymous caller can make the server buffer megabytes on someone else's
  // listing before anything authorises the edit. The limiter is the only
  // check that can run first — and the status codes prove that it does: while
  // the allowance lasts the request reaches CSRF verification and is refused
  // with 403, and once it is spent the limiter answers 429 on its own.
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  const posted = await agent
    .post('/post')
    .type('form')
    .send({ _csrf: csrf, ...validListing() });
  const publicId = posted.headers.location.match(/^\/listing\/([^/]+)\//)[1];

  const statuses = [];
  for (let i = 0; i < config.listings.editsPerHour + 1; i += 1) {
    const response = await forgedEdit(publicId);
    statuses.push(response.status);
  }

  assert.deepEqual(
    statuses,
    [403, 403, 429],
    'the allowance should be spent on refusals, then the limiter takes over'
  );
});

test('posting is still throttled', async () => {
  const statuses = [];
  for (let i = 0; i < config.listings.postsPerHour + 2; i += 1) {
    const agent = request.agent(app);
    const csrf = await tokenFor(agent, '/post');
    const response = await agent
      .post('/post')
      .type('form')
      .send({ _csrf: csrf, ...validListing({ title: `Throttled bicycle number ${i}` }) });
    statuses.push(response.status);
  }

  assert.ok(
    statuses.includes(429),
    `posting should eventually be refused, got ${statuses.join(', ')}`
  );
});

/** Wrong-password sign-ins, each from the next address `addressFor` gives. */
async function failedLogins(count, addressFor) {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/admin/login');
  const statuses = [];
  for (let i = 0; i < count; i += 1) {
    const response = await agent
      .post('/admin/login')
      .set('X-Forwarded-For', addressFor(i))
      .type('form')
      .send({ _csrf: csrf, password: 'not the password' });
    statuses.push(response.status);
  }
  return statuses;
}

test('rotating addresses inside one IPv6 prefix does not escape the login limit', async () => {
  // Regression: limits were keyed on the full address, and an IPv6 host
  // holds a /64 or more — an endless supply of fresh buckets for guessing
  // the admin password.
  const statuses = await failedLogins(12, (i) => `2001:db8:7:7::${(i + 1).toString(16)}`);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(', ')}`);
});

test('separate IPv4 clients keep separate login allowances', async () => {
  // The flip side: masking must not lump every IPv4 client together, which a
  // naive IPv6 mask does to IPv4-mapped addresses.
  const first = await failedLogins(10, () => '192.0.2.10');
  assert.ok(!first.includes(429), 'ten attempts are within the allowance');
  const other = await failedLogins(1, () => '192.0.2.11');
  assert.deepEqual(other, [401], 'a different client is not throttled');
});
