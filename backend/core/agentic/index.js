'use strict';

/**
 * Agentic module — Punto de entrada para el sistema de loop agéntico.
 *
 * Exporta:
 *   - AgenticLoop: orquestador principal del ciclo PRAL
 *   - TaskPlanner: descomposición de tareas via LLM
 *   - ReflectionEngine: evaluación de progreso
 *   - ProgressTracker: reporte de progreso via SSE
 */

const AgenticLoop = require('./AgenticLoop');
const TaskPlanner = require('./TaskPlanner');
const ReflectionEngine = require('./ReflectionEngine');
const ProgressTracker = require('./ProgressTracker');

module.exports = {
  AgenticLoop,
  TaskPlanner,
  ReflectionEngine,
  ProgressTracker,
};
