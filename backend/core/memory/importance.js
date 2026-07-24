/**
 * MemoryImportance — Weighted-sum importance calculator
 *
 * Computes a dynamic importance score for any memory using a weighted sum:
 *
 *   FinalImportance = w_base * base + w_freq * frequency + w_rec * recency
 *                   + w_emo * emotionalWeight + w_goal * goalAlignment
 *                   + w_rel * relationshipStrength
 *
 * An optional final multiplier (adjustMultiplier) is applied:
 *   result = clamp(FinalImportance * multiplier, 0, 1)
 *
 * The multiplier is a small correction (0.9–1.1), NEVER a full multiplication
 * between factors. This prevents a single low factor from destroying the score.
 *
 * All weights are configurable from IMPORTANCE_WEIGHTS.
 * Adjust the config to tune behavior without touching code.
 */

'use strict';

// ─── Configurable Weights ───────────────────────────────────────────────────
// Must sum to 1.0 for the weighted sum to produce a [0,1] range.

const IMPORTANCE_WEIGHTS = {
  base: 0.35,
  frequency: 0.20,
  recency: 0.15,
  emotional: 0.15,
  goalAlignment: 0.10,
  relationship: 0.05,
};

// Final multiplier range — small adjustment, never destructive
const MULTIPLIER_MIN = 0.9;
const MULTIPLIER_MAX = 1.1;

// Frequency normalization: N mentions = max frequency score
const FREQUENCY_MAX_MENTIONS = 8;

// Recency decay window (days)
const RECENCY_WINDOW_DAYS = 60;

// High-importance categories that get a small base boost
const HIGH_VALUE_CATEGORIES = ['personal_data', 'relationship', 'person'];
const HIGH_VALUE_BOOST = 0.10;

// Emotion keywords for matching against current emotional state
const EMOTION_KEYWORDS = {
  sadness: ['triste', 'pena', 'llorar', 'perdí', 'muerte', 'adiós', 'extraño', 'missing', 'lost', 'sad', 'cry'],
  joy: ['feliz', 'genial', 'increíble', 'logré', 'éxito', 'celebrar', 'happy', 'great', 'amazing', 'success'],
  anger: ['enojado', 'furioso', 'molest', 'odio', 'injusto', 'angry', 'furious', 'hate', 'unfair'],
  fear: ['miedo', 'asustado', 'preocupado', 'ansioso', 'nervioso', 'scared', 'afraid', 'worried', 'anxious'],
  anxiety: ['ansiedad', 'nervioso', 'preocupado', 'estrés', 'overwhelmed', 'anxious', 'stressed'],
  nostalgia: ['recuerdo', 'antes', 'cuando era', 'nostalgia', 'remember', 'back when', 'used to'],
  frustration: ['frustrado', 'no puedo', 'stuck', 'frustrated', 'stuck', 'can\'t'],
  gratitude: ['gracias', 'agradezco', 'thank', 'appreciate', 'grateful'],
  excitement: ['emocionado', 'ansioso', 'esperando', 'excited', 'can\'t wait'],
};

// Goal alignment keywords
const GOAL_OVERLAP_MIN_WORD_LENGTH = 4;

class MemoryImportance {
  /**
   * @param {Object} [config] — Override default weights/settings
   */
  constructor(config = {}) {
    this.weights = { ...IMPORTANCE_WEIGHTS, ...config.weights };
    this.multiplierMin = config.multiplierMin || MULTIPLIER_MIN;
    this.multiplierMax = config.multiplierMax || MULTIPLIER_MAX;
    this.frequencyMax = config.frequencyMax || FREQUENCY_MAX_MENTIONS;
    this.recencyWindow = config.recencyWindow || RECENCY_WINDOW_DAYS;
  }

  // ─────────────────────────────────────────────
  //  Main entry point
  // ─────────────────────────────────────────────

  /**
   * Calculate the dynamic importance score for a memory.
   *
   * @param {Object} memory — memory record from DB
   * @param {Object} [context] — current conversation context
   * @param {Array}  [context.activeGoals] — from GoalEngine.getActiveGoals()
   * @param {Object} [context.relationship] — from RelationshipEngine.get()
   * @param {Object} [context.emotionalState] — user's current emotional state from Analyzer
   * @param {string} [context.currentMessage] — current user message text
   * @returns {number} importance score between 0 and 1
   */
  calculate(memory, context = {}) {
    const base = this._scoreBase(memory);
    const frequency = this._scoreFrequency(memory);
    const recency = this._scoreRecency(memory);
    const emotional = this._scoreEmotional(memory, context);
    const goalAlignment = this._scoreGoalAlignment(memory, context);
    const relationship = this._scoreRelationship(memory, context);

    const w = this.weights;
    const raw = w.base * base
      + w.frequency * frequency
      + w.recency * recency
      + w.emotional * emotional
      + w.goalAlignment * goalAlignment
      + w.relationship * relationship;

    // Optional small multiplier for fine-tuning
    const multiplier = this._computeMultiplier(memory, context);
    const finalScore = raw * multiplier;

    return Math.max(0, Math.min(1, finalScore));
  }

  /**
   * Batch-calculate importance for multiple memories.
   *
   * @param {Array} memories
   * @param {Object} [context]
   * @returns {Array<{memoryId: number, oldImportance: number, newImportance: number, delta: number}>}
   */
  calculateBatch(memories, context = {}) {
    return memories.map(m => {
      const oldImp = m.importance || 0.5;
      const newImp = this.calculate(m, context);
      return {
        memoryId: m.id,
        oldImportance: oldImp,
        newImportance: newImp,
        delta: newImp - oldImp,
      };
    });
  }

  /**
   * Filter batch results to only meaningful changes (|delta| > threshold).
   *
   * @param {Array} results — from calculateBatch()
   * @param {number} [threshold=0.03]
   * @returns {Array} filtered results
   */
  filterSignificantChanges(results, threshold = 0.03) {
    return results.filter(r => Math.abs(r.delta) > threshold);
  }

  // ─────────────────────────────────────────────
  //  Individual factor scorers
  // ─────────────────────────────────────────────

  /**
   * Base importance from the memory's own stored value.
   * High-value categories get a small boost.
   */
  _scoreBase(memory) {
    let score = memory.importance || 0.5;
    if (HIGH_VALUE_CATEGORIES.includes(memory.type)) {
      score = Math.min(1, score + HIGH_VALUE_BOOST);
    }
    return score;
  }

  /**
   * Frequency: how often this memory has been mentioned/updated.
   * Normalized to [0,1] with FREQUENCY_MAX_MENTIONS as ceiling.
   */
  _scoreFrequency(memory) {
    const mentions = memory.mentions || 1;
    return Math.min(mentions / this.frequencyMax, 1.0);
  }

  /**
   * Recency: time since last access. Linear decay over RECENCY_WINDOW_DAYS.
   */
  _scoreRecency(memory) {
    const lastAccessed = memory.last_accessed || memory.created_at;
    if (!lastAccessed) return 0.5;

    const now = Date.now();
    const accessed = new Date(lastAccessed).getTime();
    const daysSince = (now - accessed) / (1000 * 60 * 60 * 24);

    if (daysSince <= 0) return 1.0;
    if (daysSince >= this.recencyWindow) return 0.05;
    return 1 - (daysSince / this.recencyWindow);
  }

  /**
   * Emotional weight: how much the memory's content resonates
   * with the user's current emotional state.
   */
  _scoreEmotional(memory, context) {
    const userEmotion = context.emotionalState?.dominant || '';
    const userConfidence = context.emotionalState?.confidence || 0;

    // No emotional context → neutral score
    if (!userEmotion || userConfidence < 0.3) return 0.3;

    const content = (memory.content || '').toLowerCase();
    const keywords = EMOTION_KEYWORDS[userEmotion] || [];

    // Check if memory content matches current emotion keywords
    let matchScore = 0;
    for (const kw of keywords) {
      if (content.includes(kw)) {
        matchScore = 1.0;
        break;
      }
    }

    // Experience and emotion memories naturally resonate more
    const typeBoost = ['experience', 'emotion'].includes(memory.type) ? 0.3 : 0;

    // Personal/relationship memories resonate with any strong emotion
    const personalBoost = ['personal_data', 'relationship', 'person'].includes(memory.type)
      && userConfidence > 0.5 ? 0.2 : 0;

    return Math.min(1, Math.max(0.1, matchScore * 0.5 + typeBoost + personalBoost + 0.1));
  }

  /**
   * Goal alignment: how much the memory relates to any active goal.
   * Uses word overlap weighted by goal priority.
   */
  _scoreGoalAlignment(memory, context) {
    const goals = context.activeGoals || [];
    if (goals.length === 0) return 0.2;

    const memWords = this._tokenize(memory.content || '');
    if (memWords.length === 0) return 0.2;

    let bestScore = 0;
    for (const goal of goals) {
      const goalWords = this._tokenize(goal.content || '');
      if (goalWords.length === 0) continue;

      let overlap = 0;
      for (const w of goalWords) {
        if (memWords.includes(w)) overlap++;
      }
      const overlapRatio = overlap / goalWords.length;
      const weighted = overlapRatio * (goal.priority || 0.5);
      bestScore = Math.max(bestScore, weighted);
    }

    return Math.min(1, bestScore);
  }

  /**
   * Relationship strength: how relevant this memory is given the
   * current relationship context (favorite topics, trust, familiarity).
   */
  _scoreRelationship(memory, context) {
    const rel = context.relationship;
    if (!rel) return 0.3;

    let score = 0.3; // base

    // Favorite topic match
    const favTopics = rel.favoriteTopics || [];
    const memType = (memory.type || '').toLowerCase();
    if (favTopics.includes(memType)) score += 0.4;

    // Sensitive topic penalty
    const sensTopics = rel.sensitiveTopics || [];
    if (sensTopics.includes(memType)) score -= 0.3;

    // Trust boost for personal/relationship memories
    if (['personal_data', 'relationship', 'person'].includes(memType)) {
      score += (rel.trustLevel || 0.5) * 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  // ─────────────────────────────────────────────
  //  Multiplier
  // ─────────────────────────────────────────────

  /**
   * Compute a small final multiplier for fine-tuning.
   * Range: [multiplierMin, multiplierMax] (default [0.9, 1.1]).
   *
   * Boosts:
   * - Memory was recently verified → +0.05
   * - Memory has high confidence history → +0.05
   * - Memory is very old and never accessed → -0.05
   *
   * @returns {number}
   */
  _computeMultiplier(memory, context) {
    let multiplier = 1.0;

    // Recently verified memories get a small boost
    if (memory.last_verified) {
      const daysSinceVerify = (Date.now() - new Date(memory.last_verified).getTime()) / (86400000);
      if (daysSinceVerify < 30) multiplier += 0.05;
    }

    // High average confidence → boost
    const confHistory = JSON.parse(memory.confidence_history || '[]');
    if (confHistory.length >= 3) {
      const avg = confHistory.reduce((s, e) => s + (e.confidence || 0.5), 0) / confHistory.length;
      if (avg > 0.8) multiplier += 0.05;
    }

    // Very old, never accessed memories get a slight penalty
    const daysSinceAccess = memory.last_accessed
      ? (Date.now() - new Date(memory.last_accessed).getTime()) / 86400000
      : 999;
    if (daysSinceAccess > 90 && (memory.access_count || 0) === 0) {
      multiplier -= 0.05;
    }

    return Math.max(this.multiplierMin, Math.min(this.multiplierMax, multiplier));
  }

  // ─────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────

  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= GOAL_OVERLAP_MIN_WORD_LENGTH);
  }
}

module.exports = MemoryImportance;
module.exports.IMPORTANCE_WEIGHTS = IMPORTANCE_WEIGHTS;
