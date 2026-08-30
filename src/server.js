'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { expireStaleListings } = require('./db');

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`${config.siteName} listening on http://localhost:${config.port}`);
  if (!config.admin.passwordHash && !config.admin.plainPassword) {
    console.warn('No ADMIN_PASSWORD_HASH set — the moderation panel is disabled.');
  }
});

// Expiry is also enforced per browse request; this catches idle instances.
const expiryTimer = setInterval(expireStaleListings, 60 * 60 * 1000);
expiryTimer.unref();

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
