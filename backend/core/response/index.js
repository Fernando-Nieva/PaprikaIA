/**
 * ResponseProcessor — Fase 8 (stub)
 *
 * Post-procesa la respuesta del proveedor IA antes de enviarla al usuario.
 * Verifica: coherencia con personalidad, tono correcto, uso de recuerdos.
 *
 * En Fase 1 retorna la respuesta sin modificar.
 * En Fase 8 aplicará validaciones y correcciones.
 */

class ResponseProcessor {
  /**
   * @param {CoreConfig} config - Configuración centralizada
   * @param {PersonalityEngine} personalityEngine
   */
  constructor(config, personalityEngine) {
    this.config = config;
    this.personality = personalityEngine;
  }

  /**
   * Procesa la respuesta del proveedor IA.
   *
   * @param {Object} params
   * @param {string} params.rawResponse - Respuesta original del proveedor
   * @param {Object} params.analysis - Análisis del mensaje del usuario
   * @param {Object} params.emotionalState - Estado emocional de Paprika
   * @returns {string} Respuesta procesada
   */
  process({ rawResponse, analysis, emotionalState }) {
    if (!rawResponse || typeof rawResponse !== 'string') return rawResponse;

    // Strip any residual [TOOL:name({...})] markers
    let cleaned = rawResponse.replace(/\[TOOL:\w+\(\{.+?\}\)\]/g, '').trim();

    // Collapse multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned || rawResponse;

    // Fase 8: validaciones y correcciones
    // const issues = this._detectIssues(rawResponse, analysis, emotionalState);
    // if (issues.length === 0) return rawResponse;
    // return this._applyCorrections(rawResponse, issues);
  }

  _detectIssues(response, analysis, emotionalState) {
    return [];
  }

  _applyCorrections(response, issues) {
    return response;
  }
}

module.exports = ResponseProcessor;
