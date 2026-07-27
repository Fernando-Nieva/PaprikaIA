'use strict';

const Groq = require('groq-sdk');

class GroqProvider {
  constructor(apiKey, model) {
    this.client = new Groq({ apiKey });
    this.modelName = model || 'llama-3.1-70b-versatile';
  }

  async chat(messages, onChunk, options = {}) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';

    // Support model override from ProviderManager
    const modelName = options.modelOverride?.model || this.modelName;

    const openaiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (Array.isArray(m.content)) {
          // Groq doesn't support multimodal — extract text only
          const textParts = m.content
            .filter(p => p.type === 'text')
            .map(p => p.text);
          return { role: m.role, content: textParts.join('\n') || '[multimodal content not supported by this provider]' };
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      });

    const systemMessages = messages
      .filter(m => m.role === 'system')
      .map(m => ({ role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));

    const allMessages = [...systemMessages, ...openaiMessages];

    const response = await this.client.chat.completions.create({
      model: modelName,
      messages: allMessages,
      stream: true
    });

    let fullResponse = '';
    for await (const chunk of response) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        fullResponse += text;
        if (onChunk) onChunk(text, 'text');
      }
    }

    return fullResponse;
  }
}

module.exports = GroqProvider;
