'use strict';

/**
 * ReflectionEngine — Evalúa progreso del agentic loop.
 *
 * Después de cada ronda de tool calls, evalúa:
 *   1. ¿Se cumplió el objetivo original?
 *   2. ¿Falta información?
 *   3. ¿Hay errores que corregir?
 *   4. ¿Se debe continuar, pedir más info, o terminar?
 *
 * El reflection usa el LLM para decidir, pero tiene guardrails:
 *   - Max iterations para prevenir loops infinitos
 *   - Detección de progreso estancado (mismos resultados repetidos)
 *   - Timeout absoluto
 *
 * Decisiones:
 *   'continue'  — hay más trabajo que hacer
 *   'complete'  — el objetivo se cumplió, generar respuesta final
 *   'ask_user'  — se necesita input del usuario para continuar
 *   'fallback'  — algo falló, usar respuesta parcial
 */

const REFLECTION_PROMPT = `Sos un motor de reflexión. Evaluá el progreso de una tarea agéntica.

CONTEXTO:
- Objetivo original: {objective}
- Plan: {plan_summary}
- Acciones tomadas: {actions_count}
- Resultados parciales: {partial_results}

DECISIÓN:
Analizá si la tarea está completa, si falta algo, o si hay problemas.

Respondé con SOLO uno de estos JSON:

Si el objetivo se cumplió:
{ "decision": "complete", "reasoning": "por qué está completo", "quality": "high|medium|low" }

Si falta información o hay más trabajo:
{ "decision": "continue", "reasoning": "qué falta hacer", "nextFocus": "área de enfoque siguiente" }

Si se necesita input del usuario:
{ "decision": "ask_user", "reasoning": "qué falta preguntar", "question": "pregunta al usuario" }

Si hay errores irreparables:
{ "decision": "fallback", "reasoning": "qué falló", "partialResult": "resultado parcial utilizable" }

REGLAS:
- Si hay 3+ errores consecutivos → fallback
- Si llevás 5+ iteraciones sin progreso claro → fallback
- Si el resultado parcial es útil pero incompleto → complete con quality: low
- Respondé SOLO con el JSON, sin explicaciones.`;

/**
 * Extrae y parsea el primer JSON válido de un texto usando balanced braces.
 * @param {string} text
 * @returns {Object|null}
 */
function _parseJsonFromText(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(text.substring(start, end + 1));
  } catch {
    return null;
  }
}

class ReflectionEngine {
  /**
   * @param {Function} chatFn — Función de chat del proveedor IA
   * @param {Object} [config]
   * @param {number} [config.maxConsecutiveErrors=3]
   * @param {number} [config.maxStaleIterations=3]
   * @param {number} [config.staleThreshold=100] — Diff mínima para considerar progreso
   */
  constructor(chatFn, config = {}) {
    this.chatFn = chatFn;
    this.maxConsecutiveErrors = config.maxConsecutiveErrors || 3;
    this.maxStaleIterations = config.maxStaleIterations || 3;
    this.staleThreshold = config.staleThreshold || 100;

    this._consecutiveErrors = 0;
    this._lastResultHash = '';
    this._staleCount = 0;
    this._iterations = 0;
  }

  /**
   * Evalúa el progreso actual y retorna una decisión.
   *
   * @param {Object} params
   * @param {string} params.objective — Objetivo original
   * @param {Array} params.plan — Pasos del plan
   * @param {Array} params.actionHistory — Acciones tomadas
   * @param {Array} params.toolResults — Resultados de la última ronda
   * @param {string} params.currentResponse — Respuesta actual del AI
   * @returns {Promise<{ decision: string, reasoning: string, ... }>}
   */
  async reflect({ objective, plan, actionHistory, toolResults, currentResponse }) {
    this._iterations++;

    // Guardrails rápidos (sin LLM)
    const quickDecision = this._quickChecks(toolResults);
    if (quickDecision) return quickDecision;

    // Detección de estancamiento
    const resultHash = this._hashResults(toolResults);
    if (resultHash === this._lastResultHash) {
      this._staleCount++;
    } else {
      this._staleCount = 0;
    }
    this._lastResultHash = resultHash;

    if (this._staleCount >= this.maxStaleIterations) {
      return {
        decision: 'complete',
        reasoning: 'Progreso estancado — usando resultado actual',
        quality: 'low',
      };
    }

    // Refleixón con LLM
    try {
      const partialResults = this._formatPartialResults(toolResults);
      const planSummary = this._formatPlanSummary(plan);

      const prompt = REFLECTION_PROMPT
        .replace('{objective}', objective)
        .replace('{plan_summary}', planSummary)
        .replace('{actions_count}', String(actionHistory.length))
        .replace('{partial_results}', partialResults);

      const messages = [
        { role: 'user', content: prompt },
      ];

      const response = await this.chatFn(messages, null, {
        systemPrompt: 'Respondé SOLO con JSON válido.',
        temperature: 0.2,
        maxTokens: 500,
      });

      const reflection = this._parseReflection(response);

      if (!reflection) {
        return {
          decision: 'continue',
          reasoning: 'No se pudo parsear reflexión, continuando',
        };
      }

      return reflection;
    } catch (err) {
      console.error(`[ReflectionEngine] Error: ${err.message}`);
      return {
        decision: 'continue',
        reasoning: 'Error en reflexión, continuando',
      };
    }
  }

  /**
   * Checks rápidos sin LLM.
   * @param {Array} toolResults
   * @returns {Object|null}
   */
  _quickChecks(toolResults) {
    // Too many consecutive errors
    if (toolResults && toolResults.length > 0) {
      const allErrors = toolResults.every(r => !r.success);
      if (allErrors) {
        this._consecutiveErrors++;
      } else {
        this._consecutiveErrors = 0;
      }
    }

    if (this._consecutiveErrors >= this.maxConsecutiveErrors) {
      return {
        decision: 'fallback',
        reasoning: `${this._consecutiveErrors} errores consecutivos`,
      };
    }

    return null;
  }

  /**
   * Formatea resultados parciales para el prompt.
   * @param {Array} toolResults
   * @returns {string}
   */
  _formatPartialResults(toolResults) {
    if (!toolResults || toolResults.length === 0) return 'Sin resultados aún';

    return toolResults.slice(-5).map((r, i) => {
      const result = r.success
        ? String(r.result).substring(0, 200)
        : `ERROR: ${r.result}`;
      return `[${i + 1}] ${r.tool}: ${result}`;
    }).join('\n');
  }

  /**
   * Formatea el plan para el prompt.
   * @param {Array} plan
   * @returns {string}
   */
  _formatPlanSummary(plan) {
    if (!plan || plan.length === 0) return 'Sin plan (respuesta directa)';
    return plan.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
  }

  /**
   * Hashea resultados para detectar estancamiento.
   * @param {Array} toolResults
   * @returns {string}
   */
  _hashResults(toolResults) {
    if (!toolResults || toolResults.length === 0) return '';
    return toolResults
      .map(r => `${r.tool}:${r.success}:${String(r.result).substring(0, 50)}`)
      .join('|');
  }

  /**
   * Parsea la reflexión del LLM.
   * @param {string} response
   * @returns {Object|null}
   */
  _parseReflection(response) {
    try {
      const parsed = _parseJsonFromText(response);
      if (!parsed) return null;

      const reflection = parsed;

      if (!['complete', 'continue', 'ask_user', 'fallback'].includes(reflection.decision)) {
        return null;
      }

      return reflection;
    } catch {
      return null;
    }
  }

  /**
   * Resetea el estado (para nueva tarea).
   */
  reset() {
    this._consecutiveErrors = 0;
    this._lastResultHash = '';
    this._staleCount = 0;
    this._iterations = 0;
  }

  /**
   * Retorna métricas.
   * @returns {Object}
   */
  getMetrics() {
    return {
      iterations: this._iterations,
      consecutiveErrors: this._consecutiveErrors,
      staleCount: this._staleCount,
    };
  }
}

module.exports = ReflectionEngine;
