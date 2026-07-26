'use strict';

/**
 * BaseProvider — Interfaz base para proveedores de búsqueda web.
 *
 * Cada proveedor debe implementar search() y normalizar los resultados
 * al formato SearchResult. El SearchManager solo interactúa con esta interfaz.
 *
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} snippet
 * @property {string} [content]
 * @property {string} [engine]
 * @property {number} [score]
 * @property {string} provider
 */

class BaseProvider {
  /**
   * @param {string} name - Nombre del proveedor
   * @param {Object} config - Configuración del proveedor
   */
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.timeout = config.timeout || 10000;
  }

  /**
   * Realiza una búsqueda. Debe ser implementado por cada proveedor.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults=10]
   * @param {string} [options.language='es']
   * @param {string} [options.category]
   * @param {boolean} [options.safeSearch=false]
   * @returns {Promise<SearchResult[]>}
   */
  async search(query, options = {}) {
    throw new Error(`${this.name}: search() not implemented`);
  }

  /**
   * Indica si el proveedor está disponible (configurado y accesible).
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    throw new Error(`${this.name}: isAvailable() not implemented`);
  }

  /**
   * Normaliza un resultado del proveedor al formato estándar.
   * @param {Object} raw
   * @returns {SearchResult}
   */
  _normalize(raw) {
    return {
      title: String(raw.title || '').trim(),
      url: String(raw.url || '').trim(),
      snippet: String(raw.snippet || raw.content || '').trim(),
      content: raw.content ? String(raw.content).trim() : undefined,
      engine: raw.engine || this.name,
      score: typeof raw.score === 'number' ? raw.score : 0.5,
      provider: this.name,
      thumbnail: raw.thumbnail || null,
      length: raw.length || null,
      publishedDate: raw.publishedDate || null,
    };
  }
}

module.exports = BaseProvider;
