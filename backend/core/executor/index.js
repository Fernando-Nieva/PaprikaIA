'use strict';

/**
 * CodeExecutor — Ejecución segura de código JavaScript generado por IA.
 *
 * Usa child_process.fork() para aislar el código en un proceso separado
 * con globals restringidos. El proceso padre mata al hijo si excede
 * timeouts o límites de memoria.
 *
 * SEGURIDAD (defense in depth):
 *   1. Proceso aislado (fork) — no comparte memoria con el padre
 *   2. Sandbox con solo globals seguros (Math, JSON, Date, etc.)
 *   3. Sin require, process, fs, child_process, net, http, etc.
 *   4. Timeout doble: worker se auto-destruye + padre mata el proceso
 *   5. Max output limitado para prevenir DoS por respuesta gigante
 *   6. Worker script es estático (no acepta paths del usuario)
 *
 * Límites por defecto:
 *   - Timeout: 5000ms
 *   - Max output: 8000 chars
 *   - Max code length: 10000 chars
 *   - Max concurrent executions: 3
 */

const { fork } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const WORKER_PATH = path.join(__dirname, 'sandbox-worker.js');

const DEFAULT_CONFIG = {
  timeout: 5000,
  maxOutput: 8000,
  maxCodeLength: 10000,
  maxConcurrent: 3,
  memoryLimit: '64mb', // Passed via --max-old-space-size
};

class CodeExecutor extends EventEmitter {
  /**
   * @param {Object} [config={}]
   */
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._activeWorkers = new Map(); // pid → { child, timer }
    this._queue = [];
    this._metrics = { executed: 0, errors: 0, timeouts: 0, totalMs: 0 };
  }

  /**
   * Ejecuta código JavaScript en el sandbox.
   *
   * @param {string} code — Código a ejecutar (debe retornar un valor)
   * @param {Object} [options]
   * @param {number} [options.timeout]
   * @param {string} [options.label] — Nombre descriptivo para logging
   * @returns {Promise<{ success: boolean, result?: any, output?: string[], error?: string, duration: number }>}
   */
  async execute(code, options = {}) {
    const startTime = Date.now();

    // Validar input
    if (!code || typeof code !== 'string') {
      return { success: false, error: 'Código vacío o inválido', duration: 0, output: [] };
    }

    if (code.length > this.config.maxCodeLength) {
      return {
        success: false,
        error: `Código demasiado largo (${code.length} chars, máximo ${this.config.maxCodeLength})`,
        duration: 0,
        output: [],
      };
    }

    // Verificar concurrencia
    if (this._activeWorkers.size >= this.config.maxConcurrent) {
      return {
        success: false,
        error: `Demasiadas ejecuciones en cola (máximo ${this.config.maxConcurrent})`,
        duration: 0,
        output: [],
      };
    }

    const timeout = options.timeout || this.config.timeout;
    const label = options.label || 'code';

    return new Promise((resolve) => {
      const child = fork(WORKER_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=64', '--no-warnings'],
        env: { NODE_OPTIONS: '--max-old-space-size=64 --no-warnings' },
        silent: true,
      });

      const workerInfo = { child, resolved: false };
      this._activeWorkers.set(child.pid, workerInfo);

      // Safety timer (kills process if worker hangs)
      const safetyTimer = setTimeout(() => {
        if (!workerInfo.resolved) {
          workerInfo.resolved = true;
          this._killWorker(child.pid);
          this._metrics.timeouts++;
          this._metrics.errors++;
          this._metrics.totalMs += Date.now() - startTime;
          resolve({
            success: false,
            error: `Timeout: código excedió ${timeout}ms`,
            duration: Date.now() - startTime,
            output: [],
          });
        }
      }, timeout + 2000); // Extra 2s for worker's own safety

      // IPC handler
      const onMessage = (msg) => {
        if (msg.type === 'ready') {
          // Send code to worker (wrap in try-catch for IPC errors)
          try {
            child.send({ type: 'run', code, timeout });
          } catch (e) {
            if (workerInfo.resolved) return;
            workerInfo.resolved = true;
            clearTimeout(safetyTimer);
            this._cleanupWorker(child.pid);
            this._metrics.errors++;
            this._metrics.totalMs += Date.now() - startTime;
            resolve({
              success: false,
              error: `Error del sandbox: ${e.message}`,
              output: [],
              duration: Date.now() - startTime,
            });
          }
        } else if (msg.type === 'result') {
          if (workerInfo.resolved) return;
          workerInfo.resolved = true;
          clearTimeout(safetyTimer);
          this._cleanupWorker(child.pid);
          this._metrics.executed++;
          this._metrics.totalMs += Date.now() - startTime;

          if (msg.error) {
            this._metrics.errors++;
            resolve({
              success: false,
              error: msg.error,
              output: msg.output || [],
              duration: Date.now() - startTime,
            });
          } else {
            resolve({
              success: true,
              result: msg.value,
              output: msg.output || [],
              duration: Date.now() - startTime,
            });
          }
        }
      };

      // Error handler
      const onError = (err) => {
        if (workerInfo.resolved) return;
        workerInfo.resolved = true;
        clearTimeout(safetyTimer);
        this._cleanupWorker(child.pid);
        this._metrics.errors++;
        this._metrics.totalMs += Date.now() - startTime;
        resolve({
          success: false,
          error: `Error del sandbox: ${err.message}`,
          output: [],
          duration: Date.now() - startTime,
        });
      };

      // Exit handler (worker exited before sending result)
      const onExit = (code) => {
        if (workerInfo.resolved) return;
        workerInfo.resolved = true;
        clearTimeout(safetyTimer);
        this._cleanupWorker(child.pid);
        this._metrics.executed++;
        this._metrics.totalMs += Date.now() - startTime;

        // Always resolve — even on exit(0) without result
        if (code !== 0) {
          this._metrics.errors++;
          resolve({
            success: false,
            error: `Worker terminó con código ${code}`,
            output: [],
            duration: Date.now() - startTime,
          });
        } else {
          this._metrics.errors++;
          resolve({
            success: false,
            error: 'Worker terminó sin enviar resultado',
            output: [],
            duration: Date.now() - startTime,
          });
        }
      };

      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);

      // Capture stderr
      let stderr = '';
      if (child.stderr) {
        child.stderr.on('data', (data) => { stderr += data; });
      }
    });
  }

  /**
   * Mata un worker por PID.
   * Captura child localmente para evitar race condition con PID recycling.
   * @param {number} pid
   */
  _killWorker(pid) {
    const info = this._activeWorkers.get(pid);
    if (info && info.child) {
      const child = info.child;
      try { child.kill('SIGTERM'); } catch {}
      // Force kill after 1s if still alive
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1000);
    }
    this._cleanupWorker(pid);
  }

  /**
   * Limpia references de un worker, incluyendo IPC channel.
   * @param {number} pid
   */
  _cleanupWorker(pid) {
    const info = this._activeWorkers.get(pid);
    if (info) {
      info.child.removeAllListeners();
      try { info.child.disconnect(); } catch {}
      if (info.child.stdin) info.child.stdin.destroy();
      if (info.child.stdout) info.child.stdout.destroy();
      if (info.child.stderr) info.child.stderr.destroy();
    }
    this._activeWorkers.delete(pid);
  }

  /**
   * Mata todos los workers activos.
   */
  killAll() {
    for (const [pid] of this._activeWorkers) {
      this._killWorker(pid);
    }
  }

  /**
   * Retorna métricas de ejecución.
   * @returns {Object}
   */
  getMetrics() {
    return {
      ...this._metrics,
      activeWorkers: this._activeWorkers.size,
      avgDuration: this._metrics.executed > 0
        ? Math.round(this._metrics.totalMs / this._metrics.executed)
        : 0,
    };
  }

  /**
   * Valida que el código no contenga patrones peligrosos conocidos.
   * Defense in depth — el sandbox ya bloquea acceso, pero esto
   * agrega una capa extra de prevención.
   *
   * @param {string} code
   * @returns {{ safe: boolean, reason?: string }}
   */
  static preValidate(code) {
    if (!code) return { safe: false, reason: 'Código vacío' };

    const dangerousPatterns = [
      { pattern: /require\s*\(/, reason: 'require() no permitido' },
      { pattern: /child_process/, reason: 'child_process no disponible' },
      { pattern: /(?<!child_)process\./, reason: 'process no disponible' },
      { pattern: /fs\./, reason: 'filesystem no disponible' },
      { pattern: /eval\s*\(/, reason: 'eval() no permitido' },
      { pattern: /Function\s*\(/, reason: 'Function constructor no permitido' },
      { pattern: /import\s*\(/, reason: 'import() no permitido' },
      { pattern: /fetch\s*\(/, reason: 'fetch no disponible' },
      { pattern: /XMLHttpRequest/, reason: 'XMLHttpRequest no disponible' },
      { pattern: /WebSocket/, reason: 'WebSocket no disponible' },
      { pattern: /net\./, reason: 'network no disponible' },
      { pattern: /http\./, reason: 'http no disponible' },
      { pattern: /https\./, reason: 'https no disponible' },
      { pattern: /dgram/, reason: 'dgram no disponible' },
      { pattern: /worker_threads/, reason: 'worker_threads no disponible' },
      { pattern: /vm\./, reason: 'vm module no disponible' },
      { pattern: /crypto\./, reason: 'crypto no disponible' },
      { pattern: /navigator\./, reason: 'navigator no disponible' },
      { pattern: /globalThis/, reason: 'globalThis no disponible' },
      { pattern: /window\./, reason: 'window no disponible' },
      { pattern: /document\./, reason: 'document no disponible' },
    ];

    for (const { pattern, reason } of dangerousPatterns) {
      if (pattern.test(code)) {
        return { safe: false, reason };
      }
    }

    return { safe: true };
  }
}

module.exports = CodeExecutor;
