#!/usr/bin/env node
// Hash an admin password to put into ADMIN_CREDENTIALS.
// Usage: node scripts/hash-password.mjs "plaintext-password"
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const [, , pw] = process.argv;
if (!pw) {
  console.error('Usage: node scripts/hash-password.mjs "<password>"');
  process.exit(1);
}
const N = 16384, r = 8, p = 1, keylen = 32, maxmem = 64 * 1024 * 1024;
const salt = randomBytes(16);
const key = await scrypt(pw, salt, keylen, { N, r, p, maxmem });
process.stdout.write(
  `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}\n`,
);
