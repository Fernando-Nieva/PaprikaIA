/**
 * MemorySleepCycle — Off-peak memory maintenance (sole owner)
 *
 * Exclusive responsibilities:
 *   1. Importance recalculation (re-ranking)
 *   2. Consolidation (merge similar memories)
 *   3. Decay (intelligent forgetting)
 *   4. Re-embedding (regenerate missing embeddings)
 *   5. Clustering (update semantic clusters)
 *
 * Trigger: Core decides WHEN to run (conversation count threshold or scheduler).
 *          SleepCycle only executes — it never triggers itself.
 *
 * Execution: ALWAYS async, NEVER blocks the pipeline.
 *            The user never waits for a sleep cycle.
 *
 * Guard: Concurrent runs for the same user are prevented via _running Set.
 */

'use strict';

const DEFAULT_SLEEP_CONFIG = {
  maxMemoriesToProcess: 200,
  reEmbedBatchSize: 20,
  reEmbedMaxBatches: 10,
};

class MemorySleepCycle {
  /**
   * @param {Object} db - Database interface
   * @param {Object} memoryConsolidation - MemoryConsolidation instance
   * @param {Object} importanceCalculator - MemoryImportance instance
   * @param {Object} [embeddingService] - MemoryEmbeddingService (optional)
   * @param {Object} [config] - Override defaults
   * @param {Object} [telemetry] - MemoryTelemetry (optional)
   */
  constructor(db, memoryConsolidation, importanceCalculator, embeddingService = null, config = {}, telemetry = null) {
    this.db = db;
    this.consolidation = memoryConsolidation;
    this.importance = importanceCalculator;
    this.embedding = embeddingService;
    this.config = { ...DEFAULT_SLEEP_CONFIG, ...config };
    this.telemetry = telemetry;
    this._running = new Set();
  }

  /**
   * Whether a sleep cycle is currently in progress for a given user.
   * @param {string} userId
   * @returns {boolean}
   */
  isRunning(userId) {
    return this._running.has(userId);
  }

  // ─────────────────────────────────────────────
  //  Async trigger (fire-and-forget)
  // ─────────────────────────────────────────────

  /**
   * Trigger a sleep cycle asynchronously. Returns immediately.
   * Concurrent runs for the same user are silently skipped.
   *
   * Usage from Core:
   *   this.memorySleepCycle.triggerAsync(userId, context);
   *   // ^ does NOT block the pipeline
   *
   * @param {string} userId
   * @param {Object} [context] — { emotionalState, activeGoals, relationship }
   * @returns {Promise<void>}
   */
  triggerAsync(userId, context = {}) {
    if (this._running.has(userId)) {
      return Promise.resolve();
    }

    return this._runWithGuard(userId, context);
  }

  // ─────────────────────────────────────────────
  //  Full sleep cycle
  // ─────────────────────────────────────────────

  /**
   * Execute the full sleep cycle for a user.
   * This is the heavy, blocking operation — never call from the pipeline.
   *
   * @param {string} userId
   * @param {Object} [context] — { emotionalState, activeGoals, relationship }
   * @returns {Promise<SleepResult>}
   */
  async run(userId, context = {}) {
    if (this._running.has(userId)) {
      return { skipped: true, reason: 'already_running' };
    }

    return this._runWithGuard(userId, context);
  }

  /**
   * Internal: runs the cycle with a guard to prevent concurrent execution.
   * @private
   */
  async _runWithGuard(userId, context) {
    this._running.add(userId);
    const startTime = Date.now();
    const trace = this.telemetry ? this.telemetry.child(`sleep-${userId}-${Date.now()}`) : null;
    const stats = {
      userId,
      conversationCount: 0,
      importanceRecalculated: 0,
      merged: 0,
      decayed: 0,
      removed: 0,
      reEmbedded: 0,
      clustersUpdated: 0,
    };

    try {
      if (trace) trace.start('sleep');

      // Step 1: Recalculate importance for all memories (re-ranking)
      if (trace) trace.start('importance');
      stats.importanceRecalculated = this._recalculateAllImportance(userId, context);
      if (trace) trace.end('importance', { recalculated: stats.importanceRecalculated });

      // Step 2: Consolidation (merge similar + decay + remove obsolete)
      if (trace) trace.start('consolidation');
      const consolidationResult = this.consolidation.consolidate(userId);
      if (trace) trace.end('consolidation', consolidationResult);
      this.telemetry?.counter('consolidationRuns');
      stats.merged = consolidationResult.merged;
      stats.decayed = consolidationResult.decayed;
      stats.removed = consolidationResult.removed;

      // Step 3: Re-embed memories that lost their embeddings
      if (trace) trace.start('reembed');
      stats.reEmbedded = await this._reEmbedMissing(userId);
      if (trace) trace.end('reembed', { reEmbedded: stats.reEmbedded });

      // Step 4: Update semantic clusters
      if (trace) trace.start('clusters');
      const clusterResult = await this.consolidation.assignClusters(userId);
      if (trace) trace.end('clusters', clusterResult);
      stats.clustersUpdated = clusterResult.assigned;

      // Log the sleep cycle
      stats.conversationCount = this.db.getSleepLogCount(userId);
      stats.durationMs = Date.now() - startTime;
      this.db.addSleepLog(stats);

      if (trace) {
        trace.end('sleep', stats);
        this.telemetry.log('info', 'SleepCycle', `Completed for ${userId}`, stats);
      }

      console.log(`[SleepCycle] Completed for ${userId}: ${stats.merged} merged, ${stats.decayed} decayed, ${stats.removed} removed, ${stats.reEmbedded} re-embedded, ${stats.clustersUpdated} clustered (${stats.durationMs}ms)`);

    } catch (err) {
      console.error('[SleepCycle] Error:', err.message);
    } finally {
      this._running.delete(userId);
    }

    return stats;
  }

  // ─────────────────────────────────────────────
  //  Individual steps
  // ─────────────────────────────────────────────

  /**
   * Recalculate importance for all memories using ImportanceCalculator.
   * Only updates memories with meaningful delta (> 0.03).
   *
   * @param {string} userId
   * @param {Object} context
   * @returns {number} number of memories recalculated
   */
  _recalculateAllImportance(userId, context) {
    if (!this.importance) return 0;

    const memories = this.db.getAllMemoriesForUser(userId, this.config.maxMemoriesToProcess);
    if (memories.length === 0) return 0;

    const results = this.importance.calculateBatch(memories, context);
    const significant = this.importance.filterSignificantChanges(results, 0.03);

    let count = 0;
    for (const change of significant) {
      try {
        this.db.updateMemoryImportance(change.memoryId, change.newImportance);
        count++;
      } catch (err) {
        console.error('[SleepCycle] Importance update failed:', err.message);
      }
    }

    return count;
  }

  /**
   * Re-generate embeddings for memories that are missing theirs.
   * Uses batch processing with a max iterations limit to avoid blocking.
   *
   * @param {string} userId
   * @returns {Promise<number>} number of embeddings generated
   */
  async _reEmbedMissing(userId) {
    if (!this.embedding || !this.embedding.isAvailable()) return 0;

    let total = 0;
    const maxBatches = this.config.reEmbedMaxBatches;

    for (let batch = 0; batch < maxBatches; batch++) {
      const memories = this.db.getMemoriesWithoutEmbedding(userId, this.config.reEmbedBatchSize);
      if (memories.length === 0) break;

      const contents = memories.map(m => m.content || '');
      const embeddings = await this.embedding.generateBatch(contents);

      for (let i = 0; i < memories.length; i++) {
        if (embeddings[i]) {
          const buffer = this.embedding.toBuffer(embeddings[i]);
          this.db.updateMemoryEmbedding(memories[i].id, buffer);
          total++;
        }
      }
    }

    return total;
  }
}

module.exports = MemorySleepCycle;
