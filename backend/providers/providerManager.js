'use strict';

/**
 * ProviderManager — Executes an ExecutionPlan with capability-based fallback.
 *
 * Key features:
 *   - Only attempts providers in the plan's fallbackChain
 *   - Never sends images to a non-vision provider
 *   - Passes the correct model name to each provider
 *   - Integrates HealthManager to skip degraded providers
 *   - Uses ResponseNormalizer for consistent output
 *   - Comprehensive debug logging
 */

const { ResponseNormalizer } = require('./responseNormalizer');
const { getHealthManager } = require('./healthManager');
const { getModelRegistry } = require('./modelRegistry');

class ProviderManager {
  /**
   * @param {object} params
   * @param {Map<string, object>} params.providers - Map of provider name → provider instance
   * @param {number} [params.defaultTimeout=60000]
   * @param {object} [params.healthManager] - HealthManager instance
   * @param {object} [params.modelRegistry] - ModelRegistry instance (optional, uses singleton)
   */
  constructor({ providers, defaultTimeout = 60000, healthManager, modelRegistry }) {
    this.providers = providers;
    this.defaultTimeout = defaultTimeout;
    this.health = healthManager || getHealthManager();
    this.registry = modelRegistry || getModelRegistry();
  }

  /**
   * Execute an ExecutionPlan.
   *
   * @param {import('./executionPlanner').ExecutionPlan} plan
   * @param {Array} messages - conversation messages (OpenAI format)
   * @param {Function} [onChunk] - streaming callback
   * @param {object} [options] - extra options (e.g. systemPrompt)
   * @returns {Promise<{ response: string, normalized: import('./responseNormalizer').NormalizedResponse, metadata: object }>}
   */
  async execute(plan, messages, onChunk, options = {}) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';
    const chain = this._buildChain(plan);

    if (DEBUG) {
      console.log('\n══════════════════════════════════════════════════');
      console.log('🎯 [DEBUG] ProviderManager.execute()');
      console.log('══════════════════════════════════════════════════');
      console.log('  Plan:', plan.provider, plan.model);
      console.log('  Chain:', chain.map(c => `${c.provider}/${c.model}`).join(' → '));
      console.log('  Messages:', messages.length);
      console.log('  Has multimodal:', messages.some(m => Array.isArray(m.content)));
      const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
      console.log('  Has image_url parts:', hasImage);
      console.log('  Health:', this.health.getStatus ? JSON.stringify(this.health.getStatus()) : 'N/A');
    }

    let lastError = null;
    let attemptNumber = 0;

    for (const entry of chain) {
      attemptNumber++;

      // Check health — skip degraded providers
      if (!this.health.isAvailable(entry.provider)) {
        const healthData = this.health.getHealth ? this.health.getHealth(entry.provider) : null;
        if (DEBUG) {
          console.log(`  ⏭ Skipping ${entry.provider} — degraded (cooldown: ${healthData?.remainingCooldownMs || '?'}ms)`);
        }
        continue;
      }

      const providerInstance = this.providers.get(entry.provider);
      if (!providerInstance) {
        lastError = new Error(`Provider instance not found: ${entry.provider}`);
        if (DEBUG) console.log(`  ❌ ${entry.provider}: instance not found`);
        continue;
      }

      // Build the model override — providers need to know WHICH model to use
      const modelOverride = { provider: entry.provider, model: entry.model };

      if (DEBUG) {
        console.log(`\n  ─── Attempt ${attemptNumber}/${chain.length}: ${entry.provider}/${entry.model} ───`);
        console.log('  Messages being sent:');
        messages.forEach((m, i) => {
          const isArray = Array.isArray(m.content);
          console.log(`    msg[${i}] role=${m.role}: contentisArray=${isArray}`);
          if (isArray) {
            m.content.forEach((p, j) => {
              if (p.type === 'image_url') {
                console.log(`      part[${j}]: type=image_url url_len=${p.image_url?.url?.length}`);
              } else if (p.type === 'text') {
                console.log(`      part[${j}]: type=text text="${(p.text || '').substring(0, 50)}"`);
              } else {
                console.log(`      part[${j}]: type=${p.type}`);
              }
            });
          } else {
            console.log(`      content="${String(m.content || '').substring(0, 50)}"`);
          }
        });
      }

      try {
        if (onChunk) {
          onChunk(`\n🔄 Usando: ${entry.provider} (${entry.model})\n`, 'tool');
        }

        const rawResponse = await Promise.race([
          providerInstance.chat(messages, onChunk, { ...options, modelOverride }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout: ${entry.provider} no respondió en ${plan.timeout / 1000}s`)),
              plan.timeout
            )
          ),
        ]);

        // Normalize response
        const normalized = ResponseNormalizer.normalize(rawResponse, {
          provider: entry.provider,
          model: entry.model,
        });

        // Validate
        const validation = ResponseNormalizer.validate(normalized);
        if (!validation.valid) {
          if (DEBUG) console.log(`  ⚠ ${entry.provider}: invalid response — ${validation.reason}`);
          lastError = new Error(`Invalid response from ${entry.provider}: ${validation.reason}`);
          this.health.recordFailure(entry.provider, lastError);
          continue;
        }

        // Record success
        this.health.recordSuccess(entry.provider);

        if (DEBUG) {
          console.log(`  ✅ ${entry.provider}: response received (${normalized.text.length} chars)`);
          console.log('  Response preview:', normalized.text.substring(0, 200));
        }

        return {
          response: normalized.text,
          normalized,
          metadata: {
            provider: entry.provider,
            model: entry.model,
            fallbackUsed: entry.provider !== plan.provider,
            attempts: attemptNumber,
            totalAttempts: chain.length,
          },
        };
      } catch (err) {
        lastError = err;
        this.health.recordFailure(entry.provider, err);

        if (DEBUG) console.log(`  ❌ ${entry.provider} (${entry.model}) falló: ${err.message.substring(0, 100)}`);
        if (onChunk) {
          onChunk(`\n❌ ${entry.provider} (${entry.model}) falló: ${err.message.substring(0, 80)}\n`, 'tool');
        }
        continue;
      }
    }

    throw new Error(
      `Todos los proveedores del plan fallaron. Provider primario: ${plan.provider}. Último error: ${lastError?.message}`
    );
  }

  /**
   * Build the ordered chain from the plan, filtered by health and model capabilities.
   *
   * For each entry in the chain, verifies via ModelRegistry that the model
   * actually supports the required capabilities. Skips models that don't match.
   */
  _buildChain(plan) {
    const DEBUG = process.env.DEBUG_ATTACHMENTS === 'true';
    const requiredCaps = plan.requirements || {};
    const hasRequirements = Object.keys(requiredCaps).length > 0;
    const chain = [];

    // Primary — always include (it was selected by ExecutionPlanner which already checked)
    chain.push({ provider: plan.provider, model: plan.model });

    for (const fb of plan.fallbackChain) {
      if (!this.providers.has(fb.provider)) continue;

      // If we have requirements, verify the fallback model actually supports them
      if (hasRequirements) {
        const modelCaps = this.registry.getModelCapabilities(fb.provider, fb.model);
        if (!modelCaps) {
          if (DEBUG) console.log(`  ⏭ _buildChain: ${fb.provider}/${fb.model} — not in registry, skipping`);
          continue;
        }
        const supportsAll = Object.keys(requiredCaps).every(k => modelCaps[k] === true);
        if (!supportsAll) {
          if (DEBUG) console.log(`  ⏭ _buildChain: ${fb.provider}/${fb.model} — missing caps ${Object.keys(requiredCaps).filter(k => !modelCaps[k]).join(',')}, skipping`);
          continue;
        }
      }

      chain.push({ provider: fb.provider, model: fb.model });
    }

    return chain;
  }
}

module.exports = { ProviderManager };
