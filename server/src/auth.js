import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function formatHash(salt, hash) {
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

function parseStoredHash(stored) {
  const [algo, n, r, p, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return null;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isFinite(N) || !Number.isFinite(R) || !Number.isFinite(P)) return null;
  return {
    N,
    r: R,
    p: P,
    salt: Buffer.from(saltB64, 'base64'),
    expected: Buffer.from(hashB64, 'base64'),
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return formatHash(salt, hash);
}

export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return formatHash(salt, Buffer.from(hash));
}

export function verifyPassword(password, stored) {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const actual = crypto.scryptSync(password, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return actual.length === parsed.expected.length && crypto.timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

export async function verifyPasswordAsync(password, stored) {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const actual = Buffer.from(
      await scryptAsync(password, parsed.salt, parsed.expected.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: SCRYPT_MAXMEM,
      }),
    );
    return actual.length === parsed.expected.length && crypto.timingSafeEqual(actual, parsed.expected);
  } catch {
    return false;
  }
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
