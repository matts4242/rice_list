'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, csrfFrom, tokenFor, validListing } = require('./helpers');
useTempEnvironment('moderation');

const request = require('supertest');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');

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

async function report(publicId, times = 1) {
  const agent = request.agent(app);
  const page = await agent.get(`/listing/${publicId}/report`);
  const csrf = csrfFrom(page.text);
  for (let i = 0; i < times; i += 1) {
    await agent
      .post(`/listing/${publicId}/report`)
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

test('signing out closes the panel again', async () => {
  const admin = await signInAsAdmin();
  const panel = await admin.get('/admin');

  await admin.post('/admin/logout').type('form').send({ _csrf: csrfFrom(panel.text) });

  const after = await admin.get('/admin');
  assert.equal(after.status, 302);
});
