'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Each test file gets its own throwaway database and upload directory. This
 * must run before anything requires src/config, which reads these at load.
 */
function useTempEnvironment(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rice-list-${label}-`));
  process.env.DATA_DIR = dir;
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.SESSION_SECRET = 'test-secret-not-used-in-production';
  process.env.ADMIN_PASSWORD = 'test-admin-password';
  process.env.DISABLE_RATE_LIMIT = '1';
  process.env.NODE_ENV = 'test';
  delete process.env.SMTP_HOST;
  return dir;
}

/** Pull the CSRF token out of a rendered form. */
function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('No CSRF token found in response body');
  return match[1];
}

/**
 * A tiny cookie-aware wrapper: supertest agents persist cookies, so this just
 * fetches a page and returns both its body and the token it carries.
 */
async function tokenFor(agent, url) {
  const response = await agent.get(url);
  return csrfFrom(response.text);
}

function validListing(overrides = {}) {
  return {
    title: 'Steel frame road bike in good condition',
    description:
      'A well maintained road bike with recent service history and new tyres.',
    category: 'for-sale',
    price: '250',
    location: 'Testville',
    contact_email: 'seller@example.com',
    contact_phone: '555-0100',
    ...overrides,
  };
}

module.exports = { useTempEnvironment, csrfFrom, tokenFor, validListing };
