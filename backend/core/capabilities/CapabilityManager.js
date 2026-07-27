/**
 * CapabilityManager — Central knowledge of what each model can do.
 *
 * Now driven by ModelRegistry as the single source of truth.
 * This module provides the query API that ModelSelector and other modules use.
 *
 * Design: Open/Closed — add new providers/models by calling register().
 */

const { getModelRegistry } = require('../../providers/modelRegistry');

class CapabilityManager {
  constructor(registry) {
    this._providers = new Map();
    this._registry = registry || getModelRegistry();
    this._syncFromRegistry();
  }

  /**
   * Sync capabilities from ModelRegistry (single source of truth).
   */
  _syncFromRegistry() {
    for (const providerData of this._registry.getAllProviders()) {
      this._providers.set(providerData.provider, {
        name: providerData.provider,
        models: providerData.models.map(m => ({
          name: m.name,
          capabilities: m.capabilities,
          contextLength: m.contextLength,
        })),
      });
    }
  }

  /**
   * Register a provider with its models and capabilities.
   */
  register(providerName, models) {
    this._providers.set(providerName, {
      name: providerName,
      models: models || [],
    });
  }

  /**
   * Get all models across all providers.
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
   */
  findByCapability(capability) {
    return this.getAllModels().filter(m => m.capabilities && m.capabilities[capability]);
  }

  /**
   * Check if a specific model supports a capability.
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
   */
  getModelCapabilities(providerName, modelName) {
    const provider = this._providers.get(providerName);
    if (!provider) return null;
    const model = provider.models.find(m => m.name === modelName);
    return model ? model.capabilities : null;
  }

  /**
   * Get a provider by name.
   */
  getProvider(providerName) {
    return this._providers.get(providerName) || null;
  }

  /**
   * List all registered provider names.
   */
  listProviders() {
    return Array.from(this._providers.keys());
  }

  /**
   * Get providers that have at least one model supporting ALL required capabilities.
   * Delegates to ModelRegistry for priority-sorted results.
   */
  getProvidersForCapabilities(requiredCapabilities) {
    const requiredKeys = Object.entries(requiredCapabilities)
      .filter(([, v]) => v === true)
      .map(([k]) => k);

    if (requiredKeys.length === 0) {
      return this.getAllModels().map(m => ({
        provider: m.provider,
        model: m.name,
        capabilities: m.capabilities,
      }));
    }

    // Use ModelRegistry for priority-sorted results
    const candidates = this._registry.findModelsByCapabilities(requiredCapabilities);
    if (candidates.length > 0) {
      return candidates.map(c => ({
        provider: c.provider,
        model: c.model,
        capabilities: c.capabilities,
      }));
    }

    // Fallback: local query
    const result = [];
    for (const model of this.getAllModels()) {
      const caps = model.capabilities || {};
      const hasAll = requiredKeys.every(k => caps[k] === true);
      if (hasAll) {
        result.push({
          provider: model.provider,
          model: model.name,
          capabilities: caps,
        });
      }
    }
    return result;
  }
}

module.exports = { CapabilityManager };
