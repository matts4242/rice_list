'use strict';

const net = require('node:net');

// IPv6 subscribers are routinely handed a /64 or more — a VPS gets one, most
// residential lines get a /56 — so a full IPv6 address names one of 2^64
// interchangeable identities, not one client. /56 is the prefix
// express-rate-limit itself defaults to.
const IPV6_PREFIX_BITS = 56;

/** The eight 16-bit groups of an IPv6 address, '::' expanded. */
function ipv6Groups(address) {
  let addr = address.split('%')[0]; // drop a zone index (fe80::1%eth0)

  // An embedded dotted quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last
  // two groups written in decimal.
  const quad = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    addr = `${addr.slice(0, -quad[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = addr.split('::');
  const headGroups = head ? head.split(':') : [];
  if (tail === undefined) return headGroups.map((group) => Number.parseInt(group, 16));

  const tailGroups = tail ? tail.split(':') : [];
  const zeros = new Array(8 - headGroups.length - tailGroups.length).fill('0');
  return [...headGroups, ...zeros, ...tailGroups].map((group) => Number.parseInt(group, 16));
}

/**
 * The identity a rate limit or a report is attributed to: an IPv4 address as
 * is, an IPv6 address reduced to its /56 prefix. IPv4-mapped addresses
 * (::ffff:a.b.c.d — how a dual-stack socket reports IPv4 clients) are
 * unmapped first; masking them instead would put every IPv4 client in the
 * same ::/56 bucket.
 */
function clientKey(ip) {
  const address = String(ip || '');
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!net.isIPv6(address)) return address;

  const groups = ipv6Groups(address);
  const prefix = [];
  let bits = IPV6_PREFIX_BITS;
  for (const group of groups) {
    if (bits <= 0) break;
    const keep = Math.min(16, bits);
    prefix.push((group & (0xffff << (16 - keep)) & 0xffff).toString(16));
    bits -= keep;
  }
  return `${prefix.join(':')}::/${IPV6_PREFIX_BITS}`;
}

module.exports = { clientKey, IPV6_PREFIX_BITS };
