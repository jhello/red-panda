/**
 * Fixed-window in-memory rate limiter with automatic expiry pruning.
 */
export class RateLimiter {
  constructor({ max, windowMs = 10 * 60 * 1000, now = () => Date.now() }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  /** Check without incrementing. Prefer consume() so check and increment are atomic. */
  check(key) {
    const current = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= current) {
      this.entries.set(key, { count: 0, resetAt: current + this.windowMs });
      return true;
    }
    return entry.count < this.max;
  }

  /** Increment counter for key. Kept for compatibility; new code should use consume(). */
  note(key) {
    const current = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= current) {
      this.entries.set(key, { count: 1, resetAt: current + this.windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Atomically check and consume one slot. Returns true if allowed. */
  consume(key) {
    const current = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= current) {
      this.entries.set(key, { count: 1, resetAt: current + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  reset(key) {
    this.entries.delete(key);
  }

  /** Remove expired entries so long-running processes do not leak memory. */
  prune() {
    const current = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= current) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.entries.size;
  }
}
