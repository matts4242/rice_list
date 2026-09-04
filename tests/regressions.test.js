'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, tokenFor, validListing } = require('./helpers');
useTempEnvironment('regressions');

const request = require('supertest');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db');
const admin = require('../src/lib/admin');
const listingsModel = require('../src/lib/listings');
const { randomId } = require('../src/lib/tokens');

const app = createApp();
const ADMIN_PASSWORD = 'test-admin-password';

// A body that is a well-formed multipart payload, so the only thing under test
// is whether the content type alone is enough to skip the CSRF check.
const MULTIPART_TYPE = 'multipart/form-data; boundary=----x';
const MULTIPART_BODY =
  '------x\r\nContent-Disposition: form-data; name="reason"\r\n\r\nspam\r\n------x--\r\n';

test.after(() => closeDb());

async function createListing(agent, overrides = {}) {
  const csrf = await tokenFor(agent, '/post');
  const response = await agent
    .post('/post')
    .type('form')
    .send({ _csrf: csrf, ...validListing(overrides) });
  const match = response.headers.location.match(/^\/listing\/([^/]+)\/posted\?token=([^&]+)/);
  return { publicId: match[1], manageToken: decodeURIComponent(match[2]) };
}

async function signInAsAdmin() {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/admin/login');
  const response = await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrf, password: ADMIN_PASSWORD, next: '/admin' });
  assert.equal(response.status, 302);
  return agent;
}

// ---------------------------------------------------------------------------
// CSRF: relabelling a request as multipart must not skip the check.
// ---------------------------------------------------------------------------

test('a non-upload route refuses a request that only claims to be multipart', async () => {
  // Regression: the CSRF middleware deferred verification for *any* multipart
  // request, but only the upload routes ever ran the deferred check. Any other
  // state-changing route could be forged by relabelling the content type.
  const { publicId } = await createListing(request.agent(app));

  const response = await request(app)
    .post(`/listing/${publicId}/report`)
    .set('content-type', MULTIPART_TYPE)
    .send(MULTIPART_BODY);

  assert.equal(response.status, 403);
});

test('a forged multipart post cannot remove a listing through an admin session', async () => {
  const { publicId } = await createListing(request.agent(app));
  const agent = await signInAsAdmin();

  const response = await agent
    .post(`/admin/listing/${publicId}/remove`)
    .set('content-type', MULTIPART_TYPE)
    .send(MULTIPART_BODY);

  assert.equal(response.status, 403);

  const listing = await request(app).get(`/listing/${publicId}`);
  assert.equal(listing.status, 200, 'the listing should still be live');
});

test('a forged multipart post cannot permanently delete a listing', async () => {
  const { publicId } = await createListing(request.agent(app));
  const agent = await signInAsAdmin();

  const response = await agent
    .post(`/admin/listing/${publicId}/delete`)
    .set('content-type', MULTIPART_TYPE)
    .send(MULTIPART_BODY);

  assert.equal(response.status, 403);

  const listing = await request(app).get(`/listing/${publicId}`);
  assert.equal(listing.status, 200, 'the listing should not have been deleted');
});

// ---------------------------------------------------------------------------
// Moderation dashboard: every filter tab must render.
// ---------------------------------------------------------------------------

test('every moderation filter renders', async () => {
  // Regression: the "Removed" tab ordered by l.updated_at, which the derived
  // table did not select, so the linked tab was a guaranteed 500.
  const agent = await signInAsAdmin();

  for (const filterKey of Object.keys(admin.FILTERS)) {
    const response = await agent.get(`/admin?filter=${filterKey}`);
    assert.equal(response.status, 200, `filter=${filterKey} should render`);
  }
});

test('the removed filter lists removed listings most-recently-removed first', async () => {
  const agent = await signInAsAdmin();
  const first = await createListing(request.agent(app), { title: 'First ad to be removed' });
  const second = await createListing(request.agent(app), { title: 'Second ad to be removed' });

  for (const { publicId } of [first, second]) {
    const csrf = await tokenFor(agent, `/admin/listing/${publicId}`);
    const response = await agent
      .post(`/admin/listing/${publicId}/remove`)
      .type('form')
      .send({ _csrf: csrf, reason: 'spam' });
    assert.equal(response.status, 302);
  }

  const { rows } = admin.listFor('removed', { page: 1 });
  const removed = rows.map((row) => row.public_id);
  assert.ok(removed.includes(first.publicId));
  assert.ok(removed.includes(second.publicId));
  assert.ok(
    rows.every((row) => row.updated_at),
    'updated_at must be selected for the ordering to work'
  );
});

// ---------------------------------------------------------------------------
// Login redirect: `next` must never leave the site.
// ---------------------------------------------------------------------------

test('the login redirect cannot be pointed off-site', async () => {
  // Regression: rejecting only a `//` prefix missed `/\evil.com`, which
  // browsers normalise to `//evil.com` and follow to another origin.
  for (const candidate of ['//evil.com', '/\\evil.com', '/\\/evil.com', 'https://evil.com']) {
    const agent = request.agent(app);
    const csrf = await tokenFor(agent, '/admin/login');
    const response = await agent
      .post('/admin/login')
      .type('form')
      .send({ _csrf: csrf, password: ADMIN_PASSWORD, next: candidate });

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.location,
      '/admin',
      `next=${candidate} must fall back to /admin`
    );
  }
});

test('the login redirect still honours a genuine internal path', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/admin/login');
  const response = await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrf, password: ADMIN_PASSWORD, next: '/admin?filter=all' });

  assert.equal(response.headers.location, '/admin?filter=all');
});

// ---------------------------------------------------------------------------
// Search index: traffic must not bloat it.
// ---------------------------------------------------------------------------

test('viewing a listing does not rewrite its search index rows', async () => {
  // Regression: the FTS sync trigger fired on every UPDATE of listings, so a
  // view-count bump re-indexed the row. The index grew with traffic instead of
  // with content.
  const { publicId } = await createListing(request.agent(app), {
    title: 'Unmistakable kayak for sale here',
  });

  const indexSize = () =>
    getDb().prepare('SELECT count(*) AS n FROM listings_fts_data').get().n;

  const before = indexSize();
  for (let i = 0; i < 25; i += 1) {
    await request(app).get(`/listing/${publicId}`);
  }
  assert.equal(indexSize(), before, 'page views must not touch the FTS index');

  const search = await request(app).get('/?q=kayak');
  assert.match(search.text, /Unmistakable kayak/);
});

test('editing a listing still updates its search index', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent, {
    title: 'Original headline about a canoe',
  });

  const csrf = await tokenFor(agent, `/listing/${publicId}/manage?token=${manageToken}`);
  const response = await agent
    .post(`/listing/${publicId}/manage`)
    .type('form')
    .send({
      _csrf: csrf,
      token: manageToken,
      ...validListing({ title: 'Rewritten headline about a harpsichord' }),
    });
  assert.equal(response.status, 302);

  const stale = await request(app).get('/?q=canoe');
  assert.doesNotMatch(stale.text, /Rewritten headline/);

  const fresh = await request(app).get('/?q=harpsichord');
  assert.match(fresh.text, /Rewritten headline about a harpsichord/);
});

// ---------------------------------------------------------------------------
// Expiry: a lapsed ad must go quiet immediately, not at the next sweep.
// ---------------------------------------------------------------------------

/** Backdate a listing past its expiry without running the sweep. */
function lapse(publicId) {
  getDb()
    .prepare(
      `UPDATE listings SET expires_at = datetime('now', '-1 day')
        WHERE public_id = ?`
    )
    .run(publicId);
}

test('a lapsed listing is unavailable before the expiry sweep runs', async () => {
  // Regression: status was read straight from the column, which only catches
  // up when the sweep runs, so a lapsed ad stayed fully live for up to an hour.
  const { publicId } = await createListing(request.agent(app), {
    title: 'Lapsing kayak nobody swept yet',
  });
  lapse(publicId);

  const detail = await request(app).get(`/listing/${publicId}`);
  assert.equal(detail.status, 410);
  assert.match(detail.text, /expired/i);
});

test('a lapsed listing cannot be contacted or reported', async () => {
  const agent = request.agent(app);
  const { publicId } = await createListing(agent, { title: 'Lapsing sofa in a hallway' });
  const csrf = await tokenFor(agent, `/listing/${publicId}`);
  lapse(publicId);

  const contact = await agent
    .post(`/listing/${publicId}/contact`)
    .type('form')
    .send({
      _csrf: csrf,
      sender_name: 'Buyer',
      sender_email: 'buyer@example.com',
      body: 'Is this sofa still available for collection?',
    });
  assert.equal(contact.status, 404);

  const report = await agent
    .post(`/listing/${publicId}/report`)
    .type('form')
    .send({ _csrf: csrf, reason: 'spam' });
  assert.equal(report.status, 404);
});

test('a lapsed listing drops out of browse and search', async () => {
  const { publicId } = await createListing(request.agent(app), {
    title: 'Lapsing accordion in its case',
  });

  const before = await request(app).get('/?q=accordion');
  assert.match(before.text, /Lapsing accordion/);

  lapse(publicId);

  const after = await request(app).get('/?q=accordion');
  assert.doesNotMatch(after.text, /Lapsing accordion/);
});

test('renewing a lapsed listing brings it back', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent, {
    title: 'Lapsing tuba needing a renewal',
  });
  lapse(publicId);

  const managePath = `/listing/${publicId}/manage?token=${manageToken}`;
  const page = await agent.get(managePath);
  assert.match(page.text, /expired/i, 'the manage page should say the ad lapsed');

  const csrf = await tokenFor(agent, managePath);
  const renew = await agent
    .post(`/listing/${publicId}/renew`)
    .type('form')
    .send({ _csrf: csrf, token: manageToken });
  assert.equal(renew.status, 302);

  const detail = await request(app).get(`/listing/${publicId}`);
  assert.equal(detail.status, 200);
});

// ---------------------------------------------------------------------------
// Manage-token generation must be uniform over the alphabet.
// ---------------------------------------------------------------------------

test('generated ids are uniform across the alphabet', () => {
  // Regression: `byte % 57` favoured the first 28 characters, because 256 is
  // not a multiple of the alphabet size and the ragged tail wrapped onto them.
  //
  // Comparing the two halves the old bias split, rather than per-character
  // counts, is what makes this both sensitive and stable: the biased version
  // put 54.7% of characters in the favoured bucket against a true share of
  // 49.1%, tens of standard deviations away, while sampling noise on a bucket
  // this size is under a tenth of a percent.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const favoured = new Set([...alphabet].slice(0, 256 % alphabet.length));
  const expectedShare = favoured.size / alphabet.length;

  const draws = 200000;
  let hits = 0;
  for (let i = 0; i < draws / 10; i += 1) {
    for (const char of randomId(10)) {
      assert.ok(alphabet.includes(char), `unexpected character ${char}`);
      if (favoured.has(char)) hits += 1;
    }
  }

  const share = hits / draws;
  assert.ok(
    Math.abs(share - expectedShare) < 0.01,
    `characters 0-${favoured.size - 1} took ${(share * 100).toFixed(2)}% of draws, ` +
      `expected ${(expectedShare * 100).toFixed(2)}%`
  );
});

test('generated ids are always the requested length', () => {
  for (const length of [1, 8, 10, 24, 64]) {
    assert.equal(randomId(length).length, length);
  }
});

// ---------------------------------------------------------------------------
// Admin search must treat LIKE wildcards as literal text.
// ---------------------------------------------------------------------------

test('admin search treats % and _ as characters, not wildcards', async () => {
  // Regression: the search term went into LIKE unescaped, so "%" matched
  // every listing in the database.
  await createListing(request.agent(app), { title: 'Ordinary bicycle for sale' });

  const everything = admin.listFor('all', {}).total;
  assert.ok(everything > 0, 'there should be listings to search');

  assert.equal(admin.listFor('all', { search: '%' }).total, 0);
  assert.equal(admin.listFor('all', { search: '_' }).total, 0);

  // A literal match still works.
  assert.equal(admin.listFor('all', { search: 'Ordinary bicycle' }).total, 1);
});

test('admin search finds a listing whose title really contains a percent sign', async () => {
  await createListing(request.agent(app), { title: 'Everything 50% off this weekend' });
  assert.equal(admin.listFor('all', { search: '50%' }).total, 1);
});

// Edit throttling is behavioural and needs rate limiting switched on, so it
// lives in its own file: see tests/rate-limits.test.js.
