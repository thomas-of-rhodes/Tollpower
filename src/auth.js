// PIN protection for the installer area.

import crypto from 'node:crypto';

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

export class Sessions {
  constructor() {
    this.sessions = new Map();
    this.fails = 0;
    this.lockedUntil = 0;
  }

  create() {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_HOURS * 3600e3);
    return token;
  }

  valid(token) {
    const exp = token && this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token) {
    this.sessions.delete(token);
  }

  destroyAll() {
    this.sessions.clear();
  }

  /** Returns null if allowed, or a message if locked out. */
  lockMessage() {
    if (Date.now() < this.lockedUntil) {
      const mins = Math.ceil((this.lockedUntil - Date.now()) / 60000);
      return `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
    }
    return null;
  }

  recordFailure() {
    this.fails++;
    if (this.fails >= MAX_FAILS) {
      this.fails = 0;
      this.lockedUntil = Date.now() + LOCK_MINUTES * 60e3;
    }
  }

  recordSuccess() {
    this.fails = 0;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
