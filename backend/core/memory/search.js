/**
 * MemorySearch — Multi-pool candidate retrieval engine
 *
 * This module is ONLY responsible for retrieving raw memory candidates.
 * It does NOT score or rank — that responsibility belongs entirely to ContextRanker.
 *
 * Retrieval strategy (semantic-first, keyword-last):
 *   Pool 1: Essential memories (always included — personal_data, relationship, person)
 *   Pool 2: Recent memories (last 7 days — temporal relevance)
 *   Pool 3: Semantic matches (embedding cosine similarity — PRIMARY signal)
 *   Pool 4: FTS5 keyword matches (full-text search — SECONDARY signal)
 *   Pool 5: Category structural (only when category filter specified)
 *
 * All pools are deduplicated by memory ID. Essential memories are always present.
 * keywordScore is computed ONLY when embedding service is unavailable (ContextRanker fallback).
 */

const ESSENTIAL_TYPES = ['personal_data', 'relationship', 'person'];
const ESSENTIAL_IMPORTANCE_THRESHOLD = 0.85;
const RECENT_DAYS = 7;
const SEMANTIC_MIN_SCORE = 0.25;

class MemorySearch {
  /**
   * @param {Object} db - Database helpers
   * @param {Object} config - Configuration
   * @param {Object|null} embeddingService - FastEmbed service (for semantic search)
   * @param {Object|null} goalEngine - GoalEngine (reserved)
   * @param {Object|null} relationshipEngine - RelationshipEngine (reserved)
   */
  constructor(db, config, embeddingService = null, goalEngine = null, relationshipEngine = null) {
    this.db = db;
    this.config = config;
    this.embedding = embeddingService;
    this.goals = goalEngine;
    this.relationship = relationshipEngine;
  }

  // ─────────────────────────────────────────────
  //  Main search — 5 pools, zero ranking
  // ─────────────────────────────────────────────

  /**
   * Retrieve memory candidates for a query.
   *
   * No scoring, no sorting by relevance — ContextRanker handles all ranking.
   * Essential memories are always first in the result set.
   *
   * @param {string} query - Search text
   * @param {string} userId - User identifier
   * @param {Object} [options]
   * @param {number}  [options.limit=20] - Max total candidates
   * @param {string}  [options.category] - Filter by memory type (Pool 5)
   * @param {string}  [options.contextTopic] - Topic context (reserved)
   * @returns {Promise<{memories: Array, queryEmbedding: Float32Array|null}>} Raw memories + query embedding
   */
  async search(query, userId, options = {}) {
    const { limit = 30, category } = options;

    try {
      const hasQuery = query && query.trim().length > 0;
      const semanticAvailable = await this._isSemanticAvailable();

      // ── Pool 1: Essential memories (always included) ──
      const essential = this.db.getMemoriesEssential(
        userId, ESSENTIAL_TYPES, ESSENTIAL_IMPORTANCE_THRESHOLD, 15
      );
      const essentialIds = new Set(essential.map(m => m.id));

      if (!hasQuery) {
        // No query: return essential + recent, no semantic/keyword
        const recent = this.db.getRecentMemories(userId, RECENT_DAYS, limit);
        const recentNonEssential = recent.filter(m => !essentialIds.has(m.id));
        const memories = this._attachKeywordScoreIfFallback(
          [...essential, ...recentNonEssential].slice(0, limit),
          null, semanticAvailable
        );
        return { memories, queryEmbedding: null };
      }

      // Generate query embedding (needed for Pool 3, and pipeline uses it for ContextRanker)
      let queryEmbedding = null;
      if (semanticAvailable) {
        try {
          queryEmbedding = await this.embedding.generate(query);
        } catch (err) {
          console.error('[MemorySearch] Query embedding generation failed:', err.message);
        }
      }

      // ── Pool 2: Recent memories ──
      const recent = this.db.getRecentMemories(userId, RECENT_DAYS, 30);
      const recentNonEssential = recent.filter(m => !essentialIds.has(m.id));

      // ── Pool 3: Semantic matches (PRIMARY — when embedding available) ──
      let semanticMatches = [];
      if (semanticAvailable && queryEmbedding) {
        semanticMatches = this._semanticPool(userId, queryEmbedding, 30, essentialIds);
      }

      // ── Pool 4: FTS5 keyword matches (SECONDARY — always attempted) ──
      const ftsMatches = this._ftsPool(userId, query, 20, essentialIds);

      // ── Pool 5: Category structural (only when category specified) ──
      let categoryMatches = [];
      if (category) {
        const catMems = this.db.getMemoriesByType(userId, category, 20);
        categoryMatches = catMems.filter(m => !essentialIds.has(m.id));
      }

      // ── Merge all pools, deduplicate ──
      const merged = this._mergePools(
        essential, semanticMatches, ftsMatches, recentNonEssential, categoryMatches
      );

      // ── Attach keywordScore ONLY when embeddings unavailable (ContextRanker fallback) ──
      const memories = this._attachKeywordScoreIfFallback(merged, query, semanticAvailable);

      return { memories: memories.slice(0, limit), queryEmbedding };
    } catch (err) {
      console.error('MemorySearch.search error:', err.message);
      return { memories: [], queryEmbedding: null };
    }
  }

  // ─────────────────────────────────────────────
  //  Pool builders
  // ─────────────────────────────────────────────

  /**
   * Pool 3: Semantic similarity search.
   * Loads all user embeddings, computes cosine similarity, returns top matches.
   */
  _semanticPool(userId, queryEmbedding, limit, excludeIds) {
    try {
      const memoriesWithEmbedding = this.db.getMemoriesWithEmbedding(userId, 500);
      const scored = [];

      for (const mem of memoriesWithEmbedding) {
        if (excludeIds.has(mem.id)) continue;
        if (!mem.embedding) continue;

        const memEmbedding = this.embedding.fromBuffer(mem.embedding);
        if (!memEmbedding) continue;

        const score = this.embedding.cosineSimilarity(queryEmbedding, memEmbedding);
        if (score >= SEMANTIC_MIN_SCORE) {
          scored.push({ ...mem, _semanticScore: score });
        }
      }

      scored.sort((a, b) => b._semanticScore - a._semanticScore);
      return scored.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Pool 4: FTS5 full-text keyword search.
   * Uses SQLite FTS5 for fast indexed text matching.
   */
  _ftsPool(userId, query, limit, excludeIds) {
    try {
      const results = this.db.searchMemoriesFTS(userId, query, limit);
      return results.filter(m => !excludeIds.has(m.id));
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  //  Pool merging & deduplication
  // ─────────────────────────────────────────────

  /**
   * Merge all pools, deduplicate by ID.
   * Order: essential → semantic → FTS → recent → category.
   * Signal-first: semantic and FTS are direct query matches, recent is temporal context.
   */
  _mergePools(essential, semantic, fts, recent, category) {
    const seen = new Set();
    const result = [];

    const addUnique = (mem) => {
      if (seen.has(mem.id)) return;
      seen.add(mem.id);
      result.push(mem);
    };

    // Essential first — they always survive ranking
    for (const m of essential) addUnique(m);

    // Semantic matches — strongest signal when available
    for (const m of semantic) addUnique(m);

    // FTS5 keyword matches — lexical signal
    for (const m of fts) addUnique(m);

    // Recent memories — temporal context
    for (const m of recent) addUnique(m);

    // Category structural — only when filter specified
    for (const m of category) addUnique(m);

    return result;
  }

  // ─────────────────────────────────────────────
  //  Keyword scoring (ContextRanker fallback only)
  // ─────────────────────────────────────────────

  /**
   * Attach keywordScore to all candidates ONLY when embedding service is unavailable.
   * When embeddings work, ContextRanker uses cosine similarity instead.
   */
  _attachKeywordScoreIfFallback(memories, query, semanticAvailable) {
    if (semanticAvailable || !query) return memories;

    return memories.map(m => ({
      ...m,
      keywordScore: this._calculateKeywordScore(query, m.content),
    }));
  }

  /**
   * Jaccard similarity between query words and content words.
   * Lightweight fallback for ContextRanker when embeddings are unavailable.
   */
  _calculateKeywordScore(query, content) {
    const queryWords = this._tokenize(query);
    const contentWords = this._tokenize(content);

    if (queryWords.length === 0 || contentWords.length === 0) return 0;

    const querySet = new Set(queryWords);
    const contentSet = new Set(contentWords);

    let intersection = 0;
    for (const word of querySet) {
      if (contentSet.has(word)) intersection++;
    }

    const unionSize = new Set([...querySet, ...contentSet]).size;
    return unionSize === 0 ? 0 : intersection / unionSize;
  }

  // ─────────────────────────────────────────────
  //  Utility methods
  // ─────────────────────────────────────────────

  /**
   * Check if semantic search is available.
   */
  async _isSemanticAvailable() {
    return this.embedding && this.embedding.isAvailable();
  }

  /**
   * Simple text-match search (backward compatible with MemoryClassifier).
   * Now uses FTS5 instead of LIKE.
   */
  searchByContent(query, userId) {
    try {
      const results = this.db.searchMemoriesFTS(userId, query, 10);
      if (results.length === 0) {
        // Fallback to LIKE if FTS returns nothing (e.g., special characters)
        const fallback = this.db.searchMemories(userId, query);
        return fallback.map(m => ({
          id: m.id,
          category: m.type,
          content: m.content,
          importance: m.importance,
          confidence: m.confidence,
          createdAt: m.created_at,
        }));
      }
      return results.map(m => ({
        id: m.id,
        category: m.type,
        content: m.content,
        importance: m.importance,
        confidence: m.confidence,
        createdAt: m.created_at,
      }));
    } catch (err) {
      console.error('MemorySearch.searchByContent error:', err.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  //  Text utilities
  // ─────────────────────────────────────────────

  _tokenize(text) {
    if (!text) return [];
    return this._normalize(text)
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }

  _normalize(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '');
  }
}

module.exports = MemorySearch;
