'use strict';

/**
 * ResultRanker — Re-ranking semántico para resultados de búsqueda.
 *
 * Después de obtener resultados del proveedor, los re-rankea basándose en:
 *   1. Similitud semántica con el query original (TF-IDF simple)
 *   2. Calidad del snippet (longitud, presencia de keywords)
 *   3. Diversidad de fuentes
 *   4. Presencia de contenido estructurado
 *
 * No depende de modelos externos — es rápido y determinista.
 */

class ResultRanker {
  constructor() {
    this._stopWords = new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'uno', 'de', 'del', 'al',
      'en', 'con', 'por', 'para', 'que', 'qué', 'se', 'es', 'son',
      'está', 'están', 'hay', 'como', 'cómo', 'más', 'menos', 'pero',
      'o', 'y', 'a', 'the', 'a', 'an', 'is', 'are', 'was', 'were',
      'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after',
    ]);
  }

  /**
   * Re-rankea una lista de resultados.
   *
   * @param {string} query
   * @param {SearchResult[]} results
   * @param {Object} [options]
   * @param {number} [options.maxResults=10]
   * @returns {SearchResult[]}
   */
  rank(query, results, options = {}) {
    if (!results || results.length === 0) return [];

    const keywords = this._extractKeywords(query);
    const scored = results.map((r, i) => ({
      ...r,
      _rankScore: this._scoreResult(r, keywords, i, results.length),
    }));

    scored.sort((a, b) => b._rankScore - a._rankScore);

    const limit = options.maxResults || results.length;
    return scored.slice(0, limit).map(r => {
      const { _rankScore, ...rest } = r;
      rest.score = Math.round(_rankScore * 100) / 100;
      return rest;
    });
  }

  /**
   * Extrae keywords significativas del query.
   * @param {string} query
   * @returns {string[]}
   */
  _extractKeywords(query) {
    const words = query
      .toLowerCase()
      .replace(/[áéíóú]/g, m => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' }[m]))
      .split(/[^\wáéíóúñü]+/)
      .filter(w => w.length > 2 && !this._stopWords.has(w));

    // Also include dotted terms as-is (e.g., "node.js")
    const dotted = query
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.includes('.') && w.length > 2);

    return [...new Set([...words, ...dotted])];
  }

  /**
   * Calcula un score compuesto para un resultado.
   * @param {SearchResult} result
   * @param {string[]} keywords
   * @param {number} originalIndex
   * @param {number} totalResults
   * @returns {number}
   */
  _scoreResult(result, keywords, originalIndex, totalResults) {
    const titleScore = this._textSimilarity(result.title, keywords) * 2.0;
    const snippetScore = this._textSimilarity(result.snippet, keywords) * 1.5;
    const positionScore = Math.max(0, 1 - (originalIndex / Math.max(totalResults, 1))) * 0.5;

    const lengthScore = this._snippetQuality(result.snippet);
    const diversityBonus = result.engine !== 'searxng' ? 0.1 : 0;

    return titleScore + snippetScore + positionScore + lengthScore + diversityBonus;
  }

  /**
   * Similitud simple entre texto y keywords (TF normalizado).
   * @param {string} text
   * @param {string[]} keywords
   * @returns {number} 0-1
   */
  _textSimilarity(text, keywords) {
    if (!text || keywords.length === 0) return 0;
    const lowerText = text.toLowerCase();
    const words = lowerText.split(/\s+/);
    if (words.length === 0) return 0;

    let matches = 0;
    for (const kw of keywords) {
      if (lowerText.includes(kw)) matches++;
    }

    return matches / keywords.length;
  }

  /**
   * Evalúa calidad del snippet basándose en longitud y estructura.
   * @param {string} snippet
   * @returns {number} 0-0.5
   */
  _snippetQuality(snippet) {
    if (!snippet) return 0;
    const len = snippet.length;

    if (len < 20) return 0;
    if (len > 300) return 0.3;
    if (len > 100) return 0.5;
    return 0.2;
  }
}

module.exports = ResultRanker;
