/**
 * MemoryConsolidation — Phase 4 (Optimized)
 *
 * Handles memory consolidation (merging related memories) and intelligent
 * forgetting (decaying/removing irrelevant memories).
 *
 * Consolidation:
 *   Over time, a user accumulates many small memories. This module:
 *   1. Groups related memories (same category, similar content)
 *   2. Merges them into a single, richer memory
 *   3. Preserves all important information
 *   4. Increases the merged memory's importance
 *
 * Intelligent Forgetting:
 *   Not all memories should last forever. This module:
 *   1. Decays memories that haven't been accessed
 *   2. Removes memories that have become irrelevant (importance < threshold)
 *   3. Consolidates similar memories to reduce clutter
 *   4. Never forgets high-importance personal data or relationships
 *
 * Grouping algorithm (O(n·C + Σ m_i²) instead of O(n²)):
 *   1. Cluster memories by embedding cosine similarity (greedy centroids)
 *   2. Within each small cluster, find mergeable pairs via Union-Find + Jaccard
 *   3. Non-embedding memories fall back to Jaccard in a single unclustered group
 *
 * Design principles:
 *   1. Safety first: personal_data and high-importance memories are sacred
 *   2. Gradual decay: importance reduces slowly, never jumps
 *   3. Consolidation increases quality: merged memories are richer
 *   4. All operations are logged for debugging
 */

'use strict';

// ─── Default Configuration ──────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  similarityThreshold: 0.4,
  minGroupSize: 2,
  decayCheckIntervalDays: 7,
  obsoleteThreshold: 0.15,
  staleThresholdDays: 90,
  neverForgetTypes: ['personal_data', 'relationship'],
  neverForgetImportance: 0.7,
  maxMemoriesPerUser: 200,
};

// ─── Decay Schedule ─────────────────────────────────────────────────────────

const DECAY_SCHEDULE = [
  { maxDays: 7, factor: 1.0 },
  { maxDays: 30, factor: 0.9 },
  { maxDays: 60, factor: 0.7 },
  { maxDays: 90, factor: 0.5 },
  { maxDays: Infinity, factor: 0.3 },
];

// ─── MemoryConsolidation ────────────────────────────────────────────────────

class MemoryConsolidation {
  /**
   * @param {Object} db - Database interface
   * @param {Object} [config={}] - Configuration overrides
   * @param {Object} [embeddingService] - For cluster centroid computation
   */
  constructor(db, config = {}, embeddingService = null) {
    if (!db) {
      throw new Error('MemoryConsolidation requires a database instance');
    }
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embedding = embeddingService;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Main Entry Point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Runs a full consolidation cycle for a user:
   *   1. Find mergeable groups
   *   2. Merge each group
   *   3. Apply time-based decay
   *   4. Remove obsolete memories
   *
   * @param {string} userId - User identifier
   * @returns {{ merged: number, decayed: number, removed: number, kept: number }}
   */
  consolidate(userId) {
    const stats = { merged: 0, decayed: 0, removed: 0, kept: 0 };

    // Single query: get all memories grouped by type in JS
    const memories = this.db.getMemoriesByUser(userId, this.config.maxMemoriesPerUser);
    if (!memories || memories.length === 0) return stats;

    // Group by type
    const memoriesByType = new Map();
    for (const mem of memories) {
      const type = mem.type;
      if (!memoriesByType.has(type)) memoriesByType.set(type, []);
      memoriesByType.get(type).push(mem);
    }

    // Step 1+2: Find and merge groups
    const mergedIds = new Set();
    for (const [, typeMemories] of memoriesByType) {
      if (typeMemories.length < 2) continue;

      const groups = this._groupBySimilarity(typeMemories, this.config.similarityThreshold);
      for (const group of groups) {
        if (group.length >= this.config.minGroupSize) {
          const mergeResult = this._mergeGroup(group);
          if (mergeResult) {
            stats.merged++;
            for (const mem of group) {
              if (mem.id && mem.id !== mergeResult.id) {
                mergedIds.add(mem.id);
              }
            }
          }
        }
      }
    }

    // Step 3: Apply time-based decay
    const now = Date.now();
    for (const memory of memories) {
      if (mergedIds.has(memory.id)) continue;

      const decayFactor = this._calculateDecayFactor(memory);
      if (decayFactor < 1.0) {
        const oldImportance = memory.importance || 0.5;
        const newImportance = Math.max(0.05, oldImportance * decayFactor);

        if (newImportance !== oldImportance) {
          try {
            this.db.updateMemoryImportance(memory.id, newImportance);
            this.db.logMemoryDecay(memory.id, oldImportance, newImportance, `decay factor=${decayFactor}`);
          } catch {
            // Non-critical: log and continue
          }
          stats.decayed++;
        }
      }
    }

    // Step 4: Remove obsolete memories (DELETE instead of zombie rows)
    const obsolete = this._identifyObsolete(memories);
    for (const memory of obsolete) {
      if (mergedIds.has(memory.id)) continue;

      // Don't remove protected types or high-importance memories
      if (memory.type !== 'personal_data' && (memory.importance || 0) < this.config.obsoleteThreshold) {
        try {
          this.db.logMemoryDecay(memory.id, memory.importance || 0, 0, 'obsolete removed');
          this.db.deleteMemoryById(memory.id);
        } catch {
          // Non-critical
        }
        stats.removed++;
      }
    }

    // Step 5: Count remaining
    stats.kept = memories.length - stats.merged - stats.removed;

    return stats;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Consolidation: Grouping (Optimized — O(n·C + Σ m_i²))
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Groups memories by similarity using embedding-based clustering as a
   * pre-filter, then Union-Find + Jaccard within each small cluster.
   *
   * Complexity: O(n·C) for clustering + O(Σ m_i²) for within-cluster pairing,
   * where C = number of clusters and m_i = cluster size.
   * This replaces the previous O(n²) pairwise approach.
   *
   * @param {Array} memories - Memories of the same category
   * @param {number} threshold - Similarity threshold
   * @returns {Array<Array<Object>>} Groups of similar memories
   */
  _groupBySimilarity(memories, threshold) {
    if (memories.length < 2) return [];

    // Step 1: Partition memories into semantic clusters using embeddings
    const clusters = this._clusterMemories(memories, threshold);

    // Step 2: Within each cluster, find mergeable pairs via Union-Find + Jaccard
    const allGroups = [];
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const groups = this._jaccardUnionFind(cluster, threshold);
      allGroups.push(...groups);
    }

    return allGroups;
  }

  /**
   * Partitions memories into semantic clusters using embedding cosine similarity.
   * Uses a greedy centroid approach: each memory is assigned to the nearest
   * existing cluster if similar enough, otherwise a new cluster is created.
   *
   * Memories without embeddings are placed in a single "unclustered" group
   * that falls back to Jaccard pairing.
   *
   * @param {Array} memories - All memories of a type
   * @param {number} threshold - Minimum cosine similarity to join a cluster
   * @returns {Array<Array<Object>>} Array of clusters (each is an array of memories)
   */
  _clusterMemories(memories, threshold) {
    // No embedding service → single cluster (full Jaccard, same as before)
    if (!this.embedding || !this.embedding.isAvailable()) {
      return [memories];
    }

    const withEmb = [];
    const withoutEmb = [];

    for (const m of memories) {
      if (m.embedding) {
        const emb = this.embedding.fromBuffer(m.embedding);
        if (emb) {
          withEmb.push({ memory: m, embedding: emb });
        } else {
          withoutEmb.push(m);
        }
      } else {
        withoutEmb.push(m);
      }
    }

    // All without embeddings → single cluster
    if (withEmb.length === 0) return [memories];

    // Greedy centroid clustering: O(n × C)
    const clusters = []; // { centroid: Float32Array, members: Object[] }

    for (const { memory, embedding } of withEmb) {
      let bestIdx = -1;
      let bestSim = -1;

      for (let c = 0; c < clusters.length; c++) {
        const sim = this.embedding.cosineSimilarity(embedding, clusters[c].centroid);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = c;
        }
      }

      if (bestSim >= threshold && bestIdx >= 0) {
        const cl = clusters[bestIdx];
        cl.members.push(memory);
        // Update centroid via running average
        const n = cl.members.length;
        cl.centroid = this._runningAvg(cl.centroid, embedding, n - 1, n);
      } else {
        clusters.push({ centroid: embedding, members: [memory] });
      }
    }

    // Non-embedding memories go into a single unclustered group
    if (withoutEmb.length > 0) {
      clusters.push({ centroid: null, members: withoutEmb });
    }

    return clusters.map(c => c.members);
  }

  /**
   * Computes running average of two embeddings.
   * Used for online centroid updates when a new member joins a cluster.
   *
   * @param {Float32Array} existing - Current centroid
   * @param {Float32Array} incoming - New embedding
   * @param {number} oldCount - Number of existing members
   * @param {number} newCount - New total member count
   * @returns {Float32Array} Updated centroid
   */
  _runningAvg(existing, incoming, oldCount, newCount) {
    if (!existing) return incoming;
    if (existing.length !== incoming.length) return incoming;

    const result = new Float32Array(existing.length);
    for (let i = 0; i < existing.length; i++) {
      result[i] = (existing[i] * oldCount + incoming[i]) / newCount;
    }
    return result;
  }

  /**
   * Within a single cluster, finds mergeable groups using Union-Find
   * with Jaccard content similarity.
   *
   * Cluster sizes are small (typically < 20), so O(m²) Jaccard is acceptable.
   *
   * @param {Array} memories - Memories within one cluster
   * @param {number} threshold - Jaccard similarity threshold
   * @returns {Array<Array<Object>>} Groups of mergeable memories
   */
  _jaccardUnionFind(memories, threshold) {
    const n = memories.length;
    if (n < 2) return [];

    // Union-Find with path compression
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (i) => {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    };

    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    // Compare all pairs within this cluster
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!memories[i].content || !memories[j].content) continue;

        // Don't merge memories from the exact same message
        if (memories[i].created_at && memories[j].created_at &&
            memories[i].created_at === memories[j].created_at) continue;

        const sim = this._jaccardSimilarity(memories[i].content, memories[j].content);
        if (sim >= threshold) {
          union(i, j);
        }
      }
    }

    // Collect groups
    const groupMap = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groupMap.has(root)) groupMap.set(root, []);
      groupMap.get(root).push(memories[i]);
    }

    return [...groupMap.values()];
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Consolidation: Merging
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Merges a group of similar memories into a single, richer memory.
   *
   * @param {Array<Object>} group - Memories to merge (must be same category)
   * @returns {Object|null} The merged memory, or null on failure
   */
  _mergeGroup(group) {
    if (!group || group.length < 2) return null;

    // Select the primary memory (highest importance, then newest)
    const sorted = [...group].sort((a, b) => {
      const impDiff = (b.importance || 0.5) - (a.importance || 0.5);
      if (impDiff !== 0) return impDiff;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    const primary = sorted[0];
    const mergedContent = this._createMergedMemory(group);

    // Update the primary memory with merged content + metadata
    try {
      this.db.updateMemoryContent(primary.id, mergedContent.content);
      this.db.updateMemoryImportance(primary.id, mergedContent.importance);
      if (mergedContent.mentions) {
        this.db.updateMemoryMentionsCount(primary.id, mergedContent.mentions);
      }
      if (mergedContent.confidenceHistory && mergedContent.confidenceHistory.length > 0) {
        this.db.updateMemoryConfidenceHistory(primary.id, mergedContent.confidenceHistory);
      }
      if (mergedContent.temporalType) {
        this.db.updateMemoryTemporalType(primary.id, mergedContent.temporalType);
      }
      this.db.touchMemory(primary.id);
    } catch {
      return null;
    }

    // Remove the secondary memories (DELETE instead of zombie rows)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].id) {
        try {
          this.db.logMemoryDecay(sorted[i].id, sorted[i].importance || 0.5, 0, `merged into memory ${primary.id}`);
          this.db.deleteMemoryById(sorted[i].id);
        } catch {
          // Non-critical: secondary memory removal is best-effort
        }
      }
    }

    return { id: primary.id, ...mergedContent };
  }

  /**
   * Creates a merged memory from a group by selecting the best content,
   * combining entities, and computing new importance and confidence.
   * Also merges metadata: mentions, confidence_history, temporal_type.
   *
   * @param {Array<Object>} group - Memories to merge
   * @returns {{ content: string, importance: number, confidence: number, mentions: number, confidenceHistory: Array, temporalType: string }}
   */
  _createMergedMemory(group) {
    const content = this._selectBestContent(group);
    const importance = this._calculateNewImportance(group);
    const confidence = this._averageConfidence(group);

    // Merge metadata
    const totalMentions = group.reduce((sum, m) => sum + (m.mentions || 1), 0);

    // Merge confidence histories
    const allHistory = [];
    for (const m of group) {
      try {
        const h = JSON.parse(m.confidence_history || '[]');
        allHistory.push(...h);
      } catch (err) {
        // Non-critical: malformed confidence_history, skip entry
      }
    }
    // Keep last 20 entries, sorted by timestamp
    allHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const mergedHistory = allHistory.slice(-20);

    // Temporal type: prefer the most "permanent" classification
    const tempPriority = { permanent: 3, evolving: 2, temporary: 1 };
    let temporalType = 'permanent';
    for (const m of group) {
      const t = m.temporal_type || 'permanent';
      if ((tempPriority[t] || 0) > (tempPriority[temporalType] || 0)) {
        temporalType = t;
      }
    }

    return { content, importance, confidence, mentions: totalMentions, confidenceHistory: mergedHistory, temporalType };
  }

  /**
   * Extractive summarization: select the most informative sentences
   * from a group of memories. Instead of picking the longest content,
   * extract the best sentence from each memory and combine them.
   *
   * Sentence scoring:
   * - Length (longer = more information)
   * - Keyword density (proper nouns, entities)
   * - Uniqueness (not a duplicate of already-selected sentences)
   *
   * @param {Array<Object>} memories
   * @param {number} [maxSentences=3]
   * @returns {string} Combined extractive summary
   */
  _selectBestContent(memories, maxSentences = 3) {
    if (memories.length === 0) return '';
    if (memories.length === 1) return memories[0].content || '';

    // Step 1: Extract all sentences from all memories
    const allSentences = [];
    for (const mem of memories) {
      if (!mem.content) continue;
      const sentences = this._splitSentences(mem.content);
      for (const s of sentences) {
        allSentences.push({
          text: s.trim(),
          sourceId: mem.id,
          sourceImportance: mem.importance || 0.5,
        });
      }
    }

    if (allSentences.length === 0) return '';

    // Step 2: Score each sentence
    const scored = allSentences.map(s => ({
      ...s,
      score: this._scoreSentence(s.text, s.sourceImportance),
    }));

    // Step 3: Select top sentences, avoiding duplicates
    scored.sort((a, b) => b.score - a.score);
    const selected = [];
    const seenTexts = new Set();

    for (const s of scored) {
      if (selected.length >= maxSentences) break;
      const normalized = this._normalizeText(s.text);
      if (seenTexts.has(normalized)) continue;

      // Check overlap with already-selected sentences
      let isDuplicate = false;
      for (const prev of selected) {
        if (this._jaccardSimilarity(s.text, prev.text) > 0.6) {
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) continue;

      selected.push(s);
      seenTexts.add(normalized);
    }

    if (selected.length === 0) {
      // Fallback: return longest content
      return [...memories].sort((a, b) => (b.content || '').length - (a.content || '').length)[0].content || '';
    }

    return selected.map(s => s.text).join('; ');
  }

  /**
   * Split text into sentences.
   */
  _splitSentences(text) {
    return text
      .split(/(?<=[.!?;])\s+/)
      .filter(s => s.trim().length > 5);
  }

  /**
   * Score a sentence for information density.
   * Higher score = more informative.
   *
   * Factors:
   * - Length (longer = more info, up to a cap)
   * - Proper nouns / capitalized words (entities)
   * - Numbers (specific data points)
   * - Source memory importance
   */
  _scoreSentence(text, sourceImportance = 0.5) {
    let score = 0;

    // Length score: longer sentences tend to be more informative
    const wordCount = text.split(/\s+/).length;
    score += Math.min(wordCount / 15, 1.0) * 0.3;

    // Proper nouns (capitalized words that aren't sentence-start)
    const words = text.split(/\s+/);
    let properNounCount = 0;
    for (let i = 1; i < words.length; i++) {
      if (/^[A-ZÁÉÍÓÚÑ]/.test(words[i]) && words[i].length > 2) {
        properNounCount++;
      }
    }
    score += Math.min(properNounCount / 3, 1.0) * 0.3;

    // Numbers (specific data)
    const numberCount = (text.match(/\d+/g) || []).length;
    score += Math.min(numberCount / 2, 1.0) * 0.2;

    // Source importance boost
    score += sourceImportance * 0.2;

    return score;
  }

  /**
   * Normalize text for dedup comparison.
   */
  _normalizeText(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  }

  /**
   * Calculates a new importance score for a merged group.
   * Takes the max importance but boosts it slightly for consolidation.
   *
   * @param {Array<Object>} group
   * @returns {number}
   */
  _calculateNewImportance(group) {
    if (group.length === 0) return 0.5;

    const maxImportance = Math.max(...group.map((m) => m.importance || 0.5));
    // Boost for consolidation (more memories = more important)
    const boost = Math.min(0.1, group.length * 0.02);

    return Math.min(1.0, maxImportance + boost);
  }

  /**
   * Calculates average confidence across a group.
   *
   * @param {Array<Object>} group
   * @returns {number}
   */
  _averageConfidence(group) {
    if (group.length === 0) return 0.5;

    const sum = group.reduce((acc, m) => acc + (m.confidence || 0.5), 0);
    return sum / group.length;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Helpers: Forget Decision
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Determines if a memory should be forgotten.
   *
   * A memory should be forgotten if:
   *   - importance < threshold AND not a protected type
   *   - Not accessed in 90+ days AND importance < 0.3
   *   - access_count === 0 AND created 14+ days ago AND importance < 0.2
   *
   * BUT NEVER forget:
   *   - personal_data / relationship memories
   *   - memories with importance > neverForgetImportance (0.7)
   *   - memories accessed in last 7 days
   *
   * @param {Object} memory
   * @returns {boolean}
   */
  _shouldForget(memory) {
    if (!memory) return false;

    const type = memory.type || '';
    const importance = memory.importance || 0.5;
    const accessCount = memory.access_count || 0;

    const now = Date.now();
    const createdAt = memory.created_at ? new Date(memory.created_at).getTime() : now;
    const lastAccessed = memory.last_accessed
      ? new Date(memory.last_accessed).getTime()
      : createdAt;

    const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);
    const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);

    // ── Never forget rules ──

    // Protected types
    if (this.config.neverForgetTypes.includes(type)) return false;

    // High importance
    if (importance >= this.config.neverForgetImportance) return false;

    // Accessed recently
    if (daysSinceAccess < 7) return false;

    // ── Forget rules ──

    // Very low importance
    if (importance < this.config.obsoleteThreshold) return true;

    // Stale and low importance
    if (daysSinceAccess >= this.config.staleThresholdDays && importance < 0.3) return true;

    // Never accessed and old enough
    if (accessCount === 0 && daysSinceCreation >= 14 && importance < 0.2) return true;

    return false;
  }

  /**
   * Identifies memories that should be forgotten based on importance,
   * access patterns, and age.
   *
   * @param {Array} memories
   * @returns {Array<Object>} Memories identified as obsolete
   */
  _identifyObsolete(memories) {
    return memories.filter((mem) => this._shouldForget(mem));
  }

  /**
   * Calculates a decay factor based on time since last access.
   *
   * Schedule:
   *   < 7 days:   1.0 (no decay)
   *   < 30 days:  0.9
   *   < 60 days:  0.7
   *   < 90 days:  0.5
   *   >= 90 days: 0.3
   *
   * @param {Object} memory
   * @returns {number} Decay factor between 0.3 and 1.0
   */
  _calculateDecayFactor(memory) {
    const now = Date.now();
    const lastAccessed = memory.last_accessed
      ? new Date(memory.last_accessed).getTime()
      : memory.created_at
        ? new Date(memory.created_at).getTime()
        : now;

    const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);

    for (const { maxDays, factor } of DECAY_SCHEDULE) {
      if (daysSinceAccess < maxDays) return factor;
    }

    return DECAY_SCHEDULE[DECAY_SCHEDULE.length - 1].factor;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Helpers: Similarity
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Assign unclustered memories to semantic clusters.
   * Uses embedding cosine similarity to find the nearest cluster centroid.
   * Creates new clusters when no existing cluster is close enough.
   *
   * @param {string} userId
   * @param {number} [similarityThreshold=0.4] — min cosine similarity to assign
   * @returns {{ assigned: number, clustersCreated: number }}
   */
  async assignClusters(userId, similarityThreshold = 0.4) {
    if (!this.embedding || !this.embedding.isAvailable()) {
      return { assigned: 0, clustersCreated: 0 };
    }

    const unclustered = this.db.getUnclusteredMemories(userId, 50);
    if (unclustered.length === 0) return { assigned: 0, clustersCreated: 0 };

    const clusters = this.db.getClustersByUser(userId);
    let assigned = 0;
    let clustersCreated = 0;

    for (const mem of unclustered) {
      if (!mem.embedding) continue;
      const memEmbedding = this.embedding.fromBuffer(mem.embedding);
      if (!memEmbedding) continue;

      let bestCluster = null;
      let bestSimilarity = -1;

      // Find nearest cluster
      for (const cluster of clusters) {
        if (!cluster.centroid_embedding) continue;
        const centroid = this.embedding.fromBuffer(cluster.centroid_embedding);
        if (!centroid) continue;

        const sim = this.embedding.cosineSimilarity(memEmbedding, centroid);
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestCluster = cluster;
        }
      }

      if (bestCluster && bestSimilarity >= similarityThreshold) {
        // Assign to existing cluster
        this.db.updateMemoryCluster(mem.id, bestCluster.id);

        // Update centroid (running average)
        const oldCount = bestCluster.memory_count || 0;
        const newCount = oldCount + 1;
        const newCentroid = this._runningAvg(
          this.embedding.fromBuffer(bestCluster.centroid_embedding),
          memEmbedding,
          oldCount,
          newCount
        );
        if (newCentroid) {
          const buffer = this.embedding.toBuffer(newCentroid);
          this.db.updateClusterCentroid(bestCluster.id, buffer, newCount);
        }
        assigned++;
      } else {
        // Create new cluster from this memory
        const label = this._inferClusterLabel(mem.content || '');
        const buffer = this.embedding.toBuffer(memEmbedding);
        const newCluster = this.db.createCluster(userId, label, buffer);
        this.db.updateMemoryCluster(mem.id, newCluster.id);
        this.db.updateClusterCentroid(newCluster.id, buffer, 1, label);
        clusters.push({ id: newCluster.id, centroid_embedding: buffer, memory_count: 1 });
        clustersCreated++;
        assigned++;
      }
    }

    return { assigned, clustersCreated };
  }

  /**
   * Infer a cluster label from memory content.
   * Uses the most prominent keyword/entity in the text.
   */
  _inferClusterLabel(content) {
    if (!content) return 'general';
    const words = content.split(/\s+/).filter(w => w.length > 3);
    // Return the first meaningful word as a rough label
    return words[0]?.toLowerCase() || 'general';
  }

  /**
   * Calculates Jaccard similarity between two text strings (word-level).
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {number} Similarity between 0 and 1
   */
  _jaccardSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;

    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const w of words1) {
      if (words2.has(w)) intersection++;
    }

    const union = new Set([...words1, ...words2]).size;
    return union > 0 ? intersection / union : 0;
  }
}

module.exports = MemoryConsolidation;
