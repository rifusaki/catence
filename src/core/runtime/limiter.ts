export type RateLimit = { requests: number; windowSeconds: number };

export class SlidingWindowLimiter {
  private readonly entries = new Map<string, number[]>();

  check(key: string, limit: RateLimit | null, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    if (!limit) return { allowed: true };
    const windowMs = limit.windowSeconds * 1_000;
    const recent = (this.entries.get(key) ?? []).filter((entry) => entry > now - windowMs);
    if (recent.length >= limit.requests) {
      this.entries.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1_000)) };
    }
    recent.push(now);
    this.entries.set(key, recent);
    return { allowed: true };
  }
}
