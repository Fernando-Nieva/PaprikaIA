'use strict';

/**
 * Speech-to-Text provider.
 * Supports Groq Whisper and OpenAI Whisper.
 */
class STTProvider {
  constructor(config = {}) {
    this.provider = config.provider || 'groq';
    this.apiKey = config.apiKey;
    this.model = config.model || 'whisper-large-v3';
    this.baseUrl = config.baseUrl || (this.provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : 'https://api.openai.com/v1');
  }

  /**
   * Transcribes audio from base64 data.
   *
   * @param {string} base64Data - Audio as base64
   * @param {string} mimeType - MIME type (e.g., 'audio/mpeg')
   * @returns {Promise<string|null>} - Transcribed text
   */
  async transcribe(base64Data, mimeType) {
    if (!this.apiKey) {
      console.warn('[STT] No API key configured');
      return null;
    }

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = this._getExtension(mimeType);
      const filename = `audio.${ext}`;

      const formData = new FormData();
      formData.append('file', new Blob([buffer], { type: mimeType }), filename);
      formData.append('model', this.model);
      formData.append('language', 'es');
      formData.append('response_format', 'text');

      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[STT] Error ${response.status}: ${error}`);
        return null;
      }

      const text = await response.text();
      return text.trim();
    } catch (err) {
      console.error(`[STT] Transcription error: ${err.message}`);
      return null;
    }
  }

  _getExtension(mimeType) {
    const map = {
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/webm': 'webm',
      'audio/mp4': 'm4a',
    };
    return map[mimeType] || 'mp3';
  }
}

module.exports = STTProvider;
