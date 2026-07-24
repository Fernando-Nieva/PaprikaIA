/**
 * PipelineCache — Caché de corta duración para un solo ciclo de pipeline.
 *
 * Evita consultas repetidas a la DB durante el procesamiento de un mensaje.
 * Cada ejecución del pipeline crea una nueva instancia de cache que se destruye
 * al finalizar.
 *
 * Características:
 *   - TTL configurable por entrada (default: 30s — cubre un pipeline completo)
 *   - Invalidación por key exacta o por patrón (prefijo)
 *   - Métricas de hits/misses para diagnóstico
 *   - Límite de entradas para evitar memory leaks
 *
 * Claves de cache conocidas:
 *   - entities:${userId}           → entidades del knowledge graph
 *   - relations:${userId}          → relaciones del knowledge graph
 *   - goals:context:${userId}      → objetivos para contexto
 *   - goals:active:${userId}       → objetivos activos
 *   - relationship:${userId}       → datos de relación
 *   - summary:${conversationId}    → último resumen
 *   - entitiesByUser:${userId}     → entidades raw de DB
 *   - relationsByUser:${userId}    → relaciones raw de DB
 *
 * Consumido por:
 *   - Pipeline.execute() — crea instancia, pasa a módulos
 *   - KnowledgeGraph — cachea entidades y relaciones
 *   - GoalEngine — cachea objetivos
 *   - Summarizer — cachea resúmenes
 */

'use strict';

const DEFAULT_CONFIG = {
  defaultTTL: 30000,     // 30 segundos — suficiente para un pipeline completo
  maxEntries: 200,       // Máximo de entradas en cache
  enableMetrics: true,   // Habilitar contadores de hits/misses
};

class PipelineCache {
  /**
   * @param {Object} [config={}] - Configuración del cache
   * @param {number} [config.defaultTTL] - TTL por defecto en ms
   * @param {number} [config.maxEntries] - Máximo de entradas
   * @param {boolean} [config.enableMetrics] - Habilitar métricas
   */
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._store = new Map();
    this._timestamps = new Map(); // key → creation time
    this._metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0,
    };
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Obtiene un valor del cache.
   * Retorna null si no existe o si expiró.
   *
   * @param {string} key
   * @returns {*} Valor cacheado o null
   */
  get(key) {
    if (!this._store.has(key)) {
      if (this._config.enableMetrics) this._metrics.misses++;
      return null;
    }

    const entry = this._store.get(key);
    const now = Date.now();

    if (now - entry.created > entry.ttl) {
      // Expired
      this._store.delete(key);
      this._timestamps.delete(key);
      if (this._config.enableMetrics) this._metrics.misses++;
      return null;
    }

    if (this._config.enableMetrics) this._metrics.hits++;
    return entry.value;
  }

  /**
   * Almacena un valor en cache con TTL opcional.
   *
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl] - TTL en ms (default: config.defaultTTL)
   */
  set(key, value, ttl) {
    // Evict if at capacity
    if (this._store.size >= this._config.maxEntries && !this._store.has(key)) {
      this._evictOldest();
    }

    this._store.set(key, {
      value,
      created: Date.now(),
      ttl: ttl || this._config.defaultTTL,
    });
    this._timestamps.set(key, Date.now());

    if (this._config.enableMetrics) this._metrics.sets++;
  }

  /**
   * Obtiene del cache o ejecuta la función y cachea el resultado.
   *
   * @param {string} key
   * @param {Function} fn - Función que retorna el valor a cachear
   * @param {number} [ttl] - TTL en ms
   * @returns {*} Valor cacheado o recién calculado
   */
  getOrSet(key, fn, ttl) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const value = fn();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Obtiene del cache o ejecuta una función async y cachea el resultado.
   *
   * @param {string} key
   * @param {Function} fn - Función async que retorna el valor
   * @param {number} [ttl] - TTL en ms
   * @returns {Promise<*>} Valor cacheado o recién calculado
   */
  async getOrSetAsync(key, fn, ttl) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const value = await fn();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Invalida una entrada específica.
   *
   * @param {string} key
   * @returns {boolean} true si la entrada existía
   */
  invalidate(key) {
    const existed = this._store.delete(key);
    this._timestamps.delete(key);
    if (existed && this._config.enableMetrics) this._metrics.invalidations++;
    return existed;
  }

  /**
   * Invalida todas las entradas que empiecen con un prefijo.
   * Útil para invalidar todas las entidades de un usuario: invalidatePattern('entities:u123')
   *
   * @param {string} prefix - Prefijo de las claves a invalidar
   * @returns {number} Cantidad de entradas invalidadas
   */
  invalidatePattern(prefix) {
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        this._store.delete(key);
        this._timestamps.delete(key);
        count++;
      }
    }
    if (count > 0 && this._config.enableMetrics) {
      this._metrics.invalidations += count;
    }
    return count;
  }

  /**
   * Invalida todas las entradas cuya key contenga un substring.
   *
   * @param {string} substring
   * @returns {number} Cantidad de entradas invalidadas
   */
  invalidateContaining(substring) {
    let count = 0;
    for (const key of this._store.keys()) {
      if (key.includes(substring)) {
        this._store.delete(key);
        this._timestamps.delete(key);
        count++;
      }
    }
    if (count > 0 && this._config.enableMetrics) {
      this._metrics.invalidations += count;
    }
    return count;
  }

  /**
   * Limpia todo el cache.
   */
  clear() {
    this._store.clear();
    this._timestamps.clear();
  }

  /**
   * Retorna métricas de uso del cache.
   *
   * @returns {Object}
   */
  getMetrics() {
    const total = this._metrics.hits + this._metrics.misses;
    return {
      ...this._metrics,
      size: this._store.size,
      hitRate: total > 0 ? Math.round((this._metrics.hits / total) * 100) : 0,
    };
  }

  /**
   * Retorna el número de entradas en el cache.
   *
   * @returns {number}
   */
  get size() {
    return this._store.size;
  }

  // ─────────────────────────────────────────────
  //  Helpers internos
  // ─────────────────────────────────────────────

  /**
   * Elimina la entrada más antigua cuando se alcanza el límite.
   */
  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, timestamp] of this._timestamps) {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._store.delete(oldestKey);
      this._timestamps.delete(oldestKey);
      if (this._config.enableMetrics) this._metrics.evictions++;
    }
  }
}

module.exports = PipelineCache;
