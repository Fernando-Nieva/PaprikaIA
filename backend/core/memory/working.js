/**
 * WorkingMemoryManager — Nivel 1: Memoria de trabajo (conversación actual).
 *
 * Gestiona la ventana de mensajes que se envían al proveedor IA.
 * Implementa un límite de tokens configurable con scoring inteligente:
 * en vez de cortar por antigüedad, prioriza mensajes por:
 *   1. Relevancia con el mensaje actual (Jaccard similarity)
 *   2. Importancia (señales de calidad del contenido)
 *   3. Actualidad (decay lineal por posición)
 *   4. Resonancia emocional (keywords vs estado emocional)
 *
 * Los mensajes poco relevantes se eliminan ANTES de cortar por longitud.
 *
 * Arquitectura de 3 niveles:
 *   1. Working Memory (este módulo) → mensajes recientes, ventana limitada
 *   2. Long Term Memory (memories table) → hechos, preferencias, relaciones
 *   3. Archive Memory (archive_summaries) → resúmenes de conversaciones antiguas
 *
 * Flujo:
 *   1. Carga historial completo de DB
 *   2. Scoring: puntúa cada mensaje con 4 factores
 *   3. Elimina los de menor score primero (preserva lo más relevante)
 *   4. Garantiza minMessages recientes para mantener flujo conversacional
 *   5. Retorna mensajes ordenados cronológicamente
 *   6. Mensajes eliminados → archivado
 */

'use strict';

const DEFAULT_CONFIG = {
  maxTokens: 6000,
  charsPerToken: 4,
  minMessages: 4,
  reserveForResponse: 1500,
};

// ─── Scoring Weights ────────────────────────────────────────────────────────

const WEIGHTS = {
  relevance: 0.35,
  importance: 0.25,
  recency: 0.20,
  emotional: 0.20,
};

// ─── Emotional Keywords ─────────────────────────────────────────────────────

const EMOTION_KEYWORDS = {
  joy: ['feliz', 'genial', 'increíble', 'logré', 'éxito', 'celebrar', 'amazing', 'great'],
  sadness: ['triste', 'pena', 'llorar', 'perdí', 'muerte', 'adiós', 'extraño', 'lost'],
  anger: ['enojado', 'furioso', 'molest', 'odio', 'injusto', 'angry', 'furious', 'hate'],
  fear: ['miedo', 'asustado', 'preocupado', 'ansioso', 'nervioso', 'scared', 'worried'],
  nostalgia: ['recuerdo', 'antes', 'cuando era', 'nostalgia', 'back when', 'used to'],
  excitement: ['emocionado', 'ansioso', 'esperando', 'excited', "can't wait"],
  gratitude: ['gracias', 'agradezco', 'thank', 'appreciate', 'grateful'],
  frustration: ['frustrado', 'no puedo', 'stuck', "can't", 'imposible'],
};

// ─── Importance Signals ─────────────────────────────────────────────────────

const QUESTION_PATTERNS = /\?|¿|pregunt|decime|contame|quer[eo] saber|cómo|qué|cuándo|dónde|por qué|cuánto/i;

class WorkingMemoryManager {
  /**
   * @param {Object} db - Capa de base de datos (db.js)
   * @param {Object} [config={}] - Configuración de Overwrite
   */
  constructor(db, config = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxContentTokens = this.config.maxTokens - this.config.reserveForResponse;
    // Cache: evita queries redundantes dentro del mismo pipeline cycle
    this._cachedConvId = null;
    this._cachedMessages = null;
  }

  /**
   * Invalida el cache de mensajes (llamar después de store/update).
   */
  invalidateCache() {
    this._cachedConvId = null;
    this._cachedMessages = null;
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Construye la ventana de Working Memory para una conversación.
   * Usa scoring inteligente para priorizar mensajes por relevancia,
   * importancia, actualidad y resonancia emocional.
   *
   * @param {number} conversationId
   * @param {Object} [context={}]
   * @param {string} [context.currentMessage] - Mensaje actual del usuario (para relevance)
   * @param {Object} [context.emotionalState] - Estado emocional actual (para emotional scoring)
   * @returns {{ messages: Array<{role: string, content: string}>, toArchive: Array<Object> }}
   */
  buildWindow(conversationId, context = {}) {
    const allMessages = this._getMessages(conversationId);
    if (!allMessages || allMessages.length === 0) {
      return { messages: [], toArchive: [] };
    }

    const effectiveMax = this.maxContentTokens;

    // Calcular tokens de cada mensaje
    const withMeta = allMessages.map((m, i) => ({
      ...m,
      _index: i,
      _tokens: this._estimateTokens(m.content || ''),
    }));

    const totalTokens = withMeta.reduce((sum, m) => sum + m._tokens, 0);

    // Si cabe todo, no hay nada que archivar
    if (totalTokens <= effectiveMax) {
      return {
        messages: withMeta.map(m => ({ role: m.role, content: m.content })),
        toArchive: [],
      };
    }

    // ─── Scoring: puntuar cada mensaje ───
    const scored = withMeta.map(m => ({
      ...m,
      _score: this._scoreMessage(m, withMeta.length, context),
    }));

    // ─── Selección inteligente ───
    return this._selectMessages(scored, effectiveMax);
  }

  /**
   * Retorna solo los mensajes formateados para el proveedor IA (sin toArchive).
   * Atajo para uso directo.
   *
   * @param {number} conversationId
   * @param {Object} [context]
   * @returns {Array<{role: string, content: string}>}
   */
  getMessagesForProvider(conversationId, context) {
    const { messages } = this.buildWindow(conversationId, context);
    return messages;
  }

  /**
   * Retorna los mensajes que necesitan ser archivados (resumidos).
   *
   * @param {number} conversationId
   * @param {Object} [context]
   * @returns {Array<Object>} Mensajes a archivar
   */
  getMessagesToArchive(conversationId, context) {
    const { toArchive } = this.buildWindow(conversationId, context);
    return toArchive;
  }

  /**
   * Calcula el total de tokens de los mensajes de una conversación.
   *
   * @param {number} conversationId
   * @returns {number} Total estimado de tokens
   */
  getTokenCount(conversationId) {
    const messages = this._getMessages(conversationId);
    if (!messages || messages.length === 0) return 0;
    return messages.reduce((sum, m) => sum + this._estimateTokens(m.content || ''), 0);
  }

  /**
   * Retorna estadísticas de la Working Memory.
   *
   * @param {number} conversationId
   * @returns {{ totalMessages: number, totalTokens: number, maxTokens: number, utilization: number, needsArchive: boolean }}
   */
  getStats(conversationId) {
    const messages = this._getMessages(conversationId) || [];
    const totalTokens = messages.reduce((sum, m) => sum + this._estimateTokens(m.content || ''), 0);
    const utilization = totalTokens / this.maxContentTokens;

    return {
      totalMessages: messages.length,
      totalTokens,
      maxTokens: this.maxContentTokens,
      utilization: Math.round(utilization * 100) / 100,
      needsArchive: totalTokens > this.maxContentTokens,
    };
  }

  // ─────────────────────────────────────────────
  //  Scoring: Composite
  // ─────────────────────────────────────────────

  /**
   * Calcula el score compuesto de un mensaje.
   *
   * @param {Object} msg - Mensaje con metadata
   * @param {number} totalMessages - Total de mensajes en la conversación
   * @param {Object} context - { currentMessage, emotionalState }
   * @returns {number} Score entre 0 y 1
   */
  _scoreMessage(msg, totalMessages, context) {
    const w = WEIGHTS;
    const recency = this._scoreRecency(msg, totalMessages);
    const relevance = this._scoreRelevance(msg, context.currentMessage);
    const importance = this._scoreImportance(msg);
    const emotional = this._scoreEmotional(msg, context.emotionalState);

    return w.recency * recency
      + w.relevance * relevance
      + w.importance * importance
      + w.emotional * emotional;
  }

  // ─────────────────────────────────────────────
  //  Scoring: Individual factors
  // ─────────────────────────────────────────────

  /**
   * Recency score: decay lineal basado en posición.
   * El mensaje más reciente = 1.0, el más antiguo ≈ 0.0.
   *
   * @param {Object} msg - Mensaje con _index
   * @param {number} totalMessages
   * @returns {number} 0-1
   */
  _scoreRecency(msg, totalMessages) {
    if (totalMessages <= 1) return 1.0;
    return msg._index / (totalMessages - 1);
  }

  /**
   * Relevance score: similitud Jaccard entre el contenido del mensaje
   * y el mensaje actual del usuario.
   *
   * @param {Object} msg - Mensaje con content
   * @param {string} currentMessage - Mensaje actual del usuario
   * @returns {number} 0-1
   */
  _scoreRelevance(msg, currentMessage) {
    if (!currentMessage || !msg.content) return 0.0;
    return this._jaccardSimilarity(msg.content, currentMessage);
  }

  /**
   * Importance score: señales de calidad del contenido.
   *
   * Factores:
   * - User messages > assistant messages (fuente de verdad)
   * - Preguntas > declaraciones (señal de engagement)
   * - Mensajes largos > cortos (densidad informativa, hasta un cap)
   * - Tool results = penalización (ruido operativo)
   *
   * @param {Object} msg
   * @returns {number} 0-1
   */
  _scoreImportance(msg) {
    let score = 0.3; // base

    // User messages are more important
    if (msg.role === 'user') {
      score += 0.3;
    }

    // Questions signal engagement
    if (msg.role === 'user' && QUESTION_PATTERNS.test(msg.content || '')) {
      score += 0.15;
    }

    // Length score: longer = more info, capped
    const wordCount = (msg.content || '').split(/\s+/).length;
    score += Math.min(wordCount / 50, 1.0) * 0.25;

    // Tool results are less important (operational noise)
    if (msg.role === 'tool' || msg.tool_name) {
      score -= 0.2;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Emotional score: resonancia emocional con el estado actual.
   * Detecta keywords emocionales en el mensaje y los compara
   * con el estado emocional dominante.
   *
   * @param {Object} msg
   * @param {Object} emotionalState - { dominant: string, ... }
   * @returns {number} 0-1
   */
  _scoreEmotional(msg, emotionalState) {
    if (!emotionalState || !msg.content) return 0.3; // neutral

    const dominant = emotionalState.dominant || '';
    if (!dominant) return 0.3;

    const keywords = EMOTION_KEYWORDS[dominant] || [];
    if (keywords.length === 0) return 0.3;

    const content = (msg.content || '').toLowerCase();
    for (const kw of keywords) {
      if (content.includes(kw)) return 1.0;
    }

    return 0.1; // no match
  }

  // ─────────────────────────────────────────────
  //  Selection: Greedy with priority
  // ─────────────────────────────────────────────

  /**
   * Selecciona mensajes para la ventana de Working Memory.
   *
   * Algoritmo:
   *   1. Los últimos minMessages siempre se conservan (flujo conversacional)
   *   2. Los mensajes restantes se ordenan por score descendente
   *   3. Se agregan greedily hasta llenar el presupuesto de tokens
   *   4. El conjunto final se ordena cronológicamente para el proveedor
   *
   * @param {Array} scored - Mensajes con _score, _tokens, _index
   * @param {number} maxTokens - Presupuesto máximo
   * @returns {{ messages: Array, toArchive: Array }}
   */
  _selectMessages(scored, maxTokens) {
    const n = scored.length;
    const minCount = Math.min(this.config.minMessages, n);

    // Always protect the last minMessages (conversation flow)
    const protectedSet = new Set();
    for (let i = n - minCount; i < n; i++) {
      protectedSet.add(scored[i]._index);
    }

    let protectedTokens = 0;
    for (const msg of scored) {
      if (protectedSet.has(msg._index)) {
        protectedTokens += msg._tokens;
      }
    }

    // Non-protected messages, sorted by score descending
    const candidates = scored
      .filter(m => !protectedSet.has(m._index))
      .sort((a, b) => b._score - a._score);

    // Greedily add highest-scoring messages
    const keptIndices = new Set(protectedSet);
    let usedTokens = protectedTokens;

    for (const msg of candidates) {
      if (usedTokens + msg._tokens <= maxTokens) {
        keptIndices.add(msg._index);
        usedTokens += msg._tokens;
      }
    }

    // Build result in original chronological order
    const kept = scored
      .filter(m => keptIndices.has(m._index))
      .sort((a, b) => a._index - b._index);

    const toArchive = scored
      .filter(m => !keptIndices.has(m._index))
      .sort((a, b) => a._index - b._index);

    return {
      messages: kept.map(m => ({ role: m.role, content: m.content })),
      toArchive: toArchive.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      })),
    };
  }

  // ─────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────

  /**
   * Obtiene mensajes de la DB con cache para evitar queries redundantes.
   *
   * @param {number} conversationId
   * @returns {Array<Object>}
   */
  _getMessages(conversationId) {
    if (this._cachedConvId === conversationId && this._cachedMessages) {
      return this._cachedMessages;
    }
    this._cachedMessages = this.db.getMessages(conversationId);
    this._cachedConvId = conversationId;
    return this._cachedMessages;
  }

  /**
   * Estima la cantidad de tokens en un texto.
   *
   * @param {string} text
   * @returns {number}
   */
  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / this.config.charsPerToken);
  }

  /**
   * Calcula similitud Jaccard a nivel de palabras.
   *
   * @param {string} text1
   * @param {string} text2
   * @returns {number} 0-1
   */
  _jaccardSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;

    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const w of words1) {
      if (words2.has(w)) intersection++;
    }

    const union = new Set([...words1, ...words2]).size;
    return union > 0 ? intersection / union : 0;
  }
}

module.exports = WorkingMemoryManager;
