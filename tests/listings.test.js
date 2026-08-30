'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, csrfFrom, tokenFor, validListing } = require('./helpers');
useTempEnvironment('listings');

const request = require('supertest');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');

const app = createApp();

test.after(() => closeDb());

/** Post an ad through the real form and return its id and manage token. */
async function createListing(agent, overrides = {}) {
  const csrf = await tokenFor(agent, '/post');
  const response = await agent
    .post('/post')
    .type('form')
    .send({ _csrf: csrf, ...validListing(overrides) });

  assert.equal(response.status, 302, `expected redirect, got ${response.status}`);
  const match = response.headers.location.match(
    /^\/listing\/([^/]+)\/posted\?token=([^&]+)/
  );
  assert.ok(match, `unexpected redirect: ${response.headers.location}`);
  return { publicId: match[1], manageToken: decodeURIComponent(match[2]) };
}

test('the browse page renders with no listings', async () => {
  const response = await request(app).get('/');
  assert.equal(response.status, 200);
  assert.match(response.text, /Nothing here yet/);
});

test('posting an ad publishes it and issues a manage token', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  assert.ok(publicId.length >= 8);
  assert.ok(manageToken.length >= 16);

  const listing = await request(app).get(`/listing/${publicId}`);
  assert.equal(listing.status, 200);
  assert.match(listing.text, /Steel frame road bike/);
  assert.match(listing.text, /\$250\.00/);
});

test('a listing never exposes the seller email address', async () => {
  const agent = request.agent(app);
  const { publicId } = await createListing(agent, {
    contact_email: 'private-address@example.com',
  });

  const listing = await request(app).get(`/listing/${publicId}`);
  assert.equal(listing.status, 200);
  assert.ok(!listing.text.includes('private-address@example.com'));
});

test('a phone number appears only when the poster opts in', async () => {
  const agent = request.agent(app);
  const hidden = await createListing(agent, { contact_phone: '555-9001' });
  const shown = await createListing(agent, {
    contact_phone: '555-9002',
    show_phone: 'on',
  });

  const hiddenPage = await request(app).get(`/listing/${hidden.publicId}`);
  assert.ok(!hiddenPage.text.includes('555-9001'));

  const shownPage = await request(app).get(`/listing/${shown.publicId}`);
  assert.ok(shownPage.text.includes('555-9002'));
});

test('an invalid submission is redisplayed with errors and creates nothing', async () => {
  const agent = request.agent(app);
  const before = await request(app).get('/');
  const csrf = await tokenFor(agent, '/post');

  const response = await agent
    .post('/post')
    .type('form')
    .send({ _csrf: csrf, title: 'no', description: 'tiny', category: '', contact_email: 'x' });

  assert.equal(response.status, 400);
  assert.match(response.text, /Please fix the highlighted fields/);

  const after = await request(app).get('/');
  const count = (text) => (text.match(/class="card"/g) || []).length;
  assert.equal(count(after.text), count(before.text));
});

test('a state-changing request without a CSRF token is refused', async () => {
  const response = await request(app)
    .post('/post')
    .type('form')
    .send(validListing());
  assert.equal(response.status, 403);
});

test('a rejected CSRF request still renders a complete error page', async () => {
  // Regression: the error view was rendered before the locals middleware ran,
  // which crashed the page with "site is not defined".
  const response = await request(app).post('/post').type('form').send(validListing());
  assert.equal(response.status, 403);
  assert.match(response.text, /<title>[^<]*Rice List<\/title>/);
  assert.match(response.text, /site-header/);
});

test('search finds a listing by title and misses unrelated ones', async () => {
  const agent = request.agent(app);
  await createListing(agent, { title: 'Unmistakable xylophone for sale' });

  const hit = await request(app).get('/?q=xylophone');
  assert.match(hit.text, /Unmistakable xylophone/);

  const miss = await request(app).get('/?q=submarine');
  assert.match(miss.text, /Nothing here yet/);
});

test('search tolerates punctuation without erroring', async () => {
  for (const query of ['"', '--', 'bike!!', 'a AND b', '*']) {
    const response = await request(app).get(`/?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200, `query ${query} failed`);
  }
});

test('category filtering narrows results and unknown slugs 404', async () => {
  const agent = request.agent(app);
  await createListing(agent, { title: 'A room to rent nearby', category: 'housing' });

  const housing = await request(app).get('/?category=housing');
  assert.match(housing.text, /A room to rent nearby/);
  assert.ok(!housing.text.includes('Steel frame road bike'));

  const unknown = await request(app).get('/?category=not-a-category');
  assert.equal(unknown.status, 404);
});

test('the manage page requires the correct token', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const wrong = await request(app).get(`/listing/${publicId}/manage?token=wrong`);
  assert.equal(wrong.status, 404);

  const none = await request(app).get(`/listing/${publicId}/manage`);
  assert.equal(none.status, 404);

  const right = await request(app).get(`/listing/${publicId}/manage?token=${manageToken}`);
  assert.equal(right.status, 200);
  assert.match(right.text, /Manage your ad/);
});

test('the owner can edit their ad and search reflects the change', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent, {
    title: 'Original headline for the edit test',
  });

  const page = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  const csrf = csrfFrom(page.text);

  const response = await agent
    .post(`/listing/${publicId}/manage`)
    .type('form')
    .send({
      _csrf: csrf,
      token: manageToken,
      ...validListing({ title: 'Rewritten headline mentioning kazoo', price: '10' }),
    });

  assert.equal(response.status, 302);

  const listing = await request(app).get(`/listing/${publicId}`);
  assert.match(listing.text, /Rewritten headline mentioning kazoo/);
  assert.match(listing.text, /\$10\.00/);

  // The FTS index is maintained by triggers; make sure they fired.
  const search = await request(app).get('/?q=kazoo');
  assert.match(search.text, /Rewritten headline mentioning kazoo/);
  const stale = await request(app).get('/?q=Original+headline');
  assert.ok(!stale.text.includes('Rewritten headline'));
});

test('the owner can delete their ad', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const page = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  const csrf = csrfFrom(page.text);

  const response = await agent
    .post(`/listing/${publicId}/delete`)
    .type('form')
    .send({ _csrf: csrf, token: manageToken });

  assert.equal(response.status, 302);
  const gone = await request(app).get(`/listing/${publicId}`);
  assert.equal(gone.status, 404);
});

test('an unknown listing returns a rendered 404', async () => {
  const response = await request(app).get('/listing/doesnotexist');
  assert.equal(response.status, 404);
  assert.match(response.text, /does not exist/);
});
