'use strict';

const ollama = require('ollama').default;

class OllamaProvider {
  constructor(model) {
    this.modelName = model || 'llama3.2';
  }

  async chat(messages, onChunk, options = {}) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';

    // Support model override from ProviderManager
    const modelName = options.modelOverride?.model || this.modelName;

    if (DEBUG) {
      console.log('\n─── [DEBUG] OllamaProvider.chat() ───');
      console.log('  model:', modelName);
      console.log('  Input messages:', messages.length);
    }

    const ollamaMessages = messages.map((m, idx) => {
      if (Array.isArray(m.content)) {
        if (DEBUG) console.log(`  msg[${idx}] Array.isArray content: ${m.content.length} parts`);

        const textParts = m.content.filter(p => p.type === 'text').map(p => p.text);
        const images = m.content
          .filter(p => p.type === 'image_url')
          .map(p => {
            const url = p.image_url?.url || '';
            const match = url.match(/^data:[^;]+;base64,(.+)$/);
            if (DEBUG) {
              console.log(`    image part: url prefix=${url.substring(0, 20)}, url_len=${url.length}, match=${!!match}`);
            }
            return match ? match[1] : null;
          })
          .filter(Boolean);

        if (DEBUG) {
          console.log(`    → textParts: ${textParts.length}, images: ${images.length}`);
          if (images.length > 0) {
            images.forEach((img, i) => console.log(`    → image[${i}] base64_len: ${img.length}`));
          }
        }

        return { role: m.role, content: textParts.join('\n'), images: images.length > 0 ? images : undefined };
      }
      return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    });

    if (DEBUG) {
      console.log('\n  ─── PAYLOAD EXACTO ENVIADO A OLLAMA ───');
      console.log('  model:', modelName);
      ollamaMessages.forEach((m, i) => {
        console.log(`  msg[${i}]: role=${m.role}, content_len=${m.content?.length || 0}, hasImages=${!!m.images}, imagesCount=${m.images?.length || 0}`);
        if (m.images && m.images.length > 0) {
          m.images.forEach((img, j) => console.log(`    img[${j}]: base64_len=${img.length}`));
        }
      });
    }

    try {
      const response = await ollama.chat({
        model: modelName,
        messages: ollamaMessages,
        stream: true
      });

      let fullResponse = '';
      for await (const part of response) {
        if (part.message?.content) {
          fullResponse += part.message.content;
          if (onChunk) onChunk(part.message.content, 'text');
        }
      }

      return fullResponse;
    } catch (err) {
      if (err.message?.includes('ECONNREFUSED')) {
        throw new Error('Ollama no está corriendo. Iniciá Ollama y volvé a intentar.');
      }
      throw new Error(`Error de Ollama: ${err.message?.substring(0, 100)}`);
    }
  }
}

module.exports = OllamaProvider;
