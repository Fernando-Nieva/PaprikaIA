/**
 * AttachmentDetector — auto-detect rich content from URLs in text/results.
 *
 * Usage:
 *   const detector = new AttachmentDetector();
 *   const attachments = detector.fromSearchResults(searchResult.results);
 *   const attachments = detector.fromText(text);
 *
 * Design: Open/Closed — add new detectors to detectors.js without modifying this file.
 */

const { DETECTORS } = require('./detectors');
const { website_from_search } = require('./attachments');

class AttachmentDetector {
  /**
   * Convert search results into typed attachments.
   * Each result gets run through all detectors; if none match, a website fallback is created.
   *
   * @param {Array<{title, url, snippet, engine, thumbnail}>} results
   * @returns {Array<object>} attachments
   */
  fromSearchResults(results) {
    if (!results || !Array.isArray(results)) return [];

    const attachments = [];
    const seen = new Set();

    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);

      let att = null;
      for (const detector of DETECTORS) {
        att = detector(r.url, r);
        if (att) break;
      }

      // Fallback: website card
      if (!att) {
        att = website_from_search(r);
      }

      attachments.push(att);
    }

    return attachments;
  }

  /**
   * Detect all URLs in a plain text string and classify them.
   *
   * @param {string} text
   * @returns {Array<object>} attachments
   */
  fromText(text) {
    if (!text || typeof text !== 'string') return [];

    const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
    const urls = text.match(URL_REGEX) || [];
    const attachments = [];
    const seen = new Set();

    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?)\]]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);

      for (const detector of DETECTORS) {
        const att = detector(url, {});
        if (att) {
          attachments.push(att);
          break;
        }
      }
    }

    return attachments;
  }

  /**
   * Merge two attachment arrays, deduplicating by URL.
   *
   * @param {Array} existing
   * @param {Array} incoming
   * @returns {Array}
   */
  merge(existing, incoming) {
    const seen = new Set(existing.map(a => a.url));
    const merged = [...existing];
    for (const att of incoming) {
      if (!seen.has(att.url)) {
        merged.push(att);
        seen.add(att.url);
      }
    }
    return merged;
  }
}

module.exports = AttachmentDetector;
