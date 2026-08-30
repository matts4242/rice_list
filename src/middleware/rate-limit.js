'use strict';

const rateLimit = require('express-rate-limit');

const config = require('../config');

function limiter({ max, windowMs, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Tests and local development would otherwise trip limits constantly.
    skip: () => process.env.DISABLE_RATE_LIMIT === '1',
    handler(req, res, next) {
      next(Object.assign(new Error(message), { status: 429, expose: true }));
    },
  });
}

const postLimiter = limiter({
  max: config.listings.postsPerHour,
  windowMs: 60 * 60 * 1000,
  message: 'You have posted a lot of ads recently. Please try again later.',
});

const messageLimiter = limiter({
  max: config.listings.messagesPerHour,
  windowMs: 60 * 60 * 1000,
  message: 'You have sent a lot of messages recently. Please try again later.',
});

const flagLimiter = limiter({
  max: 20,
  windowMs: 60 * 60 * 1000,
  message: 'Too many reports from this address. Please try again later.',
});

const loginLimiter = limiter({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: 'Too many login attempts. Please wait and try again.',
});

module.exports = { postLimiter, messageLimiter, flagLimiter, loginLimiter };
