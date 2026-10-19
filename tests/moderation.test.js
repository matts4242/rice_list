'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, csrfFrom, tokenFor, validListing } = require('./helpers');
useTempEnvironment('moderation');
// Auto-hide counts distinct reporters by address, so the tests below need to
// report from several: trust X-Forwarded-For and give each report its own.
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db');
const adminModel = require('../src/lib/admin');

const app = createApp();
const ADMIN_PASSWORD = 'test-admin-password';

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

let nextReporter = 1;

/** File reports from `times` different addresses, or all from `from`. */
async function report(publicId, times = 1, { from } = {}) {
  const agent = request.agent(app);
  const page = await agent.get(`/listing/${publicId}/report`);
  const csrf = csrfFrom(page.text);
  for (let i = 0; i < times; i += 1) {
    const address = from || `198.51.100.${nextReporter++}`;
    await agent
      .post(`/listing/${publicId}/report`)
      .set('X-Forwarded-For', address)
      .type('form')
      .send({ _csrf: csrf, reason: 'spam', note: `report ${i}` });
  }
}

test('the admin panel is closed to anonymous visitors', async () => {
  const response = await request(app).get('/admin');
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^\/admin\/login/);
});

test('a wrong password does not sign anyone in', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/admin/login');

  const response = await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrf, password: 'not-the-password', next: '/admin' });
  assert.equal(response.status, 401);

  const panel = await agent.get('/admin');
  assert.equal(panel.status, 302);
});

test('the correct password opens the moderation dashboard', async () => {
  const agent = await signInAsAdmin();
  const panel = await agent.get('/admin');
  assert.equal(panel.status, 200);
  assert.match(panel.text, /Moderation/);
});

test('login only redirects to paths on this site', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/admin/login');

  const response = await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: csrf, password: ADMIN_PASSWORD, next: 'https://evil.example/steal' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/admin');
});

test('a moderator can remove a listing and the public loses access', async () => {
  const poster = request.agent(app);
  const { publicId } = await createListing(poster, { title: 'Listing bound for removal' });

  const admin = await signInAsAdmin();
  const panel = await admin.get('/admin?filter=active');
  const csrf = csrfFrom(panel.text);

  const response = await admin
    .post(`/admin/listing/${publicId}/remove`)
    .type('form')
    .send({ _csrf: csrf, reason: 'Prohibited item' });
  assert.equal(response.status, 302);

  const publicView = await request(app).get(`/listing/${publicId}`);
  assert.equal(publicView.status, 410);

  const browse = await request(app).get('/');
  assert.ok(!browse.text.includes('Listing bound for removal'));

  // Moderators keep visibility, with the reason attached.
  const adminView = await admin.get(`/admin/listing/${publicId}`);
  assert.equal(adminView.status, 200);
  assert.match(adminView.text, /Prohibited item/);
});

test('a restored listing is not re-hidden by a single new report', async () => {
  // Regression: auto-hide counted lifetime reports, so restoring a listing
  // was pointless — the next report immediately hid it again.
  const poster = request.agent(app);
  const { publicId } = await createListing(poster);

  await report(publicId, 5);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);

  const admin = await signInAsAdmin();
  const panel = await admin.get('/admin?filter=removed');
  await admin
    .post(`/admin/listing/${publicId}/restore`)
    .type('form')
    .send({ _csrf: csrfFrom(panel.text) });

  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);

  await report(publicId, 1);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);
});

test('reported listings surface in the moderation queue', async () => {
  const poster = request.agent(app);
  const { publicId } = await createListing(poster, { title: 'Something worth reporting' });
  await report(publicId, 2);

  const admin = await signInAsAdmin();
  const queue = await admin.get('/admin?filter=flagged');
  assert.match(queue.text, /Something worth reporting/);

  const detail = await admin.get(`/admin/listing/${publicId}`);
  assert.match(detail.text, /Reports \(2\)/);
});

test('dismissing reports clears the queue without hiding the ad', async () => {
  const poster = request.agent(app);
  const { publicId } = await createListing(poster, { title: 'Wrongly reported ad' });
  await report(publicId, 2);

  const admin = await signInAsAdmin();
  const queue = await admin.get('/admin?filter=flagged');

  await admin
    .post(`/admin/listing/${publicId}/dismiss-reports`)
    .type('form')
    .send({ _csrf: csrfFrom(queue.text) });

  const after = await admin.get('/admin?filter=flagged');
  assert.ok(!after.text.includes('Wrongly reported ad'));
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);
});

test('a moderator can permanently delete a listing', async () => {
  const poster = request.agent(app);
  const { publicId } = await createListing(poster);

  const admin = await signInAsAdmin();
  const panel = await admin.get('/admin?filter=active');

  const response = await admin
    .post(`/admin/listing/${publicId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(panel.text) });
  assert.equal(response.status, 302);

  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 404);
  assert.equal((await admin.get(`/admin/listing/${publicId}`)).status, 404);
});

// ---------------------------------------------------------------------------
// Reports count people, not submissions.
// ---------------------------------------------------------------------------

test('one visitor reporting a listing repeatedly cannot hide it', async () => {
  // Regression: every report counted, so one person could take down any ad
  // by submitting the form five times.
  const poster = request.agent(app);
  const { publicId } = await createListing(poster, { title: 'Competitor bait listing' });

  await report(publicId, 5, { from: '203.0.113.7' });
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);

  const admin = await signInAsAdmin();
  const detail = await admin.get(`/admin/listing/${publicId}`);
  assert.match(detail.text, /Reports \(1\)/, 'repeats should not pile up in the queue');
});

test('addresses within one IPv6 prefix count as one reporter', async () => {
  // An IPv6 host typically holds a whole /64 or more, so rotating addresses
  // inside it must not manufacture distinct reporters.
  const poster = request.agent(app);
  const { publicId } = await createListing(poster);

  for (let i = 1; i <= 5; i += 1) {
    await report(publicId, 1, { from: `2001:db8:42:${i}::${i}` });
  }
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);
});

// ---------------------------------------------------------------------------
// Moderation must stick: the owner's manage link cannot undo it.
// ---------------------------------------------------------------------------

async function renewAsOwner(owner, publicId, manageToken) {
  const managePath = `/listing/${publicId}/manage?token=${encodeURIComponent(manageToken)}`;
  const page = await owner.get(managePath);
  const response = await owner
    .post(`/listing/${publicId}/renew`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), token: manageToken });
  return { page, response };
}

test('a seller cannot renew away a moderator removal', async () => {
  // Regression: renew set status = 'active' unconditionally, so the owner of
  // a removed scam ad could put it straight back up.
  const owner = request.agent(app);
  const { publicId, manageToken } = await createListing(owner);

  const admin = await signInAsAdmin();
  const panel = await admin.get(`/admin/listing/${publicId}`);
  await admin
    .post(`/admin/listing/${publicId}/remove`)
    .type('form')
    .send({ _csrf: csrfFrom(panel.text), reason: 'Scam' });
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);

  const { page, response } = await renewAsOwner(owner, publicId, manageToken);
  assert.doesNotMatch(page.text, /Renew for another period/, 'no renew button on a removed ad');
  assert.equal(response.status, 302);

  const after = await owner.get(response.headers.location);
  assert.match(after.text, /removed by a moderator, so it cannot be renewed/);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);
});

test('an auto-hidden listing cannot be renewed back up by its owner', async () => {
  const owner = request.agent(app);
  const { publicId, manageToken } = await createListing(owner);

  await report(publicId, 5);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);

  await renewAsOwner(owner, publicId, manageToken);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);
});

test('renewing a live listing still extends it', async () => {
  const owner = request.agent(app);
  const { publicId, manageToken } = await createListing(owner);
  const expiry = () =>
    getDb().prepare('SELECT expires_at FROM listings WHERE public_id = ?').get(publicId).expires_at;

  getDb()
    .prepare("UPDATE listings SET expires_at = datetime('now', '+1 day') WHERE public_id = ?")
    .run(publicId);
  const before = expiry();

  const { response } = await renewAsOwner(owner, publicId, manageToken);
  assert.equal(response.status, 302);
  assert.ok(expiry() > before, 'the expiry should move forward');
});

// ---------------------------------------------------------------------------
// The panel's view of expiry matches the public site's.
// ---------------------------------------------------------------------------

/** Backdate a listing past its expiry without running the sweep. */
function lapse(publicId) {
  getDb()
    .prepare("UPDATE listings SET expires_at = datetime('now', '-1 day') WHERE public_id = ?")
    .run(publicId);
}

test('the moderation panel shows a lapsed listing as expired, not active', async () => {
  // Regression: the panel read the stored status, which only catches up when
  // the sweep runs, so a lapsed ad sat in "Active" while the site served 410.
  const owner = request.agent(app);
  const { publicId } = await createListing(owner, { title: 'Quietly lapsed lawnmower' });
  lapse(publicId);

  const ids = (filter) => adminModel.listFor(filter, { perPage: 1000 }).rows.map((row) => row.public_id);
  assert.ok(!ids('active').includes(publicId));
  assert.ok(ids('expired').includes(publicId));

  const activeBefore = adminModel.stats().active;
  const another = await createListing(owner);
  lapse(another.publicId);
  assert.equal(adminModel.stats().active, activeBefore, 'stats should not count it as active');
});

test('restoring a lapsed listing makes it available again', async () => {
  // Regression: restore only flipped the status column, so an expired ad was
  // "restored" with a success message and stayed unavailable.
  const owner = request.agent(app);
  const { publicId } = await createListing(owner);
  lapse(publicId);
  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 410);

  const admin = await signInAsAdmin();
  const panel = await admin.get(`/admin/listing/${publicId}`);
  await admin
    .post(`/admin/listing/${publicId}/restore`)
    .type('form')
    .send({ _csrf: csrfFrom(panel.text), return_to: 'listing' });

  assert.equal((await request(app).get(`/listing/${publicId}`)).status, 200);
});

test('a filter named after an Object.prototype member falls back to the default', async () => {
  // Regression: FILTERS[key] resolved "constructor" to Object's constructor,
  // and the dashboard crashed with a 500.
  const admin = await signInAsAdmin();
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const response = await admin.get(`/admin?filter=${key}`);
    assert.equal(response.status, 200, `filter=${key} should render`);
  }
});

test('signing out closes the panel again', async () => {
  const admin = await signInAsAdmin();
  const panel = await admin.get('/admin');

  await admin.post('/admin/logout').type('form').send({ _csrf: csrfFrom(panel.text) });

  const after = await admin.get('/admin');
  assert.equal(after.status, 302);
});
