'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Mock ModelRegistry ─────────────────────────────────────────────────────

function createMockModelRegistry() {
  const providers = new Map([
    ['ollama', {
      provider: 'ollama', displayName: 'Ollama', priority: 1, requiresKey: false, isLocal: true,
      costPerMillionTokens: 0, speedEstimate: 30, available: true,
      models: [
        { name: 'llama3.2', displayName: 'Llama 3.2', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: false, available: true, installed: true },
        { name: 'llama3.2-vision', displayName: 'Llama 3.2 Vision', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: true, available: true, installed: true },
        { name: 'llava', displayName: 'LLaVA', capabilities: { vision: true, audio: false, tools: false, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 4096, maxOutput: 2048, multimodal: true, available: true, installed: true },
      ],
    }],
    ['gemini', {
      provider: 'gemini', displayName: 'Google Gemini', priority: 1, requiresKey: 'GEMINI_API_KEY', isLocal: false,
      costPerMillionTokens: 0, speedEstimate: 150, available: true,
      models: [
        { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true, available: true },
        { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true, available: true },
      ],
    }],
    ['groq', {
      provider: 'groq', displayName: 'Groq', priority: 1, requiresKey: 'GROQ_API_KEY', isLocal: false,
      costPerMillionTokens: 0, speedEstimate: 200, available: true,
      models: [
        { name: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 32768, multimodal: false, available: true },
        { name: 'whisper-large-v3', displayName: 'Whisper Large V3', capabilities: { vision: false, audio: true, tools: false, streaming: false, pdf: false, code: false, reasoning: false }, contextLength: 0, maxOutput: 0, multimodal: false, available: true },
      ],
    }],
    ['openai', {
      provider: 'openai', displayName: 'OpenAI', priority: 3, requiresKey: 'OPENAI_API_KEY', isLocal: false,
      costPerMillionTokens: 2.5, speedEstimate: 120, available: true,
      models: [
        { name: 'gpt-4o', displayName: 'GPT-4o', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 16384, multimodal: true, available: true },
        { name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 16384, multimodal: true, available: true },
      ],
    }],
  ]);

  return {
    _registry: providers,
    getAllProviders() { return Array.from(providers.values()); },
    getProvider(name) { return providers.get(name) || null; },
    getModels(providerName) { const p = providers.get(providerName); return p ? p.models : []; },
    getModel(providerName, modelName) { const m = this.getModels(providerName); return m.find(x => x.name === modelName) || null; },
    getModelCapabilities(providerName, modelName) { const m = this.getModel(providerName, modelName); return m ? m.capabilities : null; },
    findModelsByCapabilities(requiredCapabilities, options = {}) {
      const requiredKeys = Object.entries(requiredCapabilities).filter(([, v]) => v === true).map(([k]) => k);
      const candidates = [];
      for (const [providerName, providerData] of providers) {
        if (!providerData.available) continue;
        if (options.healthManager && !options.healthManager.isAvailable(providerName)) continue;
        for (const model of providerData.models) {
          if (!model.available) continue;
          const caps = model.capabilities || {};
          const hasAll = requiredKeys.every(k => caps[k] === true);
          if (hasAll) {
            candidates.push({
              provider: providerName, model: model.name, displayName: model.displayName,
              capabilities: caps, priority: providerData.priority,
              costPerMillionTokens: providerData.costPerMillionTokens,
              speedEstimate: providerData.speedEstimate,
              contextLength: model.contextLength, multimodal: model.multimodal,
              isLocal: providerData.isLocal,
            });
          }
        }
      }
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.speedEstimate !== b.speedEstimate) return b.speedEstimate - a.speedEstimate;
        if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1;
        return 0;
      });
      return candidates;
    },
    selectBest(requiredCapabilities, options = {}) {
      const c = this.findModelsByCapabilities(requiredCapabilities, options);
      if (c.length === 0) return null;
      const best = c[0];
      return { provider: best.provider, model: best.model, displayName: best.displayName, priority: best.priority, costPerMillionTokens: best.costPerMillionTokens, reason: `Best: ${best.displayName}` };
    },
  };
}

// ─── Mock CapabilityManager ──────────────────────────────────────────────

function createMockCapabilityManager(registry) {
  const providers = new Map();
  for (const pd of registry.getAllProviders()) {
    providers.set(pd.provider, {
      name: pd.provider,
      models: pd.models.map(m => ({ name: m.name, capabilities: m.capabilities, contextLength: m.contextLength })),
    });
  }

  return {
    _providers: providers,
    getProvider(name) { return providers.get(name) || null; },
    getAllModels() {
      const all = [];
      for (const [, provider] of providers) {
        for (const model of provider.models) {
          all.push({ provider: provider.name, name: model.name, capabilities: model.capabilities });
        }
      }
      return all;
    },
    getProvidersForCapabilities(requiredCapabilities) {
      const requiredKeys = Object.entries(requiredCapabilities).filter(([, v]) => v === true).map(([k]) => k);
      if (requiredKeys.length === 0) {
        return this.getAllModels().map(m => ({ provider: m.provider, model: m.name, capabilities: m.capabilities }));
      }
      const candidates = [];
      for (const model of this.getAllModels()) {
        const caps = model.capabilities || {};
        const hasAll = requiredKeys.every(k => caps[k] === true);
        if (hasAll) candidates.push({ provider: model.provider, model: model.name, capabilities: caps });
      }
      candidates.sort((a, b) => {
        const aCloud = a.provider !== 'ollama' ? 0 : 1;
        const bCloud = b.provider !== 'ollama' ? 0 : 1;
        return aCloud - bCloud;
      });
      return candidates;
    },
    findByCapability(capability) {
      return this.getAllModels().filter(m => m.capabilities && m.capabilities[capability]);
    },
    modelSupports(providerName, modelName, capability) {
      const provider = providers.get(providerName);
      if (!provider) return false;
      const model = provider.models.find(m => m.name === modelName);
      if (!model) return false;
      return !!(model.capabilities && model.capabilities[capability]);
    },
    listProviders() { return Array.from(providers.keys()); },
  };
}

// ─── Mock Provider Instance ──────────────────────────────────────────────

function createMockProvider(name, responseText = `${name} response`) {
  const calls = [];
  return {
    name,
    calls,
    chat: async (messages, onChunk, options) => {
      calls.push({ messages, options });
      if (onChunk) onChunk(`chunk from ${name}`, 'text');
      return responseText;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CapabilityManager.getProvidersForCapabilities()
// ═══════════════════════════════════════════════════════════════════════════

describe('CapabilityManager.getProvidersForCapabilities()', () => {
  let cm;

  beforeEach(() => {
    const registry = createMockModelRegistry();
    cm = createMockCapabilityManager(registry);
  });

  it('returns all models when no capabilities required', () => {
    const result = cm.getProvidersForCapabilities({});
    assert.ok(result.length > 0);
    assert.equal(result.length, 9); // 3 ollama + 2 gemini + 2 groq + 2 openai
  });

  it('filters to vision-capable models only', () => {
    const result = cm.getProvidersForCapabilities({ vision: true });
    const names = result.map(r => `${r.provider}/${r.model}`);

    assert.ok(names.includes('gemini/gemini-2.0-flash'), 'gemini-2.0-flash should be included');
    assert.ok(names.includes('gemini/gemini-1.5-flash'), 'gemini-1.5-flash should be included');
    assert.ok(names.includes('ollama/llama3.2-vision'), 'llama3.2-vision should be included');
    assert.ok(names.includes('ollama/llava'), 'llava should be included');
    assert.ok(names.includes('openai/gpt-4o'), 'gpt-4o should be included');
    assert.ok(names.includes('openai/gpt-4o-mini'), 'gpt-4o-mini should be included');

    assert.ok(!names.includes('ollama/llama3.2'), 'llama3.2 should NOT be included');
    assert.ok(!names.includes('groq/llama-3.3-70b-versatile'), 'groq llama should NOT be included');
    assert.ok(!names.includes('groq/whisper-large-v3'), 'whisper should NOT be included');
  });

  it('filters to audio-capable models only', () => {
    const result = cm.getProvidersForCapabilities({ audio: true });
    const names = result.map(r => `${r.provider}/${r.model}`);

    assert.ok(names.includes('gemini/gemini-2.0-flash'));
    assert.ok(names.includes('gemini/gemini-1.5-flash'));
    assert.ok(names.includes('groq/whisper-large-v3'));
    assert.ok(names.includes('openai/gpt-4o'));

    assert.ok(!names.includes('ollama/llama3.2'));
    assert.ok(!names.includes('groq/llama-3.3-70b-versatile'));
  });

  it('filters to models with BOTH vision AND audio', () => {
    const result = cm.getProvidersForCapabilities({ vision: true, audio: true });
    const names = result.map(r => `${r.provider}/${r.model}`);

    assert.ok(names.includes('gemini/gemini-2.0-flash'));
    assert.ok(names.includes('gemini/gemini-1.5-flash'));
    assert.ok(names.includes('openai/gpt-4o'));

    assert.ok(!names.includes('ollama/llama3.2-vision'));
    assert.ok(!names.includes('ollama/llava'));
    assert.ok(!names.includes('openai/gpt-4o-mini'));
  });

  it('sorts cloud providers before local (ollama)', () => {
    const result = cm.getProvidersForCapabilities({ vision: true });
    const firstOllamaIdx = result.findIndex(r => r.provider === 'ollama');
    const lastCloudIdx = result.reduce((max, r, i) => r.provider !== 'ollama' ? i : max, -1);
    assert.ok(lastCloudIdx < firstOllamaIdx, 'cloud providers should come before ollama');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ExecutionPlanner
// ═══════════════════════════════════════════════════════════════════════════

describe('ExecutionPlanner', () => {
  let cm;
  let mockRegistry;
  let planner;

  beforeEach(() => {
    mockRegistry = createMockModelRegistry();
    cm = createMockCapabilityManager(mockRegistry);
    const { ExecutionPlanner } = require('../executionPlanner');
    planner = new ExecutionPlanner({ capabilityManager: cm, modelRegistry: mockRegistry });
  });

  it('builds a plan with primary + fallback chain for vision', () => {
    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'image detected' }
    );

    assert.equal(plan.provider, 'gemini');
    assert.equal(plan.model, 'gemini-2.0-flash');
    assert.ok(plan.fallbackChain.length > 0, 'should have fallback providers');

    const fallbackNames = plan.fallbackChain.map(f => `${f.provider}/${f.model}`);
    assert.ok(!fallbackNames.includes('ollama/llama3.2'), 'llama3.2 should NOT be in fallback');
    assert.ok(!fallbackNames.includes('groq/llama-3.3-70b-versatile'), 'groq llama should NOT be in fallback');
  });

  it('includes discards in metadata', () => {
    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'image' }
    );

    assert.ok(plan.metadata.discards.length > 0, 'should have discards');
    const discardedNames = plan.metadata.discards.map(d => d.provider);
    assert.ok(discardedNames.includes('groq'), 'groq should be discarded for vision');
  });

  it('handles no-compatible-providers gracefully', () => {
    const plan = planner.plan(
      { vision: true, audio: true, tools: true, code: true },
      { provider: 'ollama', model: 'llama3.2', switched: false, reason: 'none' }
    );

    assert.ok(plan.provider, 'plan should have a provider');
    assert.ok(plan.model, 'plan should have a model');
  });

  it('uses selected model when it is compatible', () => {
    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'vision' }
    );

    assert.equal(plan.provider, 'gemini');
    assert.equal(plan.model, 'gemini-2.0-flash');
  });

  it('picks first compatible model when selected model is not compatible', () => {
    const plan = planner.plan(
      { vision: true },
      { provider: 'ollama', model: 'llama3.2', switched: false, reason: 'none' }
    );

    // llama3.2 has no vision, so planner picks first compatible
    assert.notEqual(plan.provider, 'ollama', 'should not pick ollama/llama3.2 for vision');
    assert.ok(plan.fallbackChain.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ProviderManager
// ═══════════════════════════════════════════════════════════════════════════

describe('ProviderManager', () => {
  let providers;
  let pm;
  let geminiProvider;
  let ollamaProvider;
  let openaiProvider;

  beforeEach(() => {
    geminiProvider = createMockProvider('gemini', 'gemini says hi');
    ollamaProvider = createMockProvider('ollama', 'ollama says hi');
    openaiProvider = createMockProvider('openai', 'openai says hi');

    providers = new Map([
      ['gemini', geminiProvider],
      ['ollama', ollamaProvider],
      ['openai', openaiProvider],
    ]);

    const { ProviderManager } = require('../providerManager');
    const { HealthManager } = require('../healthManager');
    const mockRegistry = createMockModelRegistry();
    pm = new ProviderManager({ providers, defaultTimeout: 30000, healthManager: new HealthManager(), modelRegistry: mockRegistry });
  });

  it('uses primary provider when it succeeds', async () => {
    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: { vision: true },
      fallbackChain: [{ provider: 'ollama', model: 'llama3.2' }],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.response, 'gemini says hi');
    assert.equal(result.metadata.provider, 'gemini');
    assert.equal(result.metadata.fallbackUsed, false);
    assert.equal(geminiProvider.calls.length, 1);
    assert.equal(ollamaProvider.calls.length, 0, 'ollama should NOT be called');
  });

  it('falls back to second provider when primary fails', async () => {
    geminiProvider.chat = async () => { throw new Error('Gemini quota exhausted'); };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: {},
      fallbackChain: [{ provider: 'ollama', model: 'llama3.2' }],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.response, 'ollama says hi');
    assert.equal(result.metadata.provider, 'ollama');
    assert.equal(result.metadata.fallbackUsed, true);
    assert.equal(ollamaProvider.calls.length, 1);
  });

  it('skips providers not in fallback chain', async () => {
    const groqProvider = createMockProvider('groq', 'groq says hi');
    providers.set('groq', groqProvider);

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: { vision: true },
      fallbackChain: [],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    geminiProvider.chat = async () => { throw new Error('fail'); };

    await assert.rejects(
      () => pm.execute(plan, [{ role: 'user', content: 'hello' }]),
      /Todos los proveedores del plan fallaron/
    );

    assert.equal(groqProvider.calls.length, 0, 'groq should NEVER be called (not in fallback chain)');
  });

  it('throws when all providers in chain fail', async () => {
    geminiProvider.chat = async () => { throw new Error('gemini fail'); };
    ollamaProvider.chat = async () => { throw new Error('ollama fail'); };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: {},
      fallbackChain: [{ provider: 'ollama', model: 'llama3.2' }],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    await assert.rejects(
      () => pm.execute(plan, [{ role: 'user', content: 'hello' }]),
      /Todos los proveedores del plan fallaron/
    );
  });

  it('reports fallbackUsed=true when primary fails and fallback succeeds', async () => {
    geminiProvider.chat = async () => { throw new Error('fail'); };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: {},
      fallbackChain: [{ provider: 'ollama', model: 'llama3.2' }],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.metadata.fallbackUsed, true);
    assert.equal(result.metadata.attempts, 2);
    assert.equal(result.metadata.totalAttempts, 2);
    assert.ok(result.normalized, 'should have normalized response');
    assert.ok(typeof result.response === 'string', 'response should be string');
  });

  it('falls back to OpenAI when Gemini fails (429)', async () => {
    geminiProvider.chat = async () => {
      geminiProvider.calls.push({});
      const err = new Error('429 Quota exceeded');
      err.status = 429;
      throw err;
    };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: {},
      fallbackChain: [
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'ollama', model: 'llama3.2' },
      ],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.response, 'openai says hi');
    assert.equal(result.metadata.provider, 'openai');
    assert.equal(result.metadata.fallbackUsed, true);
    assert.equal(geminiProvider.calls.length, 1);
    assert.equal(openaiProvider.calls.length, 1);
    assert.equal(ollamaProvider.calls.length, 0, 'ollama should NOT be called');
  });

  it('falls back to Ollama when OpenAI fails', async () => {
    geminiProvider.chat = async () => { geminiProvider.calls.push({}); throw new Error('Gemini fail'); };
    openaiProvider.chat = async () => { openaiProvider.calls.push({}); throw new Error('OpenAI fail'); };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      requirements: {},
      fallbackChain: [
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'ollama', model: 'llama3.2' },
      ],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.response, 'ollama says hi');
    assert.equal(result.metadata.provider, 'ollama');
    assert.equal(result.metadata.fallbackUsed, true);
    assert.equal(geminiProvider.calls.length, 1);
    assert.equal(openaiProvider.calls.length, 1);
    assert.equal(ollamaProvider.calls.length, 1);
  });

  it('uses OpenAI directly when selected as primary', async () => {
    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'openai',
      model: 'gpt-4o-mini',
      requirements: {},
      fallbackChain: [
        { provider: 'gemini', model: 'gemini-2.0-flash' },
        { provider: 'ollama', model: 'llama3.2' },
      ],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const result = await pm.execute(plan, [{ role: 'user', content: 'hello' }]);

    assert.equal(result.response, 'openai says hi');
    assert.equal(result.metadata.provider, 'openai');
    assert.equal(result.metadata.fallbackUsed, false);
    assert.equal(openaiProvider.calls.length, 1);
    assert.equal(geminiProvider.calls.length, 0);
    assert.equal(ollamaProvider.calls.length, 0);
  });

  it('OpenAI receives multimodal messages correctly', async () => {
    let receivedMessages = null;
    openaiProvider.chat = async (messages, onChunk, options) => {
      receivedMessages = messages;
      openaiProvider.calls.push({ messages, options });
      return 'Veo una imagen';
    };

    const { ExecutionPlan } = require('../executionPlanner');
    const plan = new ExecutionPlan({
      provider: 'openai',
      model: 'gpt-4o',
      requirements: { vision: true },
      fallbackChain: [],
      timeout: 30000,
      retries: 0,
      streaming: true,
      metadata: { reason: 'test' },
    });

    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const messages = [
      { role: 'system', content: 'Sos Paprika.' },
      { role: 'user', content: [
        { type: 'text', text: '¿Qué ves?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ]},
    ];

    const result = await pm.execute(plan, messages);

    assert.ok(receivedMessages, 'OpenAI should have received messages');
    const userMsg = receivedMessages.find(m => m.role === 'user' && Array.isArray(m.content));
    assert.ok(userMsg, 'Should have user message with array content');
    const imagePart = userMsg.content.find(p => p.type === 'image_url');
    assert.ok(imagePart, 'Should have image_url part');
    assert.ok(imagePart.image_url.url.startsWith('data:image/'), 'Image URL should be data URI');
    assert.equal(result.response, 'Veo una imagen');
    assert.equal(result.metadata.provider, 'openai');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: Capability filtering prevents wrong provider
// ═══════════════════════════════════════════════════════════════════════════

describe('Integration: images never sent to non-vision providers', () => {
  it('full flow: vision query → only vision providers in chain', () => {
    const mockRegistry = createMockModelRegistry();
    const cm = createMockCapabilityManager(mockRegistry);
    const { ExecutionPlanner } = require('../executionPlanner');
    const planner = new ExecutionPlanner({ capabilityManager: cm, modelRegistry: mockRegistry });

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'image attachment' }
    );

    assert.equal(plan.provider, 'gemini');

    const chainProviders = [plan.provider, ...plan.fallbackChain.map(f => f.provider)];
    for (const p of chainProviders) {
      const providerData = mockRegistry.getProvider(p);
      assert.ok(providerData, `provider ${p} should exist`);
      const hasVision = providerData.models.some(m => m.capabilities.vision);
      assert.ok(hasVision, `provider ${p} should have at least one vision model`);
    }

    const allModels = [
      { provider: plan.provider, model: plan.model },
      ...plan.fallbackChain,
    ];
    const hasLlama32 = allModels.some(m => m.provider === 'ollama' && m.model === 'llama3.2');
    assert.ok(!hasLlama32, 'ollama/llama3.2 (non-vision) should NEVER be in the chain');

    const hasGroq = allModels.some(m => m.provider === 'groq');
    assert.ok(!hasGroq, 'groq (no vision models) should NOT be in the chain');
  });

  it('full flow: text-only query → all providers available', () => {
    const mockRegistry = createMockModelRegistry();
    const cm = createMockCapabilityManager(mockRegistry);
    const { ExecutionPlanner } = require('../executionPlanner');
    const planner = new ExecutionPlanner({ capabilityManager: cm, modelRegistry: mockRegistry });

    const plan = planner.plan(
      {},
      { provider: 'ollama', model: 'llama3.2', switched: false, reason: 'text only' }
    );

    assert.ok(plan.metadata.compatibleCount > 0, 'should have compatible models');
  });
});
