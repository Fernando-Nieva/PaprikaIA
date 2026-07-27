'use strict';

/**
 * ResponseNormalizer — Unified response format from all providers.
 *
 * All providers return a raw string. This normalizer wraps it into a
 * consistent structure that the rest of the system uses.
 *
 * Output format:
 * {
 *   text: string,          // The response text
 *   usage: object,         // Token usage (if available)
 *   finishReason: string,  // 'stop' | 'tool_calls' | 'length' | 'error'
 *   provider: string,      // Provider name
 *   model: string,         // Model name
 *   metadata: object,      // Extra info
 * }
 */

class NormalizedResponse {
  constructor({ text, usage, finishReason, provider, model, metadata }) {
    this.text = text || '';
    this.usage = usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.finishReason = finishReason || 'stop';
    this.provider = provider || 'unknown';
    this.model = model || 'unknown';
    this.metadata = metadata || {};
  }

  /** Ensure response is always a clean string. */
  toString() {
    if (typeof this.text === 'string') return this.text;
    if (this.text && typeof this.text === 'object') {
      return JSON.stringify(this.text);
    }
    return String(this.text || '');
  }

  /** Check if response is meaningful (non-empty after trimming). */
  get hasContent() {
    return typeof this.text === 'string' && this.text.trim().length > 0;
  }

  /** Check if response indicates an error. */
  get isError() {
    return this.finishReason === 'error' || !this.hasContent;
  }
}

class ResponseNormalizer {
  /**
   * Normalize a raw response from any provider.
   *
   * @param {string|object} raw - Raw response from provider
   * @param {object} context - { provider, model, finishReason, usage }
   * @returns {NormalizedResponse}
   */
  static normalize(raw, context = {}) {
    let text = '';

    if (raw === null || raw === undefined) {
      text = '';
    } else if (typeof raw === 'string') {
      text = raw;
    } else if (typeof raw === 'object') {
      // Handle structured responses (some providers return objects)
      if (raw.text !== undefined) {
        text = String(raw.text);
      } else if (raw.content !== undefined) {
        text = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content);
      } else if (raw.choices && Array.isArray(raw.choices) && raw.choices[0]) {
        // OpenAI-style response object
        const choice = raw.choices[0];
        if (choice.message && choice.message.content) {
          text = choice.message.content;
        } else if (choice.delta && choice.delta.content) {
          text = choice.delta.content;
        }
      } else {
        text = JSON.stringify(raw);
      }
    } else {
      text = String(raw);
    }

    // Clean up text
    text = text.trim();

    // Strip any residual tool call markers that leaked through
    text = text.replace(/\[TOOL(?:_CALL)?:\w+\(\{[\s\S]*?\}\)\]/g, '').trim();
    text = text.replace(/\[\/TOOL_CALL\]/g, '').trim();

    return new NormalizedResponse({
      text,
      usage: context.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: context.finishReason || 'stop',
      provider: context.provider || 'unknown',
      model: context.model || 'unknown',
      metadata: context.metadata || {},
    });
  }

  /**
   * Validate that a response has meaningful content for the given capabilities.
   *
   * @param {NormalizedResponse} response
   * @param {object} capabilities - { vision: bool, ... }
   * @returns {{ valid: boolean, reason?: string }}
   */
  static validate(response, capabilities = {}) {
    if (!response) {
      return { valid: false, reason: 'Response is null/undefined' };
    }

    if (!response.hasContent) {
      return { valid: false, reason: 'Response is empty' };
    }

    if (response.text === '[image]' || response.text === '[imagen]') {
      return { valid: false, reason: 'Provider returned placeholder instead of description' };
    }

    if (response.isError) {
      return { valid: false, reason: `Response has error finishReason: ${response.finishReason}` };
    }

    return { valid: true };
  }
}

module.exports = { ResponseNormalizer, NormalizedResponse };
