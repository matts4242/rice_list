'use strict';

const express = require('express');

const listings = require('../lib/listings');
const messages = require('../lib/messages');
const flags = require('../lib/flags');
const mailer = require('../lib/mailer');
const { validateMessage, text } = require('../lib/validate');
const { thumbFor } = require('../middleware/upload');
const { messageLimiter, flagLimiter } = require('../middleware/rate-limit');

const router = express.Router();

function loadActiveListing(req, res, next) {
  const listing = listings.byPublicId(req.params.publicId);
  if (!listing || listing.status !== 'active') {
    res.status(404).render('error', {
      title: 'Listing not found',
      status: 404,
      message: 'That listing is no longer available.',
    });
    return;
  }
  req.listing = listing;
  next();
}

/**
 * Contact the seller. The seller's address is never rendered publicly — the
 * message is stored for their inbox and relayed by email when SMTP is set up.
 */
router.post('/listing/:publicId/contact', messageLimiter, loadActiveListing, async (req, res) => {
  const { listing } = req;

  // Bots fill in every field they find; humans never see this one.
  if (text(req.body.website) !== '') {
    res.redirect(`/listing/${listing.public_id}?sent=1`);
    return;
  }

  const { ok, errors, values } = validateMessage(req.body);
  if (!ok) {
    res.status(400).render('listing', {
      title: listing.title,
      listing,
      similar: listings.similarListings(listing),
      thumbFor,
      contact: { values, errors },
    });
    return;
  }

  const messageId = messages.create(listing.id, values);

  try {
    const result = await mailer.sendContactEmail({ listing, message: values });
    messages.markRelayed(messageId, {
      relayed: result.sent,
      error: result.sent ? '' : result.reason || '',
    });
  } catch (error) {
    // A relay failure must not lose the message: it stays in the inbox the
    // seller reaches through their manage link.
    console.error('Failed to relay contact message:', error.message);
    messages.markRelayed(messageId, { relayed: false, error: error.message });
  }

  req.session.flash = {
    type: 'success',
    message: 'Your message has been sent to the seller.',
  };
  res.redirect(`/listing/${listing.public_id}`);
});

router.get('/listing/:publicId/report', loadActiveListing, (req, res) => {
  res.render('report', {
    title: 'Report this listing',
    listing: req.listing,
    errors: {},
    values: {},
  });
});

router.post('/listing/:publicId/report', flagLimiter, loadActiveListing, (req, res) => {
  const { listing } = req;
  const reason = text(req.body.reason);
  const note = text(req.body.note).slice(0, 500);

  if (!flags.REASON_KEYS.includes(reason)) {
    res.status(400).render('report', {
      title: 'Report this listing',
      listing,
      errors: { reason: 'Choose a reason for reporting this ad.' },
      values: { note },
    });
    return;
  }

  flags.create(listing.id, { reason, note });

  req.session.flash = {
    type: 'success',
    message: 'Thanks — this ad has been reported for review.',
  };
  res.redirect('/');
});

module.exports = router;
