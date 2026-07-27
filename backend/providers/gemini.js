'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiProvider {
  constructor(apiKey, model) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model || 'gemini-2.0-flash';
  }

  async chat(messages, onChunk, options = {}) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';

    // Support model override from ProviderManager
    const modelName = options.modelOverride?.model || this.modelName;
    const model = this.genAI.getGenerativeModel({ model: modelName });

    const rawContents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content)
          ? m.content.map(part => {
              if (part.type === 'text') return { text: part.text };
              if (part.type === 'image_url') {
                const url = part.image_url?.url || '';
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  if (DEBUG) console.log(`  [Gemini] image: mimeType=${match[1]}, data_len=${match[2].length}`);
                  return { inlineData: { mimeType: match[1], data: match[2] } };
                }
                if (DEBUG) console.log(`  [Gemini] image: NO MATCH for url prefix=${url.substring(0, 30)}`);
                return { text: '[image]' };
              }
              return { text: JSON.stringify(part) };
            })
          : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      }));

    // Merge consecutive same-role messages (Gemini requires alternating roles)
    const contents = [];
    for (const msg of rawContents) {
      if (contents.length > 0 && contents[contents.length - 1].role === msg.role) {
        contents[contents.length - 1].parts.push(...msg.parts);
      } else {
        contents.push(msg);
      }
    }

    if (DEBUG) {
      console.log('\n─── [DEBUG] GeminiProvider.chat() ───');
      console.log('  model:', modelName);
      console.log('  contents:', contents.length);
      contents.forEach((c, i) => {
        console.log(`  content[${i}]: role=${c.role}, parts=${c.parts.length}`);
        c.parts.forEach((p, j) => {
          if (p.text) console.log(`    part[${j}]: text="${p.text.substring(0, 60)}"`);
          if (p.inlineData) console.log(`    part[${j}]: inlineData mimeType=${p.inlineData.mimeType}, data_len=${p.inlineData.data.length}`);
        });
      });
    }

    const systemInstruction = messages
      .filter(m => m.role === 'system')
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n\n');

    const result = await model.generateContentStream({
      contents,
      systemInstruction: systemInstruction || undefined
    });

    let fullResponse = '';
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullResponse += text;
        if (onChunk) onChunk(text, 'text');
      }
    }

    return fullResponse;
  }
}

module.exports = GeminiProvider;
