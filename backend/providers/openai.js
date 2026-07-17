const OpenAI = require('openai');

class OpenAIProvider {
  constructor(apiKey, model) {
    this.client = new OpenAI({ apiKey });
    this.modelName = model || 'gpt-4o-mini';
  }

  async chat(messages, onChunk) {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
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

module.exports = OpenAIProvider;
