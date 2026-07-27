/**
 * CapabilityManager — Central knowledge of what each model can do.
 *
 * Each provider declares its models with capabilities.
 * The CapabilityManager aggregates them and answers queries like:
 *   "Which models support vision?"
 *   "Does llama3.2 support images?"
 *   "What's the best model for PDF processing?"
 *
 * Design: Open/Closed — add new providers/models by calling register().
 */

class CapabilityManager {
  constructor() {
    this._providers = new Map();  // providerName -> { models: [...] }
  }

  /**
   * Register a provider with its models and capabilities.
   * @param {string} providerName
   * @param {Array<{name, capabilities, contextLength, maxTokens}>} models
   */
  register(providerName, models) {
    this._providers.set(providerName, {
      name: providerName,
      models: models || [],
    });
  }

  /**
   * Get all models across all providers.
   * @returns {Array<{provider, name, capabilities, contextLength, maxTokens}>}
   */
  getAllModels() {
    const result = [];
    for (const [providerName, provider] of this._providers) {
      for (const model of provider.models) {
        result.push({ provider: providerName, ...model });
      }
    }
    return result;
  }

  /**
   * Find models that have a specific capability.
   * @param {string} capability - e.g. 'vision', 'audio', 'tools'
   * @returns {Array<{provider, name, capabilities}>}
   */
  findByCapability(capability) {
    return this.getAllModels().filter(m => m.capabilities && m.capabilities[capability]);
  }

  /**
   * Check if a specific model supports a capability.
   * @param {string} providerName
   * @param {string} modelName
   * @param {string} capability
   * @returns {boolean}
   */
  modelSupports(providerName, modelName, capability) {
    const provider = this._providers.get(providerName);
    if (!provider) return false;
    const model = provider.models.find(m => m.name === modelName);
    if (!model) return false;
    return !!(model.capabilities && model.capabilities[capability]);
  }

  /**
   * Get capabilities for a specific model.
   * @param {string} providerName
   * @param {string} modelName
   * @returns {object|null}
   */
  getModelCapabilities(providerName, modelName) {
    const provider = this._providers.get(providerName);
    if (!provider) return null;
    const model = provider.models.find(m => m.name === modelName);
    return model ? model.capabilities : null;
  }

  /**
   * Get a provider by name.
   * @param {string} providerName
   * @returns {object|null}
   */
  getProvider(providerName) {
    return this._providers.get(providerName) || null;
  }

  /**
   * List all registered provider names.
   * @returns {string[]}
   */
  listProviders() {
    return Array.from(this._providers.keys());
  }
}

// Default capabilities for known models
const MODEL_CAPABILITIES = {
  // Ollama models
  'llama3.2':           { vision: false, audio: false, tools: true, streaming: true },
  'llama3.2-vision':    { vision: true,  audio: false, tools: true, streaming: true },
  'llava':              { vision: true,  audio: false, tools: false, streaming: true },
  'llava-llama3':       { vision: true,  audio: false, tools: false, streaming: true },
  'bakllava':           { vision: true,  audio: false, tools: false, streaming: true },
  'moondream':          { vision: true,  audio: false, tools: false, streaming: true },
  'minicpm-v':          { vision: true,  audio: false, tools: false, streaming: true },
  'qwen2.5vl':          { vision: true,  audio: false, tools: true, streaming: true },

  // Cloud models
  'gemini-2.0-flash':   { vision: true,  audio: true,  tools: true, streaming: true },
  'gemini-2.5-flash':   { vision: true,  audio: true,  tools: true, streaming: true },
  'gpt-4o':             { vision: true,  audio: true,  tools: true, streaming: true },
  'gpt-4o-mini':        { vision: true,  audio: false, tools: true, streaming: true },
  'groq-llama-3.3-70b': { vision: false, audio: false, tools: true, streaming: true },
};

module.exports = { CapabilityManager, MODEL_CAPABILITIES };
