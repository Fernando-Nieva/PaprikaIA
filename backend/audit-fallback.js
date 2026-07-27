'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK CHAIN AUDIT — ¿Quién generó la respuesta?
// ═══════════════════════════════════════════════════════════════════════════════
// Uso:  cd backend && node audit-fallback.js
// No modifica ningún archivo. Wrappea en memoria.
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const SEP  = '═'.repeat(80);
const SEP2 = '─'.repeat(80);

// ─── TRACE LOG ──────────────────────────────────────────────────────────────
const trace = [];
function log(entry) {
  trace.push(entry);
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`  [${ts}] ${entry.event.padEnd(22)} ${entry.provider || ''} / ${entry.model || ''}  ${entry.detail || ''}`);
}

// ─── WRAP PROVIDER CLASSES ──────────────────────────────────────────────────
function wrapProvider(providerInstance, providerName) {
  const originalChat = providerInstance.chat.bind(providerInstance);

  providerInstance.chat = async function wrappedChat(messages, onChunk, options = {}) {
    const modelName = options.modelOverride?.model || providerInstance.modelName;
    const attemptId = `${providerName}-${modelName}-${Date.now()}`;

    // Detectar si hay imágenes
    const hasImages = messages.some(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')
    );

    log({
      event: 'PROVIDER_ATTEMPT',
      provider: providerName,
      model: modelName,
      detail: `hasImages=${hasImages} msgs=${messages.length} attemptId=${attemptId}`
    });

    // Log de contenido multimodal
    if (hasImages) {
      messages.forEach((m, i) => {
        if (Array.isArray(m.content)) {
          m.content.forEach((p, j) => {
            if (p.type === 'image_url') {
              const url = p.image_url?.url || '';
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                log({
                  event: 'IMAGE_SENDING',
                  provider: providerName,
                  model: modelName,
                  detail: `msg[${i}] part[${j}]: mimeType=${match[1]} base64_len=${match[2].length}`
                });
              } else {
                log({
                  event: 'IMAGE_SENDING',
                  provider: providerName,
                  model: modelName,
                  detail: `msg[${i}] part[${j}]: URL format unknown prefix=${url.substring(0, 40)}`
                });
              }
            }
          });
        }
      });
    }

    const t0 = Date.now();
    try {
      const result = await originalChat(messages, onChunk, options);
      const elapsed = Date.now() - t0;

      // Log de la respuesta
      const preview = typeof result === 'string'
        ? result.substring(0, 200).replace(/\n/g, '↵')
        : String(result).substring(0, 200);

      log({
        event: 'PROVIDER_SUCCESS',
        provider: providerName,
        model: modelName,
        detail: `elapsed=${elapsed}ms response_len=${result?.length || 0} preview="${preview}"`
      });

      return result;
    } catch (err) {
      const elapsed = Date.now() - t0;
      const errMsg = err.message || String(err);
      const errPreview = errMsg.substring(0, 200).replace(/\n/g, '↵');

      log({
        event: 'PROVIDER_ERROR',
        provider: providerName,
        model: modelName,
        detail: `elapsed=${elapsed}ms error="${errPreview}"`
      });

      throw err;
    }
  };

  return providerInstance;
}

// ─── BUILD SYSTEM ───────────────────────────────────────────────────────────
function buildInstrumentedSystem() {
  // Cargar módulos
  const { getModelRegistry, PROVIDER_META } = require('./providers/modelRegistry');
  const { HealthManager, getHealthManager } = require('./providers/healthManager');
  const { ExecutionPlanner: _ExecutionPlanner } = require('./providers/executionPlanner');
  const { ProviderManager } = require('./providers/providerManager');
  const { ResponseNormalizer } = require('./providers/responseNormalizer');

  const registry = getModelRegistry();
  const health = getHealthManager();

  // Crear instancias de providers (sin wrappear aún)
  const providerClasses = {
    ollama: require('./providers/ollama'),
    gemini: require('./providers/gemini'),
    groq: require('./providers/groq'),
    openai: require('./providers/openai'),
  };

  const providers = new Map();

  for (const [name, meta] of Object.entries(PROVIDER_META)) {
    if (!meta.requiresKey || process.env[meta.requiresKey]) {
      try {
        const ProviderClass = providerClasses[name];
        if (!ProviderClass) continue;

        let instance;
        if (name === 'ollama') {
          const defaultModel = registry.getDefaultModel(name);
          instance = new ProviderClass(defaultModel?.name || 'llama3.2');
        } else {
          const defaultModel = registry.getDefaultModel(name);
          instance = new ProviderClass(process.env[meta.requiresKey], defaultModel?.name || '');
        }

        wrapProvider(instance, name);
        providers.set(name, instance);
        log({
          event: 'PROVIDER_REGISTERED',
          provider: name,
          model: registry.getDefaultModel(name)?.name || '?',
          detail: `available=true`
        });
      } catch (err) {
        log({
          event: 'PROVIDER_REGISTER_FAILED',
          provider: name,
          detail: err.message
        });
      }
    } else {
      log({
        event: 'PROVIDER_SKIPPED',
        provider: name,
        detail: `missing key: ${meta.requiresKey}`
      });
    }
  }

  const providerManager = new ProviderManager({ providers, healthManager: health, modelRegistry: registry });

  // Wrappear ProviderManager.execute para capturar el chain completo
  const originalExecute = providerManager.execute.bind(providerManager);
  providerManager.execute = async function wrappedExecute(plan, messages, onChunk, options = {}) {
    const chain = [];
    chain.push({ provider: plan.provider, model: plan.model, role: 'PRIMARY' });
    plan.fallbackChain.forEach(fb => chain.push({ provider: fb.provider, model: fb.model, role: 'FALLBACK' }));

    log({
      event: 'EXECUTE_START',
      detail: `chain=[${chain.map(c => `${c.role}:${c.provider}/${c.model}`).join(' → ')}]`
    });

    const result = await originalExecute(plan, messages, onChunk, options);

    log({
      event: 'EXECUTE_DONE',
      provider: result.metadata.provider,
      model: result.metadata.model,
      detail: `attempts=${result.metadata.attempts} fallback=${result.metadata.fallbackUsed} response_len=${result.response.length}`
    });

    return result;
  };

  return { providerManager, registry, health, ExecutionPlanner: _ExecutionPlanner };
}

// ─── TEST CASES ─────────────────────────────────────────────────────────────
async function runTest(providerManager, registry, ExecutionPlanner, label, messages, requirements = {}) {
  console.log(`\n${'#'.repeat(80)}`);
  console.log(`  TEST: ${label}`);
  console.log(`${'#'.repeat(80)}`);

  // Usar ExecutionPlanner para armar el plan
  const planner = new ExecutionPlanner({
    capabilityManager: null,
    modelRegistry: registry,
    healthManager: null,
    defaultTimeout: 30000,
  });

  // Simular modelSelection — gemini como primario
  const modelSelection = {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    reason: 'audit-test',
    switched: false,
  };

  const plan = planner.plan(requirements, modelSelection);

  console.log(`\n  Plan: ${plan.provider}/${plan.model}`);
  console.log(`  Fallback chain: ${plan.fallbackChain.map(f => `${f.provider}/${f.model}`).join(' → ')}`);
  console.log(`  Requirements: ${JSON.stringify(requirements)}`);

  try {
    const result = await providerManager.execute(plan, messages, (text, type) => {
      if (type === 'tool') process.stdout.write(`    ${text}`);
    }, { systemPrompt: 'Sos Paprika.' });

    console.log(`\n\n  ═══ RESULTADO FINAL ═══`);
    console.log(`  Provider:  ${result.metadata.provider}`);
    console.log(`  Model:     ${result.metadata.model}`);
    console.log(`  Fallback:  ${result.metadata.fallbackUsed}`);
    console.log(`  Attempts:  ${result.metadata.attempts}`);
    console.log(`  Response:  "${result.response.substring(0, 300)}"`);
    console.log(`  Len:       ${result.response.length} chars`);

    // VERIFICAR si la respuesta contiene la frase sospechosa
    const suspicious = [
      'modelo de lenguaje basado en texto',
      'archivos adjuntos',
      'contenido multimedia',
      'no puedo acceder',
    ];
    const matches = suspicious.filter(s => result.response.toLowerCase().includes(s));
    if (matches.length > 0) {
      console.log(`\n  ⚠️  FRASE SOSPECHOSA ENCONTRADA EN RESPUESTA:`);
      matches.forEach(m => console.log(`      → "${m}"`));
    }

    return result;
  } catch (err) {
    console.log(`\n  ═══ TODOS LOS PROVIDERS FALLARON ═══`);
    console.log(`  Error: ${err.message}`);
    return null;
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  FALLBACK CHAIN AUDIT — ¿Quién generó la respuesta?           ║');
  console.log('║  Script standalone — no modifica providers/                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const { providerManager, registry, health, ExecutionPlanner } = buildInstrumentedSystem();

  // TEST 1: Texto simple
  await runTest(providerManager, registry, ExecutionPlanner, 'TEXTO SIMPLE', [
    { role: 'user', content: 'Decí solo: "Hola, soy Paprika."' }
  ]);

  // TEST 2: Imagen (1x1 PNG blanco) + texto
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  await runTest(providerManager, registry, ExecutionPlanner, 'IMAGEN + TEXTO (multimodal)', [
    { role: 'user', content: [
      { type: 'text', text: 'Describí esta imagen brevemente.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }
    ]}
  ], { vision: true });

  // TEST 3: Texto largo con system instruction
  await runTest(providerManager, registry, ExecutionPlanner, 'SYSTEM INSTRUCTION', [
    { role: 'system', content: 'Sos Paprika, una asistente de 22 años de Buenos Aires. Respondés en español.' },
    { role: 'user', content: '¿Quién sos?' }
  ]);

  // ─── RESUMEN FINAL ───
  console.log(`\n\n${SEP}`);
  console.log('  RESUMEN: TRACE COMPLETO');
  console.log(SEP);
  console.log('');

  // Construir tabla
  const attempts = trace.filter(e => e.event === 'PROVIDER_ATTEMPT');
  const successes = trace.filter(e => e.event === 'PROVIDER_SUCCESS');
  const errors = trace.filter(e => e.event === 'PROVIDER_ERROR');
  const images = trace.filter(e => e.event === 'IMAGE_SENDING');

  console.log('  PROVIDERS REGISTRADOS:');
  trace.filter(e => e.event === 'PROVIDER_REGISTERED').forEach(e => {
    console.log(`    ✔ ${e.provider} / ${e.model}`);
  });
  trace.filter(e => e.event === 'PROVIDER_SKIPPED').forEach(e => {
    console.log(`    ✘ ${e.provider} — ${e.detail}`);
  });

  console.log(`\n  ATTEMPTS: ${attempts.length}`);
  attempts.forEach((a, i) => {
    const err = errors.find(e => e.model === a.model && e.provider === a.provider);
    const ok  = successes.find(e => e.model === a.model && e.provider === a.provider);
    if (err) {
      console.log(`    ${i+1}. ❌ ${a.provider}/${a.model} — FALLÓ: ${err.detail.substring(0, 100)}`);
    } else if (ok) {
      console.log(`    ${i+1}. ✅ ${a.provider}/${a.model} — RESPONDIÓ: ${ok.detail.substring(0, 100)}`);
    } else {
      console.log(`    ${i+1}. ⏭ ${a.provider}/${a.model} — SKIPPED (health)`);
    }
  });

  if (images.length > 0) {
    console.log(`\n  IMÁGENES ENVIADAS:`);
    images.forEach(e => console.log(`    📷 ${e.provider}: ${e.detail}`));
  }

  // Respuestas con frase sospechosa
  const suspiciousResponses = successes.filter(e =>
    e.detail.toLowerCase().includes('modelo de lenguaje') ||
    e.detail.toLowerCase().includes('archivos adjuntos')
  );
  if (suspiciousResponses.length > 0) {
    console.log(`\n  ⚠️  RESPUESTAS CON FRASE SOSPECHOSA:`);
    suspiciousResponses.forEach(e => console.log(`    → ${e.provider}/${e.model}: ${e.detail.substring(0, 150)}`));
  }

  console.log(`\n  TOTAL PROVIDERS QUE RESPONDIERON: ${successes.length}`);
  console.log(`  TOTAL PROVIDERS QUE FALLARON:     ${errors.length}`);

  console.log(`\n${SEP}`);
  console.log('  TABLA DE FALLBACK (por test):');
  console.log(SEP);

  // Reconstruir tabla de fallback por test
  let currentTest = '';
  trace.forEach(e => {
    if (e.event === 'EXECUTE_START') {
      currentTest = e.detail;
      console.log(`\n  TEST: ${currentTest}`);
    }
    if (e.event === 'PROVIDER_ATTEMPT') {
      process.stdout.write(`    ${e.provider}/${e.model} → `);
    }
    if (e.event === 'PROVIDER_SUCCESS') {
      console.log(`✅ RESPUESTA (${e.detail.substring(0, 80)})`);
    }
    if (e.event === 'PROVIDER_ERROR') {
      console.log(`❌ ${e.detail.substring(0, 80)}`);
      process.stdout.write(`    ↓ Fallback → `);
    }
  });

  console.log(`\n${SEP}`);
  console.log('  AUDIT COMPLETO');
  console.log(SEP);
})();
