'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempEnvironment, csrfFrom, tokenFor, validListing } = require('./helpers');
useTempEnvironment('messaging');
// Reports are counted per address; the auto-hide test reports from several.
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');
const mailer = require('../src/lib/mailer');

const app = createApp();

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

async function sendMessage(agent, publicId, overrides = {}) {
  const page = await agent.get(`/listing/${publicId}`);
  const csrf = csrfFrom(page.text);
  return agent
    .post(`/listing/${publicId}/contact`)
    .type('form')
    .send({
      _csrf: csrf,
      sender_name: 'Dana Buyer',
      sender_email: 'dana@example.com',
      body: 'Hello, is this still available? I could collect on Saturday.',
      website: '',
      ...overrides,
    });
}

test('a buyer message reaches the seller inbox', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const response = await sendMessage(agent, publicId);
  assert.equal(response.status, 302);

  const inbox = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  assert.match(inbox.text, /Dana Buyer/);
  assert.match(inbox.text, /is this still available/i);
  assert.match(inbox.text, /dana@example\.com/);
});

test('an invalid message is rejected and not stored', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const response = await sendMessage(agent, publicId, {
    sender_name: 'x',
    sender_email: 'nope',
    body: 'hi',
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /valid email address/);

  const inbox = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  assert.match(inbox.text, /Messages from buyers \(0\)/);
});

test('the honeypot silently drops bot submissions', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const response = await sendMessage(agent, publicId, {
    sender_name: 'Spam Bot',
    website: 'http://spam.example',
  });
  assert.equal(response.status, 302);

  const inbox = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  assert.match(inbox.text, /Messages from buyers \(0\)/);
  assert.ok(!inbox.text.includes('Spam Bot'));
});

test('a message is kept even when the email relay fails', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  mailer._setTransportForTests({
    sendMail: async () => {
      throw new Error('SMTP is down');
    },
  });

  try {
    const response = await sendMessage(agent, publicId, { sender_name: 'Resilient Buyer' });
    assert.equal(response.status, 302);

    const inbox = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
    assert.match(inbox.text, /Resilient Buyer/);
    assert.match(inbox.text, /Not delivered by email/);
  } finally {
    mailer._setTransportForTests(null);
  }
});

/** A relay that accepts the message and never answers. */
function useStalledRelay() {
  mailer._setTransportForTests({ sendMail: () => new Promise(() => {}) });
  mailer._setDeadlineForTests(300);
  return () => {
    mailer._setTransportForTests(null);
    mailer._setDeadlineForTests(20_000);
  };
}

test('a stalled relay cannot hold a buyer\'s request open', async () => {
  // Regression: the send was awaited with nodemailer's default timeouts
  // (minutes), so a relay that stopped answering held the request past the
  // proxy's 60 s limit and the buyer got a gateway error.
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);
  const restore = useStalledRelay();

  try {
    const started = Date.now();
    const response = await sendMessage(agent, publicId, { sender_name: 'Patient Buyer' });
    assert.equal(response.status, 302);
    assert.ok(Date.now() - started < 5000, 'the deadline should end the wait');

    const inbox = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
    assert.match(inbox.text, /Patient Buyer/);
    assert.match(inbox.text, /Not delivered by email/);
  } finally {
    restore();
  }
});

test('a stalled relay cannot cost a poster their manage link', async () => {
  const restore = useStalledRelay();
  try {
    const agent = request.agent(app);
    const csrf = await tokenFor(agent, '/post');
    const response = await agent.post('/post').type('form').send({ _csrf: csrf, ...validListing() });

    assert.equal(response.status, 302);
    assert.match(response.headers.location, /\/posted\?token=[^&]+&emailed=0$/);
  } finally {
    restore();
  }
});

test('the relay is given timeouts far shorter than the proxy\'s', () => {
  for (const [name, ms] of Object.entries(mailer.SMTP_TIMEOUTS)) {
    assert.ok(ms <= 15_000, `${name} is ${ms} ms`);
  }
});

test('a relayed message is addressed to the seller with the buyer as reply-to', async () => {
  const agent = request.agent(app);
  const { publicId } = await createListing(agent, { contact_email: 'seller@example.com' });

  const sent = [];
  mailer._setTransportForTests({
    sendMail: async (options) => {
      sent.push(options);
      return { messageId: 'test' };
    },
  });

  try {
    await sendMessage(agent, publicId);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'seller@example.com');
    assert.match(sent[0].replyTo, /dana@example\.com/);
    assert.match(sent[0].text, /is this still available/i);
  } finally {
    mailer._setTransportForTests(null);
  }
});

test('messages cannot be sent to a removed listing', async () => {
  const agent = request.agent(app);
  const { publicId, manageToken } = await createListing(agent);

  const page = await agent.get(`/listing/${publicId}/manage?token=${manageToken}`);
  await agent
    .post(`/listing/${publicId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), token: manageToken });

  const response = await agent
    .post(`/listing/${publicId}/contact`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), sender_name: 'Dana', sender_email: 'd@example.com', body: 'Anyone there at all?' });
  assert.equal(response.status, 404);
});

test('reporting a listing requires a recognised reason', async () => {
  const agent = request.agent(app);
  const { publicId } = await createListing(agent);

  const page = await agent.get(`/listing/${publicId}/report`);
  const csrf = csrfFrom(page.text);

  const bad = await agent
    .post(`/listing/${publicId}/report`)
    .type('form')
    .send({ _csrf: csrf, reason: 'made-up-reason' });
  assert.equal(bad.status, 400);

  const good = await agent
    .post(`/listing/${publicId}/report`)
    .type('form')
    .send({ _csrf: csrf, reason: 'spam', note: 'Clearly a scam.' });
  assert.equal(good.status, 302);
});

test('enough reports auto-hide a listing from the public site', async () => {
  const agent = request.agent(app);
  const { publicId } = await createListing(agent);

  const page = await agent.get(`/listing/${publicId}/report`);
  const csrf = csrfFrom(page.text);

  // Distinct reporters: one visitor reporting repeatedly counts once.
  for (let i = 0; i < 5; i += 1) {
    await agent
      .post(`/listing/${publicId}/report`)
      .set('X-Forwarded-For', `192.0.2.${i + 1}`)
      .type('form')
      .send({ _csrf: csrf, reason: 'spam', note: `report ${i}` });
  }

  const hidden = await request(app).get(`/listing/${publicId}`);
  assert.equal(hidden.status, 410);
});
