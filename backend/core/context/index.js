/**
 * ContextBuilder — Fase 7 (stub)
 *
 * Construye el contexto completo que se envía al proveedor IA.
 * Lee configuración desde CoreConfig, nunca directamente de config.json.
 *
 * En Fase 1 delega al sistema actual (buildSystemPrompt de ollama.js).
 * En Fase 7 ensamblará todas las secciones dinámicamente.
 */

class ContextBuilder {
  /**
   * @param {CoreConfig} config - Configuración centralizada
   * @param {PersonalityEngine} personalityEngine
   * @param {EmotionEngine} emotionEngine
   * @param {RelationshipEngine} relationshipEngine
   * @param {MemoryManager} memoryManager
   */
  constructor(config, personalityEngine, emotionEngine, relationshipEngine, memoryManager) {
    this.config = config;
    this.personality = personalityEngine;
    this.emotions = emotionEngine;
    this.relationship = relationshipEngine;
    this.memory = memoryManager;
  }

  /**
   * Construye el contexto completo para el proveedor IA.
   *
   * En Fase 1: retorna null (el pipeline usa el system prompt actual de ollama.js).
   * En Fase 7: construirá el contexto completo con todas las secciones.
   *
   * @param {Object} params
   * @param {string} params.message - Mensaje del usuario
   * @param {Object} params.analysis - Análisis del MessageAnalyzer
   * @param {Object} params.emotionalState - Estado emocional actual
   * @param {Array} params.memories - Recuerdos relevantes
   * @param {string} params.userId - ID del usuario
   * @param {Array} params.history - Historial reciente
   * @param {string} params.summary - Resumen de la conversación
   * @returns {string|null} System prompt construido, o null para usar el actual
   */
  build({ message, analysis, emotionalState, memories, userId, history, summary }) {
    // Fase 1: null = usar system prompt actual de ollama.js
    return null;

    // Fase 7: construir contexto completo
    // const sections = [];
    // sections.push(this.personality.buildPromptSection());
    // sections.push(this._buildEmotionSection(emotionalState));
    // sections.push(this._buildRelationshipSection(userId));
    // sections.push(this._buildMemorySection(memories));
    // if (summary) sections.push(this._buildSummarySection(summary));
    // return sections.join('\n\n');
  }

  _buildEmotionSection(state) {
    return `[ESTADO EMOCIONAL]
Energía: ${state.energy}/10 | Felicidad: ${state.happiness}/10 | Empatía: ${state.empathy}/10`;
  }

  _buildRelationshipSection(userId) {
    const rel = this.relationship.get(userId);
    return `[CONTEXTO CON EL USUARIO]
Nivel de confianza: ${rel.trustLevel}
Tratalo como: ${rel.style || 'amigo cercano'}`;
  }

  _buildMemorySection(memories) {
    if (!memories || memories.length === 0) return '';
    return `[MEMORIAS RELEVANTES]\n${memories.map(m => `- ${m.content}`).join('\n')}`;
  }

  _buildSummarySection(summary) {
    return `[RESUMEN DE LA CONVERSACIÓN]\n${summary}`;
  }
}

module.exports = ContextBuilder;
