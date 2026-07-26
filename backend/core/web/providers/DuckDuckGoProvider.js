'use strict';

/**
 * DuckDuckGoProvider — Proveedor de búsqueda web via DuckDuckGo HTML.
 *
 * No requiere API key ni servicio externo.
 * Scraping ligero del endpoint HTML de DuckDuckGo.
 *
 * Uso: cuando SearXNG no está disponible, se usa como fallback automático.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const BaseProvider = require('./BaseProvider');

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_VIDEO_URL = 'https://html.duckduckgo.com/html/';

const DEFAULT_CONFIG = {
  timeout: 10000,
  maxResults: 10,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

class DuckDuckGoProvider extends BaseProvider {
  constructor(config = {}) {
    super('duckduckgo', { ...DEFAULT_CONFIG, ...config });
  }

  async isAvailable() {
    try {
      const url = new URL(DDG_HTML_URL);
      const result = await this._httpGet(url.href, { timeout: 5000 });
      return result !== null && result.includes('result');
    } catch {
      return false;
    }
  }

  async search(query, options = {}) {
    if (!query || !query.trim()) return [];

    const params = new URLSearchParams({
      q: query.trim(),
      kl: options.language === 'es' ? 'es-es' : 'en-us',
    });

    if (options.safeSearch) {
      params.set('kp', '1');
    }

    const searchUrl = `${DDG_HTML_URL}?${params.toString()}`;

    try {
      const html = await this._httpGet(searchUrl, { timeout: this.config.timeout });
      if (!html) return [];

      const results = this._parseHtml(html);
      const limit = options.maxResults || this.config.maxResults;
      return results.slice(0, limit);
    } catch (err) {
      console.error(`[DuckDuckGo] Search failed: ${err.message}`);
      return [];
    }
  }

  _parseHtml(html) {
    const results = [];

    // Match result blocks: each result has class="result"
    const resultBlocks = html.split(/class="result(?:\s|")/);

    for (let i = 1; i < resultBlocks.length; i++) {
      const block = resultBlocks[i];

      // Extract URL from href
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      if (!urlMatch) continue;

      let url = urlMatch[1];
      // DuckDuckGo wraps URLs in redirect: //duckduckgo.com/l/?uddg=...
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)/);
      const title = titleMatch ? this._decodeHtml(titleMatch[1].trim()) : '';
      if (!title || !url) continue;

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a|<\/span|<\/div)/);
      let snippet = '';
      if (snippetMatch) {
        snippet = snippetMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        snippet = this._decodeHtml(snippet);
      }

      // Extract thumbnail if present
      const thumbMatch = block.match(/class="result__image"[^>]*src="([^"]+)"/);
      const thumbnail = thumbMatch ? thumbMatch[1] : null;

      results.push(this._normalize({
        title,
        url,
        snippet,
        thumbnail,
        engine: 'duckduckgo',
        score: Math.max(0.5, 1 - (i * 0.05)),
      }));
    }

    return results;
  }

  _decodeHtml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&hellip;/g, '...')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  }

  _httpGet(url, options = {}) {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const timeout = options.timeout || this.config.timeout;

      const req = transport.get(url, {
        timeout,
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es,en;q=0.9',
        },
      }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._httpGet(res.headers.location, options).then(resolve);
          return;
        }

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

module.exports = DuckDuckGoProvider;
