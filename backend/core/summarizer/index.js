/**
 * Summarizer — Fase 4: Resúmenes automáticos de conversaciones.
 *
 * Genera resúmenes extractivos (sin IA) cuando una conversación supera
 * un umbral configurable de mensajes. Extrae puntos clave, temas,
 * preguntas, decisiones y emociones del historial no resumido.
 *
 * Flujo:
 * 1. shouldSummarize() verifica si hay suficientes mensajes nuevos
 * 2. getUnsummarizedRange() determina qué mensajes procesar
 * 3. summarize() extrae información estructurada y guarda en DB
 * 4. getLatestSummary() retorna el resumen más reciente para el pipeline
 *
 * Consumido por:
 * - Pipeline: obtiene latestSummary para construir contexto
 * - PersonalityEngine: inyecta resumen en el system prompt
 *
 * No depende de ningún proveedor IA — todo es extracción de texto.
 */

class Summarizer {
  /**
   * @param {Object} db - Capa de base de datos (db.js)
   * @param {CoreConfig} config - Configuración centralizada
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.threshold = config.getConversation().summaryThreshold || 30;
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Verifica si una conversación necesita ser resumida.
   * Compara mensajes no resumidos contra el umbral configurado.
   *
   * @param {number} conversationId
   * @returns {boolean}
   */
  shouldSummarize(conversationId) {
    const range = this.getUnsummarizedRange(conversationId);
    return range.length >= this.threshold;
  }

  /**
   * Genera un resumen extractivo de la conversación y lo guarda en DB.
   * Toma todos los mensajes no resumidos, extrae información clave
   * y persiste un resumen estructurado en conversation_summaries.
   *
   * @param {number} conversationId
   * @returns {string|null} Resumen generado o null si no hay mensajes suficientes
   */
  async summarize(conversationId) {
    const range = this.getUnsummarizedRange(conversationId);
    if (range.length === 0) return null;

    const keyPoints = this._extractKeyPoints(range);
    const topics = this._identifyTopics(range);
    const decisions = this._identifyDecisions(range);
    const questions = this._identifyQuestions(range);
    const emotions = this._identifyEmotions(range);

    const summary = this._buildSummary(keyPoints, topics, decisions, questions, emotions);

    if (!summary || summary.trim().length === 0) return null;

    const rangeStart = range[0].id;
    const rangeEnd = range[range.length - 1].id;

    this.db.addConversationSummary(conversationId, summary, rangeStart, rangeEnd);

    return summary;
  }

  /**
   * Retorna el resumen más reciente de una conversación (string o null).
   * Es el método que consume el Pipeline.
   *
   * @param {number} conversationId
   * @returns {string|null}
   */
  getLatestSummary(conversationId) {
    try {
      return this.db.getLatestSummary(conversationId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Retorna todos los resúmenes de una conversación (objetos completos).
   *
   * @param {number} conversationId
   * @returns {Array<Object>} [{id, summary, message_range_start, message_range_end, created_at}]
   */
  getSummaries(conversationId) {
    try {
      return this.db.getSummariesByConversation(conversationId) || [];
    } catch {
      return [];
    }
  }

  /**
   * Retorna los mensajes que aún no han sido resumidos.
   * Usa el message_range_end del último resumen como punto de corte.
   *
   * @param {number} conversationId
   * @returns {Array<Object>} Mensajes no resumidos, ordenados por id ASC
   */
  getUnsummarizedRange(conversationId) {
    const messages = this.db.getMessages(conversationId);
    if (!messages || messages.length === 0) return [];

    const lastSummary = this._getLastSummaryRow(conversationId);
    const lastSummarizedEnd = lastSummary ? lastSummary.message_range_end : 0;

    return messages.filter(m => m.id > lastSummarizedEnd);
  }

  // ─────────────────────────────────────────────
  //  Métodos internos: extracción
  // ─────────────────────────────────────────────

  /**
   * Extrae los mensajes más relevantes del rango.
   * Filtro: preguntas, comandos, declaraciones emocionales,
   * información personal, decisiones, mensajes > 50 chars.
   *
   * @param {Array<Object>} messages - Mensajes del rango
   * @returns {Array<Object>} Mensajes filtrados con puntuación
   */
  _extractKeyPoints(messages) {
    const scored = [];

    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      const content = (msg.content || '').trim();
      if (content.length === 0) continue;

      let score = 0;
      const reasons = [];

      // Preguntas
      if (/\?/.test(content)) {
        score += 2;
        reasons.push('pregunta');
      }

      // Comandos o solicitudes
      if (/(?:hacé|hacer|mostrá|mostrar|decime|decir|creá|crear|eliminá|eliminar|buscá|buscar|enviá|enviar|actualizá|actualizar)/i.test(content)) {
        score += 2;
        reasons.push('comando');
      }

      // Información personal
      if (/me\s+llamo|soy\s+\w+|tengo\s+\d+\s+años|vivo\s+en|trabajo\s+en|estudio\s+en|me\s+gusta|me\s+encanta|me\s+odio/i.test(content)) {
        score += 3;
        reasons.push('info_personal');
      }

      // Declaraciones emocionales
      if (/estoy\s+(?:feliz|triste|molesto|ansioso|enojado|contento|preocupado|emocionado|frustrado)/i.test(content)) {
        score += 2;
        reasons.push('emocion');
      }

      // Decisiones o conclusiones
      if (/(?:decidí|voy\s+a|quiero|necesito|debería|pienso\s+que|creo\s+que|la\s+mejor\s+opción|conclusión)/i.test(content)) {
        score += 2;
        reasons.push('decision');
      }

      // Nombres propios / entidades
      if (/[A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)+/.test(content)) {
        score += 1;
        reasons.push('entidad');
      }

      // Longitud significativa
      if (content.length > 100) {
        score += 1;
        reasons.push('largo');
      }

      if (score > 0) {
        scored.push({ ...msg, _score: score, _reasons: reasons });
      }
    }

    // Ordenar por puntuación y retornar los más relevantes
    scored.sort((a, b) => b._score - a._score);
    const maxPoints = Math.min(scored.length, 15);
    return scored.slice(0, maxPoints);
  }

  /**
   * Identifica temas recurrentes en los mensajes.
   * Agrupa por palabras clave y retorna los más frecuentes.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>} Top temas detectados
   */
  _identifyTopics(messages) {
    const topicCounts = {};

    const topicKeywords = {
      'tecnología': ['programar', 'código', 'javascript', 'python', 'react', 'node', 'api', 'base de datos', 'servidor', 'frontend', 'backend', 'docker', 'git', 'typescript', 'deploy'],
      'trabajo': ['trabajo', 'empleo', 'jefe', 'oficina', 'proyecto', 'reunión', 'cliente', 'deadline', 'equipo', 'compañero'],
      'salud': ['médico', 'hospital', 'medicina', 'dolor', 'enfermedad', 'ejercicio', 'dieta', 'descansar', 'ansiedad', 'estrés'],
      'relaciones': ['amigo', 'familia', 'pareja', 'relación', 'conflicto', 'discusión', 'amor', 'cita', 'convivir'],
      'educación': ['estudiar', 'universidad', 'curso', 'clase', 'examen', 'profesor', 'aprender', 'tarea', 'materia'],
      'entretenimiento': ['película', 'serie', 'juego', 'música', 'libro', 'podcast', 'anime', 'videojuego', 'streaming'],
      'finanzas': ['dinero', 'ahorrar', 'gasto', 'sueldo', 'inversión', 'deuda', 'presupuesto', 'banco'],
      'cocina': ['cocinar', 'receta', 'comida', 'restaurante', 'comprar', 'ingrediente', 'plato']
    };

    for (const msg of messages) {
      const lower = (msg.content || '').toLowerCase();
      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            topicCounts[topic] = (topicCounts[topic] || 0) + 1;
            break;
          }
        }
      }
    }

    return Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);
  }

  /**
   * Identifica decisiones explícitas en los mensajes del usuario.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>} Decisiones detectadas
   */
  _identifyDecisions(messages) {
    const decisions = [];
    const decisionPatterns = [
      /(?:decidí|decidimos|elegí|la\s+mejor\s+opción\s+es|voy\s+a\s+hacer|voy\s+a\s+usar|voy\s+a\s+intentar|me\s+quedo\s+con)/i,
      /(?:creo\s+que\s+(?:debería|es\s+mejor|la\s+mejor))/i,
      /(?:la\s+conclusión\s+es|al\s+final|resultado)/i
    ];

    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = (msg.content || '').trim();

      for (const pattern of decisionPatterns) {
        if (pattern.test(content)) {
          // Extraer la oración relevante
          const sentence = this._extractRelevantSentence(content, pattern);
          if (sentence && !decisions.includes(sentence)) {
            decisions.push(sentence);
          }
          break;
        }
      }
    }

    return decisions.slice(0, 5);
  }

  /**
   * Identifica preguntas hechas por el usuario.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>} Preguntas detectadas
   */
  _identifyQuestions(messages) {
    const questions = [];

    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const content = (msg.content || '').trim();

      if (/\?$/.test(content) || /\?/.test(content)) {
        // Truncar preguntas muy largas
        const truncated = content.length > 120 ? content.substring(0, 117) + '...' : content;
        if (!questions.includes(truncated)) {
          questions.push(truncated);
        }
      }
    }

    return questions.slice(0, 8);
  }

  /**
   * Identifica emociones expresadas en los mensajes.
   *
   * @param {Array<Object>} messages
   * @returns {Array<Object>} [{emotion, speaker}]
   */
  _identifyEmotions(messages) {
    const emotions = [];

    const emotionKeywords = {
      'feliz': ['feliz', 'contento', 'alegre', 'genial', 'increíble', 'excelente'],
      'triste': ['triste', 'deprimido', 'mal', 'bajo', 'decaído'],
      'enojado': ['enojado', 'molesto', 'furioso', 'harto', 'cansado de'],
      'ansioso': ['ansioso', 'nervioso', 'preocupado', 'estresado', 'angustiado'],
      'emocionado': ['emocionado', 'entusiasmado', 'hyped', 'esperanzado'],
      'agradecido': ['agradecido', 'gracias', 'te lo agradezco']
    };

    for (const msg of messages) {
      const lower = (msg.content || '').toLowerCase();

      for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            const speaker = msg.role === 'user' ? 'usuario' : 'asistente';
            emotions.push({ emotion, speaker });
            break;
          }
        }
      }
    }

    return emotions.slice(0, 10);
  }

  // ─────────────────────────────────────────────
  //  Métodos internos: construcción
  // ─────────────────────────────────────────────

  /**
   * Construye el resumen estructurado como texto formateado.
   *
   * @param {Array<Object>} keyPoints - Puntos extraídos con score
   * @param {Array<string>} topics - Temas detectados
   * @param {Array<string>} decisions - Decisiones identificadas
   * @param {Array<string>} questions - Preguntas hechas
   * @param {Array<Object>} emotions - Emociones detectadas
   * @returns {string} Resumen formateado
   */
  _buildSummary(keyPoints, topics, decisions, questions, emotions) {
    const date = new Date().toLocaleDateString('es-AR', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const sections = [];

    sections.push(`[Resumen de conversación - ${date}]`);

    // Temas
    if (topics.length > 0) {
      sections.push(`Temas: ${topics.join(', ')}`);
    }

    // Preguntas del usuario
    if (questions.length > 0) {
      sections.push(`Preguntas del usuario:`);
      for (const q of questions) {
        sections.push(`  - ${q}`);
      }
    }

    // Decisiones
    if (decisions.length > 0) {
      sections.push(`Decisiones:`);
      for (const d of decisions) {
        sections.push(`  - ${d}`);
      }
    }

    // Puntos clave (de mensajes de usuario con mayor score)
    const topPoints = keyPoints
      .filter(kp => kp.role === 'user' && kp._score >= 2)
      .slice(0, 5);

    if (topPoints.length > 0) {
      sections.push(`Puntos clave:`);
      for (const kp of topPoints) {
        const text = kp.content.length > 100
          ? kp.content.substring(0, 97) + '...'
          : kp.content;
        sections.push(`  - ${text}`);
      }
    }

    // Emociones detectadas
    if (emotions.length > 0) {
      const grouped = {};
      for (const e of emotions) {
        const key = `${e.emotion} (${e.speaker})`;
        grouped[key] = (grouped[key] || 0) + 1;
      }
      const emotionList = Object.entries(grouped)
        .sort((a, b) => b[1] - a[1])
        .map(([desc, count]) => count > 1 ? `${desc} x${count}` : desc);
      sections.push(`Emociones: ${emotionList.join(', ')}`);
    }

    return sections.join('\n');
  }

  // ─────────────────────────────────────────────
  //  Métodos internos: utilidades
  // ─────────────────────────────────────────────

  /**
   * Obtiene la fila completa del último resumen (no solo el string).
   * @param {number} conversationId
   * @returns {Object|null} Fila de conversation_summaries o null
   */
  _getLastSummaryRow(conversationId) {
    try {
      const summaries = this.db.getSummariesByConversation(conversationId);
      return summaries && summaries.length > 0 ? summaries[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Extrae la oración más relevante de un texto dado un patrón.
   * @param {string} text
   * @param {RegExp} pattern
   * @returns {string|null}
   */
  _extractRelevantSentence(text, pattern) {
    const sentences = text.split(/[.!]+/).filter(s => s.trim().length > 5);
    for (const sentence of sentences) {
      if (pattern.test(sentence)) {
        const trimmed = sentence.trim();
        return trimmed.length > 120 ? trimmed.substring(0, 117) + '...' : trimmed;
      }
    }
    // Fallback: retornar el match completo truncado
    const match = text.match(pattern);
    if (match) {
      const m = match[0].trim();
      return m.length > 120 ? m.substring(0, 117) + '...' : m;
    }
    return null;
  }
}

module.exports = Summarizer;
