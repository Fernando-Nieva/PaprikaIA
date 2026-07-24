/**
 * ConflictResolver — Phase 4
 *
 * Detects and resolves contradictions between memories, between memory and new
 * information, and between relationship data and recent interactions.
 *
 * Conflict types:
 *   1. memory_vs_message  — new info contradicts existing memory
 *   2. memory_vs_memory   — two memories in the same category conflict
 *   3. relationship       — relationship metrics contradict analysis signals
 *   4. staleness          — memory is old and likely outdated
 *
 * Resolution strategies:
 *   - update:   Replace old memory with newer, higher-confidence info
 *   - merge:    Combine two memories into one richer record
 *   - suppress: Keep higher-confidence memory, suppress the lower
 *   - review:   Flag for future manual resolution
 *   - dual:     Keep both with contradiction tags
 *
 * Design principles:
 *   1. Conservative: prefer review over auto-resolve when uncertain
 *   2. Recency wins: newer information with sufficient confidence replaces older
 *   3. Confidence wins: higher confidence takes priority when recency is equal
 *   4. Personal data is sacred: never auto-suppress personal_data memories
 *   5. All resolutions are logged for debugging
 */

'use strict';

// ─── Default Configuration ──────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  contradictionThreshold: 0.35,
  highConfidenceThreshold: 0.75,
  recencyBias: 0.6,
  confidenceBias: 0.4,
  minConfidenceForUpdate: 0.5,
  staleDaysThreshold: 60,
  autoResolveEnabled: true,
  neverSuppressTypes: ['personal_data'],
  maxMergeGroupSize: 3,
};

// ─── Contradiction Patterns ─────────────────────────────────────────────────

const NEGATION_PREFIXES = [
  /\bno\s+/i,
  /\bnunca\s+/i,
  /\bjamás\s+/i,
  /\btampoco\s+/i,
  /\bno\s+me\s+/i,
];

const INTENSIFIERS_NEGATIVE = [
  /\bodio\s+/i,
  /\bdesprecio\s+/i,
  /\baborrezco\s+/i,
  /\bme\s+da\s+asco\s+/i,
];

const PERSONAL_DATA_PATTERNS = {
  age: [
    { pattern: /tengo\s+(\d+)\s+años/i, extract: (m) => ({ field: 'age', value: parseInt(m[1], 10) }) },
  ],
  location: [
    { pattern: /vivo\s+en\s+(.+?)(?:\.|,|$)/i, extract: (m) => ({ field: 'location', value: m[1].trim().toLowerCase() }) },
    { pattern: /soy\s+de\s+(.+?)(?:\.|,|$)/i, extract: (m) => ({ field: 'origin', value: m[1].trim().toLowerCase() }) },
  ],
  name: [
    { pattern: /me\s+llamo\s+(\w+)/i, extract: (m) => ({ field: 'name', value: m[1].trim().toLowerCase() }) },
  ],
  work: [
    { pattern: /trabajo\s+en\s+(.+?)(?:\.|,|$)/i, extract: (m) => ({ field: 'workplace', value: m[1].trim().toLowerCase() }) },
  ],
};

const POSITIVE_SENTIMENT = /\b(gusta|encanta|amo|adoro|favorito|favorita|me\s+gusta|love|like|enjoy|prefer)\b/i;
const NEGATIVE_SENTIMENT = /\b(odio|no\s+me\s+gusta|hate|dislike|despise|detesto|aborrezco)\b/i;

// ─── ConflictResolver ───────────────────────────────────────────────────────

class ConflictResolver {
  /**
   * @param {Object} db - Database interface
   * @param {Object} [config={}] - Configuration overrides
   */
  constructor(db, config = {}) {
    if (!db) {
      throw new Error('ConflictResolver requires a database instance');
    }
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Main Entry Point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Detects and resolves conflicts between new analysis, existing memories,
   * and the current relationship state.
   *
   * @param {Object} params
   * @param {Object} params.analysis - Output from MessageAnalyzer
   * @param {Array}  params.memories - Existing memories from MemorySearch
   * @param {Object} params.classifiedMemories - Output from MemoryClassifier
   * @param {Object} params.relationship - Current relationship state
   * @returns {{ conflicts: Array, actions: Array, summary: string }}
   */
  resolve({ analysis, memories, classifiedMemories, relationship }) {
    const safeAnalysis = analysis || {};
    const safeMemories = memories || [];
    const safeClassified = classifiedMemories || { memories: [] };
    const safeRelationship = relationship || {};

    const conflicts = [];
    const actions = [];

    // 1. Memory vs new message
    const memVsMsg = this._detectMemoryVsMessage(
      this._extractNewMemoryFromAnalysis(safeAnalysis, safeClassified),
      safeMemories
    );
    for (const conflict of memVsMsg) {
      const resolution = this._resolveConflict(conflict);
      conflicts.push(resolution.conflict);
      actions.push(...resolution.actions);
    }

    // 2. Memory vs memory (within existing memories)
    const memVsMem = this._detectMemoryVsMemory(safeMemories);
    for (const conflict of memVsMem) {
      const resolution = this._resolveConflict(conflict);
      conflicts.push(resolution.conflict);
      actions.push(...resolution.actions);
    }

    // 3. Relationship vs analysis
    const relConflicts = this._detectRelationshipConflict(safeRelationship, safeAnalysis);
    for (const conflict of relConflicts) {
      const resolution = this._resolveConflict(conflict);
      conflicts.push(resolution.conflict);
      actions.push(...resolution.actions);
    }

    // 4. Staleness
    const staleConflicts = this._detectStaleness(safeMemories);
    for (const conflict of staleConflicts) {
      const resolution = this._resolveConflict(conflict);
      conflicts.push(resolution.conflict);
      actions.push(...resolution.actions);
    }

    const summary = this._buildSummary(conflicts);

    return { conflicts, actions, summary };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Detection: Memory vs Message
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Compares new information (from the current analysis) against existing
   * memories to detect contradictions.
   *
   * @param {Object|null} newMemory - Extracted new memory from current message
   * @param {Array} existingMemories - User's stored memories
   * @returns {Array<Object>} Detected conflicts
   */
  _detectMemoryVsMessage(newMemory, existingMemories) {
    const conflicts = [];
    if (!newMemory || !existingMemories.length) return conflicts;

    for (const existing of existingMemories) {
      if (!existing.content) continue;

      // Same category check
      const sameCategory = newMemory.category && existing.type === newMemory.category;

      // Contradiction check: explicit opposite meaning
      const isContradiction = this._isContradiction(newMemory.content, existing.content);

      // Sentiment inversion check
      const sentimentConflict = this._hasOppositeSentiment(newMemory.content, existing.content);

      // Personal data conflict (age, location, name mismatch)
      const personalDataConflict = this._isPersonalDataConflict(newMemory.content, existing.content);

      if (isContradiction || (sameCategory && sentimentConflict) || personalDataConflict) {
        const contradictionScore = this._calculateContradictionScore(newMemory.content, existing.content);

        conflicts.push({
          type: 'memory_vs_message',
          description: this._describeConflict('memory_vs_message', newMemory, existing),
          memory1: { ...newMemory, source: 'new_message' },
          memory2: existing,
          contradictionScore,
          resolution: null,
          resolvedMemory: null,
          confidence: 0,
        });
      }
    }

    return conflicts;
  }

  /**
   * Extracts a structured new-memory object from the analysis and classified
   * memories so it can be compared against existing memories.
   *
   * @param {Object} analysis
   * @param {Object} classifiedMemories
   * @returns {Object|null}
   */
  _extractNewMemoryFromAnalysis(analysis, classifiedMemories) {
    // Prefer classified memories (they have structured content)
    if (classifiedMemories.memories && classifiedMemories.memories.length > 0) {
      const first = classifiedMemories.memories[0];
      return {
        category: first.category || null,
        content: first.content || analysis.rawMessage || '',
        importance: first.importance || analysis.importance || 0.5,
        confidence: first.confidence || analysis.confidence || 0.5,
        createdAt: new Date().toISOString(),
      };
    }

    // Fallback: extract from raw analysis if it contains declarative info
    if (analysis.rawMessage && this._containsDeclarativeInfo(analysis.rawMessage)) {
      return {
        category: null,
        content: analysis.rawMessage,
        importance: analysis.importance || 0.5,
        confidence: analysis.confidence || 0.5,
        createdAt: new Date().toISOString(),
      };
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Detection: Memory vs Memory
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Detects contradictions between existing memories within the same category.
   *
   * @param {Array} memories - User's stored memories
   * @returns {Array<Object>} Detected conflicts
   */
  _detectMemoryVsMemory(memories) {
    const conflicts = [];
    if (!memories || memories.length < 2) return conflicts;

    // Group by type/category
    const byType = new Map();
    for (const mem of memories) {
      const type = mem.type || 'unknown';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(mem);
    }

    // Compare pairs within each category
    for (const [, group] of byType) {
      if (group.length < 2) continue;

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (!a.content || !b.content) continue;

          // Skip if both are from the same exact message
          if (a.created_at && b.created_at && a.created_at === b.created_at) continue;

          const isContradiction = this._isContradiction(a.content, b.content);
          const sentimentConflict = this._hasOppositeSentiment(a.content, b.content);
          const personalDataConflict = this._isPersonalDataConflict(a.content, b.content);

          // Same content is not a conflict — it's a duplicate (handled by consolidation)
          if (a.content.toLowerCase().trim() === b.content.toLowerCase().trim()) continue;

          if (isContradiction || sentimentConflict || personalDataConflict) {
            const contradictionScore = this._calculateContradictionScore(a.content, b.content);

            // Only report if the contradiction score is significant
            if (contradictionScore >= this.config.contradictionThreshold) {
              conflicts.push({
                type: 'memory_vs_memory',
                description: this._describeConflict('memory_vs_memory', a, b),
                memory1: a,
                memory2: b,
                contradictionScore,
                resolution: null,
                resolvedMemory: null,
                confidence: 0,
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Detection: Relationship vs Analysis
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Detects contradictions between stored relationship metrics and the
   * current analysis signals (e.g., trust is high but user expresses distrust).
   *
   * @param {Object} relationship - Current relationship state
   * @param {Object} analysis - Current analysis
   * @returns {Array<Object>} Detected conflicts
   */
  _detectRelationshipConflict(relationship, analysis) {
    const conflicts = [];
    if (!relationship || !analysis) return conflicts;

    const rawMessage = (analysis.rawMessage || '').toLowerCase();
    const emotionalState = analysis.emotionalState || {};

    // Trust vs distrust signals
    if (relationship.trustLevel >= 0.7) {
      const hasDistrust = /\b(no\s+confío|don'?t\s+trust|te\s+equivocas|estás\s+mal|no\s+me\s+gustas|no\s+te\s+creo)\b/i.test(rawMessage);
      if (hasDistrust) {
        conflicts.push({
          type: 'relationship',
          description: `Relationship trust is high (${relationship.trustLevel.toFixed(2)}) but user expressed distrust signal`,
          memory1: { content: `Trust level: ${relationship.trustLevel}`, source: 'relationship' },
          memory2: null,
          contradictionScore: 0.6,
          resolution: null,
          resolvedMemory: null,
          confidence: 0,
        });
      }
    }

    // Low trust but user expresses strong vulnerability/trust
    if (relationship.trustLevel < 0.4) {
      const hasTrustSignal = /\b(te\s+confío|confío\s+en\s+vos|sos\s+importante|gracias\s+por\s+todo)\b/i.test(rawMessage);
      if (hasTrustSignal) {
        conflicts.push({
          type: 'relationship',
          description: `Relationship trust is low (${relationship.trustLevel.toFixed(2)}) but user expressed trust signal`,
          memory1: { content: `Trust level: ${relationship.trustLevel}`, source: 'relationship' },
          memory2: null,
          contradictionScore: 0.5,
          resolution: null,
          resolvedMemory: null,
          confidence: 0,
        });
      }
    }

    // High familiarity but user acts distant/formal
    if (relationship.familiarity >= 0.7) {
      const isDistant = /\b(usted|señor|señora|con\s+permiso|disculpe)\b/i.test(rawMessage);
      if (isDistant && emotionalState.valence !== undefined && emotionalState.valence < -0.2) {
        conflicts.push({
          type: 'relationship',
          description: `Familiarity is high (${relationship.familiarity.toFixed(2)}) but user is being formal and distant`,
          memory1: { content: `Familiarity: ${relationship.familiarity}`, source: 'relationship' },
          memory2: null,
          contradictionScore: 0.4,
          resolution: null,
          resolvedMemory: null,
          confidence: 0,
        });
      }
    }

    return conflicts;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Detection: Staleness
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Identifies stale memories that may be outdated based on age and access
   * patterns.
   *
   * @param {Array} memories - User's stored memories
   * @returns {Array<Object>} Detected conflicts
   */
  _detectStaleness(memories) {
    const conflicts = [];
    if (!memories) return conflicts;

    const now = Date.now();
    const staleThresholdMs = this.config.staleDaysThreshold * 24 * 60 * 60 * 1000;

    for (const mem of memories) {
      if (!mem.id) continue;

      // Never flag personal_data as stale (it doesn't go out of date)
      if (mem.type === 'personal_data') continue;

      const createdAt = mem.created_at ? new Date(mem.created_at).getTime() : now;
      const lastAccessed = mem.last_accessed ? new Date(mem.last_accessed).getTime() : createdAt;
      const age = now - createdAt;
      const timeSinceAccess = now - lastAccessed;

      // Stale if old and not accessed recently
      if (age > staleThresholdMs && timeSinceAccess > staleThresholdMs) {
        const daysSinceAccess = Math.floor(timeSinceAccess / (1000 * 60 * 60 * 24));
        const daysSinceCreation = Math.floor(age / (1000 * 60 * 60 * 24));

        conflicts.push({
          type: 'staleness',
          description: `Memory "${(mem.content || '').substring(0, 50)}..." is ${daysSinceCreation} days old and hasn't been accessed in ${daysSinceAccess} days`,
          memory1: mem,
          memory2: null,
          contradictionScore: 0,
          resolution: null,
          resolvedMemory: null,
          confidence: 0,
        });
      }
    }

    return conflicts;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Resolution
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resolves a single conflict using the appropriate strategy.
   *
   * @param {Object} conflict - Detected conflict
   * @returns {{ conflict: Object, actions: Array }}
   */
  _resolveConflict(conflict) {
    const actions = [];

    switch (conflict.type) {
      case 'memory_vs_message':
        return this._resolveMemoryVsMessage(conflict);

      case 'memory_vs_memory':
        return this._resolveMemoryVsMemory(conflict);

      case 'relationship':
        return this._resolveRelationshipConflict(conflict);

      case 'staleness':
        return this._resolveStaleness(conflict);

      default:
        conflict.resolution = 'review';
        conflict.confidence = 0;
        return { conflict, actions };
    }
  }

  /**
   * Resolves memory-vs-message conflicts.
   * Strategy: update if new info is more recent and confident, else review.
   *
   * @param {Object} conflict
   * @returns {{ conflict: Object, actions: Array }}
   */
  _resolveMemoryVsMessage(conflict) {
    const actions = [];
    const newInfo = conflict.memory1;
    const existing = conflict.memory2;

    if (!this.config.autoResolveEnabled) {
      conflict.resolution = 'review';
      conflict.confidence = 0;
      return { conflict, actions };
    }

    const newIsNewer = this._isNewer(newInfo, existing);
    const newHasHigherConfidence = this._hasHigherConfidence(newInfo, existing);

    if (newIsNewer && newHasHigherConfidence) {
      // New info wins — update the existing memory
      conflict.resolution = 'update';
      conflict.confidence = this._calculateResolutionConfidence(newInfo, existing, 'update');
      conflict.resolvedMemory = {
        ...existing,
        content: newInfo.content,
        importance: Math.max(newInfo.importance || 0.5, existing.importance || 0.5),
        confidence: newInfo.confidence || existing.confidence,
        updated_at: new Date().toISOString(),
      };

      actions.push({
        type: 'update_memory',
        data: {
          memoryId: existing.id,
          updates: {
            content: newInfo.content,
            importance: conflict.resolvedMemory.importance,
            confidence: conflict.resolvedMemory.confidence,
          },
        },
      });
    } else if (newIsNewer || newHasHigherConfidence) {
      // Partial signal — merge if possible, else review
      if (this._canMerge(newInfo, existing)) {
        const merged = this._resolveMerge(newInfo, existing);
        conflict.resolution = 'merge';
        conflict.confidence = merged.confidence;
        conflict.resolvedMemory = merged.resolvedMemory;
        actions.push(...merged.actions);
      } else {
        conflict.resolution = 'review';
        conflict.confidence = 0.3;
        actions.push({
          type: 'flag_conflict',
          data: {
            conflictType: 'memory_vs_message',
            memory1: newInfo,
            memory2: existing,
            reason: 'Cannot determine which version is more reliable',
          },
        });
      }
    } else {
      // New info is older or less confident — suppress it
      conflict.resolution = 'suppress';
      conflict.confidence = 0.6;
      conflict.resolvedMemory = existing;
    }

    return { conflict, actions };
  }

  /**
   * Resolves memory-vs-memory conflicts.
   * Strategy: merge if possible, else suppress the lower-confidence one.
   *
   * @param {Object} conflict
   * @returns {{ conflict: Object, actions: Array }}
   */
  _resolveMemoryVsMemory(conflict) {
    const actions = [];
    const mem1 = conflict.memory1;
    const mem2 = conflict.memory2;

    if (!this.config.autoResolveEnabled) {
      conflict.resolution = 'review';
      conflict.confidence = 0;
      return { conflict, actions };
    }

    // Never auto-suppress personal_data
    const neverSuppress = this.config.neverSuppressTypes;
    if (neverSuppress.includes(mem1.type) || neverSuppress.includes(mem2.type)) {
      // For personal data conflicts, use dual storage
      conflict.resolution = 'dual';
      conflict.confidence = 0.5;
      conflict.resolvedMemory = null;
      actions.push({
        type: 'flag_conflict',
        data: {
          conflictType: 'memory_vs_memory',
          memory1: mem1,
          memory2: mem2,
          reason: 'Personal data conflict — both kept for manual review',
        },
      });
      return { conflict, actions };
    }

    // Try merge first
    if (this._canMerge(mem1, mem2)) {
      const merged = this._resolveMerge(mem1, mem2);
      conflict.resolution = 'merge';
      conflict.confidence = merged.confidence;
      conflict.resolvedMemory = merged.resolvedMemory;
      actions.push(...merged.actions);
    } else {
      // Suppress the lower-confidence one
      const suppressed = this._resolveSuppress(mem1, mem2);
      conflict.resolution = 'suppress';
      conflict.confidence = suppressed.confidence;
      conflict.resolvedMemory = suppressed.kept;
      actions.push(...suppressed.actions);
    }

    return { conflict, actions };
  }

  /**
   * Resolves relationship conflicts by flagging for review.
   * Relationship metrics should not be auto-corrected by conflict resolver;
   * the RelationshipEngine handles its own gradual updates.
   *
   * @param {Object} conflict
   * @returns {{ conflict: Object, actions: Array }}
   */
  _resolveRelationshipConflict(conflict) {
    const actions = [];

    conflict.resolution = 'review';
    conflict.confidence = 0.4;

    actions.push({
      type: 'flag_conflict',
      data: {
        conflictType: 'relationship',
        memory1: conflict.memory1,
        memory2: conflict.memory2,
        reason: conflict.description,
      },
    });

    return { conflict, actions };
  }

  /**
   * Resolves staleness conflicts.
   * Strategy: decay importance for old memories, flag very old ones for review.
   *
   * @param {Object} conflict
   * @returns {{ conflict: Object, actions: Array }}
   */
  _resolveStaleness(conflict) {
    const actions = [];
    const mem = conflict.memory1;

    if (!mem || !mem.id) {
      conflict.resolution = 'review';
      conflict.confidence = 0;
      return { conflict, actions };
    }

    // Calculate a gentle decay factor for stale memories
    const decayFactor = 0.85;
    const newImportance = Math.max(0.1, (mem.importance || 0.5) * decayFactor);

    conflict.resolution = 'update';
    conflict.confidence = 0.7;
    conflict.resolvedMemory = {
      ...mem,
      importance: newImportance,
    };

    actions.push({
      type: 'update_memory',
      data: {
        memoryId: mem.id,
        updates: { importance: newImportance },
      },
    });

    return { conflict, actions };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Resolution Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Merges two conflicting memories into one richer memory.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {{ resolvedMemory: Object, confidence: number, actions: Array }}
   */
  _resolveMerge(mem1, mem2) {
    const actions = [];
    const content = this._selectBestContent(mem1, mem2);
    const importance = Math.max(mem1.importance || 0.5, mem2.importance || 0.5);
    const confidence = ((mem1.confidence || 0.5) + (mem2.confidence || 0.5)) / 2;

    const resolvedMemory = {
      id: mem1.id || mem2.id,
      type: mem1.type || mem2.type,
      content,
      importance,
      confidence,
      updated_at: new Date().toISOString(),
    };

    // Update the surviving memory
    actions.push({
      type: 'merge_memories',
      data: {
        primaryId: mem1.id,
        secondaryId: mem2.id,
        mergedContent: content,
        mergedImportance: importance,
        mergedConfidence: confidence,
      },
    });

    return { resolvedMemory, confidence, actions };
  }

  /**
   * Suppresses the lower-confidence memory and keeps the higher one.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {{ kept: Object, suppressed: Object, confidence: number, actions: Array }}
   */
  _resolveSuppress(mem1, mem2) {
    const actions = [];
    const kept = this._hasHigherConfidence(mem1, mem2) ? mem1 : mem2;
    const suppressed = kept === mem1 ? mem2 : mem1;

    // Don't suppress if the suppressed memory is personal_data
    if (suppressed.type === 'personal_data') {
      return {
        kept: mem1,
        suppressed: mem2,
        confidence: 0.3,
        actions: [],
      };
    }

    const confidence = Math.abs((kept.confidence || 0.5) - (suppressed.confidence || 0.5)) + 0.3;

    actions.push({
      type: 'update_memory',
      data: {
        memoryId: suppressed.id,
        updates: {
          importance: Math.max(0.05, (suppressed.importance || 0.5) * 0.3),
        },
      },
    });

    return { kept, suppressed, confidence: Math.min(confidence, 1), actions };
  }

  /**
   * Decides whether two memories can be merged (rather than suppressed).
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {boolean}
   */
  _canMerge(mem1, mem2) {
    // Must be same category
    const type1 = mem1.type || mem1.category;
    const type2 = mem2.type || mem2.category;
    if (type1 && type2 && type1 !== type2) return false;

    // Must share some topical overlap
    const overlap = this._calculateContradictionScore(mem1.content || '', mem2.content || '');
    return overlap > 0.1 && overlap < 0.8;
  }

  /**
   * Selects the best content from two memories for a merged result.
   * Prefers the longer, more descriptive content.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {string}
   */
  _selectBestContent(mem1, mem2) {
    const c1 = mem1.content || '';
    const c2 = mem2.content || '';

    // If one is much longer, prefer it
    if (c1.length > c2.length * 1.5) return c1;
    if (c2.length > c1.length * 1.5) return c2;

    // Combine both
    const parts = [];
    if (c1) parts.push(c1.trim());
    if (c2 && c2.trim() !== c1.trim()) parts.push(c2.trim());

    return parts.join(' | ');
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Contradiction Detection
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Calculates a contradiction score between two text snippets.
   * Higher score = more likely contradictory.
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {number} Score between 0 and 1
   */
  _calculateContradictionScore(text1, text2) {
    if (!text1 || !text2) return 0;

    const lower1 = text1.toLowerCase();
    const lower2 = text2.toLowerCase();

    let score = 0;

    // Exact contradiction patterns
    if (this._isContradiction(text1, text2)) {
      score += 0.8;
    }

    // Opposite sentiment
    if (this._hasOppositeSentiment(text1, text2)) {
      score += 0.6;
    }

    // Personal data conflict
    if (this._isPersonalDataConflict(text1, text2)) {
      score += 0.7;
    }

    // Word overlap (partial — some overlap is needed for topical relevance)
    const words1 = new Set(lower1.split(/\s+/).filter((w) => w.length > 2));
    const words2 = new Set(lower2.split(/\s+/).filter((w) => w.length > 2));
    if (words1.size > 0 && words2.size > 0) {
      let intersection = 0;
      for (const w of words1) {
        if (words2.has(w)) intersection++;
      }
      const union = new Set([...words1, ...words2]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      // Some overlap is needed — completely different texts aren't contradictions
      if (jaccard < 0.05) {
        score *= 0.3; // Penalize unrelated texts
      } else if (jaccard > 0.6) {
        score *= 0.5; // Very similar texts are duplicates, not contradictions
      }
    }

    return Math.min(score, 1);
  }

  /**
   * Detects if two texts express opposite meanings using pattern matching.
   *
   * Checks for:
   *   - "me gusta X" vs "no me gusta X" / "odio X"
   *   - "tengo N años" vs "tengo M años"
   *   - "vivo en X" vs "vivo en Y"
   *   - "soy de X" vs "soy de Y"
   *   - "trabajo en X" vs "no trabajo en X"
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {boolean}
   */
  _isContradiction(text1, text2) {
    if (!text1 || !text2) return false;

    const lower1 = text1.toLowerCase().trim();
    const lower2 = text2.toLowerCase().trim();

    // Same topic, different value — age
    const age1 = lower1.match(/tengo\s+(\d+)\s+años/);
    const age2 = lower2.match(/tengo\s+(\d+)\s+años/);
    if (age1 && age2 && age1[1] !== age2[1]) return true;

    // Same topic, different value — location
    const loc1 = lower1.match(/vivo\s+en\s+(.+?)(?:\.|,|$)/);
    const loc2 = lower2.match(/vivo\s+en\s+(.+?)(?:\.|,|$)/);
    if (loc1 && loc2 && loc1[1].trim() !== loc2[1].trim()) return true;

    // Same topic, different value — origin
    const from1 = lower1.match(/soy\s+de\s+(.+?)(?:\.|,|$)/);
    const from2 = lower2.match(/soy\s+de\s+(.+?)(?:\.|,|$)/);
    if (from1 && from2 && from1[1].trim() !== from2[1].trim()) return true;

    // Same topic, different value — workplace
    const work1 = lower1.match(/trabajo\s+en\s+(.+?)(?:\.|,|$)/);
    const work2 = lower2.match(/trabajo\s+en\s+(.+?)(?:\.|,|$)/);
    if (work1 && work2 && work1[1].trim() !== work2[1].trim()) return true;

    // Positive vs negative about same entity
    const posNeg = this._hasOppositeSentiment(text1, text2);
    if (posNeg) return true;

    // Negation pattern: one text negates the other
    for (const negPrefix of NEGATION_PREFIXES) {
      const stripped1 = lower1.replace(negPrefix, '').trim();
      const stripped2 = lower2.replace(negPrefix, '').trim();

      // If removing the negation makes them similar, they're contradictions
      if (stripped1.length > 3 && stripped2.length > 3) {
        const similarity = this._jaccardWords(stripped1, stripped2);
        if (similarity > 0.6) return true;
      }
    }

    return false;
  }

  /**
   * Detects opposite sentiment between two texts.
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {boolean}
   */
  _hasOppositeSentiment(text1, text2) {
    const lower1 = text1.toLowerCase();
    const lower2 = text2.toLowerCase();

    const t1Positive = POSITIVE_SENTIMENT.test(lower1) && !NEGATIVE_SENTIMENT.test(lower1);
    const t1Negative = NEGATIVE_SENTIMENT.test(lower1) && !POSITIVE_SENTIMENT.test(lower1);
    const t2Positive = POSITIVE_SENTIMENT.test(lower2) && !NEGATIVE_SENTIMENT.test(lower2);
    const t2Negative = NEGATIVE_SENTIMENT.test(lower2) && !POSITIVE_SENTIMENT.test(lower2);

    return (t1Positive && t2Negative) || (t1Negative && t2Positive);
  }

  /**
   * Detects conflicts in personal data fields (different ages, locations, etc.)
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {boolean}
   */
  _isPersonalDataConflict(text1, text2) {
    if (!text1 || !text2) return false;

    const lower1 = text1.toLowerCase();
    const lower2 = text2.toLowerCase();

    // Check each personal data category
    for (const [, patterns] of Object.entries(PERSONAL_DATA_PATTERNS)) {
      for (const { pattern, extract } of patterns) {
        const match1 = lower1.match(pattern);
        const match2 = lower2.match(pattern);

        if (match1 && match2) {
          const data1 = extract(match1);
          const data2 = extract(match2);

          if (data1.field === data2.field && data1.value !== data2.value) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Determines if memory1 is newer than memory2.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {boolean}
   */
  _isNewer(mem1, mem2) {
    const date1 = mem1.createdAt || mem1.created_at || mem1.updated_at || '1970-01-01';
    const date2 = mem2.createdAt || mem2.created_at || mem2.updated_at || '1970-01-01';
    return new Date(date1) > new Date(date2);
  }

  /**
   * Determines if memory1 has higher confidence than memory2.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {boolean}
   */
  _hasHigherConfidence(mem1, mem2) {
    return (mem1.confidence || 0.5) > (mem2.confidence || 0.5);
  }

  /**
   * Calculates a confidence score for a resolution decision.
   *
   * @param {Object} mem1
   * @param {Object} mem2
   * @param {string} strategy - Resolution strategy used
   * @returns {number} Confidence between 0 and 1
   */
  _calculateResolutionConfidence(mem1, mem2, strategy) {
    let confidence = 0.5;

    const newer = this._isNewer(mem1, mem2) ? mem1 : mem2;
    const older = newer === mem1 ? mem2 : mem1;

    const recencyDiff = this._isNewer(mem1, mem2)
      ? this.config.recencyBias
      : 1 - this.config.recencyBias;

    const confDiff = Math.abs((mem1.confidence || 0.5) - (mem2.confidence || 0.5));

    confidence = (recencyDiff * this.config.recencyBias) + (confDiff * 3 * this.config.confidenceBias);

    if (strategy === 'merge') confidence *= 0.85;
    if (strategy === 'suppress') confidence *= 0.9;

    return Math.min(Math.max(confidence, 0.1), 1);
  }

  /**
   * Jaccard similarity between two text strings (word-level).
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {number} Similarity between 0 and 1
   */
  _jaccardWords(text1, text2) {
    const words1 = new Set(text1.split(/\s+/).filter((w) => w.length > 2));
    const words2 = new Set(text2.split(/\s+/).filter((w) => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const w of words1) {
      if (words2.has(w)) intersection++;
    }

    const union = new Set([...words1, ...words2]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Checks if a message contains declarative information worth extracting.
   *
   * @param {string} message
   * @returns {boolean}
   */
  _containsDeclarativeInfo(message) {
    const lower = message.toLowerCase();
    const declarativePatterns = [
      /\bme\s+llamo\s+/i,
      /\btengo\s+\d+\s+años/i,
      /\bvivo\s+en\s+/i,
      /\bsoy\s+de\s+/i,
      /\bme\s+(gusta|encanta|amo|odio)\s+/i,
      /\btrabajo\s+en\s+/i,
      /\bestudio\s+(en|puedo)/i,
    ];
    return declarativePatterns.some((p) => p.test(lower));
  }

  /**
   * Builds a human-readable description of a conflict.
   *
   * @param {string} type - Conflict type
   * @param {Object} mem1
   * @param {Object} mem2
   * @returns {string}
   */
  _describeConflict(type, mem1, mem2) {
    const c1 = (mem1.content || '').substring(0, 60);
    const c2 = mem2 ? (mem2.content || '').substring(0, 60) : null;

    switch (type) {
      case 'memory_vs_message':
        return `New message contradicts existing memory: "${c1}" vs "${c2}"`;
      case 'memory_vs_memory':
        return `Two memories contradict each other: "${c1}" vs "${c2}"`;
      case 'relationship':
        return mem1.content || 'Relationship metric contradicts analysis';
      case 'staleness':
        return `Memory may be outdated: "${c1}"`;
      default:
        return `Unknown conflict type: ${type}`;
    }
  }

  /**
   * Builds a human-readable summary of all detected conflicts.
   *
   * @param {Array} conflicts
   * @returns {string}
   */
  _buildSummary(conflicts) {
    if (conflicts.length === 0) return 'No conflicts detected';

    const byType = {};
    for (const c of conflicts) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }

    const parts = [];
    for (const [type, count] of Object.entries(byType)) {
      parts.push(`${count} ${type.replace(/_/g, ' ')}`);
    }

    const resolved = conflicts.filter((c) => c.resolution && c.resolution !== 'review').length;
    const flagged = conflicts.filter((c) => c.resolution === 'review').length;

    return `${conflicts.length} conflict(s) detected: ${parts.join(', ')}. ${resolved} resolved, ${flagged} flagged for review.`;
  }
}

module.exports = ConflictResolver;
