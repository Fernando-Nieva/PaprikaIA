'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ProgressTracker = require('../ProgressTracker');
const TaskPlanner = require('../TaskPlanner');
const ReflectionEngine = require('../ReflectionEngine');
const AgenticLoop = require('../AgenticLoop');

// ─── Helpers ──────────────────────────────────────────────────

function createChatFn(responses) {
  let callIndex = 0;
  const fn = async (messages, opts, config) => {
    const resp = responses[callIndex % responses.length];
    callIndex++;
    return typeof resp === 'function' ? resp(messages, opts, config) : resp;
  };
  fn._callIndex = () => callIndex;
  return fn;
}

function createToolExecutor(overrides = {}) {
  return {
    getToolsPrompt: () => 'Available tools: web_search, run_code',
    parseToolCalls: (raw) => {
      if (overrides.parseToolCalls) return overrides.parseToolCalls(raw);
      return [];
    },
    execute: async (name, args) => {
      if (overrides.execute) return overrides.execute(name, args);
      return { tool: name, success: true, result: `Executed ${name}` };
    },
    executeFromResponse: async (raw) => {
      if (overrides.executeFromResponse) return overrides.executeFromResponse(raw);
      return { results: [], cleanText: raw };
    },
  };
}

// ─── ProgressTracker ──────────────────────────────────────────

describe('ProgressTracker', () => {
  it('constructor sets default state', () => {
    const pt = new ProgressTracker();
    const state = pt.getState();
    assert.equal(state.currentStep, 0);
    assert.equal(state.totalSteps, 0);
    assert.ok(Array.isArray(state.steps));
    assert.equal(state.steps.length, 0);
  });

  it('constructor accepts onProgress callback', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.emitProgress('hello');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'progress');
    assert.equal(events[0].data.message, 'hello');
  });

  it('init creates steps from plan', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.init('my objective', [
      { description: 'Step one' },
      { description: 'Step two' },
      { description: 'Step three' },
    ]);

    const state = pt.getState();
    assert.equal(state.totalSteps, 3);
    assert.equal(state.steps.length, 3);
    assert.equal(state.steps[0].description, 'Step one');
    assert.equal(state.steps[0].status, 'pending');
    assert.equal(state.steps[1].description, 'Step two');
    assert.equal(state.steps[2].description, 'Step three');

    const initEvent = events.find(e => e.event === 'init');
    assert.ok(initEvent);
    assert.equal(initEvent.data.objective, 'my objective');
    assert.equal(initEvent.data.totalSteps, 3);
  });

  it('emitProgress sends progress event', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.emitProgress('Working...', { extra: 42 });

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'progress');
    assert.equal(events[0].data.message, 'Working...');
    assert.equal(events[0].data.extra, 42);
    assert.equal(events[0].data.currentStep, 0);
    assert.ok(typeof events[0].ts === 'number');
  });

  it('startStep marks step as running', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.init('obj', [{ description: 'A' }, { description: 'B' }]);
    pt.startStep(1, 'detail info');

    const state = pt.getState();
    assert.equal(state.steps[0].status, 'running');
    assert.equal(state.currentStep, 1);

    const startEvent = events.find(e => e.event === 'step_start');
    assert.ok(startEvent);
    assert.equal(startEvent.data.step, 1);
    assert.equal(startEvent.data.detail, 'detail info');
  });

  it('startStep does nothing for invalid step', () => {
    const pt = new ProgressTracker();
    pt.init('obj', [{ description: 'A' }]);
    pt.startStep(99);
    const state = pt.getState();
    assert.equal(state.steps[0].status, 'pending');
  });

  it('completeStep marks step completed', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.init('obj', [{ description: 'A' }]);
    pt.startStep(1);
    pt.completeStep(1, 'done');

    const state = pt.getState();
    assert.equal(state.steps[0].status, 'completed');
    assert.equal(state.steps[0].result, 'done');

    const compEvent = events.find(e => e.event === 'step_complete');
    assert.ok(compEvent);
    assert.ok(compEvent.data.duration >= 0);
  });

  it('completeStep uses default result text', () => {
    const pt = new ProgressTracker();
    pt.init('obj', [{ description: 'A' }]);
    pt.completeStep(1);
    const state = pt.getState();
    assert.equal(state.steps[0].result, 'Completado');
  });

  it('completeStep does nothing for invalid step', () => {
    const pt = new ProgressTracker();
    pt.init('obj', [{ description: 'A' }]);
    pt.completeStep(99);
    const state = pt.getState();
    assert.equal(state.steps[0].status, 'pending');
  });

  it('errorStep marks step as error', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.init('obj', [{ description: 'A' }]);
    pt.errorStep(1, 'something broke');

    const state = pt.getState();
    assert.equal(state.steps[0].status, 'error');
    assert.equal(state.steps[0].result, 'something broke');

    const errEvent = events.find(e => e.event === 'step_error');
    assert.ok(errEvent);
    assert.equal(errEvent.data.error, 'something broke');
  });

  it('logAction records actions with timestamp', () => {
    const pt = new ProgressTracker();
    pt.logAction({ type: 'tool', description: 'web_search(...)' });
    pt.logAction({ type: 'reflection', description: 'evaluating', metadata: { x: 1 } });

    const history = pt.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'tool');
    assert.equal(history[0].description, 'web_search(...)');
    assert.ok(typeof history[0].timestamp === 'number');
    assert.equal(history[1].metadata.x, 1);
  });

  it('getHistory returns a copy', () => {
    const pt = new ProgressTracker();
    pt.logAction({ type: 'tool', description: 'a' });
    const h1 = pt.getHistory();
    h1.push({ fake: true });
    assert.equal(pt.getHistory().length, 1);
  });

  it('complete emits success event', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.init('obj', [{ description: 'A' }, { description: 'B' }]);
    pt.startStep(1);
    pt.completeStep(1);
    pt.complete(true, 'all done');

    const compEvent = events.find(e => e.event === 'complete');
    assert.ok(compEvent);
    assert.equal(compEvent.data.success, true);
    assert.equal(compEvent.data.summary, 'all done');
    assert.equal(compEvent.data.completedSteps, 1);
    assert.equal(compEvent.data.totalSteps, 2);
    assert.ok(compEvent.data.totalDuration >= 0);
  });

  it('complete emits failure event', () => {
    const events = [];
    const pt = new ProgressTracker((e) => events.push(e));
    pt.complete(false, 'failed');

    const compEvent = events.find(e => e.event === 'complete');
    assert.ok(compEvent);
    assert.equal(compEvent.data.success, false);
  });

  it('getState includes elapsed time', () => {
    const pt = new ProgressTracker();
    const state = pt.getState();
    assert.ok(state.elapsed >= 0);
  });

  it('no callback does not throw', () => {
    const pt = new ProgressTracker();
    pt.emitProgress('msg');
    pt.init('obj', [{ description: 'A' }]);
    pt.startStep(1);
    pt.completeStep(1);
    pt.complete(true);
    pt.logAction({ type: 'tool', description: 'x' });
  });
});

// ─── TaskPlanner ──────────────────────────────────────────────

describe('TaskPlanner', () => {
  it('constructor sets defaults', () => {
    const planner = new TaskPlanner(() => {});
    assert.equal(planner.maxSteps, 8);
    assert.equal(planner.simpleThreshold, 2);
  });

  it('constructor accepts config', () => {
    const planner = new TaskPlanner(() => {}, { maxSteps: 5, simpleThreshold: 3 });
    assert.equal(planner.maxSteps, 5);
    assert.equal(planner.simpleThreshold, 3);
  });

  it('plan() returns complex:false for short messages', async () => {
    const planner = new TaskPlanner(async () => '{}');
    const result = await planner.plan('qué es JavaScript?', [], {});
    assert.equal(result.complex, false);
  });

  it('plan() returns complex:false for question patterns', async () => {
    const planner = new TaskPlanner(async () => '{}');
    const tests = [
      'qué es Node.js',
      'cómo se usa Express',
      'cuánto pesa un elephant',
      'dónde está Buenos Aires',
      'cuándo fue la revolución',
      'quién es Turing',
    ];
    for (const msg of tests) {
      const result = await planner.plan(msg, [], {});
      assert.equal(result.complex, false, `Expected simple for: ${msg}`);
    }
  });

  it('plan() returns complex:false for messages < 50 chars', async () => {
    const planner = new TaskPlanner(async () => '{}');
    const result = await planner.plan('Short message here', [], {});
    assert.equal(result.complex, false);
  });

  it('plan() returns complex:false when analysis has low complexity', async () => {
    const planner = new TaskPlanner(async () => '{}');
    const result = await planner.plan(
      'This is a longer message that exceeds the fifty char threshold',
      [],
      { complexity: 'low' }
    );
    assert.equal(result.complex, false);
  });

  it('plan() parses complex plan from LLM response', async () => {
    const mockResponse = JSON.stringify({
      complex: true,
      objective: 'Analyze sales data',
      steps: [
        { id: 1, description: 'Fetch data', successCriteria: 'Data loaded', suggestedTools: ['web_fetch'] },
        { id: 2, description: 'Process data', successCriteria: 'Report generated', suggestedTools: ['run_code'] },
      ],
    });

    const planner = new TaskPlanner(async () => mockResponse);
    const result = await planner.plan(
      'Analyze the complete sales data for Q1 and generate a comprehensive report with charts and comparisons',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, true);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].description, 'Fetch data');
    assert.equal(result.steps[1].description, 'Process data');
    assert.equal(result.objective, 'Analyze sales data');
  });

  it('plan() limits steps to maxSteps', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      description: `Step ${i + 1}`,
      successCriteria: 'done',
    }));
    const mockResponse = JSON.stringify({ complex: true, objective: 'big task', steps });

    const planner = new TaskPlanner(async () => mockResponse, { maxSteps: 5 });
    const result = await planner.plan(
      'Do a massive multi-step analysis of everything in the world including all data sources and cross-references',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.steps.length, 5);
  });

  it('plan() returns complex:false for invalid LLM JSON', async () => {
    const planner = new TaskPlanner(async () => 'not json at all');
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, false);
  });

  it('plan() returns complex:false when LLM returns non-boolean complex', async () => {
    const planner = new TaskPlanner(async () => '{"complex": "yes", "steps": []}');
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, false);
  });

  it('plan() returns complex:false when steps array is empty', async () => {
    const planner = new TaskPlanner(async () => '{"complex": true, "steps": []}');
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, false);
  });

  it('plan() returns complex:false on chatFn error', async () => {
    const planner = new TaskPlanner(async () => { throw new Error('API down'); });
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, false);
  });

  it('plan() filters out invalid steps', async () => {
    const mockResponse = JSON.stringify({
      complex: true,
      objective: 'task',
      steps: [
        { id: 1, description: 'Good step', successCriteria: 'ok' },
        { id: null, description: '', successCriteria: '' },
        { id: 3, description: 'Another good step', successCriteria: 'ok' },
      ],
    });
    const planner = new TaskPlanner(async () => mockResponse);
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].description, 'Good step');
  });

  it('plan() falls back to objective when plan.objective missing', async () => {
    const mockResponse = JSON.stringify({
      complex: true,
      steps: [{ id: 1, description: 'step', successCriteria: 'done' }],
    });
    const planner = new TaskPlanner(async () => mockResponse);
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.objective, 'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports');
  });

  it('plan() returns complex:false for unparseable response without JSON', async () => {
    const planner = new TaskPlanner(async () => 'Just a plain text response with no JSON');
    const result = await planner.plan(
      'Perform an extensive analysis of all available data across multiple sources and generate comprehensive reports',
      [],
      { complexity: 'high' }
    );
    assert.equal(result.complex, false);
  });
});

// ─── ReflectionEngine ─────────────────────────────────────────

describe('ReflectionEngine', () => {
  it('constructor sets defaults', () => {
    const engine = new ReflectionEngine(() => {});
    assert.equal(engine.maxConsecutiveErrors, 3);
    assert.equal(engine.maxStaleIterations, 3);
    assert.equal(engine.staleThreshold, 100);
  });

  it('constructor accepts config', () => {
    const engine = new ReflectionEngine(() => {}, {
      maxConsecutiveErrors: 5,
      maxStaleIterations: 10,
      staleThreshold: 50,
    });
    assert.equal(engine.maxConsecutiveErrors, 5);
    assert.equal(engine.maxStaleIterations, 10);
    assert.equal(engine.staleThreshold, 50);
  });

  it('reflect() returns complete decision', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'complete', reasoning: 'All done', quality: 'high' })
    );
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [{ iteration: 1 }],
      toolResults: [{ tool: 'web_search', success: true, result: 'data' }],
      currentResponse: 'Here is the answer',
    });
    assert.equal(result.decision, 'complete');
    assert.equal(result.quality, 'high');
  });

  it('reflect() returns continue decision', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'Need more data', nextFocus: 'search' })
    );
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [{ tool: 'web_search', success: true, result: 'partial' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'continue');
  });

  it('reflect() returns ask_user decision', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'ask_user', reasoning: 'Need clarification', question: 'Which format?' })
    );
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [{ tool: 'web_search', success: true, result: 'data' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'ask_user');
    assert.equal(result.question, 'Which format?');
  });

  it('reflect() returns fallback decision', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'fallback', reasoning: 'Unrecoverable error' })
    );
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [{ tool: 'web_search', success: true, result: 'data' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'fallback');
  });

  it('reflect() returns continue on unparseable LLM response', async () => {
    const engine = new ReflectionEngine(async () => 'not valid json');
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [{ tool: 'web_search', success: true, result: 'data' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'continue');
  });

  it('reflect() returns continue on chatFn error', async () => {
    const engine = new ReflectionEngine(async () => { throw new Error('boom'); });
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [{ tool: 'web_search', success: true, result: 'data' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'continue');
  });

  it('guardrail: consecutive errors triggers fallback', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'keep going' }),
      { maxConsecutiveErrors: 2 }
    );
    const errorResults = [{ tool: 'x', success: false, result: 'err' }];

    // 1st call: 1 consecutive error
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: errorResults, currentResponse: '' });
    // 2nd call: 2 consecutive errors (hits threshold)
    const result = await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: errorResults, currentResponse: '' });

    assert.equal(result.decision, 'fallback');
    assert.ok(result.reasoning.includes('2'));
  });

  it('guardrail: successful result resets consecutive error count', async () => {
    let callCount = 0;
    const engine = new ReflectionEngine(async () => {
      callCount++;
      if (callCount <= 3) {
        return JSON.stringify({ decision: 'continue', reasoning: 'keep' });
      }
      return JSON.stringify({ decision: 'complete', reasoning: 'done', quality: 'high' });
    }, { maxConsecutiveErrors: 3 });

    const errorResults = [{ tool: 'x', success: false, result: 'err' }];
    const okResults = [{ tool: 'x', success: true, result: 'ok' }];

    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: errorResults, currentResponse: '' });
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: errorResults, currentResponse: '' });
    // Reset with success
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: okResults, currentResponse: '' });
    // Should NOT be fallback now
    const result = await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: errorResults, currentResponse: '' });
    assert.notEqual(result.decision, 'fallback');
  });

  it('guardrail: stale detection triggers complete with low quality', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'keep' }),
      { maxStaleIterations: 1 }
    );
    const sameResults = [{ tool: 'web_search', success: true, result: 'same data' }];

    // Call 1: hash differs from initial empty string, staleCount stays 0
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: sameResults, currentResponse: '' });
    // Call 2: same hash as previous, staleCount becomes 1 >= maxStaleIterations(1)
    const result = await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: sameResults, currentResponse: '' });

    assert.equal(result.decision, 'complete');
    assert.equal(result.quality, 'low');
    assert.ok(result.reasoning.includes('estancado'));
  });

  it('reflect() increments iteration count', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'ok' })
    );
    const results = [{ tool: 'x', success: true, result: 'y' }];
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: results, currentResponse: '' });
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: results, currentResponse: '' });

    const metrics = engine.getMetrics();
    assert.equal(metrics.iterations, 2);
  });

  it('reset() clears all state', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'ok' })
    );
    const results = [{ tool: 'x', success: true, result: 'y' }];
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: results, currentResponse: '' });

    engine.reset();
    const metrics = engine.getMetrics();
    assert.equal(metrics.iterations, 0);
    assert.equal(metrics.consecutiveErrors, 0);
    assert.equal(metrics.staleCount, 0);
  });

  it('getMetrics returns current state', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'ok' })
    );
    const results = [{ tool: 'x', success: true, result: 'y' }];
    await engine.reflect({ objective: 't', plan: [], actionHistory: [], toolResults: results, currentResponse: '' });
    const m = engine.getMetrics();
    assert.equal(m.iterations, 1);
    assert.equal(m.consecutiveErrors, 0);
    assert.equal(m.staleCount, 0);
  });

  it('reflect() works with empty tool results', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'complete', reasoning: 'done', quality: 'medium' })
    );
    const result = await engine.reflect({
      objective: 'test',
      plan: [],
      actionHistory: [],
      toolResults: [],
      currentResponse: 'answer',
    });
    assert.equal(result.decision, 'complete');
  });

  it('reflect() works with plan context', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'continue', reasoning: 'still need step 2' })
    );
    const result = await engine.reflect({
      objective: 'analyze data',
      plan: [
        { description: 'Fetch data from API' },
        { description: 'Process and summarize' },
      ],
      actionHistory: [{ iteration: 1, tools: ['web_fetch'] }],
      toolResults: [{ tool: 'web_fetch', success: true, result: 'raw data' }],
      currentResponse: '',
    });
    assert.equal(result.decision, 'continue');
  });

  it('reflect() handles invalid decision from LLM', async () => {
    const engine = new ReflectionEngine(async () =>
      JSON.stringify({ decision: 'invalid_choice', reasoning: 'bad' })
    );
    const results = [{ tool: 'x', success: true, result: 'y' }];
    const result = await engine.reflect({
      objective: 't', plan: [], actionHistory: [], toolResults: results, currentResponse: '',
    });
    assert.equal(result.decision, 'continue');
  });
});

// ─── AgenticLoop ──────────────────────────────────────────────

describe('AgenticLoop', () => {
  it('constructor creates planner, reflection, and progress', () => {
    const loop = new AgenticLoop({
      chatFn: async () => 'hi',
      toolExecutor: createToolExecutor(),
    });
    assert.ok(loop.planner);
    assert.ok(loop.reflection);
    assert.ok(loop.progress);
    assert.equal(loop.config.maxIterations, 10);
    assert.equal(loop.config.absoluteTimeout, 60000);
  });

  it('constructor merges custom config', () => {
    const loop = new AgenticLoop({
      chatFn: async () => 'hi',
      toolExecutor: createToolExecutor(),
      config: { maxIterations: 5, absoluteTimeout: 10000 },
    });
    assert.equal(loop.config.maxIterations, 5);
    assert.equal(loop.config.absoluteTimeout, 10000);
    assert.equal(loop.config.enablePlanning, true);
  });

  it('constructor sets default callbacks when none provided', () => {
    const loop = new AgenticLoop({
      chatFn: async () => 'hi',
      toolExecutor: createToolExecutor(),
    });
    assert.equal(typeof loop._onProgress, 'function');
    assert.equal(typeof loop._onToolCall, 'function');
  });

  it('execute() returns error when no chatFn', async () => {
    const loop = new AgenticLoop({
      chatFn: null,
      toolExecutor: createToolExecutor(),
    });
    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });
    assert.ok(result.response.includes('Error'));
    assert.equal(result.metadata.error, 'no chatFn');
    assert.equal(result.metadata.agentic, true);
  });

  it('execute() returns text response when no tools called', async () => {
    const chatFn = createChatFn(['Hello! That is a simple question.']);
    const toolExecutor = createToolExecutor({
      parseToolCalls: () => [],
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'greeting',
      context: [{ role: 'user', content: 'hi' }],
      analysis: {},
      systemPrompt: 'You are helpful.',
    });

    assert.ok(result.response.includes('Hello'));
    assert.equal(result.metadata.agentic, true);
    assert.equal(result.metadata.decision, 'complete');
    assert.ok(result.metadata.duration >= 0);
  });

  it('execute() calls tools and processes results', async () => {
    // Short objective (<50 chars) → planner skipped. Sequence: iter0(toolCall), reflection(complete)
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { query: 'test' } }] }),
      JSON.stringify({ decision: 'complete', reasoning: 'Found it', quality: 'high' }),
      'Based on the search, here is the answer.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return parsed.tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'search results here',
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'search for test',
      context: [{ role: 'user', content: 'search for test' }],
      analysis: {},
      systemPrompt: 'You are helpful.',
    });

    assert.equal(result.metadata.toolCalls, 1);
    assert.ok(result.response.length > 0);
  });

  it('execute() respects absoluteTimeout', async () => {
    // Long objective → planner calls chatFn. Use a slow chatFn to guarantee timeout.
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] }),
    ]);
    // Wrap with delay
    const slowChatFn = async (...args) => {
      await delay(5);
      return chatFn(...args);
    };

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return parsed.tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({
      chatFn: slowChatFn,
      toolExecutor,
      config: { absoluteTimeout: 1 },
    });

    const result = await loop.execute({
      objective: 'do something complex with multiple searches and analysis',
      context: [{ role: 'user', content: 'complex task' }],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(result.metadata.decision, 'fallback');
    assert.ok(result.metadata.reasoning.includes('Timeout'));
  });

  it('execute() handles chatFn errors gracefully', async () => {
    let callCount = 0;
    const chatFn = async () => {
      callCount++;
      throw new Error('API timeout');
    };

    const toolExecutor = createToolExecutor();
    const loop = new AgenticLoop({ chatFn, toolExecutor });

    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(result.metadata.decision, 'fallback');
    assert.ok(result.metadata.reasoning.includes('Error'));
  });

  it('execute() tracks metrics correctly', async () => {
    // Short objective → planner skipped. Sequence: iter0(toolCall), reflection(complete)
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'run_code', args: { code: '1+1' } }] }),
      JSON.stringify({ decision: 'complete', reasoning: 'Done', quality: 'high' }),
      'The result is 2.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 2,
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    await loop.execute({
      objective: 'calculate',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    const metrics = loop.getMetrics();
    assert.ok(metrics.totalIterations >= 1);
    assert.equal(metrics.totalToolCalls, 1);
  });

  it('execute() reports planningUsed when plan is complex', async () => {
    const complexPlan = JSON.stringify({
      complex: true,
      objective: 'complex task',
      steps: [
        { id: 1, description: 'Step 1', successCriteria: 'done' },
        { id: 2, description: 'Step 2', successCriteria: 'done' },
      ],
    });

    // Long objective (>50 chars) → planner calls chatFn. Sequence: plan, iter0(text), done
    const longObj = 'Perform comprehensive analysis of all sales data across multiple regions';
    const chatFn = createChatFn([
      complexPlan,
      'Final answer after complex analysis.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: () => [],
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    await loop.execute({
      objective: longObj,
      context: [],
      analysis: { complexity: 'high' },
      systemPrompt: 'prompt',
    });

    const metrics = loop.getMetrics();
    assert.equal(metrics.planningUsed, true);
  });

  it('execute() calls onProgress callback', async () => {
    const progressEvents = [];
    const chatFn = createChatFn(['Simple answer.']);
    const toolExecutor = createToolExecutor({ parseToolCalls: () => [] });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      onProgress: (e) => progressEvents.push(e),
    });

    await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.ok(progressEvents.length > 0);
    const progressEvt = progressEvents.find(e => e.event === 'progress');
    assert.ok(progressEvt);
  });

  it('execute() calls onToolCall for each tool call', async () => {
    const toolCalls = [];
    // Short objective → planner skipped. Sequence: iter0(2 tools), reflection(complete)
    const chatFn = createChatFn([
      JSON.stringify({
        tool_calls: [
          { name: 'web_search', args: { q: 'a' } },
          { name: 'run_code', args: { code: '1' } },
        ],
      }),
      JSON.stringify({ decision: 'complete', reasoning: 'Done', quality: 'high' }),
      'Done.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: name === 'web_search' ? 'a' : 'b',
      }),
    });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      onToolCall: (tc) => toolCalls.push(tc),
    });

    await loop.execute({
      objective: 'multi tool',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].name, 'web_search');
    assert.equal(toolCalls[1].name, 'run_code');
  });

  it('execute() allows runtime chatFn override', async () => {
    const overrideChatFn = createChatFn(['Override response.']);
    const originalChatFn = createChatFn(['Original response.']);
    const toolExecutor = createToolExecutor({ parseToolCalls: () => [] });

    const loop = new AgenticLoop({
      chatFn: originalChatFn,
      toolExecutor,
    });

    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
      chatFn: overrideChatFn,
    });

    assert.ok(result.response.includes('Override'));
  });

  it('execute() disables planning when config.enablePlanning is false', async () => {
    const chatFn = createChatFn([
      'Planned response.',
      'Simple answer.',
    ]);

    const toolExecutor = createToolExecutor({ parseToolCalls: () => [] });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      config: { enablePlanning: false },
    });

    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    const metrics = loop.getMetrics();
    assert.equal(metrics.planningUsed, false);
  });

  it('execute() disables reflection when config.enableReflection is false', async () => {
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] }),
      'Response after tool.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      config: { enableReflection: false },
    });

    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.ok(result.response.length > 0);
    assert.equal(result.metadata.agentic, true);
  });

  it('execute() limits tools per round', async () => {
    const toolCallsReceived = [];
    // Short objective → planner skipped. Sequence: iter0(6 tools), reflection(complete)
    const chatFn = createChatFn([
      JSON.stringify({
        tool_calls: [
          { name: 'web_search', args: { q: 1 } },
          { name: 'web_search', args: { q: 2 } },
          { name: 'web_search', args: { q: 3 } },
          { name: 'web_search', args: { q: 4 } },
          { name: 'web_search', args: { q: 5 } },
          { name: 'web_search', args: { q: 6 } },
        ],
      }),
      JSON.stringify({ decision: 'complete', reasoning: 'Done', quality: 'high' }),
      'Done.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: null,
      }),
    });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      config: { maxToolsPerRound: 3 },
      onToolCall: (tc) => toolCallsReceived.push(tc),
    });

    await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(toolCallsReceived.length, 3);
  });

  it('execute() returns metadata with actionHistory', async () => {
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'run_code', args: { code: '1' } }] }),
      'Result is 1.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 1,
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'calc',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.ok(Array.isArray(result.metadata.actionHistory));
    assert.ok(result.metadata.actionHistory.length >= 1);
    assert.ok(result.metadata.actionHistory[0].tools.includes('run_code'));
  });

  it('getMetrics returns reflection metrics too', async () => {
    const loop = new AgenticLoop({
      chatFn: async () => 'hi',
      toolExecutor: createToolExecutor(),
    });
    const metrics = loop.getMetrics();
    assert.ok(metrics.reflection);
    assert.equal(typeof metrics.reflection.iterations, 'number');
  });

  it('execute() handles ask_user decision from reflection', async () => {
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] }),
      JSON.stringify({ decision: 'ask_user', reasoning: 'need info', question: 'Which one?' }),
      'Which do you prefer: A or B?',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          const p = JSON.parse(raw);
          return p.tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'choose option',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(result.metadata.decision, 'ask_user');
  });

  it('execute() handles fallback decision from reflection', async () => {
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] }),
      JSON.stringify({ decision: 'fallback', reasoning: 'all failed' }),
      'Sorry, I could not complete the task.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          const p = JSON.parse(raw);
          return p.tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: false,
        result: 'error',
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'failing task',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(result.metadata.decision, 'fallback');
  });

  it('execute() handles final chatFn error gracefully', async () => {
    let callCount = 0;
    const chatFn = async () => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] });
      }
      throw new Error('final call failed');
    };

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          const p = JSON.parse(raw);
          return p.tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    const result = await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.ok(result.response.length > 0);
  });

  it('execute() tracks decisions in metrics', async () => {
    const chatFn = createChatFn([
      JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: 1 } }] }),
      JSON.stringify({ decision: 'complete', reasoning: 'done', quality: 'high' }),
      'All done.',
    ]);

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({ chatFn, toolExecutor });
    await loop.execute({
      objective: 'test',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    const metrics = loop.getMetrics();
    assert.equal(metrics.decisions.complete, 1);
    assert.equal(metrics.decisions.continue, 0);
  });

  it('execute() builds correct messages with tool results', async () => {
    let capturedMessages = null;
    const chatFn = async (messages) => {
      capturedMessages = messages;
      return 'final answer';
    };

    const toolExecutor = createToolExecutor({ parseToolCalls: () => [] });
    const loop = new AgenticLoop({ chatFn, toolExecutor });

    await loop.execute({
      objective: 'test',
      context: [{ role: 'user', content: 'hello' }],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.ok(capturedMessages);
    assert.ok(capturedMessages.some(m => m.content === 'hello'));
  });

  it('execute() maxIterations triggers fallback', async () => {
    let callCount = 0;
    const chatFn = async () => {
      callCount++;
      return JSON.stringify({ tool_calls: [{ name: 'web_search', args: { q: callCount } }] });
    };

    const toolExecutor = createToolExecutor({
      parseToolCalls: (raw) => {
        try {
          return JSON.parse(raw).tool_calls || [];
        } catch {
          return [];
        }
      },
      execute: async (name, args) => ({
        tool: name,
        success: true,
        result: 'data',
      }),
    });

    const loop = new AgenticLoop({
      chatFn,
      toolExecutor,
      config: { maxIterations: 2, enablePlanning: false, enableReflection: false },
    });

    const result = await loop.execute({
      objective: 'infinite task',
      context: [],
      analysis: {},
      systemPrompt: 'prompt',
    });

    assert.equal(result.metadata.decision, 'fallback');
    assert.ok(result.metadata.reasoning.includes('iteraciones'));
  });
});
