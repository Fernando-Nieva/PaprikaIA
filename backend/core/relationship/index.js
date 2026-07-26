/**
 * RelationshipEngine — Paprika Phase 4
 *
 * Represents the evolving bond between Paprika and each user.
 * This module does NOT store conversations or memories — it stores the
 * relationship itself: trust, familiarity, humor tolerance, emotional
 * openness, shared jokes, sensitive/favorite topics, formality, etc.
 *
 * Design principles:
 *   1. Gradual changes only — no sudden jumps between interactions.
 *   2. Trust grows slowly with vulnerability and consistency.
 *   3. Familiarity increments naturally with each conversation.
 *   4. Humor adjusts based on user's demonstrated tolerance.
 *   5. Sensitive topics are detected from emotional distress signals.
 *   6. Favorite topics emerge from repeated enthusiastic engagement.
 *   7. Inside jokes form when both parties reference shared moments.
 *
 * Persistence: SQLite via db.js (upsertRelationship, getRelationshipFull).
 * Cache: In-memory Map for fast reads within a request cycle.
 */

const { DEFAULT_RELATIONSHIP } = require('./defaults');

// ─────────────────────────────────────────────────────────────
//  Sensitivity factors: controls how fast each metric can change
//  per interaction. Lower = more gradual.
// ─────────────────────────────────────────────────────────────

const SENSITIVITY = {
  trust: 0.08,
  familiarity: 0.10,
  humor: 0.12,
  openness: 0.10,
  formality: 0.10,
  frequency: 0.15
};

// ─────────────────────────────────────────────────────────────
//  Detection heuristics: keywords and patterns
// ─────────────────────────────────────────────────────────────

const HUMOR_MARKERS = [
  'jaja', 'jeje', 'jiji', 'jopo', 'xd', 'xddd', 'lol', 'lmao',
  'ajaja', 'jsjsjs', 'jajaja', 'jejeje', 're caravana', 'me cago de risa',
  'cara de piola', 'me muero', 'baia baia', 'posta jaja', 'funny'
];

const SENSITIVE_PATTERNS = [
  /no\s+quiero\s+hablar\s+de/i,
  /no\s+me\s+gusta\s+hablar\s+de/i,
  /mejor\s+no\s+hables\s+de/i,
  /eso\s+no\s+me\s+interesa/i,
  /dejalo\s+así/i,
  /no\s+es\s+asunto/i
];

const SENSITIVE_TOPIC_KEYWORDS = [
  'muerte', 'falleció', 'fallecimiento', 'muerto', 'morir',
  'enfermedad', 'enfermo', 'cáncer', 'hospital', 'operación',
  'breakup', 'terminamos', 'se terminó', 'se acabó', 'separación',
  'duelo', 'luto', 'perdí', 'perdí a', 'extraño a',
  'suicidio', 'depresión', 'autolesión'
];

const FORMAL_MARKERS = [
  'usted', 'señor', 'señora', 'con permiso', 'por favor',
  'gracias mucho', 'le agradezco', 'disculpe', 'perdone',
  'es usted amable', 'muy amable', 'a sus órdenes'
];

const INFORMAL_MARKERS = [
  'che', 'boludo', 'boluda', 're', 'posta', 'dale', 'genial',
  'piola', 'copado', 'joya', 'bárbaro', 'qué onda', 'todo bien',
  'amigo', 'pibe', 'mina', 'gurí', 'guri'
];

const VULNERABILITY_PATTERNS = [
  /\bestoy\s+(triste|mal|deprimido|cansado|estresado|ansioso|solo)/i,
  /\bme\s+siento\s+(triste|mal|solo|vacío|perdido)/i,
  /\bno\s+(sé|puedo|aguanto|soporto)/i,
  /\bme\s+da\s+(miedo|pena|bronca|angustia)/i,
  /\bnecesito\s+(ayuda|hablar|alguien)/i,
  /\bno\s+estoy\s+bien/i,
  /\bme\s+duele/i
];

const PERSONAL_INFO_PATTERNS = [
  /me\s+llamo\s+\w+/i,
  /soy\s+\w+/i,
  /tengo\s+\d+\s+años/i,
  /vivo\s+en\s+\w+/i,
  /mi\s+(mamá|papá|hermano|hermana|familia|pareja|novio|novia)/i,
  /trabajo\s+en/i,
  /estudio\s+(en|puedo|puedo|soy)/i,
  /mi\s+favorito/i,
  /mi\s+mejor\s+amigo/i
];

const DEEP_TOPIC_MARKERS = [
  'vida', 'muerte', 'futuro', 'pasado', 'sentido', 'razón',
  'miedo', 'deseo', 'sueño', 'sueños', 'propósito', 'destino',
  'relación', 'amor', 'soledad', 'felicidad', 'tristeza',
  'familia', 'padres', 'hijos', 'infancia', 'recuerdo'
];

// ─────────────────────────────────────────────────────────────
//  RelationshipEngine class
// ─────────────────────────────────────────────────────────────

class RelationshipEngine {
  /**
   * @param {Object} db - Capa de base de datos (db.js)
   * @param {CoreConfig} config - Configuración centralizada
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.cache = new Map(); // userId -> relationship object
  }

  // ─────────────────────────────────────────────────────────
  //  Core: get
  // ─────────────────────────────────────────────────────────

  /**
   * Returns the full relationship object for a user.
   * Creates a default entry if the user is new.
   *
   * @param {string} userId
   * @returns {Object} Relationship object
   */
  get(userId) {
    if (!userId) return { ...DEFAULT_RELATIONSHIP };

    // Check cache first
    if (this.cache.has(userId)) {
      return this.cache.get(userId);
    }

    // Load from DB
    let rel = this.db.getRelationshipFull(userId);

    if (!rel) {
      // New user: persist defaults
      rel = { ...DEFAULT_RELATIONSHIP, userId };
      this.db.upsertRelationship(userId, rel);
    }

    // Cache for the rest of this request cycle
    this.cache.set(userId, rel);
    return rel;
  }

  // ─────────────────────────────────────────────────────────
  //  Core: update
  // ─────────────────────────────────────────────────────────

  /**
   * Updates the relationship based on a completed interaction.
   *
   * Flow:
   *   1. Load current relationship (or create default)
   *   2. Calculate deltas for each metric from the analysis
   *   3. Apply gradual updates (never exceed sensitivity factor)
   *   4. Detect new sensitive topics
   *   5. Detect new favorite topics
   *   6. Check for inside joke opportunities
   *   7. Detect formality shift
   *   8. Update interaction frequency
   *   9. Persist to DB
   *   10. Update cache
   *
   * @param {string} userId
   * @param {Object} analysis - Output from MessageAnalyzer
   * @param {string} response - Paprika's generated response
   */
  update(userId, analysis, response) {
    if (!userId || !analysis) return;

    // Step 1: load current state
    const rel = this.get(userId);

    // Step 2-3: calculate and apply gradual deltas
    const trustDelta = this._calculateTrustDelta(analysis, response);
    const familiarityDelta = this._calculateFamiliarityDelta(analysis);
    const humorDelta = this._calculateHumorDelta(analysis, response);
    const opennessDelta = this._calculateOpennessDelta(analysis);
    const formalityDelta = this._detectFormality(analysis);

    rel.trustLevel = this._gradualUpdate(rel.trustLevel, trustDelta, SENSITIVITY.trust);
    rel.familiarity = this._gradualUpdate(rel.familiarity, familiarityDelta, SENSITIVITY.familiarity);
    rel.humorAllowed = this._gradualUpdate(rel.humorAllowed, humorDelta, SENSITIVITY.humor);
    rel.emotionalOpenness = this._gradualUpdate(rel.emotionalOpenness, opennessDelta, SENSITIVITY.openness);
    rel.formalityLevel = this._gradualUpdate(rel.formalityLevel, formalityDelta, SENSITIVITY.formality);

    // Step 4-5: topic detection
    this._detectSensitiveTopics(rel, analysis);
    this._detectFavoriteTopics(rel, analysis);

    // Step 6: inside jokes
    this._detectInsideJokes(userId, rel, analysis);

    // Step 7: update preferred style based on formality
    if (rel.formalityLevel > 0.65) {
      rel.preferredStyle = 'formal';
    } else if (rel.formalityLevel < 0.35) {
      rel.preferredStyle = 'informal';
    } else {
      rel.preferredStyle = 'mixed';
    }

    // Step 8: interaction frequency + conversation count
    this._updateFrequency(rel);

    // Step 9: persist
    rel.lastInteraction = new Date().toISOString();
    rel.conversationCount = (rel.conversationCount || 0) + 1;

    try {
      this.db.upsertRelationship(userId, rel);
    } catch (err) {
      console.error('[RelationshipEngine] Error persisting:', err.message);
    }

    // Step 10: update cache
    this.cache.set(userId, rel);
  }

  // ─────────────────────────────────────────────────────────
  //  Core: getDescription
  // ─────────────────────────────────────────────────────────

  /**
   * Returns a human-readable text description of the relationship.
   * Used by ContextBuilder to inject into the system prompt.
   *
   * @param {string} userId
   * @returns {string} Descriptive text
   */
  getDescription(userId) {
    const rel = this.get(userId);
    const parts = [];

    // Trust description
    if (rel.trustLevel >= 0.8) {
      parts.push('Confianza muy alta. Podés ser completamente abierta.');
    } else if (rel.trustLevel >= 0.6) {
      parts.push('Confianza alta. Podés ser directa y cálida.');
    } else if (rel.trustLevel >= 0.4) {
      parts.push('Confianza moderada. Sé respetuosa pero cercana.');
    } else {
      parts.push('Confianza baja. Sé amable pero no invasiva.');
    }

    // Familiarity description
    if (rel.familiarity >= 0.7) {
      parts.push('Conocés muy bien a esta persona.');
    } else if (rel.familiarity >= 0.4) {
      parts.push('La conocés razonablemente bien.');
    } else {
      parts.push('Todavía la estás conociendo.');
    }

    // Humor
    if (rel.humorAllowed >= 0.7) {
      parts.push('Puedo usar humor libremente, incluyendo chistes internos.');
    } else if (rel.humorAllowed >= 0.4) {
      parts.push('Puedo usar algo de humor, con cuidado.');
    } else {
      parts.push('Mantené el tono serio, poco humor.');
    }

    // Emotional openness
    if (rel.emotionalOpenness >= 0.6) {
      parts.push('Esta persona suele expresar emociones abiertamente.');
    } else if (rel.emotionalOpenness <= 0.3) {
      parts.push('Esta persona tiende a ser reservada emocionalmente.');
    }

    // Preferred style
    if (rel.preferredStyle === 'formal') {
      parts.push('Prefiere trato formal (usted).');
    } else if (rel.preferredStyle === 'informal') {
      parts.push('Prefiere trato informal (voseo/amistoso).');
    } else {
      parts.push('Se adapta a un tono mixto.');
    }

    // Sensitive topics warning
    if (rel.sensitiveTopics && rel.sensitiveTopics.length > 0) {
      parts.push(`Evitar temas sensibles: ${rel.sensitiveTopics.join(', ')}.`);
    }

    // Favorite topics
    if (rel.favoriteTopics && rel.favoriteTopics.length > 0) {
      parts.push(`Le gustan los temas: ${rel.favoriteTopics.join(', ')}.`);
    }

    // Inside jokes
    if (rel.insideJokes && rel.insideJokes.length > 0) {
      parts.push(`Tenés ${rel.insideJokes.length} chiste(s) interno(s) para referirte.`);
    }

    return parts.join(' ');
  }

  // ─────────────────────────────────────────────────────────
  //  Core: getRelationshipSummary
  // ─────────────────────────────────────────────────────────

  /**
   * Returns structured relationship data for ContextBuilder.
   *
   * @param {string} userId
   * @returns {Object} Structured relationship summary
   */
  getRelationshipSummary(userId) {
    const rel = this.get(userId);

    return {
      trustLevel: rel.trustLevel,
      familiarity: rel.familiarity,
      humorAllowed: rel.humorAllowed,
      emotionalOpenness: rel.emotionalOpenness,
      formalityLevel: rel.formalityLevel,
      preferredStyle: rel.preferredStyle,
      sensitiveTopics: rel.sensitiveTopics || [],
      favoriteTopics: rel.favoriteTopics || [],
      nicknames: rel.nicknames || {},
      insideJokes: (rel.insideJokes || []).length,
      conversationCount: rel.conversationCount || 0,
      interactionFrequency: rel.interactionFrequency || 0.5,
      description: this.getDescription(userId)
    };
  }

  // ─────────────────────────────────────────────────────────
  //  Delta calculators (internal)
  // ─────────────────────────────────────────────────────────

  /**
   * Calculates how trust should change based on this interaction.
   *
   * Trust increases when:
   *   - User shares personal information
   *   - User expresses vulnerability (sad + personal)
   *   - User asks Paprika to remember something (memory_request)
   *   - User has positive valence
   *
   * Trust decreases when:
   *   - User is aggressive (high arousal + negative valence)
   *   - User says contradictory things (low confidence + negative)
   *
   * @param {Object} analysis - Message analysis
   * @param {string} response - Paprika's response
   * @returns {number} Target trust value (0-1)
   */
  _calculateTrustDelta(analysis, response) {
    let target = 0.5; // neutral pull

    const { intent, emotionalState, topic, intensity } = analysis;
    const { valence = 0, arousal = 0.5, dominant = null } = emotionalState || {};

    // ── Trust increases ──

    // User shares personal info
    if (PERSONAL_INFO_PATTERNS.some(p => p.test(analysis.rawMessage))) {
      target += 0.15;
    }

    // User expresses vulnerability (sadness + personal topic)
    if (dominant === 'sadness' && topic === 'personal') {
      target += 0.12;
    }

    // Memory request: user wants Paprika to remember something
    if (intent === 'memory_request') {
      target += 0.10;
    }

    // User is happy/positive
    if (valence > 0.3) {
      target += 0.05;
    }

    // Deep emotional expression
    if (intent === 'emotion' && emotionalState.confidence > 0.5) {
      target += 0.08;
    }

    // ── Trust decreases ──

    // Aggressive behavior: high arousal + negative valence
    if (arousal > 0.7 && valence < -0.3) {
      target -= 0.20;
    }

    // Very negative user state
    if (valence < -0.5 && intensity > 0.7) {
      target -= 0.10;
    }

    // Low-confidence interaction (may indicate inconsistency)
    if (analysis.confidence < 0.3 && intensity > 0.6) {
      target -= 0.05;
    }

    return this._clamp(target, 0, 1);
  }

  /**
   * Calculates familiarity delta based on the interaction.
   *
   * Familiarity increases with:
   *   - Every interaction: base increment
   *   - User uses Paprika's name: small boost
   *   - Deep/personal topics: extra boost
   *   - Longer conversations: accumulated boost
   *
   * @param {Object} analysis - Message analysis
   * @returns {number} Target familiarity value (0-1)
   */
  _calculateFamiliarityDelta(analysis) {
    let delta = 0.01; // Base increment per interaction

    const lower = (analysis.rawMessage || '').toLowerCase();

    // User uses name or nickname references
    if (/paprika/i.test(lower) || /\bche\b/.test(lower)) {
      delta += 0.03;
    }

    // Deep topic engagement
    if (DEEP_TOPIC_MARKERS.some(m => lower.includes(m))) {
      delta += 0.02;
    }

    // Personal topic
    if (analysis.topic === 'personal') {
      delta += 0.02;
    }

    // High-importance message (more substance = more familiarity)
    if (analysis.importance > 0.6) {
      delta += 0.01;
    }

    // Longer messages indicate more engagement
    if (analysis.rawMessage.length > 100) {
      delta += 0.01;
    }

    return delta;
  }

  /**
   * Calculates humor adjustment based on the interaction.
   *
   * Humor increases when:
   *   - User has positive emotional valence
   *   - User uses humor markers (jaja, xd, etc.)
   *   - User laughs at or positively responds to humor
   *
   * Humor decreases when:
   *   - User has negative emotional valence
   *   - User seems serious (high intensity + negative)
   *   - User explicitly says something is not funny
   *
   * @param {Object} analysis - Message analysis
   * @param {string} response - Paprika's response
   * @returns {number} Target humor level (0-1)
   */
  _calculateHumorDelta(analysis, response) {
    let target = 0.5; // neutral pull

    const lower = (analysis.rawMessage || '').toLowerCase();
    const emotionalState = analysis.emotionalState || {};

    // ── Humor increases ──

    // Positive emotional state
    if (emotionalState.valence > 0.3) {
      target += 0.10;
    }

    // Very positive
    if (emotionalState.valence > 0.6) {
      target += 0.10;
    }

    // User uses humor markers
    if (HUMOR_MARKERS.some(m => lower.includes(m))) {
      target += 0.15;
    }

    // Joy detected
    if (emotionalState.dominant === 'joy') {
      target += 0.10;
    }

    // ── Humor decreases ──

    // Negative emotional state
    if (emotionalState.valence < -0.3) {
      target -= 0.15;
    }

    // Serious/distressed
    if (emotionalState.dominant === 'sadness' || emotionalState.dominant === 'anger') {
      target -= 0.10;
    }

    // High arousal + negative = not the time for jokes
    if (emotionalState.arousal > 0.7 && emotionalState.valence < -0.2) {
      target -= 0.15;
    }

    return this._clamp(target, 0, 1);
  }

  /**
   * Calculates emotional openness delta.
   *
   * Openness increases when:
   *   - User expresses emotions directly
   *   - User shares personal feelings
   *   - Emotional state has high confidence (they're being genuine)
   *
   * Openness decreases when:
   *   - User is emotionally avoidant (short, dismissive messages)
   *   - User changes topic when emotions arise
   *
   * @param {Object} analysis - Message analysis
   * @returns {number} Target openness value (0-1)
   */
  _calculateOpennessDelta(analysis) {
    let target = 0.5;

    const { intent, intensity } = analysis;
    const emotionalState = analysis.emotionalState || {};

    // Direct emotion expression
    if (intent === 'emotion') {
      target += 0.15;
    }

    // High emotional confidence (genuine expression)
    if (emotionalState.confidence > 0.6) {
      target += 0.10;
    }

    // Vulnerability patterns
    if (VULNERABILITY_PATTERNS.some(p => p.test(analysis.rawMessage))) {
      target += 0.15;
    }

    // Personal topic with emotional content
    if (analysis.topic === 'personal' && emotionalState.confidence > 0.4) {
      target += 0.10;
    }

    // ── Openness decreases ──

    // Short dismissive messages
    if (analysis.rawMessage.length < 10 && intent !== 'greeting' && intent !== 'farewell') {
      target -= 0.05;
    }

    // Low emotional signal when discussing personal topics
    if (analysis.topic === 'personal' && emotionalState.confidence < 0.2) {
      target -= 0.05;
    }

    return this._clamp(target, 0, 1);
  }

  // ─────────────────────────────────────────────────────────
  //  Topic detection (internal)
  // ─────────────────────────────────────────────────────────

  /**
   * Detects and adds sensitive topics based on user signals.
   *
   * Signals:
   *   - User shows distress (negative emotion + high intensity)
   *   - User explicitly says "no quiero hablar de..."
   *   - Topic involves death, illness, breakup, loss keywords
   *   - User avoids a topic after it's mentioned
   *
   * @param {Object} rel - Current relationship (mutated)
   * @param {Object} analysis - Message analysis
   */
  _detectSensitiveTopics(rel, analysis) {
    const { intensity, topic } = analysis;
    const emotionalState = analysis.emotionalState || {};
    const lower = (analysis.rawMessage || '').toLowerCase();

    // Explicit avoidance patterns
    if (analysis.rawMessage && SENSITIVE_PATTERNS.some(p => p.test(analysis.rawMessage))) {
      if (topic && !rel.sensitiveTopics.includes(topic)) {
        rel.sensitiveTopics.push(topic);
      }
    }

    // Distress signals: negative emotion + high intensity
    if (emotionalState.valence < -0.5 && intensity > 0.6) {
      if (topic && !rel.sensitiveTopics.includes(topic)) {
        rel.sensitiveTopics.push(topic);
      }
    }

    // Sensitive topic keywords detected
    if (SENSITIVE_TOPIC_KEYWORDS.some(k => lower.includes(k))) {
      // Add the current topic as sensitive if not already tracked
      if (topic && !rel.sensitiveTopics.includes(topic)) {
        rel.sensitiveTopics.push(topic);
      }
    }

    // Cap the list to prevent unbounded growth
    if (rel.sensitiveTopics.length > 15) {
      rel.sensitiveTopics = rel.sensitiveTopics.slice(-15);
    }
  }

  /**
   * Detects and adds favorite topics based on enthusiasm signals.
   *
   * Signals:
   *   - User asks multiple questions on the same topic
   *   - User shows high intensity on a topic
   *   - User returns to a topic voluntarily
   *   - User shows positive emotion while discussing a topic
   *
   * @param {Object} rel - Current relationship (mutated)
   * @param {Object} analysis - Message analysis
   */
  _detectFavoriteTopics(rel, analysis) {
    const { intensity, topic } = analysis;
    const emotionalState = analysis.emotionalState || {};

    if (!topic) return;

    // Already a favorite? Still counts as engagement
    if (rel.favoriteTopics.includes(topic)) {
      return;
    }

    // High enthusiasm: positive emotion + high intensity on this topic
    if (emotionalState.valence > 0.3 && intensity > 0.6) {
      rel.favoriteTopics.push(topic);
    }

    // Direct enthusiasm expression
    if (emotionalState.dominant === 'joy' && topic) {
      rel.favoriteTopics.push(topic);
    }

    // User asks a question with strong interest
    if (analysis.intent === 'question' && intensity > 0.5 && emotionalState.valence > 0) {
      rel.favoriteTopics.push(topic);
    }

    // Cap the list
    if (rel.favoriteTopics.length > 15) {
      rel.favoriteTopics = rel.favoriteTopics.slice(-15);
    }
  }

  /**
   * Detects potential inside joke opportunities.
   *
   * Inside jokes form when:
   *   - Both parties reference the same funny moment from a past conversation
   *   - User calls back to something Paprika said that was humorous
   *   - User references a shared experience with humor
   *
   * Since we don't store conversation history here, we detect based on:
   *   - User's humor markers + reference to past interaction
   *   - Callback patterns ("te acordás cuando...", "como aquella vez...")
   *
   * @param {string} userId
   * @param {Object} rel - Current relationship (mutated)
   * @param {Object} analysis - Message analysis
   */
  _detectInsideJokes(userId, rel, analysis) {
    const lower = (analysis.rawMessage || '').toLowerCase();

    // Callback patterns: user references past shared moments
    const callbackPatterns = [
      /te\s+acordás\s+cuando/i,
      /como\s+aquella\s+vez/i,
      /como\s+cuando/i,
      /aquella\s+vez/i,
      /nos\s+reímos/i,
      /nos\s+cagamos\s+de\s+risa/i,
      /nos\-/i,
      /ese\s+chiste/i,
      /como\s+dijiste/i,
      /lo\s+que\s+dijiste/i
    ];

    const isCallback = analysis.rawMessage && callbackPatterns.some(p => p.test(analysis.rawMessage));
    const hasHumor = HUMOR_MARKERS.some(m => lower.includes(m));

    if (isCallback && hasHumor) {
      // User is referencing a past shared humorous moment
      // Create a simplified joke entry (not a full conversation replay)
      const jokeKey = `callback_${Date.now()}`;
      const jokeText = `Recuerdo compartido del usuario: "${(analysis.rawMessage || '').substring(0, 80)}"`;

      if (!rel.insideJokes.some(j => j === jokeText)) {
        rel.insideJokes.push(jokeText);

        // Also persist via the dedicated DB helper
        try {
          this.db.addInsideJoke(userId, jokeText);
        } catch (err) {
          // Non-critical: joke is still in memory
        }
      }
    }

    // Cap inside jokes to prevent unbounded growth
    if (rel.insideJokes.length > 20) {
      rel.insideJokes = rel.insideJokes.slice(-20);
    }
  }

  /**
   * Detects formality level from user's language patterns.
   *
   * Formal signals increase formality; informal signals decrease it.
   * Returns a target value that the gradual update will approach.
   *
   * @param {Object} analysis - Message analysis
   * @returns {number} Target formality level (0-1)
   */
  _detectFormality(analysis) {
    let formality = 0.5; // neutral
    const lower = (analysis.rawMessage || '').toLowerCase();

    // Formal markers increase formality
    let formalCount = 0;
    for (const marker of FORMAL_MARKERS) {
      if (lower.includes(marker)) formalCount++;
    }
    formality += formalCount * 0.12;

    // Informal markers decrease formality
    let informalCount = 0;
    for (const marker of INFORMAL_MARKERS) {
      if (lower.includes(marker)) informalCount++;
    }
    formality -= informalCount * 0.10;

    // Voseo is informal
    if (/\b(vos|vos\s+tenés|sabés|podés|querés|hacés)\b/i.test(analysis.rawMessage)) {
      formality -= 0.05;
    }

    // Usted is formal
    if (/\busted\b/i.test(analysis.rawMessage)) {
      formality += 0.10;
    }

    return this._clamp(formality, 0, 1);
  }

  // ─────────────────────────────────────────────────────────
  //  Interaction frequency tracking
  // ─────────────────────────────────────────────────────────

  /**
   * Updates interaction frequency based on time since last interaction.
   *
   * Frequency increases when:
   *   - User comes back quickly after a recent interaction
   *   - Conversation count grows
   *
   * Frequency decreases naturally over time without interactions.
   *
   * @param {Object} rel - Current relationship (mutated)
   */
  _updateFrequency(rel) {
    const now = Date.now();
    const lastInteraction = rel.lastInteraction ? new Date(rel.lastInteraction).getTime() : 0;

    if (lastInteraction === 0) {
      // First interaction
      rel.interactionFrequency = 0.5;
      return;
    }

    const hoursSinceLast = (now - lastInteraction) / (1000 * 60 * 60);

    // Update frequency based on recency
    if (hoursSinceLast < 1) {
      // Very recent: high frequency
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.9, SENSITIVITY.frequency);
    } else if (hoursSinceLast < 6) {
      // Same day: moderate-high frequency
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.7, SENSITIVITY.frequency);
    } else if (hoursSinceLast < 24) {
      // Within a day
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.6, SENSITIVITY.frequency);
    } else if (hoursSinceLast < 72) {
      // Within a few days: moderate
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.4, SENSITIVITY.frequency);
    } else if (hoursSinceLast < 168) {
      // Within a week: low-moderate
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.3, SENSITIVITY.frequency);
    } else {
      // Rarely: low
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.15, SENSITIVITY.frequency);
    }

    // Boost based on total conversation count
    if (rel.conversationCount > 50) {
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.8, 0.05);
    } else if (rel.conversationCount > 20) {
      rel.interactionFrequency = this._gradualUpdate(rel.interactionFrequency, 0.6, 0.05);
    }
  }

  // ─────────────────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────────────────

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

  /**
   * Applies a gradual update toward a target value.
   * The actual change per interaction is limited by the sensitivity factor.
   *
   * Formula:
   *   delta = target - current
   *   clampedDelta = clamp(delta, -sensitivity, +sensitivity)
   *   newValue = current + clampedDelta
   *
   * This ensures no metric ever jumps more than `sensitivity` points
   * in a single interaction, regardless of how extreme the target is.
   *
   * @param {number} current - Current value
   * @param {number} target - Target value (from delta calculator)
   * @param {number} sensitivity - Maximum change per interaction
   * @returns {number} New clamped value
   */
  _gradualUpdate(current, target, sensitivity) {
    const delta = target - current;
    const clampedDelta = this._clamp(delta, -sensitivity, sensitivity);
    return this._clamp(current + clampedDelta, 0, 1);
  }
}

module.exports = RelationshipEngine;
