const {
  CARDTRADER_RATE_LIMIT_WINDOW_MS,
  CARDTRADER_RATE_LIMIT_MAX_REQUESTS,
  CARDTRADER_RATE_LIMIT_COOLDOWN_MS,
} = require("../config/config");
const { sleep, throwIfAborted } = require("../utils/abort");

class CardTraderRateLimiter {
  constructor({
    windowMs = CARDTRADER_RATE_LIMIT_WINDOW_MS,
    maxRequests = CARDTRADER_RATE_LIMIT_MAX_REQUESTS,
    cooldownMs = CARDTRADER_RATE_LIMIT_COOLDOWN_MS,
  } = {}) {
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.maxRequests = Math.max(1, Number(maxRequests) || 1);
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.minIntervalMs = Math.max(
      1,
      Math.ceil(this.windowMs / this.maxRequests),
    );
    this.requestTimestamps = [];
    this.blockedUntil = 0;
    this.nextScheduledAt = 0;
    this.smoothingEnabledUntil = 0;
  }

  prune(now = Date.now()) {
    while (
      this.requestTimestamps.length > 0 &&
      now - this.requestTimestamps[0] >= this.windowMs
    ) {
      this.requestTimestamps.shift();
    }
  }

  getNextAvailableAt(now = Date.now()) {
    this.prune(now);

    const cooldownAvailableAt = this.blockedUntil > now ? this.blockedUntil : now;
    const windowAvailableAt =
      this.requestTimestamps.length < this.maxRequests
        ? now
        : this.requestTimestamps[0] + this.windowMs;

    if (!this.isSmoothingActive(now)) {
      return Math.max(cooldownAvailableAt, windowAvailableAt);
    }

    const spacingAvailableAt =
      this.nextScheduledAt > now ? this.nextScheduledAt : now;

    return Math.max(cooldownAvailableAt, windowAvailableAt, spacingAvailableAt);
  }

  getWaitMs(now = Date.now()) {
    return Math.max(0, this.getNextAvailableAt(now) - now);
  }

  getBlockingAvailableAt(now = Date.now()) {
    this.prune(now);

    const cooldownAvailableAt = this.blockedUntil > now ? this.blockedUntil : now;
    const windowAvailableAt =
      this.requestTimestamps.length < this.maxRequests
        ? now
        : this.requestTimestamps[0] + this.windowMs;

    return Math.max(cooldownAvailableAt, windowAvailableAt);
  }

  reserveNextSlot(now = Date.now()) {
    if (!this.isSmoothingActive(now)) {
      return this.getBlockingAvailableAt(now);
    }

    const slotAt = this.getNextAvailableAt(now);
    this.nextScheduledAt = Math.max(this.nextScheduledAt, slotAt) + this.minIntervalMs;
    return slotAt;
  }

  isSmoothingActive(now = Date.now()) {
    return this.smoothingEnabledUntil > now;
  }

  getState(now = Date.now()) {
    this.prune(now);
    const nextAvailableAt = this.getNextAvailableAt(now);

    return {
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
      queuedRequestsInWindow: this.requestTimestamps.length,
      blockedUntil:
        this.blockedUntil > now
          ? new Date(this.blockedUntil).toISOString()
          : null,
      waitMs: Math.max(0, nextAvailableAt - now),
      nextAvailableAt: new Date(nextAvailableAt).toISOString(),
      minIntervalMs: this.minIntervalMs,
      smoothingActive: this.isSmoothingActive(now),
      smoothingEnabledUntil:
        this.smoothingEnabledUntil > now
          ? new Date(this.smoothingEnabledUntil).toISOString()
          : null,
      nextScheduledAt:
        this.nextScheduledAt > now
          ? new Date(this.nextScheduledAt).toISOString()
          : null,
    };
  }

  markRateLimited(retryAfterMs = 0) {
    const now = Date.now();
    const safeRetryAfterMs = Math.max(this.cooldownMs, Number(retryAfterMs) || 0);
    this.blockedUntil = Math.max(this.blockedUntil, now + safeRetryAfterMs);
    this.smoothingEnabledUntil = Math.max(
      this.smoothingEnabledUntil,
      now + Math.max(this.windowMs * 2, safeRetryAfterMs),
    );
  }

  reset() {
    this.requestTimestamps = [];
    this.blockedUntil = 0;
    this.nextScheduledAt = 0;
    this.smoothingEnabledUntil = 0;
  }

  async waitTurn({ signal } = {}) {
    while (true) {
      throwIfAborted(signal, "Richiesta CardTrader annullata.");
      const now = Date.now();
      const slotAt = this.reserveNextSlot(now);
      const waitMs = Math.max(0, slotAt - now);

      if (waitMs > 0) {
        await sleep(waitMs, signal);
      }

      throwIfAborted(signal, "Richiesta CardTrader annullata.");
      const readyAt = this.getBlockingAvailableAt();
      const remainingWaitMs = Math.max(0, readyAt - Date.now());
      if (remainingWaitMs > 0) {
        await sleep(remainingWaitMs, signal);
        continue;
      }

      this.requestTimestamps.push(Date.now());
      return;
    }
  }
}

const sharedLimiter = new CardTraderRateLimiter();

module.exports = sharedLimiter;
module.exports.CardTraderRateLimiter = CardTraderRateLimiter;
