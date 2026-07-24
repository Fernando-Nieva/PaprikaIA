/**
 * Paprika Phase 4 - Reflection Engine
 * 
 * Performs internal analysis AFTER each response is generated.
 * This analysis is NEVER visible to the user. It generates insights
 * that drive memory updates, relationship adjustments, and emotional shifts.
 * 
 * Design Principles:
 * 1. Rule-based, not AI-based: Uses heuristics and pattern matching. No AI model calls.
 * 2. Non-blocking: Fast and synchronous. Doesn't slow down the response.
 * 3. Produces actions, not responses: Output is a list of actions for other modules.
 * 4. Logs everything: All reflections persisted for debugging and evolution tracking.
 */

'use strict';

// ─── Action Types ───────────────────────────────────────────────────────────

const ActionTypes = Object.freeze({
  NEW_MEMORY: 'new_memory',
  UPDATE_MEMORY: 'update_memory',
  RELATIONSHIP_UPDATE: 'relationship_update',
  EMOTION_NOTE: 'emotion_note',
  ENTITY_DISCOVERED: 'entity_discovered',
  CONTRADICTION: 'contradiction',
  VERIFY_MEMORY: 'verify_memory',
  NONE: 'none',
});

// ─── Constants ──────────────────────────────────────────────────────────────

const RELATIONSHIP_THRESHOLDS = Object.freeze({
  TRUST_BOOST_MIN_VALENCE: 0.5,
  TRUST_BOOST_CAP: 0.9,
  CONCERN_MIN_VALENCE: -0.3,
  CONCERN_FAMILIARITY_MIN: 0.3,
  SOCIAL_VALENCE_INCREASE: 0.02,
  SOCIAL_VALENCE_DECREASE: 0.01,
});

const EMOTION_THRESHOLDS = Object.freeze({
  STRONG_CONFIDENCE: 0.7,
  HIGH_INTENSITY: 0.8,
});

const CONTRADICTION_SIMILARITY_THRESHOLD = 0.6;

// ─── Preference Patterns ────────────────────────────────────────────────────

const PREFERENCE_PATTERNS = [
  { regex: /\b(me\s+gusta|me\s+encanta|love\s+(it|i|this)|i\s+like|i\s+enjoy|i\s+prefer)\b/i, sentiment: 'positive' },
  { regex: /\b(odio|no\s+me\s+gusta|hate|dislike|despise|can'?t\s+stand)\b/i, sentiment: 'negative' },
  { regex: /\b(prefiero|prefiere|i'?d?\s+rather|i\s+prefer)\b/i, sentiment: 'preference' },
  { regex: /\b(siempre|nunca|always|never)\s+(.*?(gusta|like|dislike|hate))\b/i, sentiment: 'habitual' },
  { regex: /\b(mi?\s+favorit[oa]?|my\s+favou?rit)\b/i, sentiment: 'favorite' },
  { regex: /\b(soy\s+(un|una|fan)|i'?m\s+a\s+fan)\b/i, sentiment: 'enthusiast' },
];

// ─── Notable Emotions ───────────────────────────────────────────────────────

const NOTABLE_EMOTIONS = new Set([
  'sad', 'angry', 'fear', 'disgust', 'surprise', 'grief', 'anxiety',
  'frustration', 'disappointment', 'lonely', 'overwhelmed', 'joy', 'excitement',
  'gratitude', 'pride', 'hope', 'relief', 'nostalgia',
]);

// ─── High-Importance Indicators ─────────────────────────────────────────────

const HIGH_IMPORTANCE_KEYWORDS = [
  /\b(important|crucial|essential|vital|priority)\b/i,
  /\b(don'?t\s+forget|never\s+forget|remember\s+this|importantísimo)\b/i,
  /\b(secret|confidential|private|personal|personally)\b/i,
  /\b(milestone|achievement|graduated|promoted|hired|fired|moved|wedding|birth|death|hospital|diagnos)\b/i,
  /\b(commitment|promise|pact|deal|agreement|deadline)\b/i,
];

// ─── Memory Category Keywords ───────────────────────────────────────────────

const MEMORY_CATEGORY_KEYWORDS = {
  preference: [/\b(gusta|encanta|prefiero|like|love|prefer|hate|odio|favourite|favorite)\b/i],
  fact: [/\b(es\s+un|es\s+una|is\s+a|is\s+an|works?\s+at|lives?\s+in|was\s+born|has\s+a)\b/i],
  event: [/\b(ayer|yesterday|hoy|today|anoche|last\s+night|last\s+week|event|party|meeting)\b/i],
  emotional: [/\b(sentí|me\s+siento|felt|feel|emotion|crying|laughing|happy|sad|angry|scared)\b/i],
  project: [/\b(project|proyecto|building|creating|developing|working\s+on|code|app|software)\b/i],
};

// ─── Entity Type Detection ──────────────────────────────────────────────────

const ENTITY_DETECTION = {
  people: [
    /\b(mi\s+(amig[oa]|compañer[oa]|herman[oa]|padre|madre|padre|hijo|espos[oa]|novi[oa]|jefe|profesor))\b/i,
    /\b(my\s+(friend|colleague|brother|sister|mother|father|son|daughter|wife|husband|partner|boss|teacher))\b/i,
    /\b(el\s+dr\.|la\s+dra\.|dr\.|dr\.?\s+[A-Z][a-z]+)\b/i,
  ],
  places: [
    /\b(en\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)\b/,
    /\b(in\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
    /\b(ciudad|country|city|pueblo|país|state|provincia)\b/i,
  ],
  technologies: [
    /\b(javascript|typescript|python|java|c\+\+|rust|go|react|angular|vue|node|django|flask|fastapi)\b/i,
    /\b(docker|kubernetes|aws|azure|gcp|firebase|mongodb|postgres|mysql|redis|graphql|rest\s*api)\b/i,
  ],
  emotions: NOTABLE_EMOTIONS,
};

// ─── Default Configuration ──────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  logEnabled: true,
  relationshipThresholds: { ...RELATIONSHIP_THRESHOLDS },
  emotionThresholds: { ...EMOTION_THRESHOLDS },
  maxReflectionActions: 10,
  minImportanceForStorage: 0.3,
  maxImportanceForStorage: 1.0,
});

// ─── Reflection Engine ──────────────────────────────────────────────────────

class ReflectionEngine {
  /**
   * @param {Object} db - Database interface (must support insert/query for reflection_log)
   * @param {Object} [config={}] - Configuration overrides
   */
  constructor(db, config = {}) {
    if (!db) {
      throw new Error('ReflectionEngine requires a database instance');
    }

    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Merge nested config properly
    if (config.relationshipThresholds) {
      this.config.relationshipThresholds = { ...RELATIONSHIP_THRESHOLDS, ...config.relationshipThresholds };
    }
    if (config.emotionThresholds) {
      this.config.emotionThresholds = { ...EMOTION_THRESHOLDS, ...config.emotionThresholds };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main Entry Point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Performs reflection on an interaction.
   * 
   * @param {Object} params
   * @param {Object} params.analysis - Parsed analysis of the user's message
   * @param {string} params.response - Paprika's generated response
   * @param {string} params.userId - User ID
   * @param {string} params.conversationId - Conversation ID
   * @param {Array}  params.memories - All memories for this user
   * @param {Object} params.classifiedMemories - Memories classified for this interaction
   * @param {Object} params.emotionalState - Current emotional state
   * @param {Object} params.relationship - Current relationship state
   * @returns {{ actions: Array<{type: string, data: Object, reasoning: string}>, reasoning: string }}
   */
  reflect({ analysis, response, userId, conversationId, memories, classifiedMemories, emotionalState, relationship }) {
    if (!this.config.enabled) {
      return { actions: [], reasoning: 'Reflection engine disabled' };
    }

    const actions = [];
    const parts = [];

    // Normalize inputs to prevent crashes on undefined
    const safeAnalysis = analysis || {};
    const safeResponse = response || '';
    const safeMemories = memories || [];
    const safeClassifiedMemories = classifiedMemories || { memories: [] };
    const safeEmotionalState = emotionalState || { valence: 0, arousal: 0, dominant: 'neutral', confidence: 0 };
    const safeRelationship = relationship || { trustLevel: 0.5, familiarity: 0.3, sentiment: 0 };

    // 1. Check for new learning
    const learningActions = this._checkNewLearning(safeAnalysis, safeResponse);
    if (learningActions.length > 0) {
      actions.push(...learningActions);
      parts.push(`${learningActions.length} new learning(s) detected`);
    }

    // 2. Check for preference discovery
    const prefActions = this._checkPreferenceDiscovery(safeAnalysis, safeResponse);
    if (prefActions.length > 0) {
      actions.push(...prefActions);
      parts.push(`${prefActions.length} preference(s) discovered`);
    }

    // 3. Check relationship changes
    const relActions = this._checkRelationshipChange(safeAnalysis, safeEmotionalState, safeRelationship);
    if (relActions.length > 0) {
      actions.push(...relActions);
      parts.push(`${relActions.length} relationship adjustment(s)`);
    }

    // 4. Check emotional significance
    const emotionActions = this._checkEmotionalSignificance(safeAnalysis);
    if (emotionActions.length > 0) {
      actions.push(...emotionActions);
      parts.push(`${emotionActions.length} emotional note(s)`);
    }

    // 5. Check contradictions
    const contradictActions = this._checkContradictions(safeAnalysis, safeMemories);
    if (contradictActions.length > 0) {
      actions.push(...contradictActions);
      parts.push(`${contradictActions.length} contradiction(s) found`);
    }

    // 6. Check memory updates
    const updateActions = this._checkMemoryUpdates(safeAnalysis, safeClassifiedMemories, safeMemories);
    if (updateActions.length > 0) {
      actions.push(...updateActions);
      parts.push(`${updateActions.length} memory update(s)`);
    }

    // 7. Check entities
    const entityActions = this._checkEntityDiscovery(safeAnalysis);
    if (entityActions.length > 0) {
      actions.push(...entityActions);
      parts.push(`${entityActions.length} entity/entities discovered`);
    }

    // 8. Check memory verification (user confirms something)
    const verifyActions = this._checkMemoryVerification(safeAnalysis, safeMemories);
    if (verifyActions.length > 0) {
      actions.push(...verifyActions);
      parts.push(`${verifyActions.length} memory(ies) verified`);
    }

    // 9. Classify temporal type of new classified memories
    const temporalActions = this._checkTemporalClassification(safeClassifiedMemories);
    if (temporalActions.length > 0) {
      actions.push(...temporalActions);
      parts.push(`${temporalActions.length} temporal classification(s)`);
    }

    // Cap actions if configured
    const finalActions = this.config.maxReflectionActions > 0
      ? actions.slice(0, this.config.maxReflectionActions)
      : actions;

    const reasoning = parts.length > 0 ? parts.join(' | ') : 'No reflection insights';

    // Log to DB
    this._logReflection(userId, conversationId, reasoning, finalActions);

    return { actions: finalActions, reasoning };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Individual Reflection Checks
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Detects new things learned that should be stored as memories.
   * 
   * @param {Object} analysis - Parsed analysis of the user's message
   * @param {string} response - Paprika's generated response
   * @returns {Array} Actions
   */
  _checkNewLearning(analysis, response) {
    const actions = [];
    const rawMessage = (analysis.rawMessage || '').toLowerCase();
    const combinedText = `${rawMessage} ${(response || '').toLowerCase()}`;

    // Check if user explicitly wants something remembered
    if (analysis.intent === 'memory_request') {
      const importance = this._computeImportance(analysis, response);
      actions.push(this._createMemoryAction('fact', analysis.rawMessage || combinedText, importance, 0.9, 'User explicitly requested to remember'));
    }

    // Check if analysis says this should be remembered and no classified memories exist
    if (analysis.shouldRemember && analysis.classifiedMemories?.length === 0) {
      const category = this._detectMemoryCategory(combinedText);
      const importance = this._computeImportance(analysis, response);
      const confidence = this._computeConfidence(analysis);
      actions.push(this._createMemoryAction(category, analysis.rawMessage || combinedText, importance, confidence, 'Should remember flag set with no existing classified memories'));
    }

    // New people detected
    const people = analysis.entities?.people || [];
    if (people.length > 0) {
      for (const person of people) {
        const importance = this._computeImportance(analysis, response);
        actions.push(this._createMemoryAction('relationship', `Person mentioned: ${person}`, Math.max(0.5, importance), 0.7, `New person entity detected: ${person}`));
      }
    }

    // High-importance content detection
    if (this._hasHighImportanceIndicators(combinedText) && !analysis.shouldRemember) {
      const category = this._detectMemoryCategory(combinedText);
      actions.push(this._createMemoryAction(category, analysis.rawMessage || combinedText, 0.7, 0.6, 'High-importance keywords detected'));
    }

    return actions;
  }

  /**
   * Discovers user preferences from their messages.
   * 
   * @param {Object} analysis - Parsed analysis of the user's message
   * @param {string} response - Paprika's generated response
   * @returns {Array} Actions
   */
  _checkPreferenceDiscovery(analysis, response) {
    const actions = [];
    const rawMessage = analysis.rawMessage || '';

    // Check raw message against preference patterns
    for (const pattern of PREFERENCE_PATTERNS) {
      if (pattern.regex.test(rawMessage)) {
        const sentiment = pattern.sentiment;
        const importance = sentiment === 'favorite' || sentiment === 'enthusiast' ? 0.8 : 0.6;
        actions.push(this._createMemoryAction(
          'preference',
          rawMessage,
          importance,
          0.75,
          `Preference pattern matched: ${sentiment}`
        ));
        break; // One preference per reflection is enough
      }
    }

    // Check classified memories for preference category
    if (analysis.classifiedMemories?.some(m => m.category === 'preference')) {
      const prefMemories = analysis.classifiedMemories.filter(m => m.category === 'preference');
      for (const mem of prefMemories) {
        if (mem.action === 'create' || mem.action === 'update') {
          const importance = this._computeImportance(analysis, response);
          actions.push(this._createMemoryAction(
            'preference',
            mem.content || rawMessage,
            Math.max(0.5, importance),
            0.8,
            'Preference identified in classified memories'
          ));
        }
      }
    }

    return actions;
  }

  /**
   * Detects changes that should affect the relationship state.
   * 
   * @param {Object} analysis - Parsed analysis
   * @param {Object} emotionalState - Current emotional state
   * @param {Object} relationship - Current relationship
   * @returns {Array} Actions
   */
  _checkRelationshipChange(analysis, emotionalState, relationship) {
    const actions = [];
    const thresholds = this.config.relationshipThresholds;

    // Positive interaction could boost trust
    if (emotionalState.valence > thresholds.TRUST_BOOST_MIN_VALENCE && relationship.trustLevel < thresholds.TRUST_BOOST_CAP) {
      const delta = Math.min(0.05, thresholds.TRUST_BOOST_CAP - relationship.trustLevel);
      if (delta > 0.01) {
        actions.push(this._createRelationshipAction(
          'trustLevel',
          delta,
          `Positive emotional state (valence: ${emotionalState.valence.toFixed(2)}) detected`
        ));
      }
    }

    // Negative emotional state with existing familiarity suggests user needs support
    if (emotionalState.valence < thresholds.CONCERN_MIN_VALENCE && relationship.familiarity > thresholds.CONCERN_FAMILIARITY_MIN) {
      // This is a concern signal — we note it but don't decrease trust
      // Instead, we might increase empathy/sentiment
      actions.push(this._createRelationshipAction(
        'sentiment',
        0.03,
        `User expressing negative emotion (valence: ${emotionalState.valence.toFixed(2)}) with familiarity ${relationship.familiarity.toFixed(2)}`
      ));
    }

    // Social connections mentioned
    const people = analysis.entities?.people || [];
    if (people.length > 0) {
      const delta = relationship.sentiment < 0 ? thresholds.SOCIAL_VALENCE_DECREASE : thresholds.SOCIAL_VALENCE_INCREASE;
      actions.push(this._createRelationshipAction(
        'familiarity',
        delta,
        `Social connections mentioned: ${people.join(', ')}`
      ));
    }

    // Explicit trust signals
    const rawMessage = (analysis.rawMessage || '').toLowerCase();
    if (/\b(thanks|thank\s+you|gracias|appreciate|confío|te\s+confío)\b/i.test(rawMessage)) {
      actions.push(this._createRelationshipAction('trustLevel', 0.02, 'User expressed gratitude or trust'));
    }

    if (/\b(no\s+confío|don'?t\s+trust|you\s+are\s+wrong|estás\s+mal)\b/i.test(rawMessage)) {
      actions.push(this._createRelationshipAction('trustLevel', -0.03, 'User expressed distrust or disagreement'));
    }

    return actions;
  }

  /**
   * Detects emotionally significant moments worth noting.
   * 
   * @param {Object} analysis - Parsed analysis
   * @returns {Array} Actions
   */
  _checkEmotionalSignificance(analysis) {
    const actions = [];
    const thresholds = this.config.emotionThresholds;
    const emotionalState = analysis.emotionalState || {};

    const _alreadyCaptured = (emotion) => actions.some(a => a.data.emotion === emotion);

    // Strong emotion detected with high confidence
    if (emotionalState.confidence > thresholds.STRONG_CONFIDENCE && emotionalState.dominant && emotionalState.dominant !== 'neutral') {
      if (!_alreadyCaptured(emotionalState.dominant)) {
        actions.push(this._createEmotionAction(
          emotionalState.dominant,
          emotionalState.confidence,
          `Strong emotion detected (confidence: ${emotionalState.confidence.toFixed(2)})`
        ));
      }
    }

    // High intensity message
    if (typeof analysis.intensity === 'number' && analysis.intensity > thresholds.HIGH_INTENSITY) {
      const dominant = emotionalState.dominant || 'neutral';
      if (!_alreadyCaptured(dominant)) {
        actions.push(this._createEmotionAction(
          dominant,
          analysis.intensity,
          `High intensity message (intensity: ${analysis.intensity.toFixed(2)})`
        ));
      }
    }

    // Notable emotions (always note these if not already captured)
    if (NOTABLE_EMOTIONS.has(emotionalState.dominant) && emotionalState.confidence > 0.5) {
      if (!_alreadyCaptured(emotionalState.dominant)) {
        actions.push(this._createEmotionAction(
          emotionalState.dominant,
          emotionalState.confidence,
          `Notable emotion "${emotionalState.dominant}" with moderate confidence`
        ));
      }
    }

    return actions;
  }

  /**
   * Compares new classified memories against existing ones to find contradictions.
   * 
   * @param {Object} analysis - Parsed analysis
   * @param {Array} memories - Existing memories
   * @returns {Array} Actions
   */
  _checkContradictions(analysis, memories) {
    const actions = [];

    if (!analysis.classifiedMemories || analysis.classifiedMemories.length === 0) {
      return actions;
    }
    if (!memories || memories.length === 0) {
      return actions;
    }

    const newMemories = analysis.classifiedMemories;

    for (const newMem of newMemories) {
      for (const existingMem of memories) {
        if (existingMem.id === newMem.id) continue;

        // Same category but different content → potential contradiction
        if (newMem.category === existingMem.category) {
          const newContent = (newMem.content || '').toLowerCase();
          const existingContent = (existingMem.content || '').toLowerCase();

          if (newContent && existingContent && newContent !== existingContent) {
            const similarity = this._textSimilarity(newContent, existingContent);

            // Not too similar (would be a duplicate, not contradiction)
            // but same category → potential contradiction
            if (similarity < CONTRADICTION_SIMILARITY_THRESHOLD && similarity > 0.1) {
              actions.push(this._createContradictionAction(
                existingMem.id,
                newMem.id,
                `Same category "${newMem.category}" but different content: "${newMem.content}" vs "${existingMem.content}"`
              ));
            }

            // Explicit contradiction detection: opposite sentiments in same category
            if (this._isOppositeSentiment(newContent, existingContent)) {
              actions.push(this._createContradictionAction(
                existingMem.id,
                newMem.id,
                `Opposite sentiments detected: "${newMem.content}" contradicts "${existingMem.content}"`
              ));
            }
          }
        }
      }
    }

    return actions;
  }

  /**
   * Detects memories that need updating based on new information.
   * 
   * @param {Object} analysis - Parsed analysis
   * @param {Object} classifiedMemories - Memories classified for this interaction
   * @param {Array} memories - All existing memories
   * @returns {Array} Actions
   */
  _checkMemoryUpdates(analysis, classifiedMemories, memories) {
    const actions = [];

    if (!classifiedMemories?.memories || classifiedMemories.memories.length === 0) {
      return actions;
    }

    for (const classified of classifiedMemories.memories) {
      // Memory explicitly marked for update
      if (classified.action === 'update' && classified.id) {
        const existingMem = memories.find(m => m.id === classified.id);
        const updates = {};

        if (classified.content) {
          updates.content = classified.content;
        }
        if (classified.importance) {
          updates.importance = classified.importance;
        }
        if (existingMem && classified.importance && classified.importance > (existingMem.importance || 0)) {
          updates.importance = classified.importance;
        }

        if (Object.keys(updates).length > 0) {
          actions.push(this._createUpdateAction(classified.id, updates));
        }
      }

      // New information boosts importance of existing related memory
      if (classified.action === 'create' && classified.relatedMemoryId) {
        const relatedMem = memories.find(m => m.id === classified.relatedMemoryId);
        if (relatedMem) {
          const currentImportance = relatedMem.importance || 0;
          const boost = 0.05;
          if (currentImportance + boost <= this.config.maxImportanceForStorage) {
            actions.push(this._createUpdateAction(relatedMem.id, {
              importance: currentImportance + boost,
              lastAccessed: new Date().toISOString(),
            }));
          }
        }
      }
    }

    return actions;
  }

  /**
   * Discovers new entities (people, places, technologies) from the message.
   * 
   * @param {Object} analysis - Parsed analysis
   * @returns {Array} Actions
   */
  _checkEntityDiscovery(analysis) {
    const actions = [];

    // People
    const people = analysis.entities?.people || [];
    for (const person of people) {
      actions.push(this._createEntityAction(
        person,
        'person',
        { source: 'conversation', discoveredAt: new Date().toISOString() }
      ));
    }

    // Places
    const places = analysis.entities?.places || [];
    for (const place of places) {
      actions.push(this._createEntityAction(
        place,
        'place',
        { source: 'conversation', discoveredAt: new Date().toISOString() }
      ));
    }

    // Technologies (only if topic is technology or project-related)
    const technologies = analysis.entities?.technologies || [];
    const topic = (analysis.topic || '').toLowerCase();
    const isTechContext = topic.includes('tech') || topic.includes('code') || topic.includes('program')
      || topic.includes('project') || topic.includes('develop') || topic.includes('software');

    if (isTechContext || technologies.length > 0) {
      for (const tech of technologies) {
        actions.push(this._createEntityAction(
          tech,
          'technology',
          { source: 'conversation', context: topic || 'general', discoveredAt: new Date().toISOString() }
        ));
      }
    }

    return actions;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  New checks: Verification, Importance Recalculation, Temporal Classification
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Detects when the user confirms or affirms existing memories.
   * Signals: "sí", "exacto", "así es", "correcto", "claro", "that's right".
   * Boosts confidence and marks as verified.
   */
  _checkMemoryVerification(analysis, memories) {
    const actions = [];
    const raw = (analysis.rawMessage || '').toLowerCase();

    const confirmPatterns = [
      /\b(sí|si|exacto|así\s+es|correcto|claro|eso\s+es|por\s+supuesto|affirmative)\b/i,
      /\b(yep|yeah|yes|right|correct|exactly|that'?s\s+right|totally)\b/i,
    ];

    const isConfirmation = confirmPatterns.some(p => p.test(raw));
    if (!isConfirmation || !memories || memories.length === 0) return actions;

    // Boost confidence of the most recent/relevant memories
    const recentMemories = memories
      .filter(m => m.id && m.content)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 3);

    for (const mem of recentMemories) {
      actions.push({
        type: ActionTypes.VERIFY_MEMORY,
        data: {
          memoryId: mem.id,
          confidenceBoost: 0.1,
        },
        reasoning: `User confirmed — verifying memory: "${(mem.content || '').substring(0, 50)}"`,
      });
    }

    return actions;
  }

  /**
   * Classify new classified memories as temporary, permanent, or evolving.
   *
   * - temporary: events, dates, experiences ("ayer", "mañana", "el lunes")
   * - permanent: facts, preferences, personal_data, people
   * - evolving: relationships, goals, projects
   */
  _checkTemporalClassification(classifiedMemories) {
    const actions = [];
    const newMemories = (classifiedMemories.memories || []).filter(m => m.action === 'new');

    for (const mem of newMemories) {
      let temporalType = 'permanent'; // default

      const content = (mem.content || '').toLowerCase();
      const category = (mem.category || '').toLowerCase();

      // Temporary indicators
      const temporaryCategories = ['date', 'event'];
      const temporaryKeywords = [
        /\b(ayer|hoy|mañana|anoche|el\s+lunes|el\s+martes|el\s+miércoles|el\s+jueves|el\s+viernes)\b/i,
        /\b(la\s+semana\s+pasada|la\s+semana\s+que\s+vienne|el\s+próximo)\b/i,
        /\b(yesterday|today|tomorrow|last\s+week|next\s+week)\b/i,
      ];

      // Evolving indicators
      const evolvingCategories = ['goal', 'project', 'relationship'];

      if (temporaryCategories.includes(category) ||
          temporaryKeywords.some(p => p.test(content))) {
        temporalType = 'temporary';
      } else if (evolvingCategories.includes(category)) {
        temporalType = 'evolving';
      }

      actions.push({
        type: 'temporal_classification',
        data: {
          memoryContent: (content || '').substring(0, 80),
          temporalType,
          category,
        },
        reasoning: `Classified as ${temporalType}: "${(mem.content || '').substring(0, 50)}"`,
      });
    }

    return actions;
  }

  /**
   * Creates a new memory action.
   */
  _createMemoryAction(category, content, importance, confidence, reasoning) {
    return {
      type: ActionTypes.NEW_MEMORY,
      data: {
        category,
        content,
        importance: this._clampImportance(importance),
        confidence: this._clampConfidence(confidence),
        createdAt: new Date().toISOString(),
      },
      reasoning: reasoning || 'New learning detected',
    };
  }

  /**
   * Creates a memory update action.
   */
  _createUpdateAction(memoryId, updates) {
    return {
      type: ActionTypes.UPDATE_MEMORY,
      data: {
        memoryId,
        updates: {
          ...updates,
          updatedAt: new Date().toISOString(),
        },
      },
      reasoning: `Memory ${memoryId} needs updating`,
    };
  }

  /**
   * Creates a relationship adjustment action.
   */
  _createRelationshipAction(field, delta, reason) {
    return {
      type: ActionTypes.RELATIONSHIP_UPDATE,
      data: {
        field,
        delta,
      },
      reasoning: reason,
    };
  }

  /**
   * Creates an emotion note action.
   */
  _createEmotionAction(emotion, intensity, reason) {
    return {
      type: ActionTypes.EMOTION_NOTE,
      data: {
        emotion,
        intensity: this._clampConfidence(intensity),
        timestamp: new Date().toISOString(),
      },
      reasoning: reason,
    };
  }

  /**
   * Creates an entity discovered action.
   */
  _createEntityAction(name, type, metadata = {}) {
    return {
      type: ActionTypes.ENTITY_DISCOVERED,
      data: {
        name,
        type,
        metadata,
      },
      reasoning: `New ${type} entity discovered: ${name}`,
    };
  }

  /**
   * Creates a contradiction action.
   */
  _createContradictionAction(memory1Id, memory2Id, detail) {
    return {
      type: ActionTypes.CONTRADICTION,
      data: {
        memory1Id,
        memory2Id,
        detail,
      },
      reasoning: detail,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Persists reflection results to the database.
   * 
   * @param {string} userId
   * @param {string} conversationId
   * @param {string} reflection - Human-readable reflection summary
   * @param {Array} actions - Actions produced by reflection
   */
  _logReflection(userId, conversationId, reflection, actions) {
    if (!this.config.logEnabled) return;

    try {
      const actionTypes = [...new Set(actions.map(a => a.type))];
      const primaryType = actionTypes.length > 0 ? actionTypes[0] : 'none';
      const detail = JSON.stringify(actions.map(a => ({ type: a.type, reasoning: a.reasoning })));

      if (typeof this.db.addReflection === 'function') {
        this.db.addReflection(userId, conversationId, reflection, primaryType, detail);
      }
    } catch {
      // Reflection logging should never crash the application
    }
  }

  /**
   * Detects the most likely memory category from text content.
   * 
   * @param {string} text
   * @returns {string}
   */
  _detectMemoryCategory(text) {
    const lowerText = text.toLowerCase();

    for (const [category, patterns] of Object.entries(MEMORY_CATEGORY_KEYWORDS)) {
      for (const pattern of patterns) {
        if (pattern.test(lowerText)) {
          return category;
        }
      }
    }

    return 'fact'; // Default category
  }

  /**
   * Computes importance score for a memory.
   * 
   * @param {Object} analysis
   * @param {string} response
   * @returns {number} Importance between 0.3 and 1.0
   */
  _computeImportance(analysis, response) {
    let importance = 0.5; // Base importance

    // User-stated importance
    if (analysis.importance && typeof analysis.importance === 'number') {
      importance = analysis.importance;
    }

    // High-intensity messages are more important
    if (typeof analysis.intensity === 'number' && analysis.intensity > 0.7) {
      importance += 0.1;
    }

    // Emotional messages tend to be important
    const emotionalState = analysis.emotionalState || {};
    if (emotionalState.confidence > 0.6) {
      importance += 0.05;
    }

    // Check for explicit importance indicators in the combined text
    const combinedText = `${analysis.rawMessage || ''} ${(response || '').toLowerCase()}`;
    for (const pattern of HIGH_IMPORTANCE_KEYWORDS) {
      if (pattern.test(combinedText)) {
        importance += 0.1;
        break;
      }
    }

    return this._clampImportance(importance);
  }

  /**
   * Computes confidence score for a memory.
   * 
   * @param {Object} analysis
   * @returns {number} Confidence between 0.3 and 1.0
   */
  _computeConfidence(analysis) {
    let confidence = 0.7; // Base confidence

    // High emotional state confidence boosts memory confidence
    const emotionalState = analysis.emotionalState || {};
    if (emotionalState.confidence > 0.8) {
      confidence += 0.1;
    }

    // Explicit memories (e.g., "my name is", "I live in") are high confidence
    const rawMessage = (analysis.rawMessage || '').toLowerCase();
    if (/\b(me\s+llamo|i'?m\s+called|my\s+name\s+is|i\s+live\s+in|my\s+favorite\s+is)\b/i.test(rawMessage)) {
      confidence += 0.15;
    }

    return this._clampConfidence(confidence);
  }

  /**
   * Checks if text contains high-importance keywords.
   * 
   * @param {string} text
   * @returns {boolean}
   */
  _hasHighImportanceIndicators(text) {
    return HIGH_IMPORTANCE_KEYWORDS.some(pattern => pattern.test(text));
  }

  /**
   * Simple text similarity based on shared words (Jaccard-like).
   * 
   * @param {string} text1
   * @param {string} text2
   * @returns {number} Similarity between 0 and 1
   */
  _textSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const word of words1) {
      if (words2.has(word)) intersection++;
    }

    const union = new Set([...words1, ...words2]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Detects if two texts express opposite sentiments about the same topic.
   * 
   * @param {string} text1
   * @param {string} text2
   * @returns {boolean}
   */
  _isOppositeSentiment(text1, text2) {
    const positivePatterns = /\b(gusta|encanta|like|love|enjoy|prefer|favorite|fan)\b/i;
    const negativePatterns = /\b(odio|hate|dislike|no\s+gusta|despise|can'?t\s+stand)\b/i;

    const text1IsPositive = positivePatterns.test(text1) && !negativePatterns.test(text1);
    const text1IsNegative = negativePatterns.test(text1) && !positivePatterns.test(text1);
    const text2IsPositive = positivePatterns.test(text2) && !negativePatterns.test(text2);
    const text2IsNegative = negativePatterns.test(text2) && !positivePatterns.test(text2);

    // Opposite sentiments
    return (text1IsPositive && text2IsNegative) || (text1IsNegative && text2IsPositive);
  }

  /**
   * Clamps importance to [0, 1].
   */
  _clampImportance(value) {
    if (typeof value !== 'number' || isNaN(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }

  /**
   * Clamps confidence to [0, 1].
   */
  _clampConfidence(value) {
    if (typeof value !== 'number' || isNaN(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { ReflectionEngine, ActionTypes, DEFAULT_CONFIG };
