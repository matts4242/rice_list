'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, tokenFor, validListing } = require('./helpers');
useTempEnvironment('regressions');

const request = require('supertest');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db');
const admin = require('../src/lib/admin');

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
