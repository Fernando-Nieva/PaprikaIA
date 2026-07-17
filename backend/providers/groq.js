const Groq = require('groq-sdk');

class GroqProvider {
  constructor(apiKey, model) {
    this.client = new Groq({ apiKey });
    this.modelName = model || 'llama-3.1-70b-versatile';
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

module.exports = GroqProvider;
