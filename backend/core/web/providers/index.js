'use strict';

/**
 * Provider registry — Factory para crear instancias de proveedores de búsqueda.
 *
 * Para agregar un nuevo proveedor:
 *   1. Crear NewProvider.js en providers/
 *   2. Extender BaseProvider
 *   3. Registrar aquí:
 *      const NewProvider = require('./NewProvider');
 *      providers.set('new', NewProvider);
 */

const SearXNGProvider = require('./SearXNGProvider');
const DuckDuckGoProvider = require('./DuckDuckGoProvider');

const providers = new Map();
providers.set('searxng', SearXNGProvider);
providers.set('duckduckgo', DuckDuckGoProvider);

/**
 * Crea una instancia de un proveedor por nombre.
 *
 * @param {string} name
 * @param {Object} [config={}]
 * @returns {BaseProvider|null}
 */
function createProvider(name, config = {}) {
  const ProviderClass = providers.get(name);
  if (!ProviderClass) return null;
  return new ProviderClass(config);
}

/**
 * Retorna la lista de nombres de proveedores disponibles.
 * @returns {string[]}
 */
function listProviders() {
  return [...providers.keys()];
}

module.exports = { createProvider, listProviders, providers };
