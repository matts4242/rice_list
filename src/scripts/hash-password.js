'use strict';

// Usage: node src/scripts/hash-password.js 'my admin password'
const { hashPassword } = require('../lib/passwords');

const password = process.argv[2];
if (!password) {
  console.error("Usage: node src/scripts/hash-password.js 'your password'");
  process.exit(1);
}

console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
