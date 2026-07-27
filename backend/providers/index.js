require('dotenv').config();
const GeminiProvider = require('./gemini');
const OpenAIProvider = require('./openai');
const GroqProvider = require('./groq');
const OllamaProvider = require('./ollama');

const PROVIDER_ORDER = ['gemini', 'groq', 'ollama', 'openai'];

const MODELS = {
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  groq: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  ollama: process.env.OLLAMA_MODEL || 'llama3.2',
};

// Capability declarations per provider
const PROVIDER_CAPABILITIES = {
  openai: {
    name: 'openai',
    models: [
      { name: 'gpt-4o',       capabilities: { vision: true,  audio: true,  tools: true, streaming: true, pdf: false }, contextLength: 128000 },
      { name: 'gpt-4o-mini',  capabilities: { vision: true,  audio: false, tools: true, streaming: true, pdf: false }, contextLength: 128000 },
    ],
  },
  gemini: {
    name: 'gemini',
    models: [
      { name: 'gemini-2.0-flash',  capabilities: { vision: true,  audio: true,  tools: true, streaming: true, pdf: true }, contextLength: 1048576 },
      { name: 'gemini-2.5-flash',  capabilities: { vision: true,  audio: true,  tools: true, streaming: true, pdf: true }, contextLength: 1048576 },
    ],
  },
  groq: {
    name: 'groq',
    models: [
      { name: 'llama-3.3-70b-versatile', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false }, contextLength: 128000 },
      { name: 'whisper-large-v3',        capabilities: { vision: false, audio: true,  tools: false, streaming: false, pdf: false }, contextLength: 0 },
    ],
  },
  ollama: {
    name: 'ollama',
    models: [
      { name: 'llama3.2',          capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false }, contextLength: 131072 },
      { name: 'llama3.2-vision',   capabilities: { vision: true,  audio: false, tools: true, streaming: true, pdf: false }, contextLength: 131072 },
      { name: 'llava',             capabilities: { vision: true,  audio: false, tools: false, streaming: true, pdf: false }, contextLength: 4096 },
      { name: 'bakllava',          capabilities: { vision: true,  audio: false, tools: false, streaming: true, pdf: false }, contextLength: 4096 },
      { name: 'moondream',         capabilities: { vision: true,  audio: false, tools: false, streaming: true, pdf: false }, contextLength: 2048 },
    ],
  },
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
  return PROVIDER_ORDER.map(name => {
    const provider = createSingleProvider(name);
    if (!provider) return null;
    const caps = PROVIDER_CAPABILITIES[name] || { name, models: [] };
    return { name, provider, models: caps.models };
  }).filter(Boolean);
}

module.exports = {
  createSingleProvider,
  getAvailableProviders,
  MODELS,
  PROVIDER_CAPABILITIES,
  PROVIDER_ORDER,
};
