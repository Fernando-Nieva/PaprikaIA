'use strict';

/**
 * SearchManager — Orquestador principal del sistema de búsqueda web.
 *
 * Coordina: proveedores → cache → re-ranking → logging.
 * Single point of entry para herramientas y pipelines.
 *
 * Uso:
 *   const searchManager = new SearchManager(config);
 *   const results = await searchManager.search('qué es node.js');
 */

const { createProvider } = require('./providers');
const SearchCache = require('./cache/SearchCache');
const ResultRanker = require('./ranking/ResultRanker');

const FALLBACK_ORDER = ['searxng', 'duckduckgo'];

const DEFAULT_CONFIG = {
  provider: 'searxng',
  maxResults: 10,
  cacheTTL: 3600000,
  cacheMaxEntries: 200,
  enableCache: true,
  enableRanking: true,
  logSearches: true,
};

class SearchManager {
  /**
   * @param {Object} [config={}]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._providers = new Map();
    this._cache = new SearchCache({
      defaultTTL: this.config.cacheTTL,
      maxEntries: this.config.cacheMaxEntries,
    });
    this._ranker = new ResultRanker();
    this._metrics = { searches: 0, errors: 0, cacheHits: 0 };
  }

  /**
   * Inicializa el proveedor por defecto.
   * @returns {Promise<boolean>}
   */
  async init() {
    const provider = createProvider(this.config.provider, this.config);
    if (!provider) {
      console.error(`[SearchManager] Provider "${this.config.provider}" not found`);
      return false;
    }

    const available = await provider.isAvailable();
    if (!available) {
      console.warn(`[SearchManager] Provider "${this.config.provider}" not available, will retry on search`);
    }

    this._providers.set(this.config.provider, provider);
    return true;
  }

  /**
   * Realiza una búsqueda web completa.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults]
   * @param {string} [options.category]
   * @param {string} [options.language]
   * @param {boolean} [options.safeSearch]
   * @param {boolean} [options.forceRefresh=false] — Ignorar cache
   * @param {string} [options.provider] — Override del proveedor
   * @returns {Promise<{ results: SearchResult[], metadata: Object }>}
   */
  async search(query, options = {}) {
    const startTime = Date.now();
    this._metrics.searches++;

    // 1. Verificar cache
    if (this.config.enableCache && !options.forceRefresh) {
      const cached = this._cache.get(query, options);
      if (cached) {
        this._metrics.cacheHits++;
        return {
          results: cached,
          metadata: {
            cached: true,
            provider: options.provider || this.config.provider,
            duration: Date.now() - startTime,
            cacheMetrics: this._cache.getMetrics(),
          },
        };
      }
    }

    // 2. Obtener proveedor (con fallback automático)
    const providerName = options.provider || this.config.provider;
    let provider = this._getOrCreateProvider(providerName);

    // 3. Ejecutar búsqueda (con fallback)
    let results;
    let usedProvider = providerName;
    try {
      results = await provider.search(query, {
        maxResults: options.maxResults || this.config.maxResults,
        language: options.language,
        category: options.category,
        safeSearch: options.safeSearch,
      });
    } catch (err) {
      console.warn(`[SearchManager] ${providerName} failed: ${err.message}, trying fallback...`);
      const fallbackResult = await this._tryFallback(providerName, query, options);
      if (fallbackResult) {
        results = fallbackResult.results;
        usedProvider = fallbackResult.provider;
      } else {
        this._metrics.errors++;
        return { results: [], metadata: { error: err.message } };
      }
    }

    // 4. Re-ranking
    if (this.config.enableRanking && results.length > 0) {
      results = this._ranker.rank(query, results, {
        maxResults: options.maxResults || this.config.maxResults,
      });
    }

    // 5. Guardar en cache
    if (this.config.enableCache) {
      this._cache.set(query, options, results);
    }

    // 6. Log
    if (this.config.logSearches) {
      this._logSearch(query, results.length, usedProvider, Date.now() - startTime);
    }

    return {
      results,
      metadata: {
        cached: false,
        provider: usedProvider,
        resultCount: results.length,
        duration: Date.now() - startTime,
      },
    };
  }

  /**
   * Obtiene o crea una instancia de proveedor.
   * @param {string} name
   * @returns {BaseProvider|null}
   */
  _getOrCreateProvider(name) {
    let provider = this._providers.get(name);
    if (!provider) {
      provider = createProvider(name, this.config);
      if (provider) {
        this._providers.set(name, provider);
      }
    }
    return provider;
  }

  /**
   * Intenta proveedores de fallback en orden.
   * @param {string} failedProvider - Nombre del proveedor que falló
   * @param {string} query
   * @param {Object} options
   * @returns {Promise<{results: Array, provider: string}|null>}
   */
  async _tryFallback(failedProvider, query, options) {
    for (const name of FALLBACK_ORDER) {
      if (name === failedProvider) continue;
      const provider = this._getOrCreateProvider(name);
      if (!provider) continue;

      try {
        const results = await provider.search(query, {
          maxResults: options.maxResults || this.config.maxResults,
          language: options.language,
          category: options.category,
          safeSearch: options.safeSearch,
        });
        console.log(`[SearchManager] Fallback to ${name} succeeded (${results.length} results)`);
        return { results, provider: name };
      } catch (err) {
        console.warn(`[SearchManager] Fallback ${name} also failed: ${err.message}`);
      }
    }
    return null;
  }

  /**
   * Obtiene métricas del search manager.
   * @returns {Object}
   */
  getMetrics() {
    return {
      ...this._metrics,
      cache: this._cache.getMetrics(),
      providers: [...this._providers.keys()],
    };
  }

  /**
   * Limpia el cache.
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Log de búsqueda para debugging.
   */
  _logSearch(query, resultCount, provider, duration) {
    const shortQuery = query.length > 50 ? query.substring(0, 50) + '...' : query;
    console.log(
      `[Search] "${shortQuery}" → ${resultCount} results via ${provider} (${duration}ms)`
    );
  }
}

module.exports = SearchManager;
