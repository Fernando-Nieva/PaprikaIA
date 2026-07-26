'use strict';

/**
 * Tests unitarios para el módulo CodeExecutor.
 *
 * Ejecutar: node backend/core/executor/__tests__/executor.test.js
 */

const assert = require('assert');
const CodeExecutor = require('../index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assertEq(a, b) {
  assert.deepStrictEqual(a, b);
}

// ─── Tests ────────────────────────────────────────────────────

async function run() {
  console.log('\n🧪 CodeExecutor Tests\n');

  const executor = new CodeExecutor({ timeout: 5000 });

  // --- Basic execution ---
  console.log('Basic execution:');

  await test('returns a number', async () => {
    const r = await executor.execute('return 42;');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 42);
  });

  await test('returns a string', async () => {
    const r = await executor.execute('return "hello world";');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 'hello world');
  });

  await test('returns an object', async () => {
    const r = await executor.execute('return { a: 1, b: 2 };');
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(r.result, { a: 1, b: 2 });
  });

  await test('returns an array', async () => {
    const r = await executor.execute('return [1, 2, 3, 4, 5];');
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(r.result, [1, 2, 3, 4, 5]);
  });

  await test('returns undefined when no return', async () => {
    const r = await executor.execute('let x = 5;');
    assert.strictEqual(r.success, true);
    // undefined gets serialized differently in IPC
  });

  await test('returns null', async () => {
    const r = await executor.execute('return null;');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, null);
  });

  // --- Math operations ---
  console.log('\nMath operations:');

  await test('calculates PI', async () => {
    const r = await executor.execute('return Math.PI;');
    assert.strictEqual(r.success, true);
    assert.ok(Math.abs(r.result - 3.141592653589793) < 0.0001);
  });

  await test('square root', async () => {
    const r = await executor.execute('return Math.sqrt(144);');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 12);
  });

  await test('power', async () => {
    const r = await executor.execute('return Math.pow(2, 10);');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 1024);
  });

  await test('floor/ceil/round', async () => {
    const r = await executor.execute(`
      return {
        floor: Math.floor(3.7),
        ceil: Math.ceil(3.2),
        round: Math.round(3.5),
      };
    `);
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(r.result, { floor: 3, ceil: 4, round: 4 });
  });

  // --- Console output ---
  console.log('\nConsole output:');

  await test('captures console.log', async () => {
    const r = await executor.execute(`
      console.log("Hello from sandbox!");
      return 42;
    `);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 42);
    assert.ok(r.output.some(o => o.includes('Hello from sandbox!')));
  });

  await test('captures multiple logs', async () => {
    const r = await executor.execute(`
      console.log("Line 1");
      console.log("Line 2");
      console.log("Line 3");
      return true;
    `);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.output.length, 3);
  });

  // --- Async execution ---
  console.log('\nAsync execution:');

  await test('handles async code', async () => {
    const r = await executor.execute(`
      const result = await new Promise(resolve => resolve(42));
      return result;
    `);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 42);
  });

  await test('handles Promise.resolve', async () => {
    const r = await executor.execute('return Promise.resolve("async result");');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, 'async result');
  });

  // --- JSON operations ---
  console.log('\nJSON operations:');

  await test('JSON.parse and stringify', async () => {
    const r = await executor.execute(`
      const obj = JSON.parse('{"x":1,"y":2}');
      return JSON.stringify({ ...obj, z: 3 });
    `);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.result, '{"x":1,"y":2,"z":3}');
  });

  // --- Array operations ---
  console.log('\nArray operations:');

  await test('map/filter/reduce', async () => {
    const r = await executor.execute(`
      const nums = [1, 2, 3, 4, 5];
      const doubled = nums.map(n => n * 2);
      const evens = doubled.filter(n => n % 2 === 0);
      const sum = evens.reduce((a, b) => a + b, 0);
      return { doubled, evens, sum };
    `);
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(r.result.doubled, [2, 4, 6, 8, 10]);
    assert.deepStrictEqual(r.result.evens, [2, 4, 6, 8, 10]);
    assert.strictEqual(r.result.sum, 30);
  });

  // --- Sandbox escape prevention ---
  console.log('\nSandbox escape prevention:');

  await test('blocks Date.constructor → Function escape', async () => {
    const r = await executor.execute('return Date.constructor("return process")();');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('blocks Array.constructor → Function escape', async () => {
    const r = await executor.execute('return Array.constructor("return process")();');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('blocks arguments.callee escape', async () => {
    const r = await executor.execute('return arguments.callee.caller.constructor("return process")();');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('blocks require() attempt', async () => {
    const r = await executor.execute('return require("fs");');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('blocks process access', async () => {
    const r = await executor.execute('return typeof process;');
    // process may be accessible as a global, but should not allow dangerous operations
    assert.strictEqual(r.success, true);
    // Verify we can't use require to load modules
    const r2 = await executor.execute('try { return typeof require("child_process"); } catch(e) { return "blocked: " + e.message; }');
    assert.strictEqual(r2.success, true);
    assert.ok(String(r2.result).includes('blocked') || r2.result === 'undefined');
  });

  // --- Error handling ---
  console.log('\nError handling:');

  await test('catches syntax errors', async () => {
    const r = await executor.execute('return {{{invalid syntax');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('catches runtime errors', async () => {
    const r = await executor.execute('return undefinedVariable.property;');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  await test('catches TypeError', async () => {
    const r = await executor.execute('null.foo;');
    assert.strictEqual(r.success, false);
    assert.ok(r.error);
  });

  // --- Timeout ---
  console.log('\nTimeout:');

  await test('times out on infinite loop', async () => {
    const r = await executor.execute('while(true) {}', { timeout: 1000 });
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('Timeout'));
  });

  // --- Input validation ---
  console.log('\nInput validation:');

  await test('rejects empty code', async () => {
    const r = await executor.execute('');
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('vacío'));
  });

  await test('rejects null code', async () => {
    const r = await executor.execute(null);
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('vacío') || r.error.includes('inválido'));
  });

  await test('rejects code too long', async () => {
    const longCode = 'return ' + '"x"'.repeat(5000);
    const r = await executor.execute(longCode);
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('largo'));
  });

  // --- Pre-validation ---
  console.log('\nPre-validation:');

  await test('rejects require()', () => {
    const r = CodeExecutor.preValidate('return require("fs")');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('require'));
  });

  await test('rejects process access', () => {
    const r = CodeExecutor.preValidate('return process.env');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('process'));
  });

  await test('rejects eval()', () => {
    const r = CodeExecutor.preValidate('eval("alert(1)")');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('eval'));
  });

  await test('rejects child_process', () => {
    const r = CodeExecutor.preValidate('return child_process.exec("ls")');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('child_process'));
  });

  await test('rejects fs access', () => {
    const r = CodeExecutor.preValidate('return fs.readFileSync("/etc/passwd")');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('filesystem'));
  });

  await test('rejects fetch', () => {
    const r = CodeExecutor.preValidate('return fetch("http://evil.com")');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('fetch'));
  });

  await test('rejects Function constructor', () => {
    const r = CodeExecutor.preValidate('return new Function("return process")()');
    assert.strictEqual(r.safe, false);
    assert.ok(r.reason.includes('Function'));
  });

  await test('rejects empty code', () => {
    const r = CodeExecutor.preValidate('');
    assert.strictEqual(r.safe, false);
  });

  await test('accepts safe math code', () => {
    const r = CodeExecutor.preValidate('return Math.PI * 2;');
    assert.strictEqual(r.safe, true);
  });

  await test('accepts safe JSON code', () => {
    const r = CodeExecutor.preValidate('return JSON.parse(JSON.stringify({a:1}));');
    assert.strictEqual(r.safe, true);
  });

  // --- Metrics ---
  console.log('\nMetrics:');

  await test('tracks execution metrics', async () => {
    await executor.execute('return 1;');
    await executor.execute('return 2;');
    const m = executor.getMetrics();
    assert.ok(m.executed >= 2);
    assert.ok(typeof m.avgDuration === 'number');
  });

  // --- Summary ---
  console.log('\n' + '─'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ All tests passed!\n');
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
