'use strict';

/**
 * E2E Tests — Image Pipeline Flow
 *
 * Tests the full image flow with mocked providers to prove:
 * 1. The model receives the image
 * 2. The model generates a description
 * 3. Paprika delivers that description to the user
 * 4. No information is lost between provider and frontend
 * 5. No unnecessary model calls are made
 *
 * Run: node --test providers/__tests__/e2e-image.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ProviderManager } = require('../providerManager');
const { ExecutionPlanner } = require('../executionPlanner');
const { HealthManager } = require('../healthManager');

// ─── Mock ModelRegistry ─────────────────────────────────────────────────────

function createMockModelRegistry() {
  const providers = new Map([
    ['ollama', {
      provider: 'ollama', displayName: 'Ollama', priority: 1, requiresKey: false, isLocal: true,
      costPerMillionTokens: 0, speedEstimate: 30, available: true,
      models: [
        { name: 'llama3.2', displayName: 'Llama 3.2', capabilities: { vision: false, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: false, available: true, installed: true },
        { name: 'llama3.2-vision', displayName: 'Llama 3.2 Vision', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: false, reasoning: false }, contextLength: 131072, maxOutput: 4096, multimodal: true, available: true, installed: true },
      ],
    }],
    ['gemini', {
      provider: 'gemini', displayName: 'Google Gemini', priority: 1, requiresKey: 'GEMINI_API_KEY', isLocal: false,
      costPerMillionTokens: 0, speedEstimate: 150, available: true,
      models: [
        { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', capabilities: { vision: true, audio: true, tools: true, streaming: true, pdf: true, code: true, reasoning: false }, contextLength: 1048576, maxOutput: 8192, multimodal: true, available: true },
      ],
    }],
    ['openai', {
      provider: 'openai', displayName: 'OpenAI', priority: 3, requiresKey: 'OPENAI_API_KEY', isLocal: false,
      costPerMillionTokens: 2.5, speedEstimate: 100, available: true,
      models: [
        { name: 'gpt-4o', displayName: 'GPT-4o', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 4096, multimodal: true, available: true },
        { name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', capabilities: { vision: true, audio: false, tools: true, streaming: true, pdf: false, code: true, reasoning: false }, contextLength: 128000, maxOutput: 4096, multimodal: true, available: true },
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
  };
}

// ─── Mock Provider Instance ──────────────────────────────────────────────

function createMockProvider(name, responseText) {
  const calls = [];
  return {
    name,
    calls,
    chat: async (messages, onChunk, options = {}) => {
      calls.push({ messages, options, timestamp: Date.now() });
      if (onChunk) onChunk(`chunk from ${name}`, 'text');
      return typeof responseText === 'function' ? responseText(messages) : responseText;
    },
  };
}

function createTestImageBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('E2E: Image Pipeline', () => {
  let geminiProvider;
  let ollamaProvider;
  let openaiProvider;
  let providers;
  let pm;
  let cm;
  let planner;
  let mockRegistry;

  beforeEach(() => {
    mockRegistry = createMockModelRegistry();
    cm = createMockCapabilityManager(mockRegistry);
    geminiProvider = createMockProvider('gemini', 'Veo un perro labrador acostado sobre un sofá gris. El perro parece relajado y tiene el hocico marrón.');
    ollamaProvider = createMockProvider('ollama', 'No puedo ver imágenes con este modelo.');
    openaiProvider = createMockProvider('openai', 'Veo una imagen con un paisaje urbano.');

    providers = new Map([
      ['gemini', geminiProvider],
      ['ollama', ollamaProvider],
      ['openai', openaiProvider],
    ]);

    pm = new ProviderManager({
      providers,
      defaultTimeout: 30000,
      healthManager: new HealthManager(),
      modelRegistry: mockRegistry,
    });

    planner = new ExecutionPlanner({
      capabilityManager: cm,
      modelRegistry: mockRegistry,
      defaultTimeout: 30000,
    });
  });

  // ─── CASO 1: Texto puro ──────────────────────────────────────────────
  it('Caso 1: Texto puro — responde correctamente', async () => {
    const plan = planner.plan(
      {},
      { provider: 'ollama', model: 'llama3.2', switched: false, reason: 'text only' }
    );

    const messages = [
      { role: 'system', content: 'Sos Paprika, una IA argentina.' },
      { role: 'user', content: '¿Qué es Node.js?' },
    ];

    const result = await pm.execute(plan, messages);

    assert.ok(result.response.length > 0, 'Should have response');
    assert.equal(result.normalized.hasContent, true, 'Normalized response should have content');
    assert.equal(result.metadata.provider, 'ollama', 'Should use ollama for text');
  });

  // ─── CASO 2: Imagen pura ─────────────────────────────────────────────
  it('Caso 2: Imagen pura — el modelo describe la imagen', async () => {
    geminiProvider.chat = async (messages, onChunk, options = {}) => {
      geminiProvider.calls.push({ messages, options });

      const userMsg = messages.find(m => m.role === 'user' && Array.isArray(m.content));
      assert.ok(userMsg, 'Should have a user message with array content');

      const imagePart = userMsg.content.find(p => p.type === 'image_url');
      assert.ok(imagePart, 'Should have image_url part');
      assert.ok(imagePart.image_url.url.startsWith('data:image/'), 'Image URL should be base64 data URI');
      assert.ok(imagePart.image_url.url.length > 100, 'Image data should be substantial');

      if (onChunk) onChunk('Veo un perro labrador', 'text');
      return 'Veo un perro labrador acostado sobre un sofá gris. El perro parece relajado y tiene el hocico marrón.';
    };

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'image detected' }
    );

    const imageBase64 = createTestImageBase64();
    const messages = [
      { role: 'system', content: 'Sos Paprika, una IA argentina con capacidades de visión.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '¿Qué ves en esta imagen?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ];

    const result = await pm.execute(plan, messages);

    assert.equal(geminiProvider.calls.length, 1, 'Gemini should be called exactly once');
    const call = geminiProvider.calls[0];
    const userMsg = call.messages.find(m => m.role === 'user' && Array.isArray(m.content));
    assert.ok(userMsg, 'User message with image should be sent to provider');

    assert.ok(result.response.includes('labrador'), 'Response should contain image description');
    assert.ok(result.response.includes('sofá'), 'Response should describe what the model sees');
    assert.equal(result.metadata.provider, 'gemini', 'Should use gemini (vision-capable)');
    assert.equal(result.metadata.fallbackUsed, false, 'Should NOT use fallback');
    assert.equal(result.normalized.hasContent, true, 'Normalized response should have content');
  });

  // ─── CASO 3: Imagen + pregunta ───────────────────────────────────────
  it('Caso 3: Imagen + pregunta — responde describiendo la imagen', async () => {
    geminiProvider.chat = async (messages, onChunk, options = {}) => {
      geminiProvider.calls.push({ messages, options });
      if (onChunk) onChunk('Veo un gato naranja', 'text');
      return 'En la imagen se ve un gato naranja acostado en una ventana con sol.';
    };

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'image detected' }
    );

    const imageBase64 = createTestImageBase64();
    const messages = [
      { role: 'system', content: 'Sos Paprika.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '¿Qué es esta imagen?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ];

    const result = await pm.execute(plan, messages);

    assert.ok(result.response.length > 0, 'Should have response');
    assert.equal(result.metadata.provider, 'gemini', 'Should use gemini for vision');
    assert.equal(geminiProvider.calls.length, 1, 'Should call gemini exactly once');
    assert.ok(result.response.includes('gato'), 'Response should mention the cat');
  });

  // ─── CASO 4: Gemini 429 → fallback a OpenAI ──────────────────
  it('Caso 4: Gemini 429 → fallback a OpenAI (vision-capable)', async () => {
    geminiProvider.chat = async () => {
      geminiProvider.calls.push({});
      const err = new Error('429 Quota exceeded');
      err.status = 429;
      throw err;
    };

    ollamaProvider.chat = async () => {
      ollamaProvider.calls.push({});
      throw new Error('Ollama vision not available');
    };

    openaiProvider.chat = async (messages, onChunk, options = {}) => {
      openaiProvider.calls.push({ messages, options });
      const userMsg = messages.find(m => m.role === 'user' && Array.isArray(m.content));
      assert.ok(userMsg, 'OpenAI should receive user message with array content');
      const imagePart = userMsg.content.find(p => p.type === 'image_url');
      assert.ok(imagePart, 'OpenAI should receive image_url part');
      if (onChunk) onChunk('Veo una imagen', 'text');
      return 'En la imagen se ve un paisaje montañoso con nieve.';
    };

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'vision needed' }
    );

    assert.equal(plan.provider, 'gemini', 'Primary should be gemini');
    assert.ok(plan.fallbackChain.some(f => f.provider === 'openai'), 'OpenAI should be in fallback');

    const messages = [
      { role: 'user', content: [
        { type: 'text', text: '¿Qué ves?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ]},
    ];

    const result = await pm.execute(plan, messages);

    assert.equal(geminiProvider.calls.length, 1, 'Gemini tried once');
    assert.equal(ollamaProvider.calls.length, 1, 'Ollama tried once and failed');
    assert.equal(openaiProvider.calls.length, 1, 'OpenAI tried once as fallback');
    assert.equal(result.metadata.provider, 'openai', 'Used OpenAI as fallback');
    assert.equal(result.metadata.fallbackUsed, true, 'Fallback was used');
  });

  // ─── CASO 5: Todos los providers fallan ──────────────────────────────
  it('Caso 5: Todos los providers fallan — error claro', async () => {
    geminiProvider.chat = async () => { geminiProvider.calls.push({}); throw new Error('Gemini fail'); };
    openaiProvider.chat = async () => { openaiProvider.calls.push({}); throw new Error('OpenAI fail'); };
    ollamaProvider.chat = async () => { ollamaProvider.calls.push({}); throw new Error('Ollama fail'); };

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'vision' }
    );

    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]}];

    await assert.rejects(
      () => pm.execute(plan, messages),
      /Todos los proveedores del plan fallaron/
    );

    assert.equal(geminiProvider.calls.length, 1, 'Gemini was tried');
    assert.equal(openaiProvider.calls.length, 1, 'OpenAI was tried');
    assert.equal(ollamaProvider.calls.length, 1, 'Ollama was tried');
  });

  // ─── CASO 6: HealthManager degrada provider ──────────────────────────
  it('Caso 6: HealthManager degrada provider — no reintenta inmediatamente', async () => {
    const health = new HealthManager();

    pm = new ProviderManager({
      providers,
      defaultTimeout: 30000,
      healthManager: health,
      modelRegistry: mockRegistry,
    });

    // Record failures to degrade gemini
    for (let i = 0; i < 5; i++) {
      health.recordFailure('gemini', new Error('quota'));
    }

    assert.equal(health.isAvailable('gemini'), false, 'Gemini should be degraded');

    ollamaProvider.chat = async (messages, onChunk) => {
      ollamaProvider.calls.push({});
      if (onChunk) onChunk('Respuesta', 'text');
      return 'Respuesta de ollama';
    };

    const plan = planner.plan(
      { vision: true },
      { provider: 'gemini', model: 'gemini-2.0-flash', switched: true, reason: 'vision' }
    );

    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Hola' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]}];

    const result = await pm.execute(plan, messages);

    assert.equal(geminiProvider.calls.length, 0, 'Gemini should be skipped (degraded)');
    assert.equal(ollamaProvider.calls.length, 1, 'Ollama should handle the request');
    assert.equal(result.metadata.provider, 'ollama');
  });

  // ─── CASO 7: ResponseNormalizer ───────────────────────────────────────
  it('Caso 7: ResponseNormalizer unifica respuestas de todos los providers', async () => {
    const { ResponseNormalizer } = require('../responseNormalizer');

    // Test with string response
    const r1 = ResponseNormalizer.normalize('Hello world', { provider: 'ollama', model: 'llama3.2' });
    assert.equal(r1.text, 'Hello world');
    assert.equal(r1.provider, 'ollama');
    assert.equal(r1.hasContent, true);

    // Test with object response
    const r2 = ResponseNormalizer.normalize({ text: 'Hi', usage: { promptTokens: 10 } }, { provider: 'gemini' });
    assert.equal(r2.text, 'Hi');
    assert.equal(r2.provider, 'gemini');

    // Test with null
    const r3 = ResponseNormalizer.normalize(null, { provider: 'groq' });
    assert.equal(r3.hasContent, false);

    // Validate good response
    const v1 = ResponseNormalizer.validate(r1);
    assert.equal(v1.valid, true);

    // Validate empty response
    const v2 = ResponseNormalizer.validate(r3);
    assert.equal(v2.valid, false);
  });

  // ─── CASO 8: ModelRegistry define capacidades una sola vez ───────────
  it('Caso 8: ModelRegistry define capacidades una sola vez', () => {
    const registry = createMockModelRegistry();

    const gemini = registry.getModel('gemini', 'gemini-2.0-flash');
    assert.ok(gemini, 'gemini-2.0-flash should exist');
    assert.equal(gemini.capabilities.vision, true, 'gemini-2.0-flash should have vision');
    assert.equal(gemini.capabilities.audio, true, 'gemini-2.0-flash should have audio');

    const ollamaLlama = registry.getModel('ollama', 'llama3.2');
    assert.ok(ollamaLlama, 'llama3.2 should exist');
    assert.equal(ollamaLlama.capabilities.vision, false, 'llama3.2 should NOT have vision');

    const ollamaVision = registry.getModel('ollama', 'llama3.2-vision');
    assert.ok(ollamaVision, 'llama3.2-vision should exist');
    assert.equal(ollamaVision.capabilities.vision, true, 'llama3.2-vision should have vision');

    const gpt4o = registry.getModel('openai', 'gpt-4o');
    assert.ok(gpt4o, 'gpt-4o should exist');
    assert.equal(gpt4o.capabilities.vision, true, 'gpt-4o should have vision');
    assert.equal(gpt4o.capabilities.tools, true, 'gpt-4o should have tools');

    const gpt4oMini = registry.getModel('openai', 'gpt-4o-mini');
    assert.ok(gpt4oMini, 'gpt-4o-mini should exist');
    assert.equal(gpt4oMini.capabilities.vision, true, 'gpt-4o-mini should have vision');

    // Find by capabilities
    const visionModels = registry.findModelsByCapabilities({ vision: true });
    assert.ok(visionModels.length >= 3, 'Should find at least 3 vision models');
    assert.ok(visionModels.some(m => m.provider === 'gemini'), 'Gemini should be in vision models');
    assert.ok(visionModels.some(m => m.provider === 'ollama'), 'Ollama vision should be in vision models');
    assert.ok(visionModels.some(m => m.provider === 'openai'), 'OpenAI should be in vision models');
  });

  // ─── CASO 9: OpenAI como proveedor primario de visión ────────────────
  it('Caso 9: OpenAI como proveedor primario de visión — responde correctamente', async () => {
    openaiProvider.chat = async (messages, onChunk, options = {}) => {
      openaiProvider.calls.push({ messages, options });
      const userMsg = messages.find(m => m.role === 'user' && Array.isArray(m.content));
      assert.ok(userMsg, 'Should have a user message with array content');
      const imagePart = userMsg.content.find(p => p.type === 'image_url');
      assert.ok(imagePart, 'Should have image_url part');
      assert.ok(imagePart.image_url.url.startsWith('data:image/'), 'Image URL should be base64 data URI');
      if (onChunk) onChunk('Veo una imagen', 'text');
      return 'En la imagen se ve un gato naranja acostado en una ventana con sol.';
    };

    const plan = planner.plan(
      { vision: true },
      { provider: 'openai', model: 'gpt-4o', switched: true, reason: 'openai selected' }
    );

    const imageBase64 = createTestImageBase64();
    const messages = [
      { role: 'system', content: 'Sos Paprika, una IA argentina con capacidades de visión.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '¿Qué ves en esta imagen?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ];

    const result = await pm.execute(plan, messages);

    assert.equal(openaiProvider.calls.length, 1, 'OpenAI should be called exactly once');
    const call = openaiProvider.calls[0];
    const userMsg = call.messages.find(m => m.role === 'user' && Array.isArray(m.content));
    assert.ok(userMsg, 'User message with image should be sent to OpenAI');

    assert.ok(result.response.includes('gato'), 'Response should contain image description');
    assert.equal(result.metadata.provider, 'openai', 'Should use openai (vision-capable)');
    assert.equal(result.metadata.fallbackUsed, false, 'Should NOT use fallback');
    assert.equal(result.normalized.hasContent, true, 'Normalized response should have content');
  });
});
