'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI HTTP-LEVEL AUDIT — Standalone (NO modifica providers/gemini.js)
// ═══════════════════════════════════════════════════════════════════════════════
// Uso:  cd backend && node audit-gemini-http.js
// Salida: consola con 3 bloques por llamada (REQUEST / RESPONSE / ANÁLISIS)
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL   = 'gemini-2.0-flash';

if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY no está definida en .env');
  process.exit(1);
}

// ─── SANITIZER ──────────────────────────────────────────────────────────────
function sanitizeHeaders(headers) {
  const safe = {};
  const h = headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : (typeof headers === 'object' && headers !== null ? headers : {});
  for (const [k, v] of Object.entries(h)) {
    if (/key|auth|token|secret/i.test(k)) {
      safe[k] = `[REDACTED len=${String(v).length}]`;
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

function truncate(str, max = 80) {
  if (!str) return '';
  return str.length > max ? `"${str.substring(0, max)}…"[len=${str.length}]` : `"${str}"`;
}

// ─── PRINT HELPERS ──────────────────────────────────────────────────────────
const SEP = '═'.repeat(80);
const SEP2 = '─'.repeat(80);

function printRequest(modelName, captured) {
  console.log(`\n${SEP}`);
  console.log('  GEMINI HTTP AUDIT — REQUEST');
  console.log(SEP);
  console.log(`  MODEL:     ${modelName}`);
  console.log(`  METHOD:    ${captured.method}`);
  console.log(`  URL:       ${captured.url}`);
  console.log(`\n${SEP2}`);
  console.log('  REQUEST HEADERS (sin API key):');
  console.log(JSON.stringify(captured.headers, null, 2));

  console.log(`\n${SEP2}`);
  console.log('  REQUEST BODY:');

  const body = captured.body;
  if (!body || typeof body !== 'object') {
    console.log('  [RAW]', String(body).substring(0, 500));
    console.log(SEP);
    return;
  }

  // ── contents ──
  if (body.contents) {
    console.log('  contents:');
    if (!Array.isArray(body.contents)) {
      console.log(`    [WARN] no es array, es ${typeof body.contents}`);
    } else {
      body.contents.forEach((c, ci) => {
        console.log(`    [{${ci}}] role: "${c.role}"`);
        if (Array.isArray(c.parts)) {
          console.log(`           parts: (${c.parts.length})`);
          c.parts.forEach((p, pi) => {
            if (p.text !== undefined) {
              console.log(`             [{${pi}}] text: ${truncate(p.text)}`);
            }
            if (p.inlineData) {
              const d = p.inlineData.data || '';
              console.log(`             [{${pi}}] inlineData:`);
              console.log(`                   mimeType: "${p.inlineData.mimeType}"`);
              console.log(`                   data.length: ${d.length} chars`);
              console.log(`                   data[0:50]:  "${d.substring(0, 50)}"`);
            }
          });
        } else {
          console.log(`           parts: [MISSING]`);
        }
      });
    }
  }

  // ── systemInstruction ──
  if (body.systemInstruction !== undefined) {
    console.log('\n  systemInstruction:');
    const si = body.systemInstruction;
    if (typeof si === 'string') {
      console.log(`    type: string (raw)`);
      console.log(`    len: ${si.length}`);
      console.log(`    preview: ${truncate(si, 120)}`);
    } else if (si && typeof si === 'object') {
      if (Array.isArray(si.parts)) {
        si.parts.forEach((p, i) => {
          const t = p.text || '';
          console.log(`    parts[${i}]: text len=${t.length} — ${truncate(t, 120)}`);
        });
      } else {
        console.log('    ' + JSON.stringify(si).substring(0, 300));
      }
    }
  }

  // ── generationConfig ──
  if (body.generationConfig) {
    console.log('\n  generationConfig:');
    console.log(JSON.stringify(body.generationConfig, null, 4).split('\n').map(l => '    ' + l).join('\n'));
  }

  // ── tools ──
  if (body.tools) {
    console.log(`\n  tools: present (${body.tools.length} tool definitions)`);
  }

  // ── safetySettings ──
  if (body.safetySettings) {
    console.log(`\n  safetySettings: present (${body.safetySettings.length} categories)`);
  }

  console.log(SEP);
}

function printResponse(resp) {
  console.log(`\n${SEP}`);
  console.log('  GEMINI HTTP AUDIT — RESPONSE');
  console.log(SEP);
  console.log(`  STATUS:  ${resp.status} ${resp.statusText}`);
  console.log(`  ELAPSED: ${resp.elapsed}ms`);
  console.log(`\n${SEP2}`);
  console.log('  RESPONSE HEADERS:');
  console.log(JSON.stringify(resp.headers, null, 2));

  console.log(`\n${SEP2}`);
  console.log('  RESPONSE BODY:');

  if (resp.body && typeof resp.body === 'object') {
    const str = JSON.stringify(resp.body, null, 2);
    if (str.length > 4000) {
      console.log(str.substring(0, 4000));
      console.log(`  [... TRUNCATED — total ${str.length} chars]`);
    } else {
      console.log(str);
    }
  } else {
    console.log(String(resp.body).substring(0, 1000));
  }
  console.log(SEP);
}

function printAnalysis(reqBody, resp) {
  console.log(`\n${SEP}`);
  console.log('  GEMINI AUDIT — ANÁLISIS vs DOCUMENTACIÓN');
  console.log(SEP);

  const issues = [];

  // ── Validar contents ──
  if (!reqBody?.contents) {
    issues.push('FATAL  contents ausente');
  } else if (!Array.isArray(reqBody.contents)) {
    issues.push('FATAL  contents no es array');
  } else {
    reqBody.contents.forEach((c, i) => {
      if (!c.role) {
        issues.push(`ERR    contents[${i}]: falta "role"`);
      } else if (!['user', 'model'].includes(c.role)) {
        issues.push(`ERR    contents[${i}].role="${c.role}" — solo "user"|"model" permitidos`);
      }
      if (!Array.isArray(c.parts)) {
        issues.push(`ERR    contents[${i}]: falta "parts" array`);
      } else {
        c.parts.forEach((p, pi) => {
          if (p.text !== undefined && typeof p.text !== 'string') {
            issues.push(`ERR    contents[${i}].parts[${pi}].text no es string`);
          }
          if (p.inlineData) {
            if (!p.inlineData.mimeType || typeof p.inlineData.mimeType !== 'string') {
              issues.push(`ERR    contents[${i}].parts[${pi}].inlineData: mimeType inválido`);
            }
            if (!p.inlineData.data || typeof p.inlineData.data !== 'string') {
              issues.push(`ERR    contents[${i}].parts[${pi}].inlineData: data inválido`);
            }
            // Verificar que data sea base64 válido
            if (p.inlineData.data && !/^[A-Za-z0-9+/=\s]+$/.test(p.inlineData.data.substring(0, 100))) {
              issues.push(`WARN   contents[${i}].parts[${pi}].inlineData: data no parece base64`);
            }
          }
          const allowed = ['text', 'inlineData', 'functionCall', 'functionResponse',
                           'executableCode', 'codeExecutionResult', 'fileData'];
          const extra = Object.keys(p).filter(k => !allowed.includes(k));
          if (extra.length > 0) {
            issues.push(`WARN   contents[${i}].parts[${pi}]: campos inesperados: [${extra}]`);
          }
        });
      }
    });
  }

  // ── Validar systemInstruction ──
  if (reqBody?.systemInstruction !== undefined) {
    const si = reqBody.systemInstruction;
    if (typeof si === 'string') {
      issues.push('WARN   systemInstruction es string plano — API espera {parts:[{text}]}');
    } else if (si && typeof si === 'object' && !Array.isArray(si)) {
      if (!si.parts || !Array.isArray(si.parts)) {
        issues.push('ERR    systemInstruction: falta "parts" array');
      }
    }
  }

  // ── Validar response ──
  if (resp.status >= 400) {
    issues.push(`FATAL  HTTP ${resp.status}: ${resp.body?.error?.message || 'sin detalle'}`);
  }
  if (resp.status === 200) {
    if (resp.body?.candidates) {
      console.log(`  OK   HTTP 200 — ${resp.body.candidates.length} candidato(s)`);
      resp.body.candidates.forEach((cand, ci) => {
        const reason = cand.finishReason || 'N/A';
        const safety = cand.safetyRatings?.map(r => `${r.category}:${r.probability}`).join(', ') || 'none';
        console.log(`       candidate[${ci}]: finishReason=${reason}`);
        console.log(`       safetyRatings: ${safety}`);
        if (cand.content?.parts) {
          cand.content.parts.forEach((p, pi) => {
            if (p.text) console.log(`         part[${pi}]: text="${p.text.substring(0, 100)}…"`);
            if (p.thought) console.log(`         part[${pi}]: thought=true`);
          });
        }
      });
    } else if (resp.body?.promptFeedback) {
      issues.push('WARN   Response tiene promptFeedback pero NO candidates');
      console.log('  promptFeedback:', JSON.stringify(resp.body.promptFeedback, null, 2));
    } else {
      issues.push('WARN   HTTP 200 pero sin candidates ni promptFeedback');
    }
  }

  // ── Resumen ──
  if (issues.length === 0) {
    console.log('\n  RESULTADO: OK — Sin problemas detectados');
  } else {
    console.log('\n  RESULTADO: ISSUES ENCONTRADOS');
    issues.forEach(iss => console.log(`    ${iss}`));
  }
  console.log(SEP);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERCEPTOR — monkey-patch globalThis.fetch
// ═══════════════════════════════════════════════════════════════════════════════
const _origFetch = globalThis.fetch;
let _lastCapturedReq = null;
let _lastCapturedResp = null;

globalThis.fetch = async function auditFetch(url, init) {
  const urlStr = typeof url === 'string' ? url : url?.url || '';

  if (urlStr.includes('generativelanguage.googleapis.com')) {

    // Capturar request
    let body = null;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    } catch { body = init?.body; }

    _lastCapturedReq = {
      method: init?.method || 'POST',
      url: urlStr,
      headers: sanitizeHeaders(init?.headers),
      body
    };

    const t0 = Date.now();
    const response = await _origFetch(url, init);
    const elapsed = Date.now() - t0;

    // Capturar response (clonar para no consumir)
    const clone = response.clone();
    let respBody = null;
    try { respBody = JSON.parse(await clone.text()); }
    catch { respBody = await response.clone().text().catch(() => '<<parse error>>'); }

    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    _lastCapturedResp = {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
      body: respBody,
      elapsed
    };

    return response;
  }
  return _origFetch(url, init);
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════
async function runTest(label, messages) {
  console.log(`\n${'#'.repeat(80)}`);
  console.log(`  TEST: ${label}`);
  console.log(`${'#'.repeat(80)}`);

  _lastCapturedReq = null;
  _lastCapturedResp = null;

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL });

  // Re-implement the exact same logic as providers/gemini.js
  const rawContents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'text') return { text: part.text };
            if (part.type === 'image_url') {
              const url = part.image_url?.url || '';
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
              return { text: '[image]' };
            }
            return { text: JSON.stringify(part) };
          })
        : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

  const contents = [];
  for (const msg of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === msg.role) {
      contents[contents.length - 1].parts.push(...msg.parts);
    } else {
      contents.push(msg);
    }
  }

  const systemInstruction = messages
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n\n');

  try {
    const result = await model.generateContentStream({
      contents,
      systemInstruction: systemInstruction || undefined
    });

    // Consume stream
    let full = '';
    for await (const chunk of result.stream) {
      const t = chunk.text();
      if (t) full += t;
    }
    console.log(`  [STREAM COMPLETE — ${full.length} chars]`);
  } catch (err) {
    console.log(`  [STREAM ERROR: ${err.message}]`);
  }

  // Print captured data
  if (_lastCapturedReq) {
    printRequest(MODEL, _lastCapturedReq);
  } else {
    console.log('  [NO SE CAPTURÓ REQUEST — ¿fetch no fue interceptado?]');
  }

  if (_lastCapturedResp) {
    printResponse(_lastCapturedResp);
    if (_lastCapturedReq) {
      printAnalysis(_lastCapturedReq.body, _lastCapturedResp);
    }
  } else {
    console.log('  [NO SE CAPTURÓ RESPONSE]');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  GEMINI HTTP-LEVEL AUDIT                                      ║');
  console.log('║  Script standalone — no modifica providers/gemini.js           ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // TEST 1: Texto plano
  await runTest('TEXTO PLAIN — mensaje simple', [
    { role: 'user', content: 'Respondés en español. Decí solo: "Hola, soy Paprika."' }
  ]);

  // TEST 2: Texto + system instruction
  await runTest('SYSTEM INSTRUCTION — con instrucción de sistema', [
    { role: 'system', content: 'Sos Paprika, una asistente IA de 22 años de Buenos Aires.' },
    { role: 'user', content: '¿Quién sos?' }
  ]);

  // TEST 3: Imagen (1x1 PNG blanco)
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  await runTest('IMAGEN — texto + inlineData PNG', [
    { role: 'user', content: [
      { type: 'text', text: '¿Qué ves en esta imagen? Describila brevemente.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }
    ]}
  ]);

  // TEST 4: Multi-turn
  await runTest('MULTI-TURN — conversación con historial', [
    { role: 'user',      content: 'Me llamo Fernando.' },
    { role: 'assistant', content: 'Hola Fernando, gusto en conocerte.' },
    { role: 'user',      content: '¿Cómo me llamo?' }
  ]);

  // Restaurar fetch
  globalThis.fetch = _origFetch;
  console.log('\n✅ Audit completo. fetch original restaurado.');
})();
