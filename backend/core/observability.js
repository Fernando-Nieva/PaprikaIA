/**
 * MemoryTelemetry — Structured observability for Paprika's memory subsystem.
 *
 * Provides:
 *   1. Per-request traces (step timings, pool counts, fallback flags)
 *   2. Global accumulated metrics (totals since startup)
 *   3. Structured log ring buffer (queryable via API)
 *   4. DEBUG mode toggle (console output when enabled)
 *
 * Usage:
 *   const telemetry = new MemoryTelemetry({ debug: true });
 *   const req = telemetry.child('req-123');
 *   req.start('search');
 *   // ... do work ...
 *   req.end('search', { candidates: 30, semanticUsed: true });
 *   telemetry.metric('pipeline.total', 1);
 *
 * Access:
 *   telemetry.getSnapshot()  — full metrics + recent logs
 *   telemetry.getLogs(50)    — last 50 structured logs
 */

'use strict';

const perfNow = typeof performance !== 'undefined' ? () => performance.now() : () => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};

const MAX_LOG_ENTRIES = 500;

class MemoryTelemetry {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.debug] — Enable DEBUG console output
   * @param {number}  [options.maxLogs] — Ring buffer size for logs
   */
  constructor(options = {}) {
    this.debug = options.debug || process.env.PAPRIKA_DEBUG === '1' || process.env.PAPRIKA_DEBUG === 'true';
    this._maxLogs = options.maxLogs || MAX_LOG_ENTRIES;

    // Global accumulated counters
    this._counters = {
      pipelineExecutions: 0,
      pipelineErrors: 0,
      sleepCycles: 0,
      sleepCycleErrors: 0,
      memorySearches: 0,
      embeddingGenerations: 0,
      embeddingBatchGenerations: 0,
      reflectionRuns: 0,
      consolidationRuns: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    // Global accumulators (for averaging)
    this._accumulators = {
      pipelineTotalMs: 0,
      searchTotalMs: 0,
      rankTotalMs: 0,
      reflectionTotalMs: 0,
      sleepTotalMs: 0,
      consolidationTotalMs: 0,
      embeddingTotalMs: 0,
    };

    // Structured log ring buffer
    this._logs = [];
  }

  // ─────────────────────────────────────────────
  //  Request-scoped child telemetry
  // ─────────────────────────────────────────────

  /**
   * Create a request-scoped child for per-pipeline tracing.
   * All metrics from the child are also aggregated into global counters.
   *
   * @param {string} requestId — Unique identifier for this request
   * @returns {RequestTrace}
   */
  child(requestId) {
    return new RequestTrace(this, requestId);
  }

  // ─────────────────────────────────────────────
  //  Global metric recording
  // ─────────────────────────────────────────────

  /**
   * Increment a global counter.
   * @param {string} name
   * @param {number} [delta=1]
   */
  counter(name, delta = 1) {
    this._counters[name] = (this._counters[name] || 0) + delta;
  }

  /**
   * Add to a global accumulator (for timing totals).
   * @param {string} name
   * @param {number} ms
   */
  accumulate(name, ms) {
    this._accumulators[name] = (this._accumulators[name] || 0) + ms;
  }

  // ─────────────────────────────────────────────
  //  Structured logging
  // ─────────────────────────────────────────────

  /**
   * Write a structured log entry.
   *
   * @param {string} level   — 'info' | 'warn' | 'error' | 'debug'
   * @param {string} module  — Module name (e.g. 'MemorySearch')
   * @param {string} message — Human-readable message
   * @param {Object} [data]  — Arbitrary structured data
   */
  log(level, module, message, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      module,
      message,
      ...data,
    };

    // Ring buffer
    this._logs.push(entry);
    if (this._logs.length > this._maxLogs) {
      this._logs.shift();
    }

    // DEBUG console output
    if (this.debug) {
      const prefix = `[Telemetry:${level.toUpperCase()}][${module}]`;
      const detail = Object.keys(data).length > 0 ? ' ' + JSON.stringify(data) : '';
      if (level === 'error') {
        console.error(`${prefix} ${message}${detail}`);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}${detail}`);
      } else {
        console.log(`${prefix} ${message}${detail}`);
      }
    }
  }

  // ─────────────────────────────────────────────
  //  Snapshot & retrieval
  // ─────────────────────────────────────────────

  /**
   * Returns a full snapshot of global metrics, accumulators, and log count.
   * @returns {Object}
   */
  getSnapshot() {
    const counters = { ...this._counters };
    const acc = { ...this._accumulators };

    // Compute averages where meaningful
    const averages = {};
    if (counters.pipelineExecutions > 0) {
      averages.pipelineAvgMs = Math.round(acc.pipelineTotalMs / counters.pipelineExecutions);
    }
    if (counters.memorySearches > 0) {
      averages.searchAvgMs = Math.round(acc.searchTotalMs / counters.memorySearches);
    }
    if (counters.reflectionRuns > 0) {
      averages.reflectionAvgMs = Math.round(acc.reflectionTotalMs / counters.reflectionRuns);
    }
    if (counters.consolidationRuns > 0) {
      averages.consolidationAvgMs = Math.round(acc.consolidationTotalMs / counters.consolidationRuns);
    }
    if (counters.sleepCycles > 0) {
      averages.sleepAvgMs = Math.round(acc.sleepTotalMs / counters.sleepCycles);
    }

    return {
      counters,
      accumulators: acc,
      averages,
      logCount: this._logs.length,
    };
  }

  /**
   * Returns the most recent log entries.
   * @param {number} [limit=50]
   * @returns {Array<Object>}
   */
  getLogs(limit = 50) {
    return this._logs.slice(-limit);
  }

  /**
   * Reset all counters, accumulators, and logs.
   */
  reset() {
    for (const key of Object.keys(this._counters)) {
      this._counters[key] = 0;
    }
    for (const key of Object.keys(this._accumulators)) {
      this._accumulators[key] = 0;
    }
    this._logs = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RequestTrace — per-request scoped telemetry
// ─────────────────────────────────────────────────────────────────────────────

class RequestTrace {
  /**
   * @param {MemoryTelemetry} parent
   * @param {string} requestId
   */
  constructor(parent, requestId) {
    this.parent = parent;
    this.requestId = requestId;
    this._startTimes = new Map();
    this._data = {};
  }

  /**
   * Start a named timer.
   * @param {string} name
   */
  start(name) {
    this._startTimes.set(name, perfNow());
  }

  /**
   * End a named timer, record elapsed ms in both the trace and global accumulator.
   * @param {string} name
   * @param {Object} [extraData] — Additional data to attach to the log
   * @returns {number} Elapsed milliseconds
   */
  end(name, extraData = {}) {
    const start = this._startTimes.get(name);
    if (start === undefined) return 0;

    const elapsed = Math.round(perfNow() - start);
    this._startTimes.delete(name);
    this._data[name] = { ms: elapsed, ...extraData };

    // Aggregate into parent global accumulators
    const accKey = this._resolveAccumulatorKey(name);
    if (accKey) {
      this.parent.accumulate(accKey, elapsed);
    }

    return elapsed;
  }

  /**
   * Record arbitrary data on this trace.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this._data[key] = value;
  }

  /**
   * Get a snapshot of all recorded trace data.
   * @returns {Object}
   */
  getTrace() {
    return {
      requestId: this.requestId,
      ...this._data,
    };
  }

  /**
   * Map a trace name to a global accumulator key.
   * @private
   */
  _resolveAccumulatorKey(name) {
    const map = {
      pipeline: 'pipelineTotalMs',
      search: 'searchTotalMs',
      rank: 'rankTotalMs',
      reflection: 'reflectionTotalMs',
      sleep: 'sleepTotalMs',
      consolidation: 'consolidationTotalMs',
      embedding: 'embeddingTotalMs',
    };
    return map[name] || null;
  }
}

module.exports = MemoryTelemetry;
