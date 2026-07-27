'use strict';

/**
 * ModelRegistry — Single source of truth for ALL models across ALL providers.
 *
 * Architecture:
 *   - Static seed: known models with full metadata (capabilities, cost, speed, priority)
 *   - Dynamic discovery: auto-detect available models from each provider
 *   - Priority system: Level 1 (free) → Level 2 (optional free) → Level 3 (paid)
 *   - Health-aware: integrates with HealthManager to skip degraded providers
 *
 * Principles:
 *   - NO hardcoded model names in selection logic
 *   - NO provider-dependent personality
 *   - Models are engines; Paprika is the identity
 *   - Free models ALWAYS preferred over paid
 *   - Local models preferred over cloud when capabilities match
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ─── Priority Levels ────────────────────────────────────────────────────────
const PRIORITY = {
  FREE: 1,          // Ollama (local), Groq free tier, Gemini free tier
  OPTIONAL: 2,      // OpenRouter free models
  PAID: 3,          // OpenAI, Anthropic, OpenRouter paid
};

// ─── Provider Metadata ──────────────────────────────────────────────────────
const PROVIDER_META = {
  ollama: {
    displayName: 'Ollama (Local)',
    priority: PRIORITY.FREE,
    requiresKey: false,
    isLocal: true,
    costPerMillionTokens: 0,
    speedEstimate: 30, // tokens/sec (local, varies by hardware)
  },
  groq: {
    displayName: 'Groq',
    priority: PRIORITY.FREE,
    requiresKey: 'GROQ_API_KEY',
    isLocal: false,
    costPerMillionTokens: 0,
    speedEstimate: 200, // very fast inference
  },
  gemini: {
    displayName: 'Google Gemini',
    priority: PRIORITY.FREE,
    requiresKey: 'GEMINI_API_KEY',
    isLocal: false,
    costPerMillionTokens: 0, // free tier
    speedEstimate: 150,
  },
  openrouter: {
    displayName: 'OpenRouter',
    priority: PRIORITY.OPTIONAL,
    requiresKey: 'OPENROUTER_API_KEY',
    isLocal: false,
    costPerMillionTokens: 0, // free models only
    speedEstimate: 100,
  },
  openai: {
    displayName: 'OpenAI',
    priority: PRIORITY.PAID,
    requiresKey: 'OPENAI_API_KEY',
    isLocal: false,
    costPerMillionTokens: 2.5, // gpt-4o-mini
    speedEstimate: 120,
  },
  anthropic: {
    displayName: 'Anthropic',
    priority: PRIORITY.PAID,
    requiresKey: 'ANTHROPIC_API_KEY',
    isLocal: false,
    costPerMillionTokens: 3, // claude-3.5-sonnet
    speedEstimate: 100,
  },
};

// ─── Static Model Seed ──────────────────────────────────────────────────────
// These are known models with their capabilities.
// Auto-discovery will add/remove models at runtime.
const MODEL_SEED = {
  ollama: [
    { name: 'llama3.2', displayName: 'Llama 3.2', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: false },
    { name: 'llama3.2-vision', displayName: 'Llama 3.2 Vision', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: true },
    { name: 'llava', displayName: 'LLaVA', capabilities: { vision: true, audio: false, tools: false, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 4096, maxOutput: 2048, multimodal: true },
    { name: 'bakllava', displayName: 'BakLLaVA', capabilities: { vision: true, audio: false, tools: false, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 4096, maxOutput: 2048, multimodal: true },
    { name: 'moondream', displayName: 'Moondream', capabilities: { vision: true, audio: false, tools: false, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 2048, maxOutput: 1024, multimodal: true },
    { name: 'qwen2.5-vl', displayName: 'Qwen 2.5 VL', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 32768, maxOutput: 4096, multimodal: true },
    { name: 'deepseek-r1', displayName: 'DeepSeek R1', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: true }, contextLength: 65536, maxOutput: 8192, multimodal: false },
    { name: 'codellama', displayName: 'CodeLlama', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 16384, maxOutput: 4096, multimodal: false },
    { name: 'mistral', displayName: 'Mistral', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 32768, maxOutput: 4096, multimodal: false },
    { name: 'gemma3', displayName: 'Gemma 3', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 32768, maxOutput: 4096, multimodal: false },
    { name: 'phi4', displayName: 'Phi-4', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: true }, contextLength: 16384, maxOutput: 4096, multimodal: false },
  ],
  groq: [
    { name: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 32768, multimodal: false },
    { name: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 128000, maxOutput: 8192, multimodal: false },
    { name: 'qwen-qwq-32b', displayName: 'Qwen QwQ 32B', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: true }, contextLength: 128000, maxOutput: 32768, multimodal: false },
    { name: 'deepseek-r1-distill-qwen-32b', displayName: 'DeepSeek R1 Distill', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: true }, contextLength: 128000, maxOutput: 32768, multimodal: false },
    { name: 'whisper-large-v3', displayName: 'Whisper Large V3', capabilities: { vision: false, audio: true, tools: false, streaming: false, pdf: false, code: false, reasoning: false }, contextLength: 0, maxOutput: 0, multimodal: false },
  ],
  gemini: [
    { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: true }, contextLength: 1048576, maxOutput: 8192, multimodal: true },
    { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true },
    { name: 'gemini-2.0-flash-lite', displayName: 'Gemini 2.0 Flash Lite', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true },
    { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true },
  ],
  openai: [
    { name: 'gpt-4o', displayName: 'GPT-4o', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 16384, multimodal: true },
    { name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 16384, multimodal: true },
    { name: 'o3-mini', displayName: 'o3-mini', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: true }, contextLength: 128000, maxOutput: 100000, multimodal: false },
  ],
  anthropic: [
    { name: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: true, code: true, reasoning: true }, contextLength: 200000, maxOutput: 64000, multimodal: true },
    { name: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 200000, maxOutput: 8192, multimodal: true },
  ],
  openrouter: [], // populated dynamically from API
};


class ModelRegistry {
  constructor() {
    this._registry = new Map();
    this._discoveryStatus = {}; // provider -> { timestamp, success, error, modelsFound }
    this._initFromSeed();
  }

  _initFromSeed() {
    for (const [providerName, models] of Object.entries(MODEL_SEED)) {
      const meta = PROVIDER_META[providerName] || {};
      this._registry.set(providerName, {
        provider: providerName,
        displayName: meta.displayName || providerName,
        priority: meta.priority || PRIORITY.PAID,
        requiresKey: meta.requiresKey || null,
        isLocal: meta.isLocal || false,
        costPerMillionTokens: meta.costPerMillionTokens || 0,
        speedEstimate: meta.speedEstimate || 50,
        available: this._isProviderAvailable(providerName),
        models: models.map(m => ({
          ...m,
          installed: providerName === 'ollama', // will be updated by sync
          available: this._isProviderAvailable(providerName),
        })),
      });
    }
  }

  _isProviderAvailable(providerName) {
    const meta = PROVIDER_META[providerName];
    if (!meta) return false;
    if (meta.requiresKey) return !!process.env[meta.requiresKey];
    return true; // local providers (ollama) always "available" structurally
  }

  // ─── Query Methods ──────────────────────────────────────────────────────

  getAllProviders() {
    return Array.from(this._registry.values());
  }

  getProvider(name) {
    return this._registry.get(name) || null;
  }

  getModels(providerName) {
    const provider = this._registry.get(providerName);
    return provider ? provider.models : [];
  }

  getModel(providerName, modelName) {
    const models = this.getModels(providerName);
    return models.find(m => m.name === modelName) || null;
  }

  getModelCapabilities(providerName, modelName) {
    const model = this.getModel(providerName, modelName);
    return model ? (model.capabilities || null) : null;
  }

  hasCapability(providerName, modelName, capability) {
    const model = this.getModel(providerName, modelName);
    return model ? (model.capabilities[capability] === true) : false;
  }

  getDefaultModel(providerName) {
    const provider = this._registry.get(providerName);
    if (!provider || provider.models.length === 0) return null;
    return provider.models[0];
  }

  getVisionModels() { return this.findModelsByCapabilities({ vision: true }); }
  getAudioModels() { return this.findModelsByCapabilities({ audio: true }); }
  getToolModels() { return this.findModelsByCapabilities({ tools: true }); }
  getCodeModels() { return this.findModelsByCapabilities({ code: true }); }
  getReasoningModels() { return this.findModelsByCapabilities({ reasoning: true }); }

  // ─── Core Query: Find Models by Capabilities (priority-sorted) ─────────

  /**
   * Find all models that support ALL required capabilities.
   * Sorted by: priority (free first) → speed (fastest first) → local after cloud.
   *
   * @param {object} requiredCapabilities - e.g. { vision: true, tools: true }
   * @param {object} [options] - { healthManager, excludeProviders: Set }
   * @returns {Array<{ provider, model, displayName, capabilities, priority, costPerMillionTokens, speedEstimate, contextLength, multimodal }>}
   */
  findModelsByCapabilities(requiredCapabilities, options = {}) {
    const requiredKeys = Object.entries(requiredCapabilities)
      .filter(([, v]) => v === true)
      .map(([k]) => k);

    const { healthManager, excludeProviders = new Set() } = options;
    const candidates = [];

    for (const [providerName, providerData] of this._registry) {
      if (excludeProviders.has(providerName)) continue;
      if (!providerData.available) continue;

      // Health check
      if (healthManager && !healthManager.isAvailable(providerName)) continue;

      for (const model of providerData.models) {
        if (!model.available) continue;
        const caps = model.capabilities || {};
        const hasAll = requiredKeys.every(k => caps[k] === true);
        if (hasAll) {
          candidates.push({
            provider: providerName,
            model: model.name,
            displayName: model.displayName,
            capabilities: caps,
            priority: providerData.priority,
            costPerMillionTokens: providerData.costPerMillionTokens,
            speedEstimate: providerData.speedEstimate,
            contextLength: model.contextLength,
            multimodal: model.multimodal,
            isLocal: providerData.isLocal,
          });
        }
      }
    }

    // Sort: priority (free first) → speed (fastest first) → cloud before local
    candidates.sort((a, b) => {
      // 1. Priority: free (1) before paid (3)
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 2. Speed: faster first
      if (a.speedEstimate !== b.speedEstimate) return b.speedEstimate - a.speedEstimate;
      // 3. Cloud before local (for same priority)
      if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1;
      return 0;
    });

    return candidates;
  }

  // ─── Best Model Selection ───────────────────────────────────────────────

  /**
   * Select the best model for given requirements.
   * Always prefers free → fast → capable.
   *
   * @param {object} requiredCapabilities - e.g. { vision: true }
   * @param {object} [options] - { healthManager, excludeProviders }
   * @returns {{ provider, model, displayName, priority, reason } | null}
   */
  selectBest(requiredCapabilities, options = {}) {
    const candidates = this.findModelsByCapabilities(requiredCapabilities, options);
    if (candidates.length === 0) return null;

    const best = candidates[0];
    return {
      provider: best.provider,
      model: best.model,
      displayName: best.displayName,
      priority: best.priority,
      costPerMillionTokens: best.costPerMillionTokens,
      reason: `Best available: ${best.displayName} (${best.provider}) [priority ${best.priority}, ${best.speedEstimate} tok/s]`,
    };
  }

  // ─── Auto-Discovery ─────────────────────────────────────────────────────

  /**
   * Run auto-discovery for ALL providers.
   * Returns summary of what was found.
   */
  async syncAll() {
    const results = {};

    // Ollama: check installed models
    try {
      results.ollama = await this.syncOllamaModels();
    } catch (err) {
      results.ollama = { error: err.message };
    }

    // Groq: verify API key and list models
    try {
      results.groq = await this.syncGroqModels();
    } catch (err) {
      results.groq = { error: err.message };
    }

    // Gemini: verify API key
    try {
      results.gemini = await this.syncGeminiModels();
    } catch (err) {
      results.gemini = { error: err.message };
    }

    // OpenRouter: discover free models
    try {
      results.openrouter = await this.syncOpenRouterModels();
    } catch (err) {
      results.openrouter = { error: err.message };
    }

    // Update availability for all providers
    for (const [name, provider] of this._registry) {
      provider.available = this._isProviderAvailable(name);
      for (const model of provider.models) {
        model.available = provider.available;
      }
    }

    return results;
  }

  async syncOllamaModels() {
    let stdout;
    try {
      const result = await execAsync('ollama list', { timeout: 10000 });
      stdout = result.stdout;
    } catch (err) {
      return { added: [], existing: [], removed: [], error: err.message };
    }

    const lines = stdout.trim().split('\n').slice(1);
    const installedNames = lines.map(l => l.split(/\s+/)[0].trim()).filter(Boolean);

    const ollamaProvider = this._registry.get('ollama');
    if (!ollamaProvider) return { added: [], existing: [], removed: [], error: 'ollama not in registry' };

    const existingNames = new Set(ollamaProvider.models.map(m => m.name));
    const installedSet = new Set(installedNames);

    const added = [];
    const existing = [];
    const removed = [];

    for (const name of installedNames) {
      if (existingNames.has(name)) {
        existing.push(name);
        // Mark as installed
        const model = ollamaProvider.models.find(m => m.name === name);
        if (model) model.installed = true;
      } else {
        const caps = this._inferOllamaCapabilities(name);
        ollamaProvider.models.push({
          name,
          displayName: name,
          capabilities: caps,
          contextLength: 131072,
          maxOutput: 4096,
          multimodal: caps.vision || caps.audio,
          installed: true,
          available: true,
        });
        added.push(name);
      }
    }

    for (const model of ollamaProvider.models) {
      if (!installedSet.has(model.name)) {
        model.installed = false;
        removed.push(model.name);
      }
    }

    this._discoveryStatus.ollama = { timestamp: Date.now(), success: true, modelsFound: installedNames.length };
    return { added, existing, removed };
  }

  async syncGroqModels() {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
      this._discoveryStatus.groq = { timestamp: Date.now(), success: false, error: 'no API key' };
      return { available: false };
    }

    try {
      const resp = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        this._discoveryStatus.groq = { timestamp: Date.now(), success: false, error: `HTTP ${resp.status}` };
        return { available: false, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      const availableModels = (data.data || []).map(m => m.id);

      // Update availability for registered Groq models
      const groqProvider = this._registry.get('groq');
      if (groqProvider) {
        groqProvider.available = true;
        for (const model of groqProvider.models) {
          model.available = availableModels.includes(model.name);
        }
      }

      this._discoveryStatus.groq = { timestamp: Date.now(), success: true, modelsFound: availableModels.length };
      return { available: true, modelsFound: availableModels.length, models: availableModels };
    } catch (err) {
      this._discoveryStatus.groq = { timestamp: Date.now(), success: false, error: err.message };
      return { available: false, error: err.message };
    }
  }

  async syncGeminiModels() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      this._discoveryStatus.gemini = { timestamp: Date.now(), success: false, error: 'no API key' };
      return { available: false };
    }

    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        this._discoveryStatus.gemini = { timestamp: Date.now(), success: false, error: `HTTP ${resp.status}` };
        return { available: false, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      const geminiProvider = this._registry.get('gemini');
      if (geminiProvider) {
        geminiProvider.available = true;
      }

      this._discoveryStatus.gemini = { timestamp: Date.now(), success: true, modelsFound: data.models?.length || 0 };
      return { available: true, modelsFound: data.models?.length || 0 };
    } catch (err) {
      this._discoveryStatus.gemini = { timestamp: Date.now(), success: false, error: err.message };
      return { available: false, error: err.message };
    }
  }

  async syncOpenRouterModels() {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      this._discoveryStatus.openrouter = { timestamp: Date.now(), success: false, error: 'no API key' };
      return { available: false };
    }

    try {
      const resp = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        this._discoveryStatus.openrouter = { timestamp: Date.now(), success: false, error: `HTTP ${resp.status}` };
        return { available: false, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();

      // Filter to free models only
      const freeModels = (data.data || []).filter(m => {
        const price = parseFloat(m.pricing?.prompt || '1');
        return price === 0;
      });

      const orProvider = this._registry.get('openrouter');
      if (orProvider) {
        orProvider.available = true;
        orProvider.models = freeModels.slice(0, 20).map(m => ({
          name: m.id,
          displayName: m.name || m.id,
          capabilities: this._inferOpenRouterCapabilities(m),
          contextLength: m.context_length || 128000,
          maxOutput: m.max_completion_tokens || 4096,
          multimodal: (m.architecture?.modality || '').includes('image'),
          installed: true,
          available: true,
        }));
      }

      this._discoveryStatus.openrouter = { timestamp: Date.now(), success: true, modelsFound: freeModels.length };
      return { available: true, modelsFound: freeModels.length };
    } catch (err) {
      this._discoveryStatus.openrouter = { timestamp: Date.now(), success: false, error: err.message };
      return { available: false, error: err.message };
    }
  }

  // ─── Inference Helpers ──────────────────────────────────────────────────

  _inferOllamaCapabilities(name) {
    const lower = name.toLowerCase();
    const hasVision = /\b(vision|llava|bakllava|moondream|multimodal|qwen.*vl|gemma.*vision)\b/.test(lower);
    const hasAudio = /\b(whisper|audio)\b/.test(lower);
    const hasTools = /\b(llama|mistral|qwen|gemma|phi|deepseek|command)\b/.test(lower) && !hasVision;
    const hasCode = /\b(codellama|code|deepseek.*coder|starcoder)\b/.test(lower);
    const hasReasoning = /\b(deepseek-r1|qwq|phi4|o3)\b/.test(lower);

    return {
      vision: hasVision,
      audio: hasAudio,
      tools: hasTools || !hasVision,
      streaming: true,
      pdf: false,
      code: hasCode || (!hasVision && !hasAudio),
      reasoning: hasReasoning,
    };
  }

  _inferOpenRouterCapabilities(modelData) {
    const modality = (modelData.architecture?.modality || '').toLowerCase();
    const name = (modelData.name || '').toLowerCase();
    return {
      vision: modality.includes('image') || /\b(vision|vl)\b/.test(name),
      audio: modality.includes('audio'),
      tools: modelData.supported_parameters?.includes('tools') || false,
      streaming: true,
      pdf: modality.includes('image'),
      code: /\b(code|coder|codellama)\b/.test(name),
      reasoning: /\b(r1|qwq|o3|reason)\b/.test(name),
    };
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────

  getDiscoveryStatus() {
    return this._discoveryStatus;
  }

  /**
   * Get full diagnostic view of all models.
   */
  getDiagnostics() {
    const rows = [];
    for (const [providerName, providerData] of this._registry) {
      const keyEnv = providerData.requiresKey;
      const keySet = keyEnv ? !!process.env[keyEnv] : true;
      const discovery = this._discoveryStatus[providerName];

      for (const model of providerData.models) {
        rows.push({
          provider: providerName,
          model: model.name,
          displayName: model.displayName,
          priority: providerData.priority,
          priorityLabel: providerData.priority === PRIORITY.FREE ? 'FREE' : providerData.priority === PRIORITY.OPTIONAL ? 'OPTIONAL' : 'PAID',
          available: model.available && providerData.available,
          installed: model.installed !== false,
          vision: model.capabilities?.vision || false,
          audio: model.capabilities?.audio || false,
          tools: model.capabilities?.tools || false,
          code: model.capabilities?.code || false,
          reasoning: model.capabilities?.reasoning || false,
          streaming: model.capabilities?.streaming || false,
          pdf: model.capabilities?.pdf || false,
          contextLength: model.contextLength,
          speedEstimate: providerData.speedEstimate,
          costPerMillionTokens: providerData.costPerMillionTokens,
          isLocal: providerData.isLocal,
          keyStatus: keyEnv ? (keySet ? 'set' : 'missing') : 'n/a',
          discoveryStatus: discovery?.success ? 'ok' : discovery?.error || 'not yet',
        });
      }
    }
    return rows;
  }

  // ─── Legacy Compatibility ───────────────────────────────────────────────

  toLegacyFormat() {
    const result = {};
    for (const [providerName, providerData] of this._registry) {
      result[providerName] = {
        name: providerName,
        models: providerData.models.map(m => ({
          name: m.name,
          capabilities: m.capabilities,
          contextLength: m.contextLength,
        })),
      };
    }
    return result;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;

function getModelRegistry() {
  if (!_instance) {
    _instance = new ModelRegistry();
  }
  return _instance;
}

module.exports = { ModelRegistry, MODEL_SEED, PROVIDER_META, PRIORITY, getModelRegistry };
