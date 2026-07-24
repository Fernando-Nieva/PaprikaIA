/**
 * ArchiveMemoryManager — Nivel 3: Memoria archivada (resúmenes de conversaciones antiguas).
 *
 * Almacena y recupera resúmenes de porciones de conversaciones que ya no
 * caben en Working Memory. Cuando la Working Memory crece demasiado, los
 * mensajes antiguos se resumen aquí y se eliminan de la ventana activa.
 *
 * Arquitectura de 3 niveles:
 *   1. Working Memory (working.js) → mensajes recientes, ventana limitada
 *   2. Long Term Memory (memories table) → hechos, preferencias, relaciones
 *   3. Archive Memory (este módulo) → resúmenes de conversaciones antiguas
 *
 * Persistencia: SQLite (tabla archive_summaries)
 *
 * Consumido por:
 *   - Pipeline: construye contexto archivado para PromptComposer
 *   - PromptComposer: sección [ARCHIVE] del system prompt
 *   - WorkingMemoryManager: triggers archiving cuando Working Memory excede tokens
 */

'use strict';

const MAX_ARCHIVES_PER_CONVERSATION = 20;

class ArchiveMemoryManager {
  /**
   * @param {Object} db - Capa de base de datos (db.js)
   */
  constructor(db) {
    this.db = db;
  }

  // ─────────────────────────────────────────────
  //  API pública: lectura
  // ─────────────────────────────────────────────

  /**
   * Retorna los resúmenes archivados más recientes de una conversación.
   * Limita a los más relevantes para no saturar el contexto.
   *
   * @param {number} conversationId
   * @param {number} [limit=5] - Máximo de resúmenes a retornar
   * @returns {Array<Object>} [{id, summary, message_range_start, message_range_end, created_at}]
   */
  getArchives(conversationId, limit = 5) {
    try {
      const all = this.db.getArchivesByConversation(conversationId) || [];
      // Ya están ordenados por created_at DESC del query
      return all.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Retorna el último resumen archivado de una conversación.
   *
   * @param {number} conversationId
   * @returns {Object|null} Último archive o null
   */
  getLatestArchive(conversationId) {
    const archives = this.getArchives(conversationId, 1);
    return archives.length > 0 ? archives[0] : null;
  }

  /**
   * Construye el contexto archivado formateado para inyectar en el system prompt.
   * Retorna un string legible que el PromptComposer incluye en la sección [ARCHIVE].
   *
   * @param {number} conversationId
   * @param {number} [maxTokens=500] - Presupuesto máximo de tokens para el contexto archivado
   * @returns {string} Contexto archivado formateado (vacío si no hay archives)
   */
  buildArchiveContext(conversationId, maxTokens = 500) {
    const archives = this.getArchives(conversationId, 3);
    if (archives.length === 0) return '';

    const lines = [];

    for (const archive of archives) {
      const date = archive.created_at
        ? new Date(archive.created_at).toLocaleDateString('es-AR')
        : '';

      const summary = (archive.summary || '').trim();
      if (!summary) continue;

      if (date) {
        lines.push(`[${date}] ${summary}`);
      } else {
        lines.push(summary);
      }
    }

    if (lines.length === 0) return '';

    const context = lines.join('\n\n');

    // Truncar si excede el presupuesto de tokens
    const maxChars = maxTokens * 4;
    if (context.length > maxChars) {
      return context.substring(0, maxChars - 3) + '...';
    }

    return context;
  }

  // ─────────────────────────────────────────────
  //  API pública: escritura
  // ─────────────────────────────────────────────

  /**
   * Crea un resumen archivado a partir de mensajes que exceden la Working Memory.
   * Genera un resumen extractivo (sin IA) de los mensajes proporcionados.
   *
   * @param {number} conversationId
   * @param {Array<Object>} messages - Mensajes a resumir [{id, role, content, created_at}]
   * @returns {Object|null} El archive creado o null si no hay suficientes mensajes
   */
  archiveMessages(conversationId, messages) {
    if (!messages || messages.length < 2) return null;

    const summary = this._generateSummary(messages);
    if (!summary || summary.trim().length === 0) return null;

    const rangeStart = messages[0].id || 0;
    const rangeEnd = messages[messages.length - 1].id || 0;

    try {
      this.db.addArchiveSummary(conversationId, summary, rangeStart, rangeEnd);
      return { summary, rangeStart, rangeEnd };
    } catch (err) {
      console.error('[ArchiveMemory] Error guardando archive:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  API pública: stats
  // ─────────────────────────────────────────────

  /**
   * Retorna estadísticas del archive de una conversación.
   *
   * @param {number} conversationId
   * @returns {{ totalArchives: number, totalMessagesArchived: number }}
   */
  getStats(conversationId) {
    try {
      const archives = this.db.getArchivesByConversation(conversationId) || [];
      const totalMessages = archives.reduce((sum, a) => {
        const range = (a.message_range_end || 0) - (a.message_range_start || 0);
        return sum + Math.max(range, 0);
      }, 0);

      return {
        totalArchives: archives.length,
        totalMessagesArchived: totalMessages,
      };
    } catch {
      return { totalArchives: 0, totalMessagesArchived: 0 };
    }
  }

  // ─────────────────────────────────────────────
  //  Internos: generación de resumen
  // ─────────────────────────────────────────────

  /**
   * Genera un resumen extractivo de una lista de mensajes.
   * Extrae puntos clave, temas y decisiones sin usar IA.
   *
   * @param {Array<Object>} messages
   * @returns {string} Resumen formateado
   */
  _generateSummary(messages) {
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const sections = [];

    // Extraer puntos clave del usuario
    const keyPoints = this._extractKeyPoints(userMessages);
    if (keyPoints.length > 0) {
      sections.push(`Puntos clave: ${keyPoints.join('; ')}`);
    }

    // Extraer temas discutidos
    const topics = this._extractTopics(messages);
    if (topics.length > 0) {
      sections.push(`Temas: ${topics.join(', ')}`);
    }

    // Extraer decisiones
    const decisions = this._extractDecisions(userMessages);
    if (decisions.length > 0) {
      sections.push(`Decisiones: ${decisions.join('; ')}`);
    }

    // Resumir respuestas del asistente (últimas 2 como contexto)
    const recentAssistant = assistantMessages.slice(-2);
    if (recentAssistant.length > 0) {
      const responseSummaries = recentAssistant
        .map(m => this._truncateSentence(m.content, 80))
        .filter(Boolean);
      if (responseSummaries.length > 0) {
        sections.push(`Respuestas: ${responseSummaries.join(' | ')}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * Extrae los puntos más relevantes de los mensajes del usuario.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>}
   */
  _extractKeyPoints(messages) {
    const points = [];

    for (const msg of messages) {
      const content = (msg.content || '').trim();
      if (content.length < 10) continue;

      // Preguntas
      if (/\?/.test(content)) {
        points.push(this._truncateSentence(content, 80));
        continue;
      }

      // Información personal
      if (/me\s+llamo|soy\s+\w+|tengo\s+\d+|vivo\s+en|trabajo|estudio/i.test(content)) {
        points.push(this._truncateSentence(content, 80));
        continue;
      }

      // Decisiones
      if (/decidí|voy\s+a|quiero|necesito|elijo|mejor\s+opción/i.test(content)) {
        points.push(this._truncateSentence(content, 80));
        continue;
      }

      // Mensajes significativos (> 50 chars)
      if (content.length > 50) {
        points.push(this._truncateSentence(content, 80));
      }
    }

    return points.slice(0, 5);
  }

  /**
   * Identifica temas principales en los mensajes.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>}
   */
  _extractTopics(messages) {
    const topicKeywords = {
      'tecnología': ['programar', 'código', 'javascript', 'python', 'react', 'node', 'api', 'servidor'],
      'trabajo': ['trabajo', 'empleo', 'jefe', 'proyecto', 'reunión', 'cliente'],
      'salud': ['médico', 'hospital', 'ejercicio', 'dieta', 'ansiedad', 'estrés'],
      'relaciones': ['amigo', 'familia', 'pareja', 'relación', 'conflicto'],
      'educación': ['estudiar', 'curso', 'clase', 'examen', 'aprender'],
      'entretenimiento': ['película', 'serie', 'juego', 'música', 'libro'],
    };

    const counts = {};
    for (const msg of messages) {
      const lower = (msg.content || '').toLowerCase();
      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            counts[topic] = (counts[topic] || 0) + 1;
            break;
          }
        }
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([topic]) => topic);
  }

  /**
   * Extrae decisiones explícitas del usuario.
   *
   * @param {Array<Object>} messages
   * @returns {Array<string>}
   */
  _extractDecisions(messages) {
    const decisions = [];
    const pattern = /(?:decidí|voy\s+a|quiero|necesito|elijo|me\s+quedo\s+con|la\s+mejor\s+opción)/i;

    for (const msg of messages) {
      if (pattern.test(msg.content || '')) {
        decisions.push(this._truncateSentence(msg.content, 80));
      }
    }

    return decisions.slice(0, 3);
  }

  /**
   * Trunca una oración a un número máximo de caracteres.
   *
   * @param {string} text
   * @param {number} maxLen
   * @returns {string}
   */
  _truncateSentence(text, maxLen) {
    if (!text) return '';
    const trimmed = text.trim();
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.substring(0, maxLen - 3) + '...';
  }
}

module.exports = ArchiveMemoryManager;
