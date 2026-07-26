'use strict';

/**
 * web_fetch tool definition for ToolExecutor.
 *
 * Descarga y extrae contenido de una URL específica.
 * Incluye protección SSRF, timeout, y extracción de texto plano.
 *
 * Uso del AI: [TOOL:web_fetch({url: "https://example.com"})]
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const UrlValidator = require('../security/UrlValidator');

const DEFAULT_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 500000; // 500KB
const MAX_OUTPUT = 6000;

/**
 * Crea la definición de la herramienta web_fetch.
 *
 * @param {Object} [options]
 * @param {boolean} [options.allowPrivate=false]
 * @returns {Object} Tool definition
 */
function createWebFetchTool(options = {}) {
  return {
    description: 'Descarga el contenido de una página web. Retorna el texto de la página (sin imágenes/css/js).',
    params: {
      url: 'string (URL completa a descargar)',
      extract: 'string (opcional: "text" para solo texto, "links" para extraer enlaces)',
    },
    execute: async (args) => {
      const url = args.url;
      if (!url) return 'Error: url es requerida';

      // Validar URL (SSRF protection)
      const validation = UrlValidator.validate(url, { allowPrivate: options.allowPrivate || false });
      if (!validation.valid) {
        return `URL bloqueada: ${validation.error}`;
      }

      try {
        const content = await fetchUrl(validation.url, {
          timeout: DEFAULT_TIMEOUT,
          maxContentLength: MAX_CONTENT_LENGTH,
        });

        if (args.extract === 'links') {
          return extractLinks(content.html, validation.url);
        }

        const text = extractText(content.html);
        if (text.length > MAX_OUTPUT) {
          return text.substring(0, MAX_OUTPUT) + '\n\n... [truncado - página muy larga]';
        }

        return text || 'No se pudo extraer contenido de la página';
      } catch (err) {
        return `Error al descargar: ${err.message}`;
      }
    },
  };
}

/**
 * Descarga una URL y retorna el HTML. Sigue redirects con validación SSRF.
 *
 * @param {string} url
 * @param {Object} options
 * @param {number} [options._depth=0] — Profundidad actual de redirects (interno)
 * @returns {Promise<{ html: string, headers: Object }>}
 */
function fetchUrl(url, options = {}) {
  const depth = options._depth || 0;
  const MAX_REDIRECTS = 5;

  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) {
      reject(new Error('Demasiados redirecciones'));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('URL inválida'));
      return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const timeout = options.timeout || 15000;

    const req = transport.get(url, {
      timeout,
      headers: {
        'User-Agent': 'PaprikaBot/1.0 (https://github.com/paprika)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      },
    }, (res) => {
      // Handle redirects with SSRF validation
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Drain original response to free socket
        res.resume();

        // Validate redirect URL (SSRF protection)
        const redirectValidation = UrlValidator.validateRedirect(
          res.headers.location,
          url,
          { allowPrivate: options.allowPrivate || false }
        );

        if (!redirectValidation.valid) {
          reject(new Error(`Redirección bloqueada: ${redirectValidation.error}`));
          return;
        }

        fetchUrl(redirectValidation.url, {
          ...options,
          _depth: depth + 1,
        }).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const contentLength = parseInt(res.headers['content-length'], 10);
      if (contentLength > (options.maxContentLength || MAX_CONTENT_LENGTH)) {
        res.resume();
        reject(new Error('Página demasiado grande'));
        return;
      }

      let body = '';
      let totalLength = 0;

      res.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > (options.maxContentLength || MAX_CONTENT_LENGTH)) {
          res.destroy();
          reject(new Error('Página demasiado grande'));
          return;
        }
        body += chunk;
      });

      res.on('end', () => {
        resolve({
          html: body,
          headers: res.headers,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout al descargar la página'));
    });
  });
}

/**
 * Extrae texto plano del HTML, removiendo tags.
 *
 * @param {string} html
 * @returns {string}
 */
function extractText(html) {
  if (!html) return '';

  let text = html;

  // Remover script y style
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Remover comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Convertir block elements a saltos de línea
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remover todos los tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decodificar HTML entities básicas
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Limpiar whitespace
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

  return text;
}

/**
 * Extrae enlaces del HTML.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string}
 */
function extractLinks(html, baseUrl) {
  if (!html) return 'No se encontraron enlaces';

  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').trim();

    if (!text || text.length < 3) continue;

    // Resolver URLs relativas
    try {
      if (href.startsWith('/')) {
        const base = new URL(baseUrl);
        href = `${base.origin}${href}`;
      } else if (!href.startsWith('http')) {
        href = new URL(href, baseUrl).href;
      }
    } catch {
      continue;
    }

    if (links.length >= 30) break;
    links.push(`- ${text.substring(0, 80)}: ${href}`);
  }

  return links.length > 0
    ? `Encontrados ${links.length} enlaces:\n${links.join('\n')}`
    : 'No se encontraron enlaces significativos';
}

module.exports = { createWebFetchTool, fetchUrl, extractText, extractLinks };
