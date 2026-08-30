'use strict';

const LIMITS = {
  title: { min: 4, max: 120 },
  description: { min: 10, max: 8000 },
  location: { max: 120 },
  email: { max: 200 },
  phone: { max: 40 },
  senderName: { min: 2, max: 80 },
  messageBody: { min: 10, max: 4000 },
  flagNote: { max: 500 },
  // Anything above this is almost certainly a typo or an attack.
  maxPriceCents: 100_000_000_00,
};

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function text(value) {
  if (typeof value !== 'string') return '';
  // Collapse whitespace runs so titles can't be padded to fake prominence.
  return value.replace(/\s+/g, ' ').trim();
}

function multilineText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function isEmail(value) {
  return EMAIL_RE.test(value) && value.length <= LIMITS.email.max;
}

/**
 * Parse a user-entered price into integer cents.
 * Returns { ok, cents } where cents === null means "contact for price".
 */
function parsePrice(raw) {
  const value = text(raw).replace(/[$,\s]/g, '');
  if (value === '') return { ok: true, cents: null };
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    return { ok: false, error: 'Price must be a number like 40 or 39.99.' };
  }
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents > LIMITS.maxPriceCents) {
    return { ok: false, error: 'Price is too large.' };
  }
  return { ok: true, cents };
}

function validateListing(input, categorySlugs) {
  const errors = {};
  const values = {
    title: text(input.title),
    description: multilineText(input.description),
    location: text(input.location),
    category: text(input.category),
    contactEmail: text(input.contact_email).toLowerCase(),
    contactPhone: text(input.contact_phone),
    showPhone: input.show_phone === 'on' || input.show_phone === true,
    priceRaw: text(input.price),
  };

  if (values.title.length < LIMITS.title.min) {
    errors.title = `Title must be at least ${LIMITS.title.min} characters.`;
  } else if (values.title.length > LIMITS.title.max) {
    errors.title = `Title must be ${LIMITS.title.max} characters or fewer.`;
  }

  if (values.description.length < LIMITS.description.min) {
    errors.description = `Description must be at least ${LIMITS.description.min} characters.`;
  } else if (values.description.length > LIMITS.description.max) {
    errors.description = `Description must be ${LIMITS.description.max} characters or fewer.`;
  }

  if (!categorySlugs.includes(values.category)) {
    errors.category = 'Choose a category.';
  }

  if (values.location.length > LIMITS.location.max) {
    errors.location = `Location must be ${LIMITS.location.max} characters or fewer.`;
  }

  if (!isEmail(values.contactEmail)) {
    errors.contact_email = 'Enter a valid email address.';
  }

  if (values.contactPhone.length > LIMITS.phone.max) {
    errors.contact_phone = 'Phone number is too long.';
  }
  if (values.showPhone && values.contactPhone === '') {
    errors.contact_phone = 'Add a phone number or uncheck "show my phone number".';
  }

  const price = parsePrice(values.priceRaw);
  if (!price.ok) {
    errors.price = price.error;
  } else {
    values.priceCents = price.cents;
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

function validateMessage(input) {
  const errors = {};
  const values = {
    senderName: text(input.sender_name),
    senderEmail: text(input.sender_email).toLowerCase(),
    body: multilineText(input.body),
  };

  if (values.senderName.length < LIMITS.senderName.min) {
    errors.sender_name = 'Enter your name.';
  } else if (values.senderName.length > LIMITS.senderName.max) {
    errors.sender_name = 'Name is too long.';
  }

  if (!isEmail(values.senderEmail)) {
    errors.sender_email = 'Enter a valid email address so the seller can reply.';
  }

  if (values.body.length < LIMITS.messageBody.min) {
    errors.body = `Message must be at least ${LIMITS.messageBody.min} characters.`;
  } else if (values.body.length > LIMITS.messageBody.max) {
    errors.body = `Message must be ${LIMITS.messageBody.max} characters or fewer.`;
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

module.exports = {
  LIMITS,
  text,
  multilineText,
  isEmail,
  parsePrice,
  validateListing,
  validateMessage,
};
