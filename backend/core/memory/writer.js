/**
 * MemoryWriter — Fase 4 (stub)
 *
 * Decide qué información de la conversación debe guardarse como recuerdo.
 * Se ejecuta DESPUÉS de que Paprika responde.
 *
 * En Fase 1 no genera nuevos recuerdos.
 */

class MemoryWriter {
  constructor(db) {
    this.db = db;
  }

  /**
   * Evalúa la conversación y decide si hay información nueva para recordar.
   *
   * @param {Object} params
   * @param {string} params.userMessage - Último mensaje del usuario
   * @param {string} params.assistantResponse - Respuesta de Paprika
   * @param {Object} params.analysis - Análisis del MessageAnalyzer
   * @param {string} params.userId - ID del usuario
   * @returns {Array} Lista de recuerdos nuevos para almacenar
   */
  evaluate({ userMessage, assistantResponse, analysis, userId }) {
    // Fase 1: no generar recuerdos
    return [];

    // Fase 4: lógica completa
    // const memories = [];
    // if (analysis.shouldRemember) {
    //   memories.push({
    //     userId,
    //     type: this._classifyMemory(userMessage, analysis),
    //     content: this._extractMemoryContent(userMessage, assistantResponse),
    //     importance: this._calculateImportance(analysis)
    //   });
    // }
    // return memories;
  }

  _classifyMemory(message, analysis) {
    return 'fact';
  }

  _extractMemoryContent(userMessage, assistantResponse) {
    return userMessage;
  }

  _calculateImportance(analysis) {
    return 0.5;
  }
}

module.exports = MemoryWriter;
