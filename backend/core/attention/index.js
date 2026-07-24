/**
 * AttentionEngine — Paprika Phase 7
 *
 * Determines WHERE Paprika's cognitive focus should be during a response.
 * This is NOT about what information is available (ContextRanker handles that).
 * It's about what deserves attention RIGHT NOW.
 *
 * Analogy: you can hear background noise but focus on one conversation.
 * The AttentionEngine decides what's the "conversation" and what's the "noise"
 * for each interaction.
 *
 * Core concept — Attention Window:
 *   A weighted focus distribution across primary, secondary, and suppressed areas.
 *   The pipeline uses this to allocate prompt space and guide response generation.
 *
 * Consumed by:
 *   - ContextBuilder: to weight which memories/context to include
 *   - PersonalityEngine: to allocate prompt space per section
 *   - Pipeline: to know urgency and special flags (emotional emergency, etc.)
 *
 * NOT a persistent engine — stateless per-call, no DB writes.
 */

const DEFAULT_CONFIG = {
  maxSecondary: 4,
  minWeight: 0.05,
  urgencyBase: 0.3,
  emotionalEmergencyThreshold: 0.7,
  topicShiftThreshold: 0.3,
};

class AttentionEngine {
  /**
   * @param {Object} config - Optional overrides for DEFAULT_CONFIG
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ──────────────────────────────────────────────
  //  Main entry
  // ──────────────────────────────────────────────

  /**
   * Computes the attention window for the current interaction.
   *
   * @param {Object} params
   * @param {Object} params.analysis        - Output from MessageAnalyzer
   * @param {Array}  params.memories        - Ranked memories from ContextRanker
   * @param {Object} params.relationship    - From RelationshipEngine.get()
   * @param {Object} params.emotionalState  - From EmotionEngine.getState()
   * @param {Object} params.goals           - From GoalEngine (array or object with active goals)
   * @param {Object} params.knowledge       - From KnowledgeGraph
   * @param {Array}  params.history         - Recent messages [{role, content}]
   * @returns {Object} Attention window
   */
  focus({ analysis, memories, relationship, emotionalState, goals, knowledge, history }) {
    const safeAnalysis = analysis || {};
    const safeMemories = memories || [];
    const safeRelationship = relationship || {};
    const safeEmotionalState = emotionalState || {};
    const safeGoals = goals || [];
    const safeHistory = history || [];

    // Detect special states first (they influence all other decisions)
    const emotionalEmergency = this._detectEmotionalEmergency(safeAnalysis, safeEmotionalState);
    const topicShift = this._detectTopicShift(safeAnalysis, safeHistory);
    const goalOpportunity = this._detectGoalOpportunity(safeAnalysis, safeGoals);

    // Detect focus areas
    const primary = this._detectPrimaryFocus(
      safeAnalysis, safeGoals, safeRelationship, emotionalEmergency
    );

    const secondary = this._detectSecondaryFocus(
      safeAnalysis, safeMemories, safeGoals, safeEmotionalState,
      primary, goalOpportunity, emotionalEmergency
    );

    const suppressed = this._detectSuppressed(safeAnalysis, safeMemories, safeHistory);

    // Calculate urgency
    const urgency = this._calculateUrgency(safeAnalysis, safeEmotionalState, safeRelationship);

    // Normalize and rank
    const rankedSecondary = this._rankSignals(secondary);
    const normalizedSecondary = this._normalizeWeights(rankedSecondary).slice(0, this.config.maxSecondary);

    // Apply budget allocation
    const budget = this._budgetAllocation(primary, normalizedSecondary);

    return {
      primary,
      secondary: normalizedSecondary,
      suppressed,
      urgency: Math.round(urgency * 100) / 100,
      topicShift,
      emotionalEmergency,
      goalOpportunity,
      budget,
      description: this._describeAttention({
        primary,
        secondary: normalizedSecondary,
        suppressed,
        urgency,
        topicShift,
        emotionalEmergency,
        goalOpportunity,
      }),
    };
  }

  // ──────────────────────────────────────────────
  //  Focus detection — Primary
  // ──────────────────────────────────────────────

  /**
   * Determines what deserves MOST attention in this interaction.
   *
   * Priority hierarchy:
   *   1. Emotional emergency  → emotional support
   *   2. Goal progress        → the specific goal
   *   3. Question answering   → answering the question
   *   4. Topic continuation   → continuing the topic
   *   5. Relationship building → building trust
   *   6. Default              → conversation topic
   *
   * @param {Object} analysis      - Message analysis
   * @param {Array|Object} goals   - Active goals
   * @param {Object} relationship  - Current relationship state
   * @param {boolean} emotionalEmergency - Whether emotional emergency was detected
   * @returns {Object} { type, value, weight }
   */
  _detectPrimaryFocus(analysis, goals, relationship, emotionalEmergency) {
    // 1. Emotional emergency takes absolute priority
    if (emotionalEmergency) {
      return { type: 'emotion', value: 'emotional_support', weight: 0.5 };
    }

    // 2. Goal progress — user mentions or asks about a goal
    const goalFocus = this._findGoalFocus(analysis, goals);
    if (goalFocus) {
      return goalFocus;
    }

    // 3. Question answering
    if (analysis.intent === 'question') {
      return { type: 'question', value: analysis.topic || 'answering_question', weight: 0.45 };
    }

    // 4. Topic continuation
    if (analysis.topic) {
      return { type: 'topic', value: analysis.topic, weight: 0.4 };
    }

    // 5. Relationship building — low trust + user shows vulnerability
    const trustLevel = relationship.trustLevel != null ? relationship.trustLevel : 0.5;
    if (trustLevel < 0.4 && this._isVulnerable(analysis)) {
      return { type: 'relationship', value: 'building_trust', weight: 0.4 };
    }

    // 6. Default — conversation as primary
    return { type: 'topic', value: 'conversation', weight: 0.35 };
  }

  // ──────────────────────────────────────────────
  //  Focus detection — Secondary
  // ──────────────────────────────────────────────

  /**
   * Determines supporting focus areas that should receive partial attention.
   *
   * Sources:
   *   - Related memories from ContextRanker
   *   - Active goals relevant to the message
   *   - Emotional undertones to be aware of
   *   - Relationship considerations
   *
   * @param {Object} analysis        - Message analysis
   * @param {Array} memories         - Ranked memories
   * @param {Array|Object} goals     - Active goals
   * @param {Object} emotionalState  - Current emotional state
   * @param {Object} primary         - The primary focus (to avoid duplication)
   * @param {boolean} goalOpportunity - Whether a goal opportunity was detected
   * @param {boolean} emotionalEmergency - Whether emotional emergency is active
   * @returns {Array<Object>} Secondary focus signals
   */
  _detectSecondaryFocus(analysis, memories, goals, emotionalState, primary, goalOpportunity, emotionalEmergency) {
    const signals = [];

    // Memories with meaningful relevance (score > 0.1)
    if (memories.length > 0) {
      for (const memory of memories) {
        const score = memory.score || memory.relevance || 0;
        if (score > 0.1 && memory.content) {
          signals.push({
            type: 'memory',
            value: this._truncate(memory.content, 60),
            weight: this._scoreAttentionSignal({ type: 'memory', score }, { analysis, emotionalState }),
          });
        }
      }
    }

    // Active goals related to the current message
    const activeGoals = this._getActiveGoals(goals);
    for (const goal of activeGoals) {
      if (goal.name && this._isGoalRelated(goal, analysis)) {
        signals.push({
          type: 'goal',
          value: goal.name,
          weight: this._scoreAttentionSignal({ type: 'goal', goal, goalOpportunity }, { analysis, emotionalState }),
        });
      }
    }

    // Emotional undertones — if user has detectable emotion but NOT an emergency
    if (!emotionalEmergency && emotionalState.dominant && emotionalState.confidence > 0.3) {
      signals.push({
        type: 'emotion',
        value: emotionalState.dominant,
        weight: this._scoreAttentionSignal(
          { type: 'emotion_undertone', confidence: emotionalState.confidence, valence: emotionalState.valence },
          { analysis }
        ),
      });
    }

    // Relationship considerations — if trust is moderate, keep awareness
    const trustLevel = emotionalState.trust != null ? emotionalState.trust : null;
    if (trustLevel != null && trustLevel < 0.6 && trustLevel > 0.2) {
      signals.push({
        type: 'relationship',
        value: 'maintaining_rapport',
        weight: 0.1,
      });
    }

    // Knowledge graph entities — if the message mentions known entities
    if (analysis.entities) {
      const totalEntities = (analysis.entities.people || []).length +
                            (analysis.entities.places || []).length +
                            (analysis.entities.projects || []).length;
      if (totalEntities > 0) {
        signals.push({
          type: 'knowledge',
          value: 'known_entities',
          weight: Math.min(0.05 + totalEntities * 0.03, 0.15),
        });
      }
    }

    // Avoid duplicating what primary already covers
    return signals.filter(s => !(s.type === primary.type && s.value === primary.value));
  }

  // ──────────────────────────────────────────────
  //  Focus detection — Suppressed
  // ──────────────────────────────────────────────

  /**
   * Determines what should be de-emphasized or ignored.
   *
   * Suppression rules:
   *   - Memories with very low relevance (< 0.1)
   *   - Topics unrelated to current message
   *   - Emotional states that don't match current interaction
   *   - Old goals that are completed or abandoned
   *
   * @param {Object} analysis  - Message analysis
   * @param {Array} memories   - Ranked memories
   * @param {Array} history    - Recent messages
   * @returns {Array<string>} Labels of suppressed items
   */
  _detectSuppressed(analysis, memories, history) {
    const suppressed = [];

    // Low-relevance memories
    const lowMemories = (memories || []).filter(m => {
      const score = m.score || m.relevance || 0;
      return score <= 0.1;
    });
    if (lowMemories.length > 0) {
      suppressed.push(`low_relevance_memories(${lowMemories.length})`);
    }

    // Topics unrelated to current message
    if (analysis.topic && history && history.length > 0) {
      const recentTopics = this._extractRecentTopics(history);
      const unrelated = recentTopics.filter(t => t !== analysis.topic);
      if (unrelated.length > 0) {
        suppressed.push('previous_topics');
      }
    }

    // Emotional states that don't match current interaction
    // If the user's current emotion is neutral but Paprika's state is emotional,
    // suppress the Paprika emotional state to avoid projecting
    const userValence = analysis.emotionalState ? analysis.emotionalState.valence : 0;
    if (Math.abs(userValence) < 0.2) {
      suppressed.push('paprika_emotional_state');
    }

    // Greetings and farewells suppress deep topic focus
    if (analysis.intent === 'greeting' || analysis.intent === 'farewell') {
      suppressed.push('deep_topics');
      suppressed.push('goal_progress');
    }

    return suppressed;
  }

  // ──────────────────────────────────────────────
  //  Urgency calculation
  // ──────────────────────────────────────────────

  /**
   * Calculates how urgently this message needs attention.
   *
   * Formula:
   *   urgency = base
   *     + (user emotional intensity * 0.3)
   *     + (is question * 0.2)
   *     + (is personal * 0.1)
   *     + (time pressure words * 0.1)
   *
   * @param {Object} analysis       - Message analysis
   * @param {Object} emotionalState - Current emotional state
   * @param {Object} relationship   - Current relationship
   * @returns {number} Urgency 0-1
   */
  _calculateUrgency(analysis, emotionalState, relationship) {
    let urgency = this.config.urgencyBase;

    // Emotional intensity contribution
    const intensity = analysis.intensity || 0;
    urgency += intensity * 0.3;

    // Question = slightly more urgent (user expects answer)
    if (analysis.intent === 'question') {
      urgency += 0.2;
    }

    // Personal messages carry more urgency
    if (analysis.topic === 'personal' || this._isPersonalMessage(analysis)) {
      urgency += 0.1;
    }

    // Time pressure words
    if (this._hasTimePressure(analysis.rawMessage || '')) {
      urgency += 0.1;
    }

    // Emotional emergency overrides everything
    const emotionalEmergency = this._detectEmotionalEmergency(analysis, emotionalState);
    if (emotionalEmergency) {
      urgency = Math.max(urgency, 0.9);
    }

    // Commands are moderately urgent
    if (analysis.intent === 'command') {
      urgency += 0.05;
    }

    return Math.min(Math.max(urgency, 0), 1);
  }

  // ──────────────────────────────────────────────
  //  Topic shift detection
  // ──────────────────────────────────────────────

  /**
   * Detects whether the user has shifted topics compared to recent history.
   *
   * Uses keyword overlap (Jaccard similarity) between the current message
   * topic keywords and recent conversation topic keywords.
   * If similarity < threshold → topic shift.
   *
   * On topic shift, attention resets to the new topic but keeps partial
   * secondary attention on the old topic for smooth transitions.
   *
   * @param {Object} analysis - Message analysis
   * @param {Array} history   - Recent messages
   * @returns {boolean} True if a significant topic shift was detected
   */
  _detectTopicShift(analysis, history) {
    if (!analysis.topic || !history || history.length < 2) {
      return false;
    }

    const currentTopic = analysis.topic;
    const recentTopics = this._extractRecentTopics(history);

    if (recentTopics.length === 0) return false;

    // Calculate Jaccard-like similarity between current topic and recent topics
    const currentWords = this._tokenize(currentTopic);
    const recentWords = new Set();
    for (const topic of recentTopics) {
      for (const word of this._tokenize(topic)) {
        recentWords.add(word);
      }
    }

    if (currentWords.length === 0 || recentWords.size === 0) return false;

    let intersection = 0;
    for (const word of currentWords) {
      if (recentWords.has(word)) intersection++;
    }

    const union = currentWords.length + recentWords.size - intersection;
    const similarity = union > 0 ? intersection / union : 0;

    return similarity < this.config.topicShiftThreshold;
  }

  // ──────────────────────────────────────────────
  //  Emotional emergency detection
  // ──────────────────────────────────────────────

  /**
   * Detects whether the user is in emotional distress requiring focused support.
   *
   * Conditions:
   *   - valence < -0.5 AND arousal > 0.7 → HIGH urgency
   *   - dominant emotion is 'sadness' or 'anger' with confidence > 0.7
   *   - intensity > 0.8 → very focused attention
   *
   * @param {Object} analysis       - Message analysis
   * @param {Object} emotionalState - Emotional state
   * @returns {boolean} True if emotional emergency
   */
  _detectEmotionalEmergency(analysis, emotionalState) {
    if (!emotionalState) return false;

    const valence = emotionalState.valence != null ? emotionalState.valence : 0;
    const arousal = emotionalState.arousal != null ? emotionalState.arousal : 0.5;
    const dominant = emotionalState.dominant || null;
    const confidence = emotionalState.confidence != null ? emotionalState.confidence : 0;
    const intensity = analysis.intensity || 0;

    // Condition 1: Strong negative valence + high arousal
    if (valence < -0.5 && arousal > 0.7) {
      return true;
    }

    // Condition 2: Sadness or anger with high confidence
    if ((dominant === 'sadness' || dominant === 'angry' || dominant === 'anger') && confidence > 0.7) {
      return true;
    }

    // Condition 3: Very high intensity emotional expression
    if (intensity > 0.8 && valence < -0.3) {
      return true;
    }

    return false;
  }

  // ──────────────────────────────────────────────
  //  Goal opportunity detection
  // ──────────────────────────────────────────────

  /**
   * Detects whether the user's message relates to an active goal.
   *
   * Signals:
   *   - Mentioning the goal explicitly → high attention
   *   - Showing progress toward goal → moderate attention
   *   - Asking about goal → high attention
   *   - New information related to goal → moderate attention
   *
   * @param {Object} analysis - Message analysis
   * @param {Array|Object} goals - Active goals
   * @returns {boolean} True if a goal opportunity was detected
   */
  _detectGoalOpportunity(analysis, goals) {
    const activeGoals = this._getActiveGoals(goals);
    if (activeGoals.length === 0) return false;

    const lower = (analysis.rawMessage || '').toLowerCase();

    for (const goal of activeGoals) {
      if (!goal.name) continue;
      const goalName = goal.name.toLowerCase();

      // Direct mention of goal name
      if (lower.includes(goalName)) return true;

      // Check for goal-related keywords
      const goalWords = this._tokenize(goalName);
      let wordMatches = 0;
      for (const word of goalWords) {
        if (word.length > 2 && lower.includes(word)) wordMatches++;
      }
      if (goalWords.length > 0 && wordMatches / goalWords.length >= 0.5) return true;

      // Progress-related language
      if (/\b(avancé|progres[oa]|logré|completé|terminé|hice|logrado|avance)\b/i.test(analysis.rawMessage)) {
        return true;
      }

      // Goal-related question patterns
      if (analysis.intent === 'question' && wordMatches > 0) {
        return true;
      }
    }

    return false;
  }

  // ──────────────────────────────────────────────
  //  Relationship moment detection
  // ──────────────────────────────────────────────

  /**
   * Detects whether this is a key moment for relationship building.
   *
   * @param {Object} analysis       - Message analysis
   * @param {Object} relationship   - Current relationship
   * @param {Object} emotionalState - Emotional state
   * @returns {boolean} True if this is a relationship-building moment
   */
  _detectRelationshipMoment(analysis, relationship, emotionalState) {
    if (!relationship) return false;

    const trustLevel = relationship.trustLevel != null ? relationship.trustLevel : 0.5;
    const valence = emotionalState ? (emotionalState.valence || 0) : 0;
    const intensity = analysis.intensity || 0;

    // Low trust + user sharing personal info
    if (trustLevel < 0.4 && this._isPersonalMessage(analysis)) {
      return true;
    }

    // User expresses vulnerability
    if (this._isVulnerable(analysis) && valence < 0) {
      return true;
    }

    // User shares something meaningful (high importance + positive emotion)
    if ((analysis.importance || 0) > 0.6 && valence > 0.3) {
      return true;
    }

    // Memory request — user wants Paprika to remember something = trust signal
    if (analysis.intent === 'memory_request') {
      return true;
    }

    return false;
  }

  // ──────────────────────────────────────────────
  //  Attention scoring
  // ──────────────────────────────────────────────

  /**
   * Generic scorer for any attention signal.
   * Returns a weight between minWeight and 0.5 based on signal properties.
   *
   * @param {Object} signal  - The signal to score { type, ...properties }
   * @param {Object} context - Context for scoring { analysis, emotionalState }
   * @returns {number} Weight 0-0.5
   */
  _scoreAttentionSignal(signal, context) {
    const analysis = context.analysis || {};
    const emotionalState = context.emotionalState || {};

    let score = 0.15; // base weight

    switch (signal.type) {
      case 'memory':
        // Higher relevance score → higher attention weight
        score = 0.05 + (signal.score || 0) * 0.35;
        break;

      case 'goal':
        // Goal opportunity gets higher weight
        if (signal.goalOpportunity) {
          score = 0.3 + (signal.goal ? (signal.goal.progress || 0.5) * 0.15 : 0);
        } else {
          score = 0.15 + (signal.goal ? (signal.goal.progress || 0.5) * 0.1 : 0);
        }
        break;

      case 'emotion_undertone':
        // Higher confidence emotions get more attention
        score = 0.1 + (signal.confidence || 0) * 0.2;
        // Negative emotions get slightly more weight (they need more care)
        if ((signal.valence || 0) < -0.2) {
          score += 0.05;
        }
        break;

      case 'relationship':
        score = 0.1;
        break;

      case 'knowledge':
        score = 0.08;
        break;

      default:
        score = 0.15;
    }

    return Math.max(this.config.minWeight, Math.min(score, 0.5));
  }

  /**
   * Ranks signals by weight in descending order.
   *
   * @param {Array<Object>} signals - Array of { type, value, weight }
   * @returns {Array<Object>} Sorted by weight descending
   */
  _rankSignals(signals) {
    return [...signals].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  }

  /**
   * Calculates prompt space budget allocation.
   * Determines what percentage of the prompt should be dedicated to each area.
   *
   * @param {Object} primary   - Primary focus { type, value, weight }
   * @param {Array} secondary  - Secondary focuses
   * @returns {Object} { primary: number, secondary: number, memories: number, other: number }
   */
  _budgetAllocation(primary, secondary) {
    // Primary focus gets the largest allocation
    const primaryBudget = 0.4;

    // Secondary focuses split remaining budget proportionally
    const secondaryTotalWeight = secondary.reduce((sum, s) => sum + (s.weight || 0), 0);
    const maxSecondaryBudget = 0.35;

    const secondaryBudget = Math.min(
      secondaryTotalWeight > 0 ? 0.35 : 0,
      maxSecondaryBudget
    );

    // Memories get a portion based on how many relevant memories exist
    const memoryCount = secondary.filter(s => s.type === 'memory').length;
    const memoryBudget = Math.min(memoryCount * 0.05, 0.15);

    // Remaining for other context
    const otherBudget = Math.max(0, 1 - primaryBudget - secondaryBudget - memoryBudget);

    return {
      primary: Math.round(primaryBudget * 100) / 100,
      secondary: Math.round(secondaryBudget * 100) / 100,
      memories: Math.round(memoryBudget * 100) / 100,
      other: Math.round(otherBudget * 100) / 100,
    };
  }

  // ──────────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────────

  /**
   * Normalizes weights in a signal array so they sum to 1.0.
   *
   * @param {Array<Object>} signals - Array of { type, value, weight }
   * @returns {Array<Object>} Signals with normalized weights
   */
  _normalizeWeights(signals) {
    if (!signals || signals.length === 0) return [];

    const totalWeight = signals.reduce((sum, s) => sum + (s.weight || 0), 0);
    if (totalWeight === 0) return signals;

    return signals.map(s => ({
      ...s,
      weight: Math.round((s.weight / totalWeight) * 100) / 100,
    }));
  }

  /**
   * Generates a human-readable summary of the attention window for debugging.
   *
   * @param {Object} attention - The attention window object
   * @returns {string} Descriptive text in Spanish (matching project convention)
   */
  _describeAttention(attention) {
    const parts = [];

    // Primary focus
    const primaryLabel = {
      emotion: 'emocional',
      topic: 'tema',
      question: 'respuesta',
      goal: 'objetivo',
      relationship: 'relación',
    };
    parts.push(
      `Foco principal: ${primaryLabel[attention.primary.type] || attention.primary.type} (${attention.primary.value})`
    );

    // Secondary focuses
    if (attention.secondary.length > 0) {
      const labels = attention.secondary.map(s => `${s.type}:${s.value}`);
      parts.push(`Focos secundarios: ${labels.join(', ')}`);
    }

    // Suppressed
    if (attention.suppressed.length > 0) {
      parts.push(`Suprimido: ${attention.suppressed.join(', ')}`);
    }

    // Urgency
    const urgencyLabel = attention.urgency >= 0.8
      ? 'muy alta'
      : attention.urgency >= 0.6
        ? 'alta'
        : attention.urgency >= 0.4
          ? 'moderada'
          : 'baja';
    parts.push(`Urgencia: ${urgencyLabel} (${attention.urgency})`);

    // Special flags
    const flags = [];
    if (attention.emotionalEmergency) flags.push('EMERGENCIA EMOCIONAL');
    if (attention.topicShift) flags.push('CAMBIO DE TEMA');
    if (attention.goalOpportunity) flags.push('OPORTUNIDAD DE OBJETIVO');
    if (flags.length > 0) {
      parts.push(`Señales especiales: ${flags.join(', ')}`);
    }

    return parts.join(' | ');
  }

  // ──────────────────────────────────────────────
  //  Internal helpers
  // ──────────────────────────────────────────────

  /**
   * Finds if any active goal should become the primary focus.
   *
   * @param {Object} analysis - Message analysis
   * @param {Array|Object} goals - Active goals
   * @returns {Object|null} Goal focus signal or null
   */
  _findGoalFocus(analysis, goals) {
    const activeGoals = this._getActiveGoals(goals);
    const lower = (analysis.rawMessage || '').toLowerCase();

    for (const goal of activeGoals) {
      if (!goal.name) continue;

      const goalName = goal.name.toLowerCase();
      if (lower.includes(goalName)) {
        return { type: 'goal', value: goal.name, weight: 0.45 };
      }

      // Check word overlap
      const goalWords = this._tokenize(goalName);
      let matches = 0;
      for (const word of goalWords) {
        if (word.length > 2 && lower.includes(word)) matches++;
      }
      if (goalWords.length > 0 && matches / goalWords.length >= 0.5) {
        return { type: 'goal', value: goal.name, weight: 0.4 };
      }
    }

    return null;
  }

  /**
   * Extracts active goals from various possible goal formats.
   *
   * @param {Array|Object} goals - Goals from GoalEngine
   * @returns {Array} Array of goal objects
   */
  _getActiveGoals(goals) {
    if (!goals) return [];
    if (Array.isArray(goals)) {
      return goals.filter(g => g && !g.completed && !g.abandoned);
    }
    if (goals.active && Array.isArray(goals.active)) {
      return goals.active.filter(g => g && !g.completed && !g.abandoned);
    }
    return [];
  }

  /**
   * Checks if a goal is related to the current analysis.
   *
   * @param {Object} goal     - Goal object
   * @param {Object} analysis - Message analysis
   * @returns {boolean}
   */
  _isGoalRelated(goal, analysis) {
    if (!goal || !goal.name) return false;
    const goalName = goal.name.toLowerCase();
    const lower = (analysis.rawMessage || '').toLowerCase();

    if (lower.includes(goalName)) return true;

    const goalWords = this._tokenize(goalName);
    let matches = 0;
    for (const word of goalWords) {
      if (word.length > 2 && lower.includes(word)) matches++;
    }
    return goalWords.length > 0 && matches / goalWords.length >= 0.3;
  }

  /**
   * Checks if the user is expressing vulnerability.
   *
   * @param {Object} analysis - Message analysis
   * @returns {boolean}
   */
  _isVulnerable(analysis) {
    const lower = (analysis.rawMessage || '').toLowerCase();
    const vulnerabilityPatterns = [
      /\bestoy\s+(triste|mal|deprimido|cansado|estresado|ansioso|solo)/i,
      /\bme\s+siento\s+(triste|mal|solo|vacío|perdido)/i,
      /\bno\s+(sé|puedo|aguanto|soporto)/i,
      /\bme\s+da\s+(miedo|pena|bronca|angustia)/i,
      /\bnecesito\s+(ayuda|hablar|alguien)/i,
      /\bno\s+estoy\s+bien/i,
      /\bme\s+duele/i,
    ];
    return vulnerabilityPatterns.some(p => p.test(analysis.rawMessage || ''));
  }

  /**
   * Checks if the message is personal in nature.
   *
   * @param {Object} analysis - Message analysis
   * @returns {boolean}
   */
  _isPersonalMessage(analysis) {
    if (analysis.topic === 'personal') return true;
    const lower = (analysis.rawMessage || '').toLowerCase();
    return /\b(me\s+llamo|soy\s+\w+|tengo\s+\d+\s+años|vivo\s+en|mi\s+(mamá|papá|familia|pareja))\b/i.test(lower);
  }

  /**
   * Checks for time-pressure language.
   *
   * @param {string} message - Raw message
   * @returns {boolean}
   */
  _hasTimePressure(message) {
    const lower = message.toLowerCase();
    const patterns = [
      /\bur[gp]ente/i, /\bde\s+ahora/i, /\brápido/i, /\bpronto/i,
      /\b ya\b/i, /\benseguida/i, /\bno\s+puedo\s+esperar/i,
      /\bantes\s+de/i, /\bdeadline/i, /\bvencimiento/i, /\bao\s+ya\b/i,
    ];
    return patterns.some(p => p.test(lower));
  }

  /**
   * Extracts topics from recent conversation history.
   *
   * @param {Array} history - Recent messages [{role, content}]
   * @returns {Array<string>} Extracted topic keywords
   */
  _extractRecentTopics(history) {
    const topics = [];
    // Look at last 5 messages for topic signals
    const recent = history.slice(-5);
    for (const msg of recent) {
      if (!msg.content) continue;
      const lower = msg.content.toLowerCase();
      // Extract meaningful words (length > 3, not common stop words)
      const words = this._tokenize(lower);
      for (const word of words) {
        if (word.length > 3 && !topics.includes(word)) {
          topics.push(word);
        }
      }
    }
    return topics;
  }

  /**
   * Tokenizes a string into lowercase words.
   *
   * @param {string} text
   * @returns {Array<string>}
   */
  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^a-záéíóúñü0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 0);
  }

  /**
   * Truncates a string to a maximum length, adding ellipsis if needed.
   *
   * @param {string} str
   * @param {number} maxLen
   * @returns {string}
   */
  _truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }

  /**
   * Clamps a value between min and max.
   *
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  _clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
}

module.exports = AttentionEngine;
