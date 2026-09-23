'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { expireStaleListings } = require('./db');

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`${config.siteName} listening on http://${shown}:${config.port}`);
  if (!config.admin.passwordHash && !config.admin.plainPassword) {
    console.warn('No ADMIN_PASSWORD_HASH set — the moderation panel is disabled.');
  }
  if (config.trustProxy && config.host === '0.0.0.0') {
    console.warn(
      'TRUST_PROXY is on but this process is listening on every interface. ' +
        'Anything that reaches this port without going through the proxy can ' +
        'set X-Forwarded-For and choose its own identity, which defeats rate ' +
        'limiting. Set HOST=127.0.0.1, or firewall the port.'
    );
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
