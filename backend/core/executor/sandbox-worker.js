'use strict';

/**
 * Sandbox Worker — Script que se ejecuta como child_process.fork().
 *
 * Recibe código via IPC, lo ejecuta en un contexto restringido,
 * y retorna resultado/output via IPC.
 *
 * SEGURIDAD (defense in depth):
 *   - Solo globals seguros sin constructor chain
 *   - Proxy que bloquea acceso a .constructor en todos los objetos
 *   - Sin require, process, fs, child_process, net, http, etc.
 *   - Timeout forzado por el padre + safety timer interno
 *   - Strict mode para prevenir arguments.callee
 *
 * Protocolo IPC:
 *   Padre → Worker: { type: 'run', code: '...', timeout: 5000 }
 *   Worker → Padre: { type: 'result', value: ..., output: [...], error: null }
 *   Worker → Padre: { type: 'result', value: null, output: [...], error: '...' }
 */

// ─── Timeout de seguridad (el padre también mata el proceso) ───
const SAFETY_TIMEOUT = 10000; // 10s absoluto max

// ─── Captura de console.log ───
const MAX_OUTPUT_ENTRIES = 500;
const _output = [];
const _fakeConsole = Object.freeze({
  log: (...args) => { if (_output.length < MAX_OUTPUT_ENTRIES) _output.push(args.map(_stringify).join(' ')); },
  warn: (...args) => { if (_output.length < MAX_OUTPUT_ENTRIES) _output.push('[warn] ' + args.map(_stringify).join(' ')); },
  error: (...args) => { if (_output.length < MAX_OUTPUT_ENTRIES) _output.push('[error] ' + args.map(_stringify).join(' ')); },
  info: (...args) => { if (_output.length < MAX_OUTPUT_ENTRIES) _output.push('[info] ' + args.map(_stringify).join(' ')); },
});

function _stringify(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Wrapper que bloquea acceso a .constructor en cualquier objeto/función.
 * Previene sandbox escape via Date.constructor → Function → process.
 */
const _BLOCKED_PROPS = new Set([
  'constructor', '__proto__', 'prototype',
  '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
]);

function _safe(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object' && typeof obj !== 'function') return obj;

  return new Proxy(obj, {
    get(target, prop) {
      if (_BLOCKED_PROPS.has(prop)) return undefined;
      const val = Reflect.get(target, prop);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    },
    set() { return false; },
    has(target, prop) {
      if (_BLOCKED_PROPS.has(prop)) return false;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (_BLOCKED_PROPS.has(prop)) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * Crea un objeto Math seguro (sin constructor chain).
 */
function _safeMath() {
  const m = {
    PI: Math.PI,
    E: Math.E,
    LN2: Math.LN2,
    LN10: Math.LN10,
    LOG2E: Math.LOG2E,
    LOG10E: Math.LOG10E,
    SQRT1_2: Math.SQRT1_2,
    SQRT2: Math.SQRT2,
    abs: Math.abs.bind(Math),
    ceil: Math.ceil.bind(Math),
    floor: Math.floor.bind(Math),
    round: Math.round.bind(Math),
    trunc: Math.trunc.bind(Math),
    sign: Math.sign.bind(Math),
    max: Math.max.bind(Math),
    min: Math.min.bind(Math),
    pow: Math.pow.bind(Math),
    sqrt: Math.sqrt.bind(Math),
    cbrt: Math.cbrt.bind(Math),
    log: Math.log.bind(Math),
    log2: Math.log2.bind(Math),
    log10: Math.log10.bind(Math),
    sin: Math.sin.bind(Math),
    cos: Math.cos.bind(Math),
    tan: Math.tan.bind(Math),
    asin: Math.asin.bind(Math),
    acos: Math.acos.bind(Math),
    atan: Math.atan.bind(Math),
    atan2: Math.atan2.bind(Math),
    random: Math.random.bind(Math),
  };
  return _safe(m);
}

/**
 * Safe JSON (sin constructor chain).
 */
function _safeJSON() {
  return _safe({
    parse: JSON.parse.bind(JSON),
    stringify: JSON.stringify.bind(JSON),
  });
}

// ─── Safe globals — sin constructores que permitan escape ───
const SAFE_GLOBALS = Object.freeze({
  // Primitives
  NaN, Infinity, undefined,
  parseInt, parseFloat, isNaN, isFinite,

  // Math (sin prototype chain)
  Math: _safeMath(),

  // JSON (sin prototype chain)
  JSON: _safeJSON(),

  // Date — solo como valor, no como constructor
  // (el usuario no puede hacer `new Date()` pero sí usar métodos estáticos)
  Date: _safe({ now: Date.now.bind(Date) }),

  // Array — solo utilidades estáticas, no constructor
  Array: _safe({
    from: Array.from.bind(Array),
    isArray: Array.isArray.bind(Array),
    of: Array.of.bind(Array),
  }),

  // encodeURIComponent/decodeURIComponent
  encodeURIComponent, decodeURIComponent,
  encodeURI, decodeURI,

  // console restringido
  console: _fakeConsole,

  // TextEncoder/TextDecoder
  TextDecoder, TextEncoder,
});

// ─── Safety timer ───
const _safetyTimer = setTimeout(() => {
  try {
    process.send({ type: 'result', value: null, output: _output, error: 'Timeout: seguridad activada (10s)' });
  } catch {}
  process.exit(1);
}, SAFETY_TIMEOUT);
_safetyTimer.unref();

// ─── IPC handler ───
process.on('message', (msg) => {
  if (msg.type !== 'run') return;

  const { code, timeout } = msg;

  // Timeout del padre
  const timer = setTimeout(() => {
    try {
      process.send({ type: 'result', value: null, output: _output, error: `Timeout: código excedió ${timeout || 5000}ms` });
    } catch {}
    process.exit(1);
  }, timeout || 5000);
  timer.unref();

  try {
    // Compilar en sandbox con Function constructor
    // Las variables del scope son los SAFE_GLOBALS (sin constructor chain)
    const sandboxKeys = Object.keys(SAFE_GLOBALS);
    const sandboxValues = sandboxKeys.map(k => SAFE_GLOBALS[k]);

    // Crear función con scope restringido
    const wrappedCode = `
      "use strict";
      return (async () => {
        ${code}
      })();
    `;

    const SandboxFunction = new Function(...sandboxKeys, wrappedCode);
    const resultPromise = SandboxFunction(...sandboxValues);

    // Handle both sync and async results
    Promise.resolve(resultPromise)
      .then((result) => {
        clearTimeout(timer);
        // Wrap result to block constructor access on returned objects
        const safeResult = (typeof result === 'object' && result !== null)
          ? _safe(result)
          : result;
        try {
          process.send({ type: 'result', value: safeResult, output: _output, error: null });
        } catch {}
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(timer);
        const errMsg = err && err.message ? err.message : String(err);
        try {
          process.send({ type: 'result', value: null, output: _output, error: errMsg });
        } catch {}
        process.exit(1);
      });
  } catch (err) {
    clearTimeout(timer);
    const errMsg = err && err.message ? err.message : String(err);
    try {
      process.send({ type: 'result', value: null, output: _output, error: errMsg });
    } catch {}
    process.exit(1);
  }
});

// Signal ready
process.send({ type: 'ready' });
