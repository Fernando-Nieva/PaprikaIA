'use strict';

/**
 * SearchCache — Cache con TTL para resultados de búsqueda web.
 *
 * Evita búsquedas repetidas del mismo query. Usa hashing de query
 * como key para normalizar variaciones menores.
 *
 * Configuración:
 *   defaultTTL — TTL por defecto en ms (default: 1 hora)
 *   maxEntries — Máximo de entradas (default: 200)
 */

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  defaultTTL: 3600000, // 1 hora
  maxEntries: 200,
};

class SearchCache {
  /**
   * @param {Object} [config={}]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._store = new Map();
    this._timestamps = new Map();
    this._metrics = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  /**
   * Genera una key normalizada para un query.
   * Normaliza: lowercase, trim, colapsa espacios, ordena params.
   *
   * @param {string} query
   * @param {Object} [options]
   * @returns {string}
   */
  static _makeKey(query, options = {}) {
    const normalized = query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');

    const optionStr = JSON.stringify({
      category: options.category || '',
      language: options.language || '',
      maxResults: options.maxResults || 10,
    });

    const hash = crypto
      .createHash('sha256')
      .update(`${normalized}::${optionStr}`)
      .digest('hex')
      .substring(0, 16);

    return `search:${hash}`;
  }

  /**
   * Obtiene resultados cacheados.
   *
   * @param {string} query
   * @param {Object} [options]
   * @returns {Array|null}
   */
  get(query, options = {}) {
    const key = SearchCache._makeKey(query, options);
    const entry = this._store.get(key);

    if (!entry) {
      this._metrics.misses++;
      return null;
    }

    if (Date.now() - entry.created > entry.ttl) {
      this._store.delete(key);
      this._timestamps.delete(key);
      this._metrics.misses++;
      return null;
    }

    this._metrics.hits++;
    return entry.value;
  }

  /**
   * Almacena resultados en cache.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {Array} results
   * @param {number} [ttl]
   */
  set(query, options, results, ttl) {
    if (this._store.size >= this.config.maxEntries) {
      this._evictOldest();
    }

    const key = SearchCache._makeKey(query, options);
    this._store.set(key, {
      value: results,
      created: Date.now(),
      ttl: ttl || this.config.defaultTTL,
    });
    this._timestamps.set(key, Date.now());
    this._metrics.sets++;
  }

  /**
   * Limpia el cache.
   */
  clear() {
    this._store.clear();
    this._timestamps.clear();
  }

  /**
   * Retorna métricas de uso.
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
   * Elimina la entrada más antigua.
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
      this._metrics.evictions++;
    }
  }
}

module.exports = SearchCache;
