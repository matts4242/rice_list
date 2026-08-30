'use strict';

const express = require('express');

const config = require('../config');
const admin = require('../lib/admin');
const listings = require('../lib/listings');
const messages = require('../lib/messages');
const flags = require('../lib/flags');
const { verifyPassword } = require('../lib/passwords');
const { text } = require('../lib/validate');
const { requireAdmin } = require('../middleware/auth');
const { deleteImages, thumbFor } = require('../middleware/upload');
const { loginLimiter } = require('../middleware/rate-limit');

const router = express.Router();

/**
 * Accept either a scrypt hash (preferred) or a plaintext password from the
 * environment, so a first run needs no hashing step.
 */
function passwordIsValid(candidate) {
  if (config.admin.passwordHash) {
    return verifyPassword(candidate, config.admin.passwordHash);
  }
  if (config.admin.plainPassword) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(config.admin.plainPassword);
    return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
  }
  return false;
}

function adminIsConfigured() {
  return Boolean(config.admin.passwordHash || config.admin.plainPassword);
}

/** Only ever redirect to a path on this site. */
function safeNext(raw) {
  const value = typeof raw === 'string' ? raw : '';
  return value.startsWith('/') && !value.startsWith('//') ? value : '/admin';
}

router.get('/login', (req, res) => {
  if (req.session.isAdmin) {
    res.redirect('/admin');
    return;
  }
  res.render('admin/login', {
    title: 'Admin login',
    configured: adminIsConfigured(),
    error: null,
    next: safeNext(req.query.next),
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const nextPath = safeNext(req.body.next);

  if (!adminIsConfigured()) {
    res.status(503).render('admin/login', {
      title: 'Admin login',
      configured: false,
      error: null,
      next: nextPath,
    });
    return;
  }

  if (!passwordIsValid(String(req.body.password || ''))) {
    res.status(401).render('admin/login', {
      title: 'Admin login',
      configured: true,
      error: 'Incorrect password.',
      next: nextPath,
    });
    return;
  }

  // Rotate the session id so a pre-login cookie cannot become an admin one.
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).render('admin/login', {
        title: 'Admin login',
        configured: true,
        error: 'Could not start a session. Please try again.',
        next: nextPath,
      });
      return;
    }
    req.session.isAdmin = true;
    req.session.save(() => res.redirect(nextPath));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.use(requireAdmin);

router.get('/', (req, res) => {
  const filterKey = typeof req.query.filter === 'string' ? req.query.filter : 'flagged';
  const search = text(req.query.q);
  const page = Number.parseInt(req.query.page, 10) || 1;

  const result = admin.listFor(filterKey, { page, search });

  res.render('admin/dashboard', {
    title: 'Moderation',
    stats: admin.stats(),
    filters: admin.FILTERS,
    search,
    ...result,
  });
});

router.get('/listing/:publicId', (req, res) => {
  const listing = listings.byPublicId(req.params.publicId);
  if (!listing) {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That listing does not exist.',
    });
    return;
  }

  res.render('admin/listing', {
    title: `Review "${listing.title}"`,
    listing,
    reports: flags.forListing(listing.id),
    inbox: messages.forListing(listing.id),
    flagLabel: flags.labelFor,
    thumbFor,
  });
});

function loadListing(req, res, next) {
  const listing = listings.byPublicId(req.params.publicId);
  if (!listing) {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That listing does not exist.',
    });
    return;
  }
  req.listing = listing;
  next();
}

router.post('/listing/:publicId/remove', loadListing, (req, res) => {
  const reason = text(req.body.reason) || 'Removed by a moderator';
  listings.setStatus(req.listing.id, 'removed', reason);
  flags.resolveForListing(req.listing.id);
  req.session.flash = { type: 'success', message: `"${req.listing.title}" was removed.` };
  res.redirect(req.body.return_to === 'listing' ? `/admin/listing/${req.listing.public_id}` : '/admin');
});

router.post('/listing/:publicId/restore', loadListing, (req, res) => {
  listings.setStatus(req.listing.id, 'active', '');
  flags.resolveForListing(req.listing.id);
  req.session.flash = { type: 'success', message: `"${req.listing.title}" was restored.` };
  res.redirect(req.body.return_to === 'listing' ? `/admin/listing/${req.listing.public_id}` : '/admin');
});

router.post('/listing/:publicId/dismiss-reports', loadListing, (req, res) => {
  flags.resolveForListing(req.listing.id);
  req.session.flash = { type: 'success', message: 'Reports dismissed.' };
  res.redirect(req.body.return_to === 'listing' ? `/admin/listing/${req.listing.public_id}` : '/admin');
});

router.post('/listing/:publicId/delete', loadListing, async (req, res, next) => {
  try {
    const images = listings.imagesFor(req.listing.id).map((row) => row.filename);
    listings.remove(req.listing.id);
    await deleteImages(images);
  } catch (error) {
    next(error);
    return;
  }
  req.session.flash = {
    type: 'success',
    message: `"${req.listing.title}" was permanently deleted.`,
  };
  res.redirect('/admin');
});

module.exports = router;
