const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiProvider {
  constructor(apiKey, model) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model || 'gemini-2.0-flash';
  }

  async chat(messages, onChunk) {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

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
                  return { inlineData: { mimeType: match[1], data: match[2] } };
                }
                return { text: '[image]' };
              }
              return { text: JSON.stringify(part) };
            })
          : [{ text: m.content }]
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
