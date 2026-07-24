/**
 * SelfAccess — Acceso al estado interno de Paprika
 *
 * Agrega el estado de todos los módulos cognitivos en un formato
 * que el modelo de IA puede usar para responder preguntas sobre
 * sí misma: quién es, qué sabe, qué siente, qué recuerda, etc.
 *
 * Cuando el usuario pregunta "quién sos", "qué sabés de mí",
 * "qué sentís", etc., SelfAccess provee la información que
 * el PromptComposer incluye en el system prompt.
 *
 * Consumido por:
 *   - Pipeline: paso intermedio antes de PromptComposer
 *   - PromptComposer: sección [SELF STATE]
 */

const DEFAULT_CONFIG = {
  maxMemoriesInSummary: 8,
  maxGoalsInSummary: 5,
  maxEntitiesInSummary: 10,
  maxRelationshipsInSummary: 5,
};

class SelfAccess {
  /**
   * @param {Object} modules - All core modules needed for state access
   * @param {PersonalityEngine} modules.personality
   * @param {EmotionEngine} modules.emotions
   * @param {RelationshipEngine} modules.relationship
   * @param {GoalEngine} modules.goals
   * @param {MemoryManager} modules.memory
   * @param {MemorySearch} modules.memorySearch
   * @param {KnowledgeGraph} modules.knowledge
   * @param {Object} [config]
   */
  constructor(modules, config) {
    this.personality = modules.personality;
    this.emotions = modules.emotions;
    this.relationship = modules.relationship;
    this.goals = modules.goals;
    this.memory = modules.memory;
    this.memorySearch = modules.memorySearch;
    this.knowledge = modules.knowledge;
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  /**
   * Genera el estado completo de Paprika para un usuario.
   * Este es el payload principal que se incluye en el system prompt
   * para que el modelo sepa quién es y qué sabe.
   *
   * @param {string} userId
   * @returns {Object} Estado completo de Paprika
   */
  getFullState(userId) {
    return {
      identity: this._getIdentity(),
      personality: this._getPersonalitySummary(),
      emotional: this._getEmotionalSummary(),
      relationship: this._getRelationshipSummary(userId),
      memories: this._getMemorySummary(userId),
      goals: this._getGoalSummary(userId),
      knowledge: this._getKnowledgeSummary(userId),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Genera una sección de texto para el system prompt
   * con toda la información de autoconocimiento.
   *
   * @param {string} userId
   * @returns {string} Sección formateada para el prompt
   */
  buildSelfStateSection(userId) {
    const state = this.getFullState(userId);
    const lines = [];

    // Identity
    lines.push(`SOS ${state.identity.name}.`);
    lines.push(`${state.identity.description}`);
    if (state.identity.essence) {
      lines.push(`Tu esencia: ${state.identity.essence}`);
    }

    // Emotional state
    if (state.emotional.description) {
      lines.push(`\nEstado emocional actual: ${state.emotional.description}`);
    }

    // Relationship with this user
    if (state.relationship.description) {
      lines.push(`\nRelación con el usuario: ${state.relationship.description}`);
    }

    // Memories about the user
    if (state.memories.length > 0) {
      lines.push(`\nLo que sabés sobre el usuario:`);
      for (const mem of state.memories) {
        lines.push(`- [${mem.category}] ${mem.content}`);
      }
    }

    // Active goals
    if (state.goals.length > 0) {
      lines.push(`\nObjetivos activos del usuario:`);
      for (const goal of state.goals) {
        const progress = Math.round((goal.progress || 0) * 100);
        lines.push(`- ${goal.content} (${progress}% completado, prioridad: ${goal.priority || 'media'})`);
      }
    }

    // Known entities
    if (state.knowledge.entities.length > 0) {
      lines.push(`\nEntidades conocidas: ${state.knowledge.entities.map(e => `${e.name} (${e.type})`).join(', ')}`);
    }

    // Personality traits (compact)
    if (state.personality.interests && state.personality.interests.length > 0) {
      lines.push(`\nTus intereses: ${state.personality.interests.join(', ')}`);
    }

    if (state.personality.catchphrase) {
      lines.push(`Frase típica: "${state.personality.catchphrase}"`);
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────
  //  Internal state extractors
  // ─────────────────────────────────────────────

  _getIdentity() {
    try {
      return this.personality.getIdentity();
    } catch {
      return { name: 'Paprika', whoAmI: 'Soy Paprika', description: '', essence: '' };
    }
  }

  _getPersonalitySummary() {
    try {
      const identity = this.personality.getIdentity();
      const speech = this.personality.getSpeech();
      const humor = this.personality.getHumor();
      const interests = this.personality.getInterests();
      const values = this.personality.getValues();
      const goals = this.personality.getGoals();

      return {
        name: identity.name,
        style: speech.style,
        humorStyle: humor.style,
        catchphrase: humor.catchphrase,
        interests: interests,
        values: values,
        goals: goals,
      };
    } catch {
      return {};
    }
  }

  _getEmotionalSummary() {
    try {
      const state = this.emotions.getState();
      const description = this.emotions.getToneDescription();

      // Find dominant emotions (threshold > 0.6)
      const dominant = Object.entries(state)
        .filter(([, v]) => v > 0.6)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ dimension: k, level: Math.round(v * 100) }));

      return {
        state,
        description,
        dominant,
      };
    } catch {
      return { state: {}, description: '', dominant: [] };
    }
  }

  _getRelationshipSummary(userId) {
    try {
      const summary = this.relationship.getRelationshipSummary(userId);
      return {
        trust: summary.trustLevel,
        familiarity: summary.familiarity,
        formality: summary.formalityLevel,
        preferredStyle: summary.preferredStyle,
        conversationCount: summary.conversationCount,
        favoriteTopics: summary.favoriteTopics || [],
        sensitiveTopics: summary.sensitiveTopics || [],
        insideJokes: summary.insideJokes || 0,
        description: summary.description,
      };
    } catch {
      return { description: '' };
    }
  }

  _getMemorySummary(userId) {
    try {
      const memories = this.memory.getAll(userId, this.config.maxMemoriesInSummary);
      return memories.map((m) => ({
        category: m.type,
        content: m.content,
        importance: m.importance,
      }));
    } catch {
      return [];
    }
  }

  _getGoalSummary(userId) {
    try {
      const goals = this.goals.getActiveGoals(userId);
      return goals.slice(0, this.config.maxGoalsInSummary).map((g) => ({
        content: g.content || g.goal,
        category: g.category,
        priority: g.priority > 0.7 ? 'alta' : g.priority > 0.4 ? 'media' : 'baja',
        progress: g.progress || 0,
        mentions: g.mentions || 1,
      }));
    } catch {
      return [];
    }
  }

  _getKnowledgeSummary(userId) {
    try {
      const entities = this.knowledge.getEntitiesByUser(userId, {
        limit: this.config.maxEntitiesInSummary,
      });
      const stats = this.knowledge.getStats(userId);

      return {
        entities: entities.map((e) => ({
          name: e.name,
          type: e.entity_type,
        })),
        totalEntities: stats.entities,
        totalRelations: stats.relations,
      };
    } catch (err) {
      console.error('[SelfAccess] Knowledge summary failed:', err.message);
      return { entities: [], totalEntities: 0, totalRelations: 0 };
    }
  }
}

module.exports = SelfAccess;
