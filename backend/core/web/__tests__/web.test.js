'use strict';

/**
 * Tests unitarios para el módulo Web.
 *
 * Ejecutar: node backend/core/web/__tests__/web.test.js
 */

const assert = require('assert');

// ─── Test Helpers ─────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── Tests ────────────────────────────────────────────────────

console.log('\n🧪 Web Module Tests\n');

// --- UrlValidator ---
console.log('UrlValidator:');

const UrlValidator = require('../security/UrlValidator');

test('rejects non-http protocols', () => {
  const r = UrlValidator.validate('ftp://example.com');
  assert.strictEqual(r.valid, false);
});

test('rejects localhost', () => {
  const r = UrlValidator.validate('http://localhost:8080/api');
  assert.strictEqual(r.valid, false);
});

test('rejects 127.x', () => {
  const r = UrlValidator.validate('http://127.0.0.1/admin');
  assert.strictEqual(r.valid, false);
});

test('rejects 192.168.x', () => {
  const r = UrlValidator.validate('http://192.168.1.1/router');
  assert.strictEqual(r.valid, false);
});

test('rejects 10.x', () => {
  const r = UrlValidator.validate('http://10.0.0.1/internal');
  assert.strictEqual(r.valid, false);
});

test('rejects 169.254.x (metadata)', () => {
  const r = UrlValidator.validate('http://169.254.169.254/metadata');
  assert.strictEqual(r.valid, false);
});

test('rejects blocked ports', () => {
  const r = UrlValidator.validate('http://example.com:22/ssh');
  assert.strictEqual(r.valid, false);
});

test('accepts valid https URL', () => {
  const r = UrlValidator.validate('https://example.com/path?q=1');
  assert.strictEqual(r.valid, true);
  assert.ok(r.url.startsWith('https://'));
});

test('accepts http with allowed port', () => {
  const r = UrlValidator.validate('http://example.com:8080/api');
  assert.strictEqual(r.valid, true);
});

test('rejects invalid URL format', () => {
  const r = UrlValidator.validate('not a url');
  assert.strictEqual(r.valid, false);
});

test('rejects IPv4-mapped IPv6 (127.0.0.1 mapped)', () => {
  const r = UrlValidator.validate('http://[::ffff:7f00:1]/admin');
  assert.strictEqual(r.valid, false);
});

test('rejects IPv4-mapped IPv6 (10.0.0.1 mapped)', () => {
  const r = UrlValidator.validate('http://[::ffff:a00:1]/internal');
  assert.strictEqual(r.valid, false);
});

test('rejects IPv4-mapped IPv6 (192.168.1.1 mapped)', () => {
  const r = UrlValidator.validate('http://[::ffff:c0a8:101]/router');
  assert.strictEqual(r.valid, false);
});

test('rejects [::] (unspecified)', () => {
  const r = UrlValidator.validate('http://[::]/');
  assert.strictEqual(r.valid, false);
});

test('validateRedirect resolves relative and validates', () => {
  const r = UrlValidator.validateRedirect('/new-page', 'http://example.com');
  assert.strictEqual(r.valid, true);
  assert.ok(r.url.includes('example.com'));
});

test('validateRedirect blocks private IP in redirect', () => {
  const r = UrlValidator.validateRedirect('http://169.254.169.254/metadata', 'http://example.com');
  assert.strictEqual(r.valid, false);
});

test('validateRedirect blocks localhost redirect', () => {
  const r = UrlValidator.validateRedirect('http://localhost:6379/', 'http://example.com');
  assert.strictEqual(r.valid, false);
});

test('validateDns fails when no addresses resolve', async () => {
  const r = await UrlValidator.validateDns('http://this-host-definitely-does-not-exist-xyz123.com');
  assert.strictEqual(r.valid, false);
});

// --- SearchCache ---
console.log('\nSearchCache:');

const SearchCache = require('../cache/SearchCache');

test('returns null for miss', () => {
  const cache = new SearchCache();
  assert.strictEqual(cache.get('test query'), null);
});

test('stores and retrieves results', () => {
  const cache = new SearchCache();
  const results = [{ title: 'test', url: 'http://test.com' }];
  cache.set('test query', {}, results);
  const got = cache.get('test query', {});
  assert.deepStrictEqual(got, results);
});

test('different options = different cache entries', () => {
  const cache = new SearchCache();
  cache.set('test', { category: 'news' }, [{ a: 1 }]);
  cache.set('test', { category: 'images' }, [{ b: 2 }]);
  assert.deepStrictEqual(cache.get('test', { category: 'news' }), [{ a: 1 }]);
  assert.deepStrictEqual(cache.get('test', { category: 'images' }), [{ b: 2 }]);
});

test('expired entries are evicted', () => {
  const cache = new SearchCache({ defaultTTL: 1 });
  cache.set('test', {}, [{ a: 1 }]);
  // Simulate time passing by directly manipulating
  const key = SearchCache._makeKey('test', {});
  const entry = cache._store.get(key);
  entry.created = Date.now() - 100;
  assert.strictEqual(cache.get('test', {}), null);
});

test('metrics track hits and misses', () => {
  const cache = new SearchCache();
  cache.get('a'); // miss
  cache.set('b', {}, [{ x: 1 }]);
  cache.get('b'); // hit
  cache.get('c'); // miss
  const m = cache.getMetrics();
  assert.strictEqual(m.hits, 1);
  assert.strictEqual(m.misses, 2);
  assert.strictEqual(m.size, 1);
});

test('clear empties cache', () => {
  const cache = new SearchCache();
  cache.set('a', {}, [1]);
  cache.set('b', {}, [2]);
  cache.clear();
  assert.strictEqual(cache.get('a'), null);
  assert.strictEqual(cache.getMetrics().size, 0);
});

// --- ResultRanker ---
console.log('\nResultRanker:');

const ResultRanker = require('../ranking/ResultRanker');

test('returns empty for empty input', () => {
  const ranker = new ResultRanker();
  assert.deepStrictEqual(ranker.rank('test', []), []);
});

test('ranks title matches higher', () => {
  const ranker = new ResultRanker();
  const results = [
    { title: 'Irrelevant', url: 'http://a.com', snippet: 'nothing', engine: 'google' },
    { title: 'Node.js es genial', url: 'http://b.com', snippet: 'nada', engine: 'google' },
  ];
  const ranked = ranker.rank('node.js', results);
  assert.strictEqual(ranked[0].url, 'http://b.com');
});

test('returns correct number of results', () => {
  const ranker = new ResultRanker();
  const results = Array.from({ length: 20 }, (_, i) => ({
    title: `Result ${i}`,
    url: `http://${i}.com`,
    snippet: 'test',
  }));
  const ranked = ranker.rank('test', results, { maxResults: 5 });
  assert.strictEqual(ranked.length, 5);
});

test('each result has score', () => {
  const ranker = new ResultRanker();
  const results = [{ title: 'test', url: 'http://x.com', snippet: 'hello' }];
  const ranked = ranker.rank('test', results);
  assert.strictEqual(typeof ranked[0].score, 'number');
});

// --- SearXNGProvider ---
console.log('\nSearXNGProvider:');

const SearXNGProvider = require('../providers/SearXNGProvider');

test('creates with default config', () => {
  const p = new SearXNGProvider();
  assert.strictEqual(p.name, 'searxng');
  assert.ok(p.config.url);
});

test('creates with custom config', () => {
  const p = new SearXNGProvider({ url: 'http://custom:9090' });
  assert.strictEqual(p.config.url, 'http://custom:9090');
});

test('normalizes search results', () => {
  const p = new SearXNGProvider();
  const normalized = p._normalize({
    title: 'Test Title',
    url: 'http://test.com',
    content: 'Test snippet',
    engine: 'google',
    score: 0.8,
  });
  assert.strictEqual(normalized.title, 'Test Title');
  assert.strictEqual(normalized.url, 'http://test.com');
  assert.strictEqual(normalized.provider, 'searxng');
});

test('parses empty results gracefully', () => {
  const p = new SearXNGProvider();
  assert.deepStrictEqual(p._parseResults(null), []);
  assert.deepStrictEqual(p._parseResults({}), []);
  assert.deepStrictEqual(p._parseResults({ results: [] }), []);
});

// --- Tool Definitions ---
console.log('\nTool Definitions:');

const { createWebSearchTool } = require('../tools/web_search');
const { createWebFetchTool } = require('../tools/web_fetch');

test('web_search tool has required fields', () => {
  const mockSearchManager = { search: async () => ({ results: [], metadata: {} }) };
  const tool = createWebSearchTool(mockSearchManager);
  assert.ok(tool.description);
  assert.ok(tool.params);
  assert.ok(tool.execute);
  assert.ok(tool.params.query);
});

test('web_fetch tool has required fields', () => {
  const tool = createWebFetchTool();
  assert.ok(tool.description);
  assert.ok(tool.params);
  assert.ok(tool.execute);
  assert.ok(tool.params.url);
});

test('web_search returns no results message', async () => {
  const mockSearchManager = { search: async () => ({ results: [], metadata: {} }) };
  const tool = createWebSearchTool(mockSearchManager);
  const result = await tool.execute({ query: 'test' });
  assert.ok(result.includes('No se encontraron'));
});

test('web_fetch blocks invalid URLs', async () => {
  const tool = createWebFetchTool();
  const result = await tool.execute({ url: 'http://localhost/admin' });
  assert.ok(result.includes('bloqueada'));
});

// --- Provider Registry ---
console.log('\nProvider Registry:');

const { createProvider, listProviders } = require('../providers');

test('lists available providers', () => {
  const list = listProviders();
  assert.ok(list.includes('searxng'));
});

test('creates searxng provider', () => {
  const p = createProvider('searxng');
  assert.ok(p);
  assert.strictEqual(p.name, 'searxng');
});

test('returns null for unknown provider', () => {
  const p = createProvider('nonexistent');
  assert.strictEqual(p, null);
});

// --- ExtractText ---
console.log('\nextractText:');

const { extractText, extractLinks } = require('../tools/web_fetch');

test('removes HTML tags', () => {
  const html = '<p>Hello <b>world</b></p>';
  const text = extractText(html);
  assert.ok(text.includes('Hello'));
  assert.ok(text.includes('world'));
  assert.ok(!text.includes('<p>'));
});

test('removes script and style', () => {
  const html = '<script>alert("xss")</script><p>Safe content</p><style>.x{}</style>';
  const text = extractText(html);
  assert.ok(text.includes('Safe content'));
  assert.ok(!text.includes('alert'));
});

test('extracts links from HTML', () => {
  const html = '<a href="http://google.com">Google</a> <a href="http://github.com">GitHub</a>';
  const result = extractLinks(html, 'http://example.com');
  assert.ok(result.includes('Google'));
  assert.ok(result.includes('GitHub'));
});

// --- Summary ---
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All tests passed!\n');
}
