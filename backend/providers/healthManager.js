'use strict';

/**
 * HealthManager — Tracks provider health and degrades failed providers.
 *
 * When a provider fails (429, 401, 403, 5xx, timeout), mark it as
 * degraded for a configurable period. During that period, skip it
 * in the fallback chain.
 *
 * Health states:
 *   'healthy'   — provider is operational
 *   'degraded'  — provider recently failed, skip for cooldown
 *   'dead'      — provider failed too many times, extended cooldown
 */

const DEFAULT_COOLDOWN_MS = 60000;      // 1 minute for first failure
const EXTENDED_COOLDOWN_MS = 300000;    // 5 minutes for repeated failures
const DEAD_THRESHOLD = 5;               // failures before marking as dead
const HEALTH_CHECK_INTERVAL_MS = 30000; // how often to re-check degraded providers

class ProviderHealth {
  constructor(name) {
    this.name = name;
    this.state = 'healthy';
    this.failures = 0;
    this.lastFailure = null;
    this.firstFailure = null;
    this.cooldownUntil = 0;
    this.lastError = null;
    this.lastErrorType = null;
    this.successCount = 0;
    this.totalAttempts = 0;
    this.retries = 0;
  }

  get isHealthy() {
    return this.state === 'healthy' || (this.state === 'degraded' && Date.now() >= this.cooldownUntil);
  }

  get remainingCooldownMs() {
    if (this.state === 'healthy') return 0;
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  get nextAttempt() {
    if (this.state === 'healthy') return null;
    return this.cooldownUntil;
  }

  recordSuccess() {
    this.successCount++;
    this.totalAttempts++;
    if (this.state !== 'healthy') {
      this.state = 'healthy';
      this.failures = 0;
      this.retries = 0;
      this.cooldownUntil = 0;
    }
  }

  recordFailure(errorType) {
    this.failures++;
    this.retries++;
    this.totalAttempts++;
    this.lastFailure = Date.now();
    this.lastErrorType = errorType;

    if (!this.firstFailure) this.firstFailure = Date.now();

    if (this.failures >= DEAD_THRESHOLD) {
      this.state = 'dead';
      this.cooldownUntil = Date.now() + EXTENDED_COOLDOWN_MS;
    } else {
      this.state = 'degraded';
      this.cooldownUntil = Date.now() + DEFAULT_COOLDOWN_MS;
    }
  }

  toJSON() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      retries: this.retries,
      successCount: this.successCount,
      totalAttempts: this.totalAttempts,
      lastErrorType: this.lastErrorType,
      firstFailure: this.firstFailure,
      lastFailure: this.lastFailure,
      remainingCooldownMs: this.remainingCooldownMs,
      nextAttempt: this.nextAttempt,
    };
  }
}

class HealthManager {
  constructor() {
    this._providers = new Map();
    this._errorClassifier = HealthManager.classifyError;
  }

  /**
   * Get or create health record for a provider.
   */
  getHealth(providerName) {
    if (!this._providers.has(providerName)) {
      this._providers.set(providerName, new ProviderHealth(providerName));
    }
    return this._providers.get(providerName);
  }

  /**
   * Check if a provider should be attempted.
   */
  isAvailable(providerName) {
    const health = this.getHealth(providerName);
    return health.isHealthy;
  }

  /**
   * Filter a list of provider entries to only healthy ones.
   * Returns providers in the same format as input, minus degraded/dead ones.
   */
  filterHealthy(providers) {
    return providers.filter(p => this.isAvailable(p.provider));
  }

  /**
   * Record a successful call.
   */
  recordSuccess(providerName) {
    this.getHealth(providerName).recordSuccess();
  }

  /**
   * Record a failed call with automatic error classification.
   */
  recordFailure(providerName, error) {
    const health = this.getHealth(providerName);
    const errorType = this._errorClassifier(error);
    health.recordFailure(errorType);

    if (process.env.DEBUG_ATTACHMENTS === 'true') {
      console.log(`  [HealthManager] ${providerName} marked as ${health.state} (failures: ${health.failures}, cooldown: ${health.remainingCooldownMs}ms, error: ${errorType})`);
    }
  }

  /**
   * Classify an error into a category for health tracking.
   */
  static classifyError(error) {
    const msg = (error?.message || '').toLowerCase();
    const status = error?.status || error?.statusCode || 0;

    if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
      return 'rate_limited';
    }
    if (status === 401 || status === 403 || msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
      return 'auth_error';
    }
    if (status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
      return 'not_found';
    }
    if (status >= 500 || msg.includes('500') || msg.includes('502') || msg.includes('503')) {
      return 'server_error';
    }
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('esockettimedout')) {
      return 'timeout';
    }
    if (msg.includes('econnrefused') || msg.includes('enotfound')) {
      return 'connection_error';
    }
    return 'unknown_error';
  }

  /**
   * Get status summary of all tracked providers.
   */
  getStatus() {
    const status = {};
    for (const [name, health] of this._providers) {
      status[name] = health.toJSON();
    }
    return status;
  }

  /**
   * Manually reset a provider's health.
   */
  reset(providerName) {
    this._providers.set(providerName, new ProviderHealth(providerName));
  }

  /**
   * Reset all providers.
   */
  resetAll() {
    this._providers.clear();
  }
}

// Singleton
let _instance = null;

function getHealthManager() {
  if (!_instance) {
    _instance = new HealthManager();
  }
  return _instance;
}

module.exports = { HealthManager, ProviderHealth, getHealthManager };
