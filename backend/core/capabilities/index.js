/**
 * Capabilities module — entry point.
 *
 * Usage:
 *   const { CapabilityManager, ModelSelector, setupCapabilities } = require('./capabilities');
 *   const cm = setupCapabilities(providers);
 *   const selector = new ModelSelector(cm, config);
 */

const { CapabilityManager, MODEL_CAPABILITIES } = require('./CapabilityManager');
const ModelSelector = require('./ModelSelector');

/**
 * Setup capabilities from available providers.
 * @param {Array<{name, models}>} providers - from getAvailableProviders() or custom
 * @param {object} config - model selection preferences from .env
 * @returns {CapabilityManager}
 */
function setupCapabilities(providers, config = {}) {
  const cm = new CapabilityManager();

  for (const provider of providers) {
    const models = (provider.models || []).map(m => ({
      name: typeof m === 'string' ? m : m.name,
      capabilities: typeof m === 'string'
        ? (MODEL_CAPABILITIES[m] || { vision: false, audio: false, tools: true, streaming: true })
        : m.capabilities,
      contextLength: typeof m === 'object' ? m.contextLength : undefined,
    }));
    cm.register(provider.name, models);
  }

  return cm;
}

module.exports = { CapabilityManager, ModelSelector, MODEL_CAPABILITIES, setupCapabilities };
