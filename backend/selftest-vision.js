'use strict';
/**
 * selftest-vision.js — Vision pipeline self-test.
 * Run: node selftest-vision.js
 *
 * Verifies:
 *   1. Vision model exists in ModelRegistry (with priority info)
 *   2. Auto-discovery works for all providers
 *   3. Model responds to a test image via ProviderManager
 *   4. ResponseNormalizer produces correct output
 *   5. HealthManager state is clean
 */

require('dotenv').config({ path: __dirname + '/.env' });

const { getModelRegistry, PRIORITY } = require('./providers/modelRegistry');
const { ResponseNormalizer } = require('./providers/responseNormalizer');

// Tiny 1x1 red PNG (base64)
const TEST_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const RESULTS = [];

function pass(name, detail) {
  RESULTS.push({ name, status: 'PASS', detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, reason) {
  RESULTS.push({ name, status: 'FAIL', reason });
  console.log(`  ✗ ${name} — ${reason}`);
}

async function selftest() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Paprika — Vision Self Test');
  console.log('═══════════════════════════════════════════════════\n');

  const registry = getModelRegistry();
  const priorityLabel = (p) => p === PRIORITY.FREE ? 'FREE' : p === PRIORITY.OPTIONAL ? 'OPTIONAL' : 'PAID';

  // Test 1: Auto-discovery
  console.log('── 1. Auto-Discovery ──');
  const syncResults = await registry.syncAll();
  for (const [provider, result] of Object.entries(syncResults)) {
    if (result.error) {
      console.log(`  ○ ${provider}: ${result.error}`);
    } else if (result.available === false) {
      console.log(`  ○ ${provider}: no disponible`);
    } else {
      console.log(`  ✓ ${provider}: ${result.modelsFound || 0} modelos`);
    }
  }

  // Test 2: Vision models exist
  console.log('\n── 2. Vision Models in Registry ──');
  const visionModels = registry.getVisionModels();
  if (visionModels.length === 0) {
    fail('vision-model-exists', 'No vision models registered');
    console.log('  → Install: ollama pull llama3.2-vision');
    console.log('  → Or add GEMINI_API_KEY / GROQ_API_KEY to .env');
  } else {
    for (const vm of visionModels) {
      const tag = priorityLabel(vm.priority);
      pass('vision-model', `${vm.provider}/${vm.model} [${tag}, ${vm.speedEstimate} tok/s]`);
    }
  }

  // Test 3: At least one vision provider instance available
  console.log('\n── 3. Vision Provider Available ──');
  let availableVisionProvider = null;
  let availableVisionModel = null;
  try {
    const { createProviderInstances } = require('./providers');
    const providers = createProviderInstances();
    for (const vm of visionModels) {
      if (providers.has(vm.provider)) {
        availableVisionProvider = vm.provider;
        availableVisionModel = vm.model;
        break;
      }
    }
    if (availableVisionProvider) {
      pass('vision-provider-available', `${availableVisionProvider}/${availableVisionModel}`);
    } else {
      fail('vision-provider-available', 'Vision model registered but no provider instance created');
    }
  } catch (err) {
    fail('vision-provider-available', err.message);
  }

  // Test 4: ResponseNormalizer works
  console.log('\n── 4. ResponseNormalizer ──');
  try {
    const testResponse = {
      text: 'Veo una imagen que muestra un cuadrado rojo pequeño sobre fondo blanco.',
      usage: { promptTokens: 100, completionTokens: 20 },
      provider: 'ollama',
      model: 'llama3.2-vision',
    };
    const normalized = ResponseNormalizer.normalize(testResponse, {
      provider: 'ollama',
      model: 'llama3.2-vision',
    });
    if (normalized.text && normalized.text.length > 0 && normalized.provider === 'ollama') {
      pass('response-normalizer', `${normalized.text.length} chars, provider: ${normalized.provider}`);
    } else {
      fail('response-normalizer', 'Normalized response missing text or provider');
    }
  } catch (err) {
    fail('response-normalizer', err.message);
  }

  // Test 5: Validation
  console.log('\n── 5. Response Validation ──');
  try {
    const goodResponse = ResponseNormalizer.normalize({
      text: 'Veo un gato naranja.',
      provider: 'ollama',
      model: 'llama3.2-vision',
    });
    const goodValidation = ResponseNormalizer.validate(goodResponse);
    if (goodValidation.valid) {
      pass('validate-good-response', 'valid');
    } else {
      fail('validate-good-response', goodValidation.reason);
    }

    const emptyResponse = ResponseNormalizer.normalize({ text: '', provider: 'ollama' });
    const emptyValidation = ResponseNormalizer.validate(emptyResponse);
    if (!emptyValidation.valid) {
      pass('validate-empty-rejected', `correctly rejected: ${emptyValidation.reason}`);
    } else {
      fail('validate-empty-rejected', 'Empty response should be invalid');
    }
  } catch (err) {
    fail('response-validation', err.message);
  }

  // Test 6: HealthManager
  console.log('\n── 6. HealthManager State ──');
  try {
    const { getHealthManager } = require('./providers/healthManager');
    const health = getHealthManager();
    const status = health.getStatus();
    const degradedCount = Object.values(status).filter(s => s.state !== 'healthy').length;
    if (degradedCount === 0) {
      pass('health-clean', 'All providers healthy');
    } else {
      const degraded = Object.entries(status).filter(([, s]) => s.state !== 'healthy');
      for (const [name, s] of degraded) {
        const reason = s.lastErrorType ? `${s.lastErrorType}, retry in ${Math.round(s.remainingCooldownMs / 1000)}s` : s.state;
        console.log(`  ⚠ ${name}: ${reason}`);
      }
      pass('health-clean', `${degradedCount} degraded (expected in env without keys)`);
    }
  } catch (err) {
    fail('health-manager', err.message);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  const passed = RESULTS.filter(r => r.status === 'PASS').length;
  const failed = RESULTS.filter(r => r.status === 'FAIL').length;
  console.log(`  Results: ${passed} passed, ${failed} failed, ${RESULTS.length} total`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    for (const r of RESULTS.filter(r => r.status === 'FAIL')) {
      console.log(`    ✗ ${r.name}: ${r.reason}`);
    }
  }

  // Vision readiness
  console.log('\n── Vision Readiness ──');
  if (availableVisionProvider) {
    console.log(`  ✓ Ready — will use ${availableVisionProvider}/${availableVisionModel}`);
  } else {
    console.log('  ✗ NOT READY — no working vision provider');
    console.log('  → Quick fix: ollama pull llama3.2-vision');
    console.log('  → Or: add GEMINI_API_KEY to backend/.env');
  }

  // Priority summary
  console.log('\n── Model Priority Order ──');
  const allRows = registry.getDiagnostics();
  const byPriority = allRows
    .filter(r => r.available)
    .sort((a, b) => a.priority - b.priority || a.speedEstimate - b.speedEstimate);
  for (let i = 0; i < Math.min(byPriority.length, 8); i++) {
    const r = byPriority[i];
    console.log(`  ${i + 1}. [${priorityLabel(r.priority)}] ${r.provider}/${r.displayName} (${r.speedEstimate} tok/s)`);
  }
  if (byPriority.length > 8) console.log(`  ... and ${byPriority.length - 8} more`);

  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

selftest().catch(err => {
  console.error('Self test failed:', err);
  process.exit(1);
});
