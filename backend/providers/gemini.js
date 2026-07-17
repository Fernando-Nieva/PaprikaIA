const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiProvider {
  constructor(apiKey, model) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model || 'gemini-1.5-flash';
  }

  async chat(messages, onChunk) {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
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
