'use strict';
/**
 * providers/index.js — Dynamic provider factory.
 *
 * Architecture:
 *   - ModelRegistry is the single source of truth for which providers/models exist
 *   - This module creates provider INSTANCES based on what's available
 *   - NO hardcoded model names — everything reads from ModelRegistry
 *   - NO provider order hardcoded — priority comes from ModelRegistry
 *
 * Flow:
 *   ModelRegistry → tells us which providers exist + which are available
 *   providers/index.js → creates instances for available providers
 *   ProviderManager → uses instances + ModelRegistry for execution
 */

require('dotenv').config();

const { getModelRegistry, PROVIDER_META, PRIORITY } = require('./modelRegistry');

// ─── Provider class map ─────────────────────────────────────────────────────
// Lazy-loaded to avoid circular deps
const _providerClasses = {};
function _getProviderClass(name) {
  if (!_providerClasses[name]) {
    switch (name) {
      case 'ollama': _providerClasses[name] = require('./ollama'); break;
      case 'gemini': _providerClasses[name] = require('./gemini'); break;
      case 'openai': _providerClasses[name] = require('./openai'); break;
      case 'groq': _providerClasses[name] = require('./groq'); break;
      // OpenRouter uses OpenAI-compatible API
      case 'openrouter': _providerClasses[name] = require('./openai'); break;
      // Anthropic: future
      // case 'anthropic': _providerClasses[name] = require('./anthropic'); break;
      default: return null;
    }
  }
  return _providerClasses[name];
}

// ─── Dynamic Provider Creation ──────────────────────────────────────────────

/**
 * Create a provider instance for the given provider name.
 * Returns null if the provider can't be created (missing API key, etc.)
 *
 * @param {string} providerName
 * @returns {object|null} provider instance
 */
function createSingleProvider(providerName) {
  const registry = getModelRegistry();
  const providerData = registry.getProvider(providerName);
  if (!providerData) return null;

  // Check if API key is required and available
  const keyEnv = providerData.requiresKey;
  if (keyEnv && !process.env[keyEnv]) return null;

  const ProviderClass = _getProviderClass(providerName);
  if (!ProviderClass) return null;

  // Get default model for this provider
  const defaultModel = providerData.models[0];
  if (!defaultModel) return null;

  const apiKey = keyEnv ? process.env[keyEnv] : undefined;

  try {
    if (providerName === 'ollama') {
      return new ProviderClass(defaultModel.name);
    } else if (providerName === 'openrouter') {
      // OpenRouter uses OpenAI-compatible API with different base URL
      return new ProviderClass(apiKey, defaultModel.name);
    } else {
      return new ProviderClass(apiKey, defaultModel.name);
    }
  } catch (err) {
    console.warn(`[providers] Failed to create ${providerName}: ${err.message}`);
    return null;
  }
}

/**
 * Get all available providers in priority order.
 * Reads from ModelRegistry — no hardcoded order.
 *
 * @returns {Array<{ name: string, provider: object, models: Array }>}
 */
function getAvailableProviders() {
  const registry = getModelRegistry();
  const allProviders = registry.getAllProviders();

  // Sort by priority (free first)
  const sorted = allProviders.sort((a, b) => a.priority - b.priority);

  return sorted.map(providerData => {
    const provider = createSingleProvider(providerData.provider);
    if (!provider) return null;
    return {
      name: providerData.provider,
      provider,
      models: providerData.models.map(m => ({
        name: m.name,
        capabilities: m.capabilities,
        contextLength: m.contextLength,
      })),
    };
  }).filter(Boolean);
}

/**
 * Create a Map of provider name → provider instance for all available providers.
 * Used by ProviderManager for capability-filtered execution.
 *
 * @returns {Map<string, object>}
 */
function createProviderInstances() {
  const map = new Map();
  for (const { name, provider } of getAvailableProviders()) {
    map.set(name, provider);
  }
  return map;
}

// ─── Legacy Compatibility ───────────────────────────────────────────────────
// These exports exist for backward compatibility with existing code.
// New code should use ModelRegistry directly.

const MODELS = {};
const registry = getModelRegistry();
for (const [providerName, providerData] of registry._registry) {
  MODELS[providerName] = providerData.models[0]?.name || '';
}

const PROVIDER_CAPABILITIES = registry.toLegacyFormat();

const PROVIDER_ORDER = Array.from(registry._registry.keys())
  .sort((a, b) => (registry.getProvider(a)?.priority || 99) - (registry.getProvider(b)?.priority || 99));

module.exports = {
  createSingleProvider,
  createProviderInstances,
  getAvailableProviders,
  MODELS,
  PROVIDER_CAPABILITIES,
  PROVIDER_ORDER,
};
