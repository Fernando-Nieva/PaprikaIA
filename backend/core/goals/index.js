/**
 * GoalEngine — Fase 5: Seguimiento y gestión de objetivos del usuario.
 *
 * Rastrea objetivos a lo largo de las conversaciones. Los objetivos se extraen
 * de mensajes del usuario y evolucionan a lo largo del tiempo.
 *
 * Ciclo de vida de un objetivo:
 *   1. Discovery  → Usuario menciona querer hacer/aprender/lograr algo
 *   2. Tracking   → Se registra progreso cuando el usuario menciona avances
 *   3. Completion → Usuario logra el objetivo → marcado como completado
 *   4. Abandonment→ Usuario pierde interés → marcado como abandonado
 *   5. Evolution  → Objetivo cambia de alcance → actualizado
 *
 * Consumido por:
 *   - Pipeline: extractGoals() y trackProgress() durante pre-response
 *   - ContextRanker: getGoalsForContext() para scoring de relevancia
 *   - PromptComposer: getGoalSummary() para sección del system prompt
 *   - MemoryManager: correlaciona recuerdos con objetivos activos
 *
 * Persistencia: SQLite (tabla user_goals, user_milestones)
 */

const DEFAULT_CONFIG = {
  maxActiveGoals: 10,
  priorityDecayDays: 7,
  milestoneThreshold: 0.1,
  completionThreshold: 0.85,
  priorityWeights: {
    mentionCount: 0.2,
    recency: 0.3,
    intensity: 0.2,
    explicitImportance: 0.3,
  },
};

const GOAL_CATEGORIES = ['learning', 'project', 'personal', 'career', 'health', 'social'];

class GoalEngine {
  /**
   * @param {Object} db — Capa de base de datos (db.js)
   * @param {Object} config — Configuración centralizada (CoreConfig)
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.goalConfig = {
      ...DEFAULT_CONFIG,
      ...(config && config.getGoals ? config.getGoals() : {}),
    };
  }

  // ─────────────────────────────────────────────
  //  API pública: consultas
  // ─────────────────────────────────────────────

  /**
   * Retorna todos los objetivos activos de un usuario.
   *
   * @param {string} userId
   * @returns {Array<Object>} Objetivos activos ordenados por prioridad descendente
   */
  getActiveGoals(userId) {
    try {
      const goals = this.db.getGoalsByUser(userId) || [];
      return goals
        .filter((g) => g.status === 'active')
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    } catch {
      return [];
    }
  }

  /**
   * Retorna un objetivo específico por ID.
   *
   * @param {number} goalId
   * @returns {Object|null} Objetivo encontrado o null
   */
  getGoalById(goalId) {
    try {
      return this.db.getGoalById(goalId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Retorna todos los objetivos de un usuario con filtros opcionales.
   *
   * @param {string} userId
   * @param {Object} options
   * @param {string} [options.status] — Filtrar por estado (active, completed, abandoned, paused)
   * @param {number} [options.limit=20] — Límite de resultados
   * @returns {Array<Object>} Objetivos encontrados
   */
  getAllGoals(userId, options = {}) {
    try {
      let goals = this.db.getGoalsByUser(userId) || [];

      if (options.status) {
        goals = goals.filter((g) => g.status === options.status);
      }

      const limit = options.limit || 20;
      return goals.slice(0, limit);
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  //  API pública: discovery & tracking
  // ─────────────────────────────────────────────

  /**
   * Extrae objetivos potenciales del análisis de un mensaje.
   * Crea nuevos objetivos si se detectan patrones de goal.
   * Actualiza menciones de objetivos existentes si se detecta overlap.
   *
   * @param {Object} analysis — Output de MessageAnalyzer.analyze()
   * @param {string} userId
   * @returns {Array<Object>} Objetivos creados o actualizados
   */
  extractGoals(analysis, userId) {
    if (!analysis || !analysis.rawMessage) return [];

    const detectedGoals = this._detectGoalPatterns(analysis);
    const results = [];

    for (const detected of detectedGoals) {
      const existing = this._findExistingGoal(userId, detected.content);

      if (existing) {
        // Actualizar menciones y prioridad
        this._updateGoalMentions(existing);
        results.push(existing);
      } else {
        // Crear nuevo objetivo
        const newGoal = this._createGoal(userId, detected);
        if (newGoal) {
          results.push(newGoal);
        }
      }
    }

    // Detectar progreso en objetivos existentes
    if (results.length === 0) {
      const activeGoals = this.getActiveGoals(userId);
      for (const goal of activeGoals) {
        const progressResult = this._detectProgress(goal, analysis);
        if (progressResult.detected) {
          this._updateGoalProgress(goal, progressResult);
          results.push(goal);
        }
      }
    }

    return results;
  }

  /**
   * Registra progreso en objetivos existentes.
   * Detecta señales de avance, milestones, o retroceso.
   *
   * @param {Object} analysis — Output de MessageAnalyzer.analyze()
   * @param {string} userId
   * @returns {Array<Object>} Objetivos con progreso actualizado
   */
  trackProgress(analysis, userId) {
    if (!analysis || !analysis.rawMessage) return [];

    const activeGoals = this.getActiveGoals(userId);
    const updated = [];

    for (const goal of activeGoals) {
      // Detectar completación
      const completionResult = this._detectCompletion(goal, analysis);
      if (completionResult.detected) {
        this.completeGoal(goal.id, completionResult.detail);
        updated.push({ ...goal, status: 'completed' });
        continue;
      }

      // Detectar abandono
      const abandonResult = this._detectAbandonment(goal, analysis);
      if (abandonResult.detected) {
        this.abandonGoal(goal.id, abandonResult.reason);
        updated.push({ ...goal, status: 'abandoned' });
        continue;
      }

      // Detectar progreso
      const progressResult = this._detectProgress(goal, analysis);
      if (progressResult.detected) {
        this._updateGoalProgress(goal, progressResult);
        updated.push(goal);
      }

      // Detectar milestones
      const milestoneResult = this._detectMilestone(goal, analysis);
      if (milestoneResult.detected) {
        this._addMilestone(goal, milestoneResult.text);
        updated.push(goal);
      }

      // Actualizar entidades relacionadas
      this._updateRelatedEntities(goal, analysis);
    }

    return updated;
  }

  /**
   * Marca un objetivo como completado.
   *
   * @param {number} goalId
   * @param {string} [detail] — Detalle opcional sobre la completación
   * @returns {Object|null} Objetivo actualizado o null
   */
  completeGoal(goalId, detail) {
    try {
      const goal = this.getGoalById(goalId);
      if (!goal) return null;

      this.db.updateGoal(goalId, {
        status: 'completed',
        progress: 1.0,
        completed_at: new Date().toISOString(),
      });

      if (detail) {
        this._addMilestone(goal, detail);
      }

      return { ...goal, status: 'completed', progress: 1.0 };
    } catch {
      return null;
    }
  }

  /**
   * Marca un objetivo como abandonado.
   *
   * @param {number} goalId
   * @param {string} [reason] — Razón del abandono
   * @returns {Object|null} Objetivo actualizado o null
   */
  abandonGoal(goalId, reason) {
    try {
      const goal = this.getGoalById(goalId);
      if (!goal) return null;

      this.db.updateGoal(goalId, {
        status: 'abandoned',
        abandoned_at: new Date().toISOString(),
        metadata: JSON.stringify({ ...(JSON.parse(goal.metadata || '{}')), abandonReason: reason }),
      });

      return { ...goal, status: 'abandoned' };
    } catch {
      return null;
    }
  }

  /**
   * Actualiza la prioridad de un objetivo.
   *
   * @param {number} goalId
   * @param {number} priority — Nueva prioridad (0-1)
   * @returns {Object|null} Objetivo actualizado o null
   */
  updateGoalPriority(goalId, priority) {
    try {
      const clamped = Math.min(Math.max(priority, 0), 1);
      this.db.updateGoal(goalId, { priority: clamped });

      const goal = this.getGoalById(goalId);
      return goal ? { ...goal, priority: clamped } : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  API pública: para otros módulos
  // ─────────────────────────────────────────────

  /**
   * Retorna objetivos activos formateados para ContextRanker.
   *
   * @param {string} userId
   * @returns {Array<Object>} Objetivos con campos normalizados
   */
  getGoalsForContext(userId) {
    const goals = this.getActiveGoals(userId);
    return goals.map((g) => ({
      goal: g.content,
      content: g.content,
      category: g.category,
      priority: g.priority,
      progress: g.progress,
      status: g.status,
      mentions: g.mentions,
      milestones: g.milestones || [],
      relatedEntities: g.relatedEntities || [],
    }));
  }

  /**
   * Retorna un resumen textual de los objetivos activos.
   * Consumido por PromptComposer.
   *
   * @param {string} userId
   * @returns {string} Resumen formateado de objetivos activos
   */
  getGoalSummary(userId) {
    const goals = this.getActiveGoals(userId);
    if (goals.length === 0) return '';

    const priorityLabel = (p) => {
      if (p >= 0.7) return 'alta';
      if (p >= 0.4) return 'media';
      return 'baja';
    };

    const lines = goals.map((g) => {
      const pct = Math.round((g.progress || 0) * 100);
      const prio = priorityLabel(g.priority || 0);
      return `- ${g.content} (progreso: ${pct}%, prioridad ${prio})`;
    });

    return `Objetivos activos:\n${lines.join('\n')}`;
  }

  // ─────────────────────────────────────────────
  //  Internos: detección de patrones
  // ─────────────────────────────────────────────

  /**
   * Detecta patrones de objetivos en el mensaje del usuario.
   * Retorna objetivos potenciales con categoría y confianza.
   *
   * @param {Object} analysis — Output del Analyzer
   * @returns {Array<Object>} Objetivos detectados [{ content, category, rawMatch, confidence }]
   */
  _detectGoalPatterns(analysis) {
    const message = analysis.rawMessage || '';
    const goals = [];

    const goalPatterns = [
      { pattern: /quiero\s+aprender\s+(.+)/i, category: 'learning' },
      { pattern: /quiero\s+hacer\s+(.+)/i, category: 'project' },
      { pattern: /quiero\s+conseguir\s+(.+)/i, category: 'personal' },
      { pattern: /mi\s+objetivo\s+es\s+(.+)/i, category: 'personal' },
      { pattern: /mi\s+meta\s+es\s+(.+)/i, category: 'personal' },
      { pattern: /estoy\s+(?:trabajando|estudiando)\s+en\s+(.+)/i, category: 'project' },
      { pattern: /necesito\s+(?:aprender|hacer|conseguir)\s+(.+)/i, category: 'learning' },
      { pattern: /voy\s+a\s+(?:hacer|aprender|conseguir)\s+(.+)/i, category: 'project' },
      { pattern: /me\s+gustaría\s+(?:aprender|hacer|lograr)\s+(.+)/i, category: 'learning' },
      { pattern: /estoy\s+intentando\s+(.+)/i, category: 'project' },
      { pattern: /soñ(?:o|é)\s+con\s+(.+)/i, category: 'personal' },
      { pattern: /planifico\s+(?:aprender|hacer)\s+(.+)/i, category: 'learning' },
    ];

    for (const { pattern, category } of goalPatterns) {
      const match = message.match(pattern);
      if (match) {
        const content = this._normalizeGoalContent(match[1].trim());
        if (content && content.length > 2) {
          goals.push({
            content,
            category,
            rawMatch: match[0],
            confidence: analysis.confidence || 0.5,
          });
        }
      }
    }

    return goals;
  }

  /**
   * Detecta si el mensaje menciona progreso en un objetivo existente.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} analysis — Output del Analyzer
   * @returns {Object} { detected: boolean, signal: string, delta: number }
   */
  _detectProgress(goal, analysis) {
    const message = (analysis.rawMessage || '').toLowerCase();
    const goalContent = (goal.content || '').toLowerCase();
    const result = { detected: false, signal: null, delta: 0 };

    // Verificar si el mensaje es sobre este objetivo
    const goalWords = goalContent.split(/\s+/).filter((w) => w.length > 3);
    const relevantWords = goalWords.filter((w) => message.includes(w));
    const relevance = goalWords.length > 0 ? relevantWords.length / goalWords.length : 0;

    if (relevance < 0.3 && goalWords.length > 1) return result;

    // Señales positivas de progreso
    const positiveSignals = [
      { pattern: /avanc(?:é|e|o)\s+con/i, delta: 0.1, signal: 'avance' },
      { pattern: /termin(?:é|e|o)\s+(?:la|el|lo|de)/i, delta: 0.2, signal: 'terminó paso' },
      { pattern: /logr(?:é|e|o)\s+(?:la|el|lo)/i, delta: 0.25, signal: 'logró' },
      { pattern: /ya\s+sé\s+(?:hacer|usar|usando)/i, delta: 0.15, signal: 'aprendió' },
      { pattern: /pud(?:é|e|o)\s+(?:hacer|lograr|completar)/i, delta: 0.15, signal: 'pudo' },
      { pattern: /funciona(?:\s+ya|\s+perfecto)/i, delta: 0.1, signal: 'funciona' },
      { pattern: /está\s+(?:listo|hecho|terminado)/i, delta: 0.2, signal: 'completado' },
      { pattern: /me\s+está\s+(?:saliendo|quedando)/i, delta: 0.1, signal: 'mejorando' },
      { pattern: /entend(?:í|o)\s+(?:cómo|el|la)/i, delta: 0.1, signal: 'entendió' },
      { pattern: /descubr(?:í|o)\s+(?:que|cómo)/i, delta: 0.1, signal: 'descubrió' },
    ];

    // Señales negativas
    const negativeSignals = [
      { pattern: /no\s+pud(?:é|e|o)/i, delta: -0.1, signal: 'no pudo' },
      { pattern: /me\s+trab(?:é|e|o)/i, delta: -0.1, signal: ' trabó' },
      { pattern: /no\s+avanc(?:é|e|o)/i, delta: -0.05, signal: 'no avanzó' },
      { pattern: /me\s+estoy\s+(?:frustrando|enojando)/i, delta: -0.15, signal: 'frustración' },
      { pattern: /no\s+(?:entiendo|comprendo)/i, delta: -0.1, signal: 'no entiende' },
      { pattern: /es\s+(?:muy\s+difícil|complicado)/i, delta: -0.05, signal: 'dificultad' },
    ];

    for (const sig of positiveSignals) {
      if (sig.pattern.test(analysis.rawMessage || '')) {
        result.detected = true;
        result.delta = sig.delta;
        result.signal = sig.signal;
        return result;
      }
    }

    for (const sig of negativeSignals) {
      if (sig.pattern.test(analysis.rawMessage || '')) {
        result.detected = true;
        result.delta = sig.delta;
        result.signal = sig.signal;
        return result;
      }
    }

    return result;
  }

  /**
   * Detecta si un objetivo fue completado.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} analysis — Output del Analyzer
   * @returns {Object} { detected: boolean, detail: string }
   */
  _detectCompletion(goal, analysis) {
    const message = analysis.rawMessage || '';
    const result = { detected: false, detail: null };

    const completionPatterns = [
      /(?:logr(?:é|e|o)|termin(?:é|e|o)|complet(?:é|e|o)|acab(?:é|e|o))\s+(?:la|el|lo|de)\s+(?:objetivo|meta|proyecto)/i,
      /ya\s+(?:lo|la|lo)\s+(?:termin(?:é|e|o)|logr(?:é|e|o)|complet(?:é|e|o))/i,
      /está\s+(?:listo|hecho|terminado|completado)/i,
      /pude\s+(?:hacerlo|completarlo|lograrlo)/i,
      /lo\s+(?:logré|terminé|completé)/i,
    ];

    for (const pattern of completionPatterns) {
      const match = message.match(pattern);
      if (match) {
        result.detected = true;
        result.detail = match[0];
        return result;
      }
    }

    // Si el progreso actual es alto y hay señal de terminado
    if ((goal.progress || 0) >= this.goalConfig.completionThreshold) {
      if (/termin(?:ado|é|e)/i.test(message) && this._goalOverlap(goal, message)) {
        result.detected = true;
        result.detail = 'Progreso alto + señal de terminado';
      }
    }

    return result;
  }

  /**
   * Detecta si el usuario perdió interés o abandonó un objetivo.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} analysis — Output del Analyzer
   * @returns {Object} { detected: boolean, reason: string }
   */
  _detectAbandonment(goal, analysis) {
    const message = (analysis.rawMessage || '').toLowerCase();
    const result = { detected: false, reason: null };

    const abandonPatterns = [
      { pattern: /ya\s+no\s+(?:quiero|me\s+interesa|importa)/i, reason: 'perdió interés' },
      { pattern: /(?:olvídalo|dejalo|no\s+importa)/i, reason: 'descartado' },
      { pattern: /ya\s+no\s+es\s+(?:importante|prioridad|necesario)/i, reason: 'ya no es prioridad' },
      { pattern: /mejor\s+(?:no|olvídalo|dejalo)/i, reason: 'cambio de opinión' },
      { pattern: /no\s+(?:voy\s+a|quiero)\s+(?:seguir|intentar)\s+con/i, reason: 'dejó de intentar' },
    ];

    for (const { pattern, reason } of abandonPatterns) {
      if (pattern.test(analysis.rawMessage || '')) {
        if (this._goalOverlap(goal, analysis.rawMessage || '')) {
          result.detected = true;
          result.reason = reason;
          return result;
        }
      }
    }

    return result;
  }

  /**
   * Calcula la prioridad de un objetivo basándose en menciones, recencia,
   * intensidad e importancia explícita.
   *
   * Fórmula:
   *   priority = (mentionScore * 0.2) + (recencyScore * 0.3)
   *            + (intensityScore * 0.2) + (explicitImportance * 0.3)
   *
   * @param {Object} goal — Objetivo con campos: mentions, lastMentioned, metadata
   * @returns {number} Prioridad calculada (0-1)
   */
  _calculatePriority(goal) {
    const weights = this.goalConfig.priorityWeights;

    // Mention score: más menciones → mayor prioridad (saturación en 5)
    const mentionScore = Math.min((goal.mentions || 1) / 5, 1.0);

    // Recency score: decae exponencialmente con días desde última mención
    const lastMentioned = goal.lastMentioned ? new Date(goal.lastMentioned) : new Date();
    const daysSinceMention = (Date.now() - lastMentioned.getTime()) / (1000 * 60 * 60 * 24);
    const decayDays = this.goalConfig.priorityDecayDays;
    const recencyScore = Math.exp(-daysSinceMention / decayDays);

    // Intensity score: intensidad emocional del usuario al mencionar el objetivo
    const meta = this._parseMetadata(goal.metadata);
    const intensityScore = meta.lastIntensity || 0.5;

    // Explicit importance: importancia declarada explícitamente
    const explicitImportance = meta.explicitImportance || goal.priority || 0.5;

    const priority =
      mentionScore * weights.mentionCount +
      recencyScore * weights.recency +
      intensityScore * weights.intensity +
      explicitImportance * weights.explicitImportance;

    return Math.min(Math.max(Math.round(priority * 100) / 100, 0), 1);
  }

  /**
   * Detecta milestones (pasos intermedios alcanzados) en el progreso.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} analysis — Output del Analyzer
   * @returns {Object} { detected: boolean, text: string }
   */
  _detectMilestone(goal, analysis) {
    const message = analysis.rawMessage || '';
    const result = { detected: false, text: null };

    const milestonePatterns = [
      { pattern: /instal(?:é|e|o)\s+(.+)/i, text: 'Instaló' },
      { pattern: /configur(?:é|e|o)\s+(.+)/i, text: 'Configuró' },
      { pattern: /complet(?:é|e|o)\s+(.+)/i, text: 'Completó' },
      { pattern: /hice\s+(?:el|la|lo)\s+(.+)/i, text: 'Hizo' },
      { pattern: /funciona\s+(.+)/i, text: 'Funciona' },
      { pattern: /pr(?:imer|imera)\s+(.+)/i, text: 'Primer' },
      { pattern: /acabo\s+de\s+(.+)/i, text: 'Recién hizo' },
    ];

    for (const { pattern, text } of milestonePatterns) {
      const match = message.match(pattern);
      if (match && this._goalOverlap(goal, message)) {
        result.detected = true;
        result.text = `${text}: ${match[1].trim()}`;
        return result;
      }
    }

    return result;
  }

  /**
   * Actualiza las entidades relacionadas de un objetivo basándose
   * en las entidades detectadas en el análisis actual.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} analysis — Output del Analyzer
   */
  _updateRelatedEntities(goal, analysis) {
    const entities = analysis.entities || {};
    const allEntities = [
      ...(entities.people || []),
      ...(entities.places || []),
      ...(entities.projects || []),
    ];

    if (allEntities.length === 0) return;

    const current = goal.relatedEntities || [];
    const merged = [...new Set([...current, ...allEntities])];

    if (merged.length > current.length) {
      try {
        this.db.updateGoal(goal.id, {
          related_entities: JSON.stringify(merged),
        });
      } catch {
        // Actualización de entidades es opcional
      }
    }
  }

  // ─────────────────────────────────────────────
  //  Internos: helpers
  // ─────────────────────────────────────────────

  /**
   * Busca si ya existe un objetivo con contenido similar para el usuario.
   *
   * @param {string} userId
   * @param {string} content — Contenido del nuevo objetivo detectado
   * @returns {Object|null} Objetivo existente o null
   */
  _findExistingGoal(userId, content) {
    try {
      const goals = this.getActiveGoals(userId);
      const normalizedNew = content.toLowerCase().trim();

      for (const goal of goals) {
        const normalizedExisting = (goal.content || '').toLowerCase().trim();

        // Match exacto
        if (normalizedExisting === normalizedNew) return goal;

        // Overlap significativo de palabras
        const newWords = normalizedNew.split(/\s+/).filter((w) => w.length > 3);
        const existingWords = normalizedExisting.split(/\s+/).filter((w) => w.length > 3);
        const overlap = newWords.filter((w) => existingWords.includes(w));

        if (newWords.length > 0 && overlap.length / newWords.length >= 0.5) {
          return goal;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Verifica si el mensaje tiene overlap con el contenido del objetivo.
   *
   * @param {Object} goal
   * @param {string} message
   * @returns {boolean}
   */
  _goalOverlap(goal, message) {
    const goalWords = (goal.content || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const messageLower = message.toLowerCase();
    const matches = goalWords.filter((w) => messageLower.includes(w));
    return goalWords.length > 0 ? matches.length / goalWords.length >= 0.3 : false;
  }

  /**
   * Crea un nuevo objetivo en la base de datos.
   *
   * @param {string} userId
   * @param {Object} detected — { content, category, rawMatch, confidence }
   * @returns {Object|null} Objetivo creado o null
   */
  _createGoal(userId, detected) {
    try {
      const now = new Date().toISOString();
      const metadata = JSON.stringify({
        rawMatch: detected.rawMatch,
        lastIntensity: 0.5,
        explicitImportance: detected.confidence || 0.5,
      });

      const result = this.db.addGoal({
        user_id: userId,
        content: detected.content,
        category: detected.category,
        priority: detected.confidence || 0.5,
        progress: 0,
        status: 'active',
        mentions: 1,
        first_mentioned: now,
        last_mentioned: now,
        related_memories: '[]',
        related_entities: '[]',
        milestones: '[]',
        metadata,
      });

      if (result && result.lastInsertRowid) {
        return this.getGoalById(result.lastInsertRowid);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Actualiza el contador de menciones de un objetivo.
   *
   * @param {Object} goal — Objetivo existente
   */
  _updateGoalMentions(goal) {
    try {
      const newMentions = (goal.mentions || 0) + 1;
      this.db.updateGoal(goal.id, {
        mentions: newMentions,
        last_mentioned: new Date().toISOString(),
      });

      // Recalcular prioridad
      goal.mentions = newMentions;
      goal.lastMentioned = new Date().toISOString();
      const newPriority = this._calculatePriority(goal);
      this.db.updateGoal(goal.id, { priority: newPriority });
    } catch {
      // Actualización es opcional
    }
  }

  /**
   * Actualiza el progreso de un objetivo.
   *
   * @param {Object} goal — Objetivo existente
   * @param {Object} progressResult — { delta, signal }
   */
  _updateGoalProgress(goal, progressResult) {
    try {
      const current = goal.progress || 0;
      const newProgress = Math.min(Math.max(current + progressResult.delta, 0), 1);
      const rounded = Math.round(newProgress * 100) / 100;

      this.db.updateGoal(goal.id, { progress: rounded });
      goal.progress = rounded;

      // Actualizar metadata con la última señal
      const meta = this._parseMetadata(goal.metadata);
      meta.lastSignal = progressResult.signal;
      meta.lastDelta = progressResult.delta;
      meta.lastSignalDate = new Date().toISOString();
      this.db.updateGoal(goal.id, { metadata: JSON.stringify(meta) });
    } catch {
      // Actualización es opcional
    }
  }

  /**
   * Agrega un milestone a un objetivo.
   *
   * @param {Object} goal — Objetivo existente
   * @param {string} text — Texto del milestone
   */
  _addMilestone(goal, text) {
    try {
      const current = goal.milestones || [];
      const milestone = { text, date: new Date().toISOString() };
      const updated = [...current, milestone];

      this.db.updateGoal(goal.id, {
        milestones: JSON.stringify(updated),
      });
    } catch {
      // Agregar milestone es opcional
    }
  }

  /**
   * Normaliza el contenido de un objetivo para evitar duplicados.
   *
   * @param {string} content — Contenido crudo
   * @returns {string} Contenido normalizado
   */
  _normalizeGoalContent(content) {
    if (!content) return '';
    return content
      .replace(/[.,;:!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  }

  /**
   * Parsea metadata de string JSON a objeto.
   *
   * @param {string|Object} metadata
   * @returns {Object}
   */
  _parseMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object') return metadata;
    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }
}

module.exports = GoalEngine;
