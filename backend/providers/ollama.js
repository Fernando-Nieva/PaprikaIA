const ollama = require('ollama').default;

class OllamaProvider {
  constructor(model) {
    this.modelName = model || 'llama3.2';
  }

  async chat(messages, onChunk) {
    const ollamaMessages = messages.map(m => {
      if (Array.isArray(m.content)) {
        const textParts = m.content.filter(p => p.type === 'text').map(p => p.text);
        const images = m.content
          .filter(p => p.type === 'image_url')
          .map(p => {
            const url = p.image_url?.url || '';
            const match = url.match(/^data:[^;]+;base64,(.+)$/);
            return match ? match[1] : null;
          })
          .filter(Boolean);
        return { role: m.role, content: textParts.join('\n'), images };
      }
      return m;
    });

    try {
      const response = await ollama.chat({
        model: this.modelName,
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
