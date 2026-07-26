'use strict';

/**
 * SearXNGProvider — Proveedor de búsqueda web via SearXNG.
 *
 * SearXNG es un metarrotador de búsqueda open source que agraga resultados
 * de múltiples motores (Google, Bing, DuckDuckGo, Wikipedia, etc.).
 *
 * Configuración (.env):
 *   SEARXNG_URL          — URL de la instancia SearXNG (default: http://localhost:8080)
 *   SEARXNG_TIMEOUT      — Timeout en ms (default: 10000)
 *   SEARXNG_LANGUAGE     — Idioma (default: es)
 *   SEARXNG_SAFESEARCH   — SafeSearch 0-3 (default: 0)
 *   SEARXNG_ENGINES      — Motores específicos (default: vacío = todos)
 *   SEARXNG_FORMAT       — Formato de respuesta (default: json)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const BaseProvider = require('./BaseProvider');

const DEFAULT_CONFIG = {
  url: 'http://localhost:8080',
  timeout: 10000,
  language: 'es',
  safeSearch: 0,
  engines: '',
  format: 'json',
  maxResults: 10,
  userAgent: 'PaprikaBot/1.0 (https://github.com/paprika)',
};

class SearXNGProvider extends BaseProvider {
  /**
   * @param {Object} [config={}] — Configuración (lee de .env por defecto)
   */
  constructor(config = {}) {
    super('searxng', {
      ...DEFAULT_CONFIG,
      url: process.env.SEARXNG_URL || DEFAULT_CONFIG.url,
      timeout: parseInt(process.env.SEARXNG_TIMEOUT, 10) || DEFAULT_CONFIG.timeout,
      language: process.env.SEARXNG_LANGUAGE || DEFAULT_CONFIG.language,
      safeSearch: parseInt(process.env.SEARXNG_SAFESEARCH, 10) || DEFAULT_CONFIG.safeSearch,
      engines: process.env.SEARXNG_ENGINES || DEFAULT_CONFIG.engines,
      ...config,
    });
  }

  /**
   * Verifica si SearXNG está accesible.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const url = new URL(this.config.url);
      const result = await this._httpGet(url.href, { timeout: 3000 });
      return result !== null;
    } catch {
      return false;
    }
  }

  /**
   * Realiza una búsqueda en SearXNG.
   *
   * @param {string} query
   * @param {Object} [options]
   * @returns {Promise<SearchResult[]>}
   */
  async search(query, options = {}) {
    if (!query || !query.trim()) return [];

    const params = new URLSearchParams({
      q: query.trim(),
      format: this.config.format,
      language: options.language || this.config.language,
      safesearch: String(options.safeSearch ?? this.config.safeSearch),
    });

    if (options.category) {
      params.set('categories', options.category);
    }

    if (this.config.engines) {
      params.set('engines', this.config.engines);
    }

    const searchUrl = `${this.config.url}/search?${params.toString()}`;

    try {
      const raw = await this._httpGet(searchUrl, { timeout: this.timeout });
      if (!raw) return [];

      const data = JSON.parse(raw);
      const results = this._parseResults(data);
      const limit = options.maxResults || this.config.maxResults;

      return results.slice(0, limit);
    } catch (err) {
      console.error(`[SearXNG] Search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Parsea la respuesta de SearXNG al formato estándar.
   * @param {Object} data
   * @returns {SearchResult[]}
   */
  _parseResults(data) {
    if (!data || !Array.isArray(data.results)) return [];

    return data.results
      .filter(r => r.url && r.title)
      .map(r => this._normalize({
        title: r.title,
        url: r.url,
        snippet: r.content || '',
        engine: (r.engines && r.engines[0]) || 'searxng',
        score: typeof r.score === 'number' ? r.score : 0.5,
        thumbnail: r.thumbnail || null,
        length: r.length || null,
        publishedDate: r.publishedDate || null,
      }));
  }

  /**
   * Realiza un request HTTP GET con timeout.
   * @param {string} url
   * @param {Object} [options]
   * @returns {Promise<string|null>}
   */
  _httpGet(url, options = {}) {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const timeout = options.timeout || this.timeout;

      const req = transport.get(url, {
        timeout,
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'application/json',
        },
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          resolve(null);
          return;
        }

        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }
}

module.exports = SearXNGProvider;
