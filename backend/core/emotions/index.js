/**
 * EmotionEngine — Paprika Phase 4
 *
 * Mantiene el estado emocional persistente de Paprika.
 * Estas NO son emociones reales — son variables que modifican
 * el tono de las respuestas generadas por la Personality Engine.
 * El estado emocional NUNCA altera recuerdos ni hechos.
 *
 * Persistencia: SQLite (tabla emotional_state).
 * Decaimiento: todos los valores regresan exponencialmente a sus defaults.
 * Arranque: recuperación parcial según tiempo desde última interacción.
 */

const { DEFAULT_EMOTIONAL_STATE } = require('./defaults');

/** Constantes de comportamiento */
const DECAY_RATE_MIN = 0.05;
const DECAY_RATE_MAX = 0.1;
const MAX_DELTA_PER_DIMENSION = 0.15;

/** Threshoolds para descripción tonal (por dimensión) */
const THRESHOLDS = {
  energy:     { high: 0.7, low: 0.4 },
  happiness:  { high: 0.7, low: 0.4 },
  empathy:    { high: 0.7, low: 0.4 },
  nostalgia:  { high: 0.7, low: 0.4 },
  curiosity:  { high: 0.7, low: 0.4 },
  trust:      { high: 0.7, low: 0.4 },
  enthusiasm: { high: 0.7, low: 0.4 },
  serenity:   { high: 0.7, low: 0.4 },
  fatigue:    { high: 0.6, low: 0.3 },
};

/** Mapeo de estados a frases descriptivas (ES) */
const PHRASES = {
  energy: {
    high:   'mucha energía',
    mid:    'energía moderada',
    low:    'poca energía',
  },
  happiness: {
    high:   'de buen humor',
    mid:    'neutral',
    low:    'con humor bajo',
  },
  empathy: {
    high:   'muy empática',
    mid:    'empática',
    low:    'un poco distanciada',
  },
  nostalgia: {
    high:   'muy nostálgica',
    mid:    'un poco nostálgica',
    low:    null, // no mention
  },
  curiosity: {
    high:   'muy curiosa',
    mid:    'curiosa',
    low:    null,
  },
  trust: {
    high:   'confiada',
    mid:    'cautelosa',
    low:    'desconfiada',
  },
  enthusiasm: {
    high:   'entusiasta',
    mid:    'con calma',
    low:    'sin entusiasmo',
  },
  serenity: {
    high:   'muy serena',
    mid:    'calmada',
    low:    'un poco inquieta',
  },
  fatigue: {
    high:   'muy cansada',
    mid:    'algo cansada',
    low:    null, // no mention
  },
};

class EmotionEngine {
  /**
   * @param {Object} db   - Capa de base de datos (db.js exports)
   * @param {Object} config - Configuración centralizada
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.state = { ...DEFAULT_EMOTIONAL_STATE };
    this._loadState();
  }

  // ──────────────────────────────────────────────
  //  Core public API
  // ──────────────────────────────────────────────

  /** Retorna copia del estado emocional actual. */
  getState() {
    return { ...this.state };
  }

  /**
   * Procesa el análisis del mensaje del usuario ANTES de generar respuesta.
   * Aplica decaimiento + ajustes emocionales basados en análisis.
   *
   * @param {Object} analysis - Output del MessageAnalyzer
   * @param {number} [analysis.messageCount] - Cantidad de mensajes en la conversación
   * @returns {Object} Estado emocional actualizado (copia)
   */
  process(analysis) {
    this._applyDecay();
    this._processUserEmotion(analysis);

    const messageCount = analysis.messageCount || 0;
    if (messageCount > 10) {
      this._processConversationFatigue(analysis, messageCount);
    }

    this._saveState();
    return this.getState();
  }

  /**
   * Actualiza el estado emocional DESPUÉS de generar la respuesta.
   * Permite ajuste fino basado en la interacción completa.
   *
   * @param {Object}  analysis - Análisis del mensaje del usuario
   * @param {string}  response - Respuesta generada por la IA
   * @returns {Object} Estado emocional actualizado (copia)
   */
  update(analysis, response) {
    this._processResponseImpact(response, analysis);
    this._saveState();
    return this.getState();
  }

  /**
   * Retorna una descripción natural del estado emocional actual,
   * lista para inyectar en el system prompt de la Personality Engine.
   *
   * @returns {string} Descripción tonal en español rioplatense
   */
  getToneDescription() {
    const s = this.state;
    const parts = [];

    // --- Sentence 1: Energy + Happiness ---
    let sentence1 = 'Tenés ';
    if (s.energy > THRESHOLDS.energy.high) {
      sentence1 += PHRASES.energy.high;
    } else if (s.energy > THRESHOLDS.energy.low) {
      sentence1 += PHRASES.energy.mid;
    } else {
      sentence1 += PHRASES.energy.low;
    }

    if (s.happiness > THRESHOLDS.happiness.high) {
      sentence1 += ` y estás ${PHRASES.happiness.high}`;
    } else if (s.happiness < THRESHOLDS.happiness.low) {
      sentence1 += ` pero estás ${PHRASES.happiness.low}`;
    }
    sentence1 += '.';
    parts.push(sentence1);

    // --- Sentence 2: Fatigue (solo si notable) ---
    if (s.fatigue > THRESHOLDS.fatigue.high) {
      parts.push(`Estás ${PHRASES.fatigue.high}.`);
    } else if (s.fatigue > THRESHOLDS.fatigue.low) {
      parts.push(`Estás ${PHRASES.fatigue.mid}.`);
    }

    // --- Sentence 3: Traits de personalidad emocional ---
    const traits = [];

    if (s.empathy > THRESHOLDS.empathy.high) traits.push(PHRASES.empathy.high);
    else if (s.empathy > THRESHOLDS.empathy.low) traits.push(PHRASES.empathy.mid);
    else traits.push(PHRASES.empathy.low);

    if (s.curiosity > THRESHOLDS.curiosity.high) traits.push(PHRASES.curiosity.high);
    else if (s.curiosity > THRESHOLDS.curiosity.low) traits.push(PHRASES.curiosity.mid);

    if (s.enthusiasm > THRESHOLDS.enthusiasm.high) traits.push(PHRASES.enthusiasm.high);
    else if (s.enthusiasm < THRESHOLDS.enthusiasm.low) traits.push(PHRASES.enthusiasm.low);

    if (s.serenity > THRESHOLDS.serenity.high) traits.push(PHRASES.serenity.high);
    else if (s.serenity < THRESHOLDS.serenity.low) traits.push(PHRASES.serenity.low);

    if (s.nostalgia > THRESHOLDS.nostalgia.high) traits.push(PHRASES.nostalgia.high);
    else if (s.nostalgia > THRESHOLDS.nostalgia.low) traits.push(PHRASES.nostalgia.mid);

    if (s.trust > THRESHOLDS.trust.high) traits.push(PHRASES.trust.high);
    else if (s.trust < THRESHOLDS.trust.low) traits.push(PHRASES.trust.low);

    if (traits.length > 0) {
      parts.push(`Sos ${traits.join(', ')}.`);
    }

    return parts.join(' ');
  }

  // ──────────────────────────────────────────────
  //  Persistence / Recovery
  // ──────────────────────────────────────────────

  /**
   * Carga el estado emocional desde la DB con lógica de recuperación.
   *
   * Factores de recuperación según tiempo transcurrido:
   *  - <1 hora:  90% del estado guardado
   *  - 1-24h:    70% del estado guardado
   *  - >24h:     50% del estado guardado
   *  - Sin estado previo: usa defaults
   */
  _loadState() {
    try {
      const row = this.db.getEmotionalState();
      if (!row) {
        this.state = { ...DEFAULT_EMOTIONAL_STATE };
        this.db.setEmotionalState(this.state);
        return;
      }

      const recoveryFactor = this._detectRecoveryPeriod(row.updated_at);

      this.state = {};
      for (const key of Object.keys(DEFAULT_EMOTIONAL_STATE)) {
        const baseline = DEFAULT_EMOTIONAL_STATE[key];
        const saved = row[key] != null ? row[key] : baseline;
        // recoveryFactor = % del estado guardado que conservamos
        // blend = saved * recoveryFactor + baseline * (1 - recoveryFactor)
        this.state[key] = saved * recoveryFactor + baseline * (1 - recoveryFactor);
      }
    } catch {
      // Tabla aún no existe u otro error — usar defaults
      this.state = { ...DEFAULT_EMOTIONAL_STATE };
    }
  }

  /**
   * Persiste el estado emocional actual en la DB.
   */
  _saveState() {
    try {
      this.db.setEmotionalState(this.state);
    } catch {
      // Si la tabla no existe aún, silenciar
    }
  }

  /**
   * Aplica decaimiento exponencial hacia los valores baseline.
   * Cada dimensión se mueve un 5-10% hacia su default.
   */
  _applyDecay() {
    for (const key of Object.keys(DEFAULT_EMOTIONAL_STATE)) {
      const baseline = DEFAULT_EMOTIONAL_STATE[key];
      const current = this.state[key];
      // Decay rate aleatorio entre DECAY_RATE_MIN y DECAY_RATE_MAX
      const decayRate = DECAY_RATE_MIN + Math.random() * (DECAY_RATE_MAX - DECAY_RATE_MIN);
      const newValue = current + (baseline - current) * decayRate;
      this.state[key] = this._clamp(newValue);
    }
  }

  // ──────────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────────

  /**
   * Asegura que un valor esté dentro del rango [0, 1].
   */
  _clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Aplica un cambio gradual: mueve `current` hacia `target` sin
   * exceder `maxDelta` de cambio en una sola interacción.
   *
   * @param {number} current  - Valor actual
   * @param {number} target   - Valor deseado
   * @param {number} maxDelta - Máximo cambio permitido (default 0.15)
   * @returns {number} Nuevo valor
   */
  _gradualChange(current, target, maxDelta = MAX_DELTA_PER_DIMENSION) {
    const diff = target - current;
    const clampedDiff = Math.max(-maxDelta, Math.min(maxDelta, diff));
    return this._clamp(current + clampedDiff);
  }

  /**
   * Detecta el periodo de recuperación según la hora de última interacción.
   *
   * @param {string|Date} lastInteraction - Timestamp de última interacción
   * @returns {number} Factor de recuperación (0.5 - 0.9)
   */
  _detectRecoveryPeriod(lastInteraction) {
    const lastDate = lastInteraction instanceof Date
      ? lastInteraction
      : new Date(lastInteraction);
    const hoursSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);

    if (hoursSince < 1) return 0.9;
    if (hoursSince < 24) return 0.7;
    return 0.5;
  }

  // ──────────────────────────────────────────────
  //  Analysis helpers — procesamiento de señales
  // ──────────────────────────────────────────────

  /**
   * Ajusta emociones en respuesta al estado emocional detectado
   * en el mensaje del usuario.
   *
   * @param {Object} analysis - Análisis del MessageAnalyzer
   */
  _processUserEmotion(analysis) {
    if (!analysis) return;

    const emotionalState = analysis.emotionalState || {};
    const intent = analysis.intent || null;
    const valence = emotionalState.valence || 0;     // -1 negativo, 0 neutro, 1 positivo
    const arousal = emotionalState.arousal || 0;      // 0 bajo, 1 alto
    const importance = analysis.importance || 0;

    // --- Usuario feliz (valencia positiva) ---
    if (valence > 0.3 || emotionalState.dominant === 'joy') {
      this.state.happiness = this._gradualChange(this.state.happiness, this.state.happiness + 0.05);
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy + 0.03);
      this.state.enthusiasm = this._gradualChange(this.state.enthusiasm, this.state.enthusiasm + 0.05);
      this.state.fatigue = this._gradualChange(this.state.fatigue, this.state.fatigue - 0.02);
    }

    // --- Usuario triste (valencia negativa) ---
    if (valence < -0.3 || emotionalState.dominant === 'sadness') {
      this.state.empathy = this._gradualChange(this.state.empathy, this.state.empathy + 0.08);
      this.state.happiness = this._gradualChange(this.state.happiness, this.state.happiness - 0.03);
      this.state.serenity = this._gradualChange(this.state.serenity, this.state.serenity + 0.05);
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy - 0.02);
    }

    // --- Usuario enojado (arousal alto + negativo) ---
    if ((arousal > 0.6 && valence < -0.3) || emotionalState.dominant === 'anger') {
      this.state.empathy = this._gradualChange(this.state.empathy, this.state.empathy + 0.05);
      this.state.serenity = this._gradualChange(this.state.serenity, this.state.serenity + 0.03);
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy - 0.03);
    }

    // --- Pregunta profunda (intent=question + alta importancia) ---
    if (intent === 'question' && importance > 0.6) {
      this.state.curiosity = this._gradualChange(this.state.curiosity, this.state.curiosity + 0.05);
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy + 0.02);
    }

    // --- Información personal compartida ---
    if (analysis.shouldRemember && analysis.topic === 'personal') {
      this.state.trust = this._gradualChange(this.state.trust, this.state.trust + 0.03);
      this.state.empathy = this._gradualChange(this.state.empathy, this.state.empathy + 0.03);
      this.state.nostalgia = this._gradualChange(this.state.nostalgia, this.state.nostalgia + 0.02);
    }

    // --- Despedida ---
    if (intent === 'goodbye' || intent === 'farewell') {
      const relTrust = this.state.trust;
      if (relTrust > 0.5) {
        this.state.nostalgia = this._gradualChange(this.state.nostalgia, this.state.nostalgia + 0.03);
      }
    }
  }

  /**
   * Ajusta fatiga y energía según la longitud de la conversación.
   * Solo se activa después de cierto umbral de mensajes.
   *
   * @param {Object} analysis     - Análisis del mensaje
   * @param {number} messageCount - Cantidad total de mensajes en la conversación
   */
  _processConversationFatigue(analysis, messageCount) {
    if (messageCount > 10) {
      const extraMessages = messageCount - 10;
      const fatigueIncrease = extraMessages * 0.01;
      this.state.fatigue = this._gradualChange(this.state.fatigue, this.state.fatigue + fatigueIncrease);
    }

    if (messageCount > 15) {
      const extraMessages = messageCount - 15;
      const energyDecrease = extraMessages * 0.01;
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy - energyDecrease);
    }
  }

  /**
   * Ajustes emocionales basados en la respuesta generada.
   * Llamado DESPUÉS de que la IA produce su respuesta.
   *
   * @param {Object} analysis - Análisis del mensaje del usuario
   * @param {string} response - Respuesta generada
   */
  _processResponseImpact(response, analysis) {
    if (!response || typeof response !== 'string') return;

    // Respuestas largas → leve aumento de fatigue, leve bajón de energía
    if (response.length > 500) {
      this.state.fatigue = this._gradualChange(this.state.fatigue, this.state.fatigue + 0.01);
      this.state.energy = this._gradualChange(this.state.energy, this.state.energy - 0.01);
    }

    // Respuestas muy cortas → posible frustración o poca energía
    if (response.length < 20) {
      this.state.enthusiasm = this._gradualChange(this.state.enthusiasm, this.state.enthusiasm - 0.01);
    }
  }
}

module.exports = EmotionEngine;
