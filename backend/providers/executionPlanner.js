'use strict';

const { getModelRegistry } = require('./modelRegistry');

/**
 * ExecutionPlan — Builds an ExecutionPlan from requirements and model selection.
 *
 * Single responsibility: prepare a plan. Never executes anything.
 *
 * The plan contains:
 *   - provider: the primary provider to use
 *   - model: the model to use
 *   - requirements: what the query needs (e.g. { vision: true })
 *   - fallbackChain: ordered list of compatible providers (priority-sorted: free first)
 *   - timeout, retries, streaming: execution config
 *   - metadata: reason, timestamp, discards
 */

class ExecutionPlan {
  constructor({ provider, model, requirements, fallbackChain, timeout, retries, streaming, metadata }) {
    this.provider = provider;
    this.model = model;
    this.requirements = requirements;
    this.fallbackChain = fallbackChain;
    this.timeout = timeout;
    this.retries = retries;
    this.streaming = streaming;
    this.metadata = metadata;
  }
}

class ExecutionPlanner {
  /**
   * @param {object} params
   * @param {object} params.capabilityManager
   * @param {object} [params.modelRegistry] - ModelRegistry instance
   * @param {object} [params.healthManager] - HealthManager instance
   * @param {number} [params.defaultTimeout=60000]
   * @param {number} [params.defaultRetries=1]
   * @param {boolean} [params.defaultStreaming=true]
   */
  constructor({ capabilityManager, modelRegistry, healthManager, defaultTimeout = 60000, defaultRetries = 1, defaultStreaming = true }) {
    this.cm = capabilityManager;
    this.registry = modelRegistry || getModelRegistry();
    this.health = healthManager || null;
    this.defaultTimeout = defaultTimeout;
    this.defaultRetries = defaultRetries;
    this.defaultStreaming = defaultStreaming;
  }

  /**
   * Build an ExecutionPlan from requirements and a ModelSelector result.
   *
   * The fallback chain is sorted by ModelRegistry priority:
   *   Level 1 (FREE): Ollama local → Groq → Gemini
   *   Level 2 (OPTIONAL): OpenRouter free models
   *   Level 3 (PAID): OpenAI, Anthropic
   *
   * @param {{ vision?: boolean, audio?: boolean, tools?: boolean, code?: boolean }} requirements
   * @param {{ provider: string, model: string, switched: boolean, reason: string, unavailable?: boolean }} modelSelection
   * @returns {ExecutionPlan}
   */
  plan(requirements, modelSelection) {
    const requiredCaps = this._extractRequired(requirements);

    // Use ModelRegistry as single source of truth — sorted by priority (free first)
    const compatibleModels = this.registry.findModelsByCapabilities(requiredCaps, {
      healthManager: this.health,
    });

    const discards = this._getDiscards(requiredCaps);

    let fallbackChain;
    let primaryProvider;
    let primaryModel;

    if (compatibleModels.length === 0) {
      fallbackChain = [];
      primaryProvider = modelSelection.provider;
      primaryModel = modelSelection.model;
    } else {
      // Check if the selected model is in the compatible list
      const selectedEntry = compatibleModels.find(
        c => c.provider === modelSelection.provider && c.model === modelSelection.model
      );

      if (selectedEntry) {
        primaryProvider = selectedEntry.provider;
        primaryModel = selectedEntry.model;
        fallbackChain = compatibleModels
          .filter(c => !(c.provider === primaryProvider && c.model === primaryModel))
          .map(c => ({ provider: c.provider, model: c.model }));
      } else {
        // Selected model not compatible — pick first compatible (highest priority)
        primaryProvider = compatibleModels[0].provider;
        primaryModel = compatibleModels[0].model;
        fallbackChain = compatibleModels.slice(1).map(c => ({ provider: c.provider, model: c.model }));
      }
    }

    return new ExecutionPlan({
      provider: primaryProvider,
      model: primaryModel,
      requirements: requiredCaps,
      fallbackChain,
      timeout: this.defaultTimeout,
      retries: this.defaultRetries,
      streaming: this.defaultStreaming,
      metadata: {
        reason: modelSelection.reason || 'selection',
        switched: modelSelection.switched || false,
        unavailable: compatibleModels.length === 0,
        compatibleCount: compatibleModels.length,
        discards,
        timestamp: Date.now(),
      },
    });
  }

  _extractRequired(capabilities) {
    const required = {};
    if (capabilities.vision || capabilities.needsVision) required.vision = true;
    if (capabilities.audio || capabilities.needsAudio) required.audio = true;
    if (capabilities.tools) required.tools = true;
    if (capabilities.code) required.code = true;
    return required;
  }

  _getDiscards(requiredCaps) {
    const discards = [];
    const capKeys = Object.entries(requiredCaps).filter(([, v]) => v).map(([k]) => k);
    if (capKeys.length === 0) return discards;

    for (const providerData of this.registry.getAllProviders()) {
      const hasCompatibleModel = providerData.models.some(model => {
        const caps = model.capabilities || {};
        return capKeys.every(k => caps[k] === true);
      });

      if (!hasCompatibleModel) {
        const reasons = capKeys.filter(k => {
          return !providerData.models.some(m => m.capabilities && m.capabilities[k]);
        });
        discards.push({
          provider: providerData.provider || providerData.name,
          reason: `no model supports: ${reasons.join(', ')}`,
        });
      }
    }

    return discards;
  }
}

module.exports = { ExecutionPlan, ExecutionPlanner };
