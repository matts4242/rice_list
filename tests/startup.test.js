'use strict';

/**
 * server.js warns at startup when TRUST_PROXY is on and the listener can be
 * reached from other machines. The check runs in the listen callback against
 * the address actually bound, so test it the way it runs: start the real
 * server in a child process on an ephemeral port and read what it prints.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const WARNING = /TRUST_PROXY is on/;

function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-list-startup-'));
  return new Promise((resolve, reject) => {
    // Run from the temp directory so dotenv cannot pick up a local .env.
    const child = spawn(process.execPath, [SERVER], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        PORT: '0',
        DATA_DIR: dir,
        SESSION_SECRET: 'test-secret-not-used-in-production',
        ADMIN_PASSWORD: 'test-admin-password',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      // Warnings are printed in the same callback as this line.
      if (stdout.includes('listening on')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(deadline);
      fs.rmSync(dir, { recursive: true, force: true });
      if (stdout.includes('listening on')) resolve(stderr);
      else reject(new Error(`server did not start:\n${stdout}${stderr}`));
    });
  });
}

function canBind(host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

const externalAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((iface) => iface.family === 'IPv4' && !iface.internal)?.address;

test('TRUST_PROXY on every IPv4 interface warns', async () => {
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: '0.0.0.0' });
  assert.match(stderr, WARNING);
});

test('TRUST_PROXY on a specific non-loopback address warns', {
  skip: !externalAddress && 'no non-loopback IPv4 interface',
}, async () => {
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: externalAddress });
  assert.match(stderr, WARNING);
});

test('TRUST_PROXY on the IPv6 wildcard warns', async (t) => {
  if (!(await canBind('::'))) {
    t.skip('IPv6 is not available here');
    return;
  }
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: '::' });
  assert.match(stderr, WARNING);
});

test('TRUST_PROXY on loopback stays quiet', async () => {
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: '127.0.0.1' });
  assert.doesNotMatch(stderr, WARNING);
});

test('TRUST_PROXY on another loopback address stays quiet', async (t) => {
  if (!(await canBind('127.0.0.2'))) {
    t.skip('127.0.0.2 is not usable here');
    return;
  }
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: '127.0.0.2' });
  assert.doesNotMatch(stderr, WARNING);
});

// A hostname is judged by the address it resolved to, 127.0.0.1 or ::1.
test('TRUST_PROXY on localhost stays quiet', async () => {
  const stderr = await startServer({ TRUST_PROXY: '1', HOST: 'localhost' });
  assert.doesNotMatch(stderr, WARNING);
});

test('every interface without TRUST_PROXY stays quiet', async () => {
  const stderr = await startServer({ TRUST_PROXY: '0', HOST: '0.0.0.0' });
  assert.doesNotMatch(stderr, WARNING);
});
