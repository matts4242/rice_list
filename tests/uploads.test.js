'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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

/** Post a valid listing carrying one attached file; returns the response. */
async function postWithFile(buffer, file) {
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(validListing())) req = req.field(key, value);
  return req.attach('images', buffer, file);
}

/** Create a listing with one photo, returning what the manage page needs. */
async function createWithPhoto(agent, title) {
  const csrf = await tokenFor(agent, '/post');
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(validListing({ title }))) req = req.field(key, value);
  const created = await req.attach('images', await pngBuffer(), 'first.png');
  const match = created.headers.location.match(/^\/listing\/([^/]+)\/posted\?token=([^&]+)/);
  return { publicId: match[1], manageToken: decodeURIComponent(match[2]) };
}

/**
 * A valid PNG declaring 16383×16383 pixels: 1-bit greyscale, all zeros, so
 * it deflates to a few tens of kilobytes but decodes to over 268 million
 * pixels.
 */
function pixelBombPng(size = 16383) {
  const crc32 = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  const rowBytes = 1 + Math.ceil(size / 8); // filter byte + packed pixels
  const pixels = zlib.deflateSync(Buffer.alloc(rowBytes * size), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('an image whose pixel count would exhaust memory is refused before decoding', async () => {
  // Regression: only the file size was limited, and a ~180 KB image can
  // declare 16383×16383 pixels — about 2.3 GB to decode, per upload.
  const bomb = pixelBombPng();
  assert.ok(bomb.length < 200 * 1024, `the bomb should be small, was ${bomb.length} bytes`);
  const before = uploadedFiles().length;

  const rssBefore = process.memoryUsage().rss;
  const response = await postWithFile(bomb, { filename: 'bomb.png', contentType: 'image/png' });
  const grown = process.memoryUsage().rss - rssBefore;

  assert.equal(response.status, 400);
  assert.match(response.text, /too large/);
  assert.equal(uploadedFiles().length, before, 'nothing should be written');
  assert.ok(grown < 512 * 1024 * 1024, `memory grew by ${Math.round(grown / 1e6)} MB`);
});

test('transparent areas are kept white, not flattened to black', async () => {
  // Regression: JPEG has no alpha, and sharp flattens onto black by default,
  // so black text on a transparent background vanished entirely.
  const transparent = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  const before = new Set(uploadedFiles());
  const response = await postWithFile(transparent, 'clear.png');
  assert.equal(response.status, 302);

  const stored = uploadedFiles().filter((name) => !before.has(name));
  assert.equal(stored.length, 2, 'image and thumbnail');
  for (const name of stored) {
    const { channels } = await sharp(path.join(config.uploadDir, name)).stats();
    assert.ok(channels.every((channel) => channel.min > 240), `${name} should be white`);
  }
});

test('editing with an unreadable photo is refused without saving the text', async () => {
  // Regression: the text was saved first and the photo decoded afterwards,
  // so a bad photo produced a 500 — with the edit already half applied.
  const agent = request.agent(app);
  const { publicId, manageToken } = await createWithPhoto(agent, 'Original title kept on failure');

  const managePage = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  let edit = agent
    .post(`/listing/${publicId}/manage`)
    .field('_csrf', csrfFrom(managePage.text))
    .field('token', manageToken);
  for (const [key, value] of Object.entries(validListing({ title: 'Edited title that should not stick' }))) {
    edit = edit.field(key, value);
  }
  const response = await edit.attach('images', Buffer.from('definitely not a png'), {
    filename: 'broken.png',
    contentType: 'image/png',
  });

  assert.equal(response.status, 400);
  assert.match(response.text, /could not be read/);
  const listing = await request(app).get(`/listing/${publicId}`);
  assert.match(listing.text, /Original title kept on failure/);
  assert.doesNotMatch(listing.text, /Edited title that should not stick/);
});

test('a body that is not valid multipart is a 400, not a 500', async () => {
  const response = await request(app)
    .post('/post')
    .set('content-type', 'multipart/form-data; boundary=zzz')
    .send('this is not multipart at all');
  assert.equal(response.status, 400);
});

test('an upload with far more fields than any form sends is cut off early', async () => {
  // Regression: field count and size were unlimited, so an anonymous request
  // could make the parser buffer hundreds of megabytes before the CSRF check.
  let req = request(app).post('/post');
  for (let i = 0; i < 40; i += 1) req = req.field(`junk${i}`, 'x');
  const tooMany = await req;
  assert.equal(tooMany.status, 413);

  const tooBig = await request(app)
    .post('/post')
    .field('description', 'x'.repeat(200 * 1024));
  assert.equal(tooBig.status, 413);
});

test('a long description in a multibyte script still fits', async () => {
  // The field limit is in bytes; the description limit is in characters.
  const agent = request.agent(app);
  const csrf = await tokenFor(agent, '/post');
  const description = '日本語の説明文です。'.repeat(790).slice(0, 7900);
  let req = agent.post('/post').field('_csrf', csrf);
  for (const [key, value] of Object.entries(validListing({ description }))) req = req.field(key, value);
  const response = await req.attach('images', await pngBuffer(), 'photo.png');
  assert.equal(response.status, 302);
});

test('the temporary test directory stayed inside the OS temp dir', () => {
  assert.match(tempDir, /rice-list-uploads-/);
});
