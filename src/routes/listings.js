'use strict';

const express = require('express');
const multer = require('multer');

const config = require('../config');
const listings = require('../lib/listings');
const messages = require('../lib/messages');
const mailer = require('../lib/mailer');
const { expireStaleListings } = require('../db');
const { validateListing } = require('../lib/validate');
const { upload, processImages, deleteImages, thumbFor } = require('../middleware/upload');
const { verifyCsrf } = require('../middleware/csrf');
const { postLimiter } = require('../middleware/rate-limit');

const router = express.Router();

const imageUpload = upload.array('images', config.listings.maxImages);

/**
 * Parse an upload, then verify CSRF. This is the only multipart entry point in
 * the app, so folding the deferred CSRF check in here means an upload route
 * cannot accidentally skip it.
 */
function handleUpload(req, res, next) {
  imageUpload(req, res, (err) => {
    if (!err) {
      verifyCsrf(req, res, next);
      return;
    }
    if (err instanceof multer.MulterError) {
      const messagesByCode = {
        LIMIT_FILE_SIZE: `Each image must be under ${Math.floor(config.listings.maxImageBytes / (1024 * 1024))} MB.`,
        LIMIT_FILE_COUNT: `You can upload at most ${config.listings.maxImages} images.`,
        LIMIT_UNEXPECTED_FILE: 'Images must be JPEG, PNG, WebP or GIF files.',
      };
      req.uploadError = messagesByCode[err.code] || 'Those images could not be uploaded.';
      verifyCsrf(req, res, next);
      return;
    }
    next(err);
  });
}

function pageNumber(raw) {
  const page = Number.parseInt(raw, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

router.get('/', (req, res) => {
  expireStaleListings();

  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const categorySlug =
    typeof req.query.category === 'string' && req.query.category
      ? req.query.category
      : null;

  if (categorySlug && !listings.categoryBySlug(categorySlug)) {
    res.status(404).render('error', {
      title: 'Unknown category',
      status: 404,
      message: 'That category does not exist.',
    });
    return;
  }

  const result = listings.browse({
    categorySlug,
    search,
    page: pageNumber(req.query.page),
  });

  res.render('index', {
    title: categorySlug
      ? listings.categoryBySlug(categorySlug).name
      : 'Latest listings',
    search,
    categorySlug,
    thumbFor,
    ...result,
  });
});

router.get('/post', (req, res) => {
  res.render('post', {
    title: 'Post an ad',
    values: { showPhone: false },
    errors: {},
  });
});

router.post('/post', postLimiter, handleUpload, async (req, res, next) => {
  const categorySlugs = listings.allCategories().map((category) => category.slug);
  const { ok, errors, values } = validateListing(req.body, categorySlugs);

  if (req.uploadError) errors.images = req.uploadError;

  if (!ok || errors.images) {
    res.status(400).render('post', { title: 'Post an ad', values, errors });
    return;
  }

  let filenames = [];
  try {
    filenames = await processImages(req.files);
  } catch {
    res.status(400).render('post', {
      title: 'Post an ad',
      values,
      errors: { images: 'One of those images could not be read. Try a different file.' },
    });
    return;
  }

  let created;
  try {
    created = listings.create(values, filenames);
  } catch (error) {
    await deleteImages(filenames);
    next(error);
    return;
  }

  // The manage link is the poster's only way back in, so show it on screen
  // even when email delivery is unavailable or fails.
  let emailed = false;
  try {
    const result = await mailer.sendManageLinkEmail({
      listing: created.listing,
      manageToken: created.manageToken,
    });
    emailed = result.sent;
  } catch (error) {
    console.error('Failed to email manage link:', error.message);
  }

  req.session.flash = { type: 'success', message: 'Your ad is live.' };
  res.redirect(
    `/listing/${created.listing.public_id}/posted?token=${encodeURIComponent(created.manageToken)}&emailed=${emailed ? '1' : '0'}`
  );
});

router.get('/listing/:publicId/posted', (req, res) => {
  const listing = listings.byPublicId(req.params.publicId);
  if (!listing) {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That listing does not exist.',
    });
    return;
  }

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!listings.authenticateManageToken(listing.public_id, token)) {
    res.redirect(`/listing/${listing.public_id}`);
    return;
  }

  res.render('posted', {
    title: 'Your ad is live',
    listing,
    manageToken: token,
    emailed: req.query.emailed === '1',
  });
});

router.get('/listing/:publicId', (req, res) => {
  const listing = listings.byPublicId(req.params.publicId);
  if (!listing) {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That listing does not exist or has been removed.',
    });
    return;
  }

  if (listing.status !== 'active' && !req.session.isAdmin) {
    res.status(410).render('error', {
      title: 'Listing unavailable',
      status: 410,
      message:
        listing.status === 'expired'
          ? 'This listing has expired.'
          : 'This listing has been removed.',
    });
    return;
  }

  listings.recordView(listing.id);

  res.render('listing', {
    title: listing.title,
    listing,
    similar: listings.similarListings(listing),
    thumbFor,
    contact: { values: {}, errors: {} },
  });
});

// ---------------------------------------------------------------------------
// Manage (edit / delete / renew) — authenticated by the secret token only.
// ---------------------------------------------------------------------------

/**
 * Authenticate a manage request by its secret token. On multipart routes this
 * must run after the upload middleware, which is what parses the body the
 * token arrives in.
 */
function loadManagedListing(req, res, next) {
  const listing = listings.byPublicId(req.params.publicId);
  const token =
    (typeof req.query.token === 'string' && req.query.token) ||
    (typeof req.body?.token === 'string' && req.body.token) ||
    '';

  if (!listing || !listings.authenticateManageToken(req.params.publicId, token)) {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That management link is not valid. Check the link in your email.',
    });
    return;
  }

  req.listing = listing;
  req.manageToken = token;
  next();
}

router.get('/listing/:publicId/manage', loadManagedListing, (req, res) => {
  res.render('manage', {
    title: `Manage "${req.listing.title}"`,
    listing: req.listing,
    manageToken: req.manageToken,
    inbox: messages.forListing(req.listing.id),
    values: null,
    errors: {},
    thumbFor,
  });
});

router.post('/listing/:publicId/manage', handleUpload, loadManagedListing, async (req, res, next) => {
  const categorySlugs = listings.allCategories().map((category) => category.slug);
  const { ok, errors, values } = validateListing(req.body, categorySlugs);

  if (req.uploadError) errors.images = req.uploadError;

  if (!ok || errors.images) {
    res.status(400).render('manage', {
      title: `Manage "${req.listing.title}"`,
      listing: req.listing,
      manageToken: req.manageToken,
      inbox: messages.forListing(req.listing.id),
      values,
      errors,
      thumbFor,
    });
    return;
  }

  try {
    listings.update(req.listing.id, values);

    if (req.files && req.files.length > 0) {
      const filenames = await processImages(req.files);
      const previous = listings.imagesFor(req.listing.id).map((row) => row.filename);
      listings.replaceImages(req.listing.id, filenames);
      await deleteImages(previous);
    }
  } catch (error) {
    next(error);
    return;
  }

  req.session.flash = { type: 'success', message: 'Your ad has been updated.' };
  res.redirect(`/listing/${req.listing.public_id}/manage?token=${encodeURIComponent(req.manageToken)}`);
});

router.post('/listing/:publicId/renew', loadManagedListing, (req, res) => {
  listings.renew(req.listing.id);
  req.session.flash = {
    type: 'success',
    message: `Your ad is active again for another ${config.listings.expiryDays} days.`,
  };
  res.redirect(`/listing/${req.listing.public_id}/manage?token=${encodeURIComponent(req.manageToken)}`);
});

router.post('/listing/:publicId/delete', loadManagedListing, async (req, res, next) => {
  try {
    const images = listings.imagesFor(req.listing.id).map((row) => row.filename);
    listings.remove(req.listing.id);
    await deleteImages(images);
  } catch (error) {
    next(error);
    return;
  }
  req.session.flash = { type: 'success', message: 'Your ad has been deleted.' };
  res.redirect('/');
});

module.exports = router;
