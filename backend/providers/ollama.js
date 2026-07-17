const ollama = require('ollama').default;

class OllamaProvider {
  constructor(model) {
    this.modelName = model || 'llama3.2';
  }

  async chat(messages, onChunk) {
    const response = await ollama.chat({
      model: this.modelName,
      messages,
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
  }
}

module.exports = OllamaProvider;
