'use strict';

const net = require('node:net');
const config = require('./config');
const { createApp } = require('./app');
const { expireStaleListings } = require('./db');

/**
 * Loopback is 127.0.0.0/8 and ::1, plus 127.x written as an IPv4-mapped IPv6
 * address. Everything else, the wildcards 0.0.0.0 and :: included, can be
 * reached from other machines.
 */
function isLoopback(address) {
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return net.isIPv4(v4) && v4.startsWith('127.');
}

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`${config.siteName} listening on http://${shown}:${config.port}`);
  if (!config.admin.passwordHash && !config.admin.plainPassword) {
    console.warn('No ADMIN_PASSWORD_HASH set — the moderation panel is disabled.');
  }
  // Judge the address actually bound, not the HOST string: '::', a public
  // address, or a hostname that resolves to one is as exposed as 0.0.0.0.
  const bound = server.address().address;
  if (config.trustProxy && !isLoopback(bound)) {
    console.warn(
      `TRUST_PROXY is on but this process is listening on ${bound}, which ` +
        'is not loopback. Anything that reaches this port without going ' +
        'through the proxy can set X-Forwarded-For and choose its own ' +
        'identity, which defeats rate limiting. Set HOST=127.0.0.1, or ' +
        'firewall the port.'
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
