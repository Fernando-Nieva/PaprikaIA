'use strict';

/**
 * TaskPlanner — Descompone objetivos complejos en subtareas ejecutables.
 *
 * Usa el LLM para generar un plan JSON estructurado desde un objetivo
 * en lenguaje natural. Cada paso tiene descripción, criterio de éxito,
 * y herramientas sugeridas.
 *
 * Para tareas simples (1-2 round trips), el planner retorna null
 * y el agentic loop usa el tool loop directamente.
 *
 * Output del planner:
 *   { complex: true, steps: [
 *     { id: 1, description: "...", successCriteria: "...", tools: ["web_search"] },
 *     { id: 2, description: "...", successCriteria: "...", tools: ["run_code"] },
 *   ]}
 *
 * Si la tarea es simple:
 *   { complex: false }
 */

const PLAN_PROMPT = `Sos un planificador de tareas. Analizá el objetivo del usuario y decidí si necesita un plan de múltiples pasos.

REGLAS:
1. Si la tarea es SIMPLE (1-2 acciones, respuesta directa), retorná: { "complex": false }
2. Si la tarea es COMPLEJA (múltiples búsquedas, comparaciones, análisis, generación de contenido), creá un plan.

PLAN FORMAT (solo si es compleja):
{
  "complex": true,
  "objective": "resumen del objetivo",
  "steps": [
    {
      "id": 1,
      "description": "qué hacer en este paso",
      "successCriteria": "cómo saber si se completó",
      "suggestedTools": ["herramienta_sugerida"]
    }
  ]
}

HERRAMIENTAS DISPONIBLES:
- web_search: buscar en internet
- web_fetch: descargar contenido de una URL
- run_code: ejecutar JavaScript (cálculos, procesamiento)
- read_file: leer archivos del proyecto
- search_content: buscar contenido en archivos
- list_dir: listar directorios

MÁXIMO 8 pasos. Cada paso debe ser atómico y verificable.
Si no estás seguro, marcá como simple (complex: false).

Respondé SOLO con el JSON, sin explicaciones.`;

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

class TaskPlanner {
  /**
   * @param {Function} chatFn — Función de chat del proveedor IA
   * @param {Object} [config]
   * @param {number} [config.maxSteps=8]
   * @param {number} [config.simpleThreshold=2] — Si <= N tools necesarias, es simple
   */
  constructor(chatFn, config = {}) {
    this.chatFn = chatFn;
    this.maxSteps = config.maxSteps || 8;
    this.simpleThreshold = config.simpleThreshold || 2;
  }

  /**
   * Analiza un objetivo y retorna un plan.
   *
   * @param {string} objective — Objetivo del usuario
   * @param {Array} context — Mensajes de contexto
   * @param {Object} analysis — Análisis del analyzer (intent, topic, etc.)
   * @returns {Promise<{ complex: boolean, steps?: Array, objective?: string }>}
   */
  async plan(objective, context, analysis) {
    // Heurística rápida: tareas muy cortas son simples
    if (this._isSimpleByHeuristic(objective, analysis)) {
      return { complex: false };
    }

    try {
      const messages = [
        ...context.slice(-6), // Últimos 6 mensajes para contexto
        { role: 'user', content: `Objetivo: ${objective}` },
      ];

      const response = await this.chatFn(messages, null, {
        systemPrompt: PLAN_PROMPT,
        temperature: 0.3,
        maxTokens: 1000,
      });

      const plan = this._parsePlan(response);

      if (!plan || !plan.complex) {
        return { complex: false };
      }

      // Validar y limitar pasos
      plan.steps = plan.steps.slice(0, this.maxSteps);
      plan.objective = plan.objective || objective;

      return plan;
    } catch (err) {
      console.error(`[TaskPlanner] Error: ${err.message}`);
      return { complex: false };
    }
  }

  /**
   * Heurística rápida para detectar tareas simples.
   *
   * @param {string} objective
   * @param {Object} analysis
   * @returns {boolean}
   */
  _isSimpleByHeuristic(objective, analysis) {
    const lower = objective.toLowerCase();

    // Si el usuario pide contenido de internet, NO es simple — necesita tool calls
    const INTERNET_KEYWORDS = /\b(buscar|busca|buscame|buscá|buscáme|busca(?:r)?|encontr(?:ar|á|ame)|youtube|video|videos|noticias|actualidad|clima|temperatura|precio|precio de|cuánto cuesta|reseña|review|opinión|pelicula|serie|anime|música|canción|tutorial|resultado|partido|gol|score|reddit|twitter|github|stackoverflow|documentacion|docu)\b/i;
    if (INTERNET_KEYWORDS.test(lower)) return false;

    // Preguntas directas son simples
    const simplePatterns = [
      /^qué\s+(es|son|significa)/i,
      /^cómo\s+(se|hago|funciona)/i,
      /^cuánto\s+(es|mide)/i,
      /^dónde\s+(está|están)/i,
      /^cuándo\s+(es|fue|será)/i,
      /^quién\s+(es|fue|son)/i,
      /^(sí|no|creo|pensás|opinás)/i,
    ];

    if (simplePatterns.some(p => p.test(objective))) return true;

    // Mensajes cortos son simples
    if (objective.length < 50) return true;

    // Análisis de baja complejidad
    if (analysis && analysis.complexity === 'low') return true;

    return false;
  }

  /**
   * Parsea la respuesta del LLM en un plan válido.
   *
   * @param {string} response
   * @returns {Object|null}
   */
  _parsePlan(response) {
    try {
      const parsed = _parseJsonFromText(response);
      if (!parsed) return null;

      const plan = parsed;

      // Validar estructura
      if (typeof plan.complex !== 'boolean') return null;
      if (!plan.complex) return { complex: false };
      if (!Array.isArray(plan.steps) || plan.steps.length === 0) return null;

      // Validar cada paso
      plan.steps = plan.steps.filter(step =>
        step.id &&
        typeof step.description === 'string' &&
        step.description.length > 0
      );

      if (plan.steps.length === 0) return null;

      return plan;
    } catch {
      return null;
    }
  }
}

module.exports = TaskPlanner;
