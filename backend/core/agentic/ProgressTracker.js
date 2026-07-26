'use strict';

/**
 * ProgressTracker — Reporta progreso del agentic loop via SSE.
 *
 * Mantiene un historial de acciones tomadas y permite al frontend
 * mostrar progreso granular (Paso 1/5, Paso 2/5, etc.).
 *
 * Cada acción registrada tiene:
 *   - step: número de paso
 *   - total: total de pasos estimado
 *   - description: qué se está haciendo
 *   - status: 'pending' | 'running' | 'completed' | 'error'
 *   - result: resultado resumido (opcional)
 *   - timestamp
 */

class ProgressTracker {
  /**
   * @param {Function} [onProgress] — Callback para enviar eventos SSE
   */
  constructor(onProgress) {
    this._onProgress = onProgress || (() => {});
    this._steps = [];
    this._currentStep = 0;
    this._totalSteps = 0;
    this._startTime = Date.now();
    this._actionHistory = [];
  }

  /**
   * Inicializa el tracker con un plan.
   *
   * @param {string} objective — Objetivo de la tarea
   * @param {Array<{description: string}>} plan — Pasos del plan
   */
  init(objective, plan) {
    this._steps = plan.map((p, i) => ({
      step: i + 1,
      total: plan.length,
      description: p.description,
      status: 'pending',
      result: null,
      timestamp: null,
    }));
    this._totalSteps = plan.length;
    this._currentStep = 0;

    this._emit('init', {
      objective,
      totalSteps: this._totalSteps,
      steps: this._steps.map(s => ({ step: s.step, description: s.description })),
    });
  }

  /**
   * Marca un paso como en progreso.
   *
   * @param {number} stepNumber — Número de paso (1-indexed)
   * @param {string} [detail] — Detalle adicional
   */
  startStep(stepNumber, detail) {
    const step = this._steps[stepNumber - 1];
    if (!step) return;

    step.status = 'running';
    step.timestamp = Date.now();
    this._currentStep = stepNumber;

    this._emit('step_start', {
      step: step.step,
      total: step.total,
      description: step.description,
      detail,
    });
  }

  /**
   * Marca un paso como completado.
   *
   * @param {number} stepNumber
   * @param {string} [result] — Resultado resumido
   */
  completeStep(stepNumber, result) {
    const step = this._steps[stepNumber - 1];
    if (!step) return;

    step.status = 'completed';
    step.result = result || 'Completado';

    this._emit('step_complete', {
      step: step.step,
      total: step.total,
      description: step.description,
      result: step.result,
      duration: step.timestamp ? Date.now() - step.timestamp : 0,
    });
  }

  /**
   * Marca un paso como error.
   *
   * @param {number} stepNumber
   * @param {string} error
   */
  errorStep(stepNumber, error) {
    const step = this._steps[stepNumber - 1];
    if (!step) return;

    step.status = 'error';
    step.result = error;

    this._emit('step_error', {
      step: step.step,
      total: step.total,
      description: step.description,
      error,
    });
  }

  /**
   * Registra una acción tomada (tool call, reflexión, etc.).
   *
   * @param {Object} action
   * @param {string} action.type — 'tool' | 'reflection' | 'planning' | 'response'
   * @param {string} action.description
   * @param {Object} [action.metadata]
   */
  logAction(action) {
    this._actionHistory.push({
      ...action,
      timestamp: Date.now(),
    });
  }

  /**
   * Emite un evento de progreso general.
   *
   * @param {string} message
   * @param {Object} [data]
   */
  emitProgress(message, data) {
    this._emit('progress', {
      message,
      currentStep: this._currentStep,
      totalSteps: this._totalSteps,
      elapsed: Date.now() - this._startTime,
      ...data,
    });
  }

  /**
   * Emite el evento de completion.
   *
   * @param {boolean} success
   * @param {string} [summary]
   */
  complete(success, summary) {
    this._emit('complete', {
      success,
      summary,
      totalSteps: this._totalSteps,
      completedSteps: this._steps.filter(s => s.status === 'completed').length,
      totalDuration: Date.now() - this._startTime,
      actions: this._actionHistory.length,
    });
  }

  /**
   * Resetea el tracker para una nueva tarea.
   */
  reset() {
    this._steps = [];
    this._currentStep = 0;
    this._totalSteps = 0;
    this._startTime = Date.now();
    this._actionHistory = [];
  }

  /**
   * Retorna el historial de acciones.
   * @returns {Array}
   */
  getHistory() {
    return [...this._actionHistory];
  }

  /**
   * Retorna estado actual del progreso.
   * @returns {Object}
   */
  getState() {
    return {
      currentStep: this._currentStep,
      totalSteps: this._totalSteps,
      elapsed: Date.now() - this._startTime,
      steps: this._steps.map(s => ({
        step: s.step,
        description: s.description,
        status: s.status,
        result: s.result,
      })),
    };
  }

  /**
   * Emite un evento SSE.
   * @param {string} event
   * @param {Object} data
   */
  _emit(event, data) {
    this._onProgress({ event, data, ts: Date.now() });
  }
}

module.exports = ProgressTracker;
