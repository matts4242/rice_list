'use strict';

const nodemailer = require('nodemailer');

const config = require('../config');
const { escapeHtml } = require('./format');

let transport;
let transportReady = false;

function getTransport() {
  if (transport !== undefined) return transport;

  if (!config.smtp.host) {
    // No SMTP configured: messages are still stored and shown in the
    // seller's inbox, they just aren't emailed anywhere.
    transport = null;
    return transport;
  }

  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });
  transportReady = true;
  return transport;
}

function isEnabled() {
  return Boolean(getTransport()) && transportReady;
}

async function send({ to, subject, text, html, replyTo }) {
  const mailer = getTransport();
  if (!mailer) return { sent: false, reason: 'smtp-not-configured' };

  await mailer.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    html,
    replyTo,
  });
  return { sent: true };
}

function listingUrl(publicId) {
  return `${config.siteUrl}/listing/${publicId}`;
}

/** Relay a buyer's enquiry to the seller, with the buyer set as reply-to. */
async function sendContactEmail({ listing, message }) {
  const url = listingUrl(listing.public_id);
  const subject = `[${config.siteName}] New message about "${listing.title}"`;

  const text = [
    `${message.senderName} <${message.senderEmail}> sent you a message about your listing:`,
    '',
    listing.title,
    url,
    '',
    '---',
    message.body,
    '---',
    '',
    `Reply directly to this email to reach ${message.senderName}.`,
  ].join('\n');

  const html = `
    <p><strong>${escapeHtml(message.senderName)}</strong>
       (${escapeHtml(message.senderEmail)}) sent you a message about your listing:</p>
    <p><a href="${escapeHtml(url)}">${escapeHtml(listing.title)}</a></p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding:0 0 0 12px">
      ${escapeHtml(message.body).replace(/\n/g, '<br>')}
    </blockquote>
    <p>Reply directly to this email to reach ${escapeHtml(message.senderName)}.</p>
  `;

  return send({
    to: listing.contact_email,
    subject,
    text,
    html,
    replyTo: `${message.senderName} <${message.senderEmail}>`,
  });
}

/** Email the poster the secret link that lets them edit or delete the ad. */
async function sendManageLinkEmail({ listing, manageToken }) {
  const url = `${listingUrl(listing.public_id)}/manage?token=${encodeURIComponent(manageToken)}`;
  const subject = `[${config.siteName}] Your listing "${listing.title}"`;

  const text = [
    'Your listing is live:',
    listingUrl(listing.public_id),
    '',
    'Keep this private link to edit or delete it later:',
    url,
  ].join('\n');

  const html = `
    <p>Your listing is live: <a href="${escapeHtml(listingUrl(listing.public_id))}">${escapeHtml(listing.title)}</a></p>
    <p>Keep this private link to edit or delete it later:<br>
       <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
  `;

  return send({ to: listing.contact_email, subject, text, html });
}

/** Test seam: lets the suite swap in a recording transport. */
function _setTransportForTests(fake) {
  transport = fake;
  transportReady = Boolean(fake);
}

module.exports = {
  isEnabled,
  send,
  sendContactEmail,
  sendManageLinkEmail,
  _setTransportForTests,
};
