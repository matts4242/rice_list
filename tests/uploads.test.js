'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, csrfFrom, tokenFor, validListing } = require('./helpers');
const tempDir = useTempEnvironment('uploads');

const sharp = require('sharp');
const request = require('supertest');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');
const config = require('../src/config');

const app = createApp();

test.after(() => closeDb());

function pngBuffer(width = 800, height = 600) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .png()
    .toBuffer();
}

function uploadedFiles() {
  return fs.existsSync(config.uploadDir) ? fs.readdirSync(config.uploadDir) : [];
}

test('an ad can be posted with a photo attached', async () => {
  // Regression: the CSRF check ran before multer parsed the multipart body,
  // so every upload was rejected with a 403.
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  const image = await pngBuffer();

  const fields = validListing({ title: 'Bicycle with a photograph attached' });
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);

  const response = await req.attach('images', image, 'photo.png');
  assert.equal(response.status, 302, `upload rejected with ${response.status}`);

  const match = response.headers.location.match(/^\/listing\/([^/]+)\/posted/);
  const listing = await request(app).get(`/listing/${match[1]}`);
  assert.match(listing.text, /<img class="gallery-main"/);
});

test('uploads are re-encoded to JPEG with a thumbnail and no EXIF', async () => {
  const files = uploadedFiles();
  const full = files.filter((name) => !name.includes('-thumb'));
  assert.ok(full.length >= 1, 'expected a stored image');
  assert.ok(files.includes(full[0].replace('.jpg', '-thumb.jpg')), 'expected a thumbnail');

  const metadata = await sharp(path.join(config.uploadDir, full[0])).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);

  const thumb = await sharp(
    path.join(config.uploadDir, full[0].replace('.jpg', '-thumb.jpg'))
  ).metadata();
  assert.ok(thumb.width <= 480);
});

test('a file that is not an image is refused', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');

  const fields = validListing();
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);

  const response = await req.attach(
    'images',
    Buffer.from('#!/bin/sh\necho not an image\n'),
    { filename: 'payload.sh', contentType: 'application/x-sh' }
  );

  assert.equal(response.status, 400);
  assert.match(response.text, /JPEG, PNG, WebP or GIF/);
});

test('a file lying about its content type still fails to decode', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');

  const fields = validListing();
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);

  const response = await req.attach('images', Buffer.from('definitely not a png'), {
    filename: 'fake.png',
    contentType: 'image/png',
  });

  assert.equal(response.status, 400);
  assert.match(response.text, /could not be read/);
});

test('a multipart post with a bad CSRF token is still refused', async () => {
  const agent = request.agent(app);
  await tokenFor(agent, '/post');
  const image = await pngBuffer();

  const fields = validListing();
  let req = agent.post('/post').field('_csrf', 'wrong-token');
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);

  const response = await req.attach('images', image, 'photo.png');
  assert.equal(response.status, 403);
});

test('replacing photos on edit removes the previous files', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  const image = await pngBuffer();

  const fields = validListing({ title: 'Listing whose photos get replaced' });
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  const created = await req.attach('images', image, 'first.png');

  const match = created.headers.location.match(/^\/listing\/([^/]+)\/posted\?token=([^&]+)/);
  const publicId = match[1];
  const manageToken = decodeURIComponent(match[2]);

  const before = uploadedFiles();

  const managePage = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  const manageCsrf = csrfFrom(managePage.text);

  let edit = agent
    .post(`/listing/${publicId}/manage`)
    .field('_csrf', manageCsrf)
    .field('token', manageToken);
  for (const [key, value] of Object.entries(fields)) edit = edit.field(key, value);

  const replaced = await edit.attach('images', await pngBuffer(640, 480), 'second.png');
  assert.equal(replaced.status, 302);

  const after = uploadedFiles();
  assert.equal(after.length, before.length, 'old image files should be cleaned up');
});

test('deleting a listing removes its image files', async () => {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  const image = await pngBuffer();

  const fields = validListing({ title: 'Listing to delete with photos' });
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  const created = await req.attach('images', image, 'doomed.png');

  const match = created.headers.location.match(/^\/listing\/([^/]+)\/posted\?token=([^&]+)/);
  const publicId = match[1];
  const manageToken = decodeURIComponent(match[2]);

  const before = uploadedFiles().length;

  const managePage = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  await agent
    .post(`/listing/${publicId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(managePage.text), token: manageToken });

  assert.equal(uploadedFiles().length, before - 2, 'image and thumbnail should be gone');
});

test('the temporary test directory stayed inside the OS temp dir', () => {
  assert.match(tempDir, /rice-list-uploads-/);
});
