'use strict';

/**
 * Web module — Punto de entrada para el sistema de búsqueda web.
 *
 * Exporta:
 *   - SearchManager: orquestador principal
 *   - createWebSearchTool: tool definition para ToolExecutor
 *   - createWebFetchTool: tool definition para ToolExecutor
 *   - Providers: SearXNGProvider
 *   - Utilities: UrlValidator, SearchCache, ResultRanker
 */

const SearchManager = require('./SearchManager');
const { createWebSearchTool } = require('./tools/web_search');
const { createWebFetchTool } = require('./tools/web_fetch');
const UrlValidator = require('./security/UrlValidator');
const SearchCache = require('./cache/SearchCache');
const ResultRanker = require('./ranking/ResultRanker');
const { createProvider, listProviders } = require('./providers');

module.exports = {
  SearchManager,
  createWebSearchTool,
  createWebFetchTool,
  UrlValidator,
  SearchCache,
  ResultRanker,
  createProvider,
  listProviders,
};
