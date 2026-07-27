/**
 * Capabilities module — entry point.
 *
 * Usage:
 *   const { CapabilityManager, ModelSelector, setupCapabilities } = require('./capabilities');
 *   const cm = setupCapabilities();
 *   const selector = new ModelSelector(cm, config);
 */

const { CapabilityManager } = require('./CapabilityManager');
const ModelSelector = require('./ModelSelector');
const { getModelRegistry } = require('../../providers/modelRegistry');

/**
 * Setup capabilities from ModelRegistry (single source of truth).
 * No longer needs providers list — reads directly from ModelRegistry.
 *
 * @param {Array} [providers] - ignored, kept for backward compat
 * @param {object} [config] - model selection preferences
 * @returns {CapabilityManager}
 */
function setupCapabilities(providers, config = {}) {
  const registry = getModelRegistry();
  return new CapabilityManager(registry);
}

module.exports = { CapabilityManager, ModelSelector, setupCapabilities };
