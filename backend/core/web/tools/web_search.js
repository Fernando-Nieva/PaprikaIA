'use strict';

/**
 * web_search tool definition for ToolExecutor.
 *
 * Permite a Paprika buscar en internet via SearXNG.
 * Retorna resultados re-rankingados y cacheados.
 * Incluye thumbnails para resultados de video (YouTube, etc).
 *
 * Uso del AI: [TOOL:web_search({query: "qué es node.js"})]
 */

/**
 * Extrae el ID de un video de YouTube de una URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Detecta si una URL es de YouTube.
 * @param {string} url
 * @returns {boolean}
 */
function isYouTubeUrl(url) {
  return !!extractYouTubeId(url);
}

/**
 * Crea la definición de la herramienta web_search.
 *
 * @param {SearchManager} searchManager
 * @returns {Object} Tool definition
 */
function createWebSearchTool(searchManager) {
  return {
    description: 'Busca información en internet. Retorna resultados de búsqueda con título, URL y snippet. Para videos, incluye miniatura.',
    params: {
      query: 'string (término de búsqueda)',
      max_results: 'number (opcional, default 5)',
      category: 'string (opcional: general, images, news, science, it, videos)',
    },
    execute: async (args) => {
      const query = args.query;
      if (!query) return 'Error: query es requerido';

      const maxResults = Math.min(parseInt(args.max_results, 10) || 5, 15);

      // Auto-detect video category
      let category = args.category;
      const videoKeywords = ['video', 'youtube', 'ver', 'tutorial', 'clase', 'musica', 'cancion', 'opening', 'anime', 'pelicula'];
      if (!category && videoKeywords.some(kw => query.toLowerCase().includes(kw))) {
        category = 'videos';
      }

      const { results, metadata } = await searchManager.search(query, {
        maxResults,
        category,
      });

      if (results.length === 0) {
        return `No se encontraron resultados para "${query}"`;
      }

      const lines = results.map((r, i) => {
        const ytId = extractYouTubeId(r.url);
        const isVideo = ytId || isYouTubeUrl(r.url) || r.thumbnail;

        // Build thumbnail line if available
        let thumbnailLine = '';
        if (r.thumbnail) {
          thumbnailLine = `    Miniatura: ${r.thumbnail}`;
        } else if (ytId) {
          thumbnailLine = `    Miniatura: https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
        }

        // Build duration line
        const durationLine = r.length ? `    Duración: ${r.length}` : '';

        return [
          `[${i + 1}] ${r.title}${isVideo ? ' [VIDEO]' : ''}`,
          `    URL: ${r.url}`,
          thumbnailLine,
          durationLine,
          `    ${r.snippet.substring(0, 200)}`,
          '',
        ].filter(Boolean).join('\n');
      });

      const header = `Resultados para "${query}" (${metadata.duration}ms${metadata.cached ? ', cache' : ''}):\n`;
      return header + lines.join('\n');
    },
  };
}

module.exports = { createWebSearchTool, extractYouTubeId, isYouTubeUrl };
