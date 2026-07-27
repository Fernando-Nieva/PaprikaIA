'use strict';
/**
 * diagnose.js — Provider diagnostics script.
 * Run: node diagnose.js
 *
 * Shows: priority, cost, speed, availability, vision, audio, streaming, health status.
 */

require('dotenv').config({ path: __dirname + '/.env' });

const { getModelRegistry, PRIORITY } = require('./providers/modelRegistry');
const { getHealthManager } = require('./providers/healthManager');

async function diagnose() {
  const registry = getModelRegistry();
  const health = getHealthManager();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Paprika — Multi-Model Orchestrator Diagnostics');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Auto-discover all providers
  console.log('── Auto-Discovery ──');
  const syncResults = await registry.syncAll();
  for (const [provider, result] of Object.entries(syncResults)) {
    if (result.error) {
      console.log(`  ✗ ${provider}: ${result.error}`);
    } else if (result.available === false) {
      console.log(`  ○ ${provider}: no disponible`);
    } else {
      console.log(`  ✓ ${provider}: ${result.modelsFound || 0} modelos, sync OK`);
    }
  }

  // Model table
  console.log('\n── Model Registry ──');
  const rows = registry.getDiagnostics();
  const priorityLabel = (p) => p === PRIORITY.FREE ? 'FREE' : p === PRIORITY.OPTIONAL ? 'OPT' : 'PAID';
  const icon = (v) => v ? '✓' : '·';

  // Header
  console.log(
    '  ' +
    'Priority'.padEnd(6) +
    'Provider'.padEnd(14) +
    'Model'.padEnd(30) +
    'Vis'.padEnd(4) +
    'Aud'.padEnd(4) +
    'Tool'.padEnd(5) +
    'Code'.padEnd(5) +
    'Rsn'.padEnd(4) +
    'Str'.padEnd(4) +
    'Ctx'.padEnd(8) +
    'Speed'.padEnd(6) +
    'Cost'.padEnd(6) +
    'Avail'.padEnd(6)
  );
  console.log('  ' + '─'.repeat(100));

  for (const row of rows) {
    console.log(
      '  ' +
      priorityLabel(row.priority).padEnd(6) +
      row.provider.padEnd(14) +
      row.displayName.padEnd(30) +
      icon(row.vision).padEnd(4) +
      icon(row.audio).padEnd(4) +
      icon(row.tools).padEnd(5) +
      icon(row.code).padEnd(5) +
      icon(row.reasoning).padEnd(4) +
      icon(row.streaming).padEnd(4) +
      String(row.contextLength).padEnd(8) +
      `${row.speedEstimate}t/s`.padEnd(6) +
      `$${row.costPerMillionTokens}`.padEnd(6) +
      icon(row.available).padEnd(6)
    );
  }

  // Health status
  console.log('\n── Health Status ──');
  const healthStatus = health.getStatus();
  for (const [name, data] of Object.entries(healthStatus)) {
    const icon = data.state === 'healthy' ? '●' : data.state === 'degraded' ? '◐' : '○';
    const reason = data.lastErrorType ? ` (${data.lastErrorType})` : '';
    const nextRetry = data.nextAttempt ? ` retry in ${Math.round(data.remainingCooldownMs / 1000)}s` : '';
    console.log(`  ${icon} ${name}: ${data.state}${reason} — failures: ${data.failures}, successes: ${data.successCount}${nextRetry}`);
  }

  // Vision summary
  console.log('\n── Vision Capability ──');
  const visionModels = registry.getVisionModels();
  if (visionModels.length === 0) {
    console.log('  ✗ No vision models available');
  } else {
    console.log(`  ✓ ${visionModels.length} vision model(s):`);
    for (const m of visionModels) {
      console.log(`    - ${m.provider}/${m.model} [priority ${m.priority}, ${m.speedEstimate} tok/s]`);
    }
  }

  // Priority summary
  console.log('\n── Priority Summary ──');
  const allModels = rows.filter(r => r.available);
  const freeCount = allModels.filter(r => r.priority === PRIORITY.FREE).length;
  const optCount = allModels.filter(r => r.priority === PRIORITY.OPTIONAL).length;
  const paidCount = allModels.filter(r => r.priority === PRIORITY.PAID).length;
  console.log(`  FREE (Level 1): ${freeCount} models — Ollama, Groq, Gemini`);
  console.log(`  OPTIONAL (Level 2): ${optCount} models — OpenRouter free`);
  console.log(`  PAID (Level 3): ${paidCount} models — OpenAI, Anthropic`);

  console.log('\n═══════════════════════════════════════════════════════════════');
}

diagnose().catch(err => {
  console.error('Diagnose failed:', err);
  process.exit(1);
});
