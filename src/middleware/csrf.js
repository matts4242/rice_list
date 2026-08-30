'use strict';

const crypto = require('node:crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isMultipart(req) {
  return (req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
}

function tokenIsValid(req) {
  const supplied = req.body?._csrf || req.get('x-csrf-token') || '';
  const expected = req.session?.csrfToken || '';
  const suppliedBuf = Buffer.from(String(supplied));
  const expectedBuf = Buffer.from(String(expected));
  return (
    expectedBuf.length > 0 &&
    suppliedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(suppliedBuf, expectedBuf)
  );
}

function reject(next) {
  next(
    Object.assign(new Error('Your form session expired. Please try again.'), {
      status: 403,
      expose: true,
    })
  );
}

/**
 * Per-session CSRF token, checked on every state-changing request.
 * Kept in-house rather than pulling in a deprecated csurf-style dependency.
 *
 * Multipart bodies are not parsed yet at this point in the chain — multer
 * runs inside the route — so those requests are marked deferred and verified
 * by verifyCsrf once the body exists.
 */
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  if (isMultipart(req)) {
    req.csrfDeferred = true;
    next();
    return;
  }

  if (!tokenIsValid(req)) {
    reject(next);
    return;
  }
  next();
}

/** Verify a deferred multipart token. Safe to call more than once. */
function verifyCsrf(req, res, next) {
  if (!req.csrfDeferred) {
    next();
    return;
  }
  if (!tokenIsValid(req)) {
    reject(next);
    return;
  }
  req.csrfDeferred = false;
  next();
}

module.exports = { csrf, verifyCsrf };
