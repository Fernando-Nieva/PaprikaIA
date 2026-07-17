require('dotenv').config();
const GeminiProvider = require('./gemini');
const OpenAIProvider = require('./openai');
const GroqProvider = require('./groq');
const OllamaProvider = require('./ollama');

const PROVIDER_ORDER = ['openai', 'gemini', 'groq', 'ollama'];

const MODELS = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  ollama: 'llama3.2'
};

function createSingleProvider(name) {
  switch (name) {
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return new OpenAIProvider(key, MODELS.openai);
    }
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return null;
      return new GeminiProvider(key, MODELS.gemini);
    }
    case 'groq': {
      const key = process.env.GROQ_API_KEY;
      if (!key) return null;
      return new GroqProvider(key, MODELS.groq);
    }
    case 'ollama':
      return new OllamaProvider(MODELS.ollama);
    default:
      return null;
  }
}

function getAvailableProviders() {
  return PROVIDER_ORDER.map(name => ({ name, provider: createSingleProvider(name) }))
    .filter(p => p.provider !== null);
}

module.exports = { createSingleProvider, getAvailableProviders, MODELS };
