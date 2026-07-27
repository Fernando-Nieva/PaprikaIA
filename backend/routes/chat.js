const express = require('express');
const router = express.Router();
const db = require('../db');
const { chat } = require('../ollama');

let core = null;

function setupRoutes(paprikaCore) {
  core = paprikaCore;
}

router.get('/conversations', (req, res) => {
  res.json(db.getConversations());
});

router.post('/conversations', (req, res) => {
  const { title } = req.body;
  res.json(db.createConversation(title));
});

router.delete('/conversations/:id', (req, res) => {
  db.deleteConversation(parseInt(req.params.id));
  res.json({ ok: true });
});

router.get('/conversations/:id/messages', (req, res) => {
  const msgs = db.getMessages(parseInt(req.params.id));
  // Parse JSON attachments from DB
  res.json(msgs.map(m => ({
    ...m,
    attachments: m.attachments ? (() => { try { return JSON.parse(m.attachments); } catch { return []; } })() : [],
  })));
});

router.post('/conversations/:id/messages', async (req, res) => {
  const conversationId = parseInt(req.params.id);
  const { content, attachments } = req.body;

  if (process.env.DEBUG_ATTACHMENTS === 'true') {
    console.log('\n══════════════════════════════════════════════════');
    console.log('📂 [DEBUG ATTACHMENTS] Etapa 1: chat.js — Llegada');
    console.log('══════════════════════════════════════════════════');
    console.log('  Content:', typeof content, content ? content.substring(0, 80) : '(vacio)');
    console.log('  Attachments recibidos:', attachments ? attachments.length : 0);
    if (attachments && attachments.length > 0) {
      attachments.forEach((att, i) => {
        console.log(`  [${i}] fields:`, Object.keys(att));
        console.log(`  [${i}] mimeType:`, att.mimeType);
        console.log(`  [${i}] filename:`, att.filename);
        console.log(`  [${i}] has base64:`, !!att.base64, 'length:', att.base64 ? att.base64.length : 0);
        console.log(`  [${i}] has id:`, !!att.id);
        console.log(`  [${i}] preview:`, att.base64 ? att.base64.substring(0, 30) + '...' : '(sin base64)');
      });
    }
  }

  db.addMessage(conversationId, 'user', content, null, JSON.stringify(attachments || []));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const safeWrite = (data) => {
    if (!res.destroyed && !req.aborted) {
      try { res.write(data); } catch {}
    }
  };

  let fullResponse = '';
  let richAttachments = [];

  try {
    if (core) {
      // Paprika Core pipeline: pasa por analyzer → emotions → memory → context → provider → response processor
      if (process.env.DEBUG_ATTACHMENTS === 'true') {
        console.log('  → Enviando a core.processMessage, attachments:', (attachments || []).length);
      }
      const result = await core.processMessage({
        message: content,
        conversationId,
        userId: 'default',
        getHistory: () => db.getMessages(conversationId),
        chatFn: chat,
        attachments: attachments || [],
        onChunk: (chunk, type) => {
          if (type === 'text') {
            fullResponse += chunk;
            safeWrite(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
          } else if (type === 'tool') {
            safeWrite(`data: ${JSON.stringify({ type: 'tool', content: chunk })}\n\n`);
            // Also send tool events to process console
            safeWrite(`data: ${JSON.stringify({ type: 'process', step: 'Tool', detail: typeof chunk === 'string' ? chunk.trim() : '', level: 'tool', ts: Date.now() })}\n\n`);
          } else if (type === 'attachments') {
            // Rich content attachments (cards, videos, images, etc.)
            const atts = Array.isArray(chunk) ? chunk : [];
            richAttachments = richAttachments.concat(atts);
            safeWrite(`data: ${JSON.stringify({ type: 'attachments', data: atts })}\n\n`);
          }
        },
        onProcess: (proc) => {
          safeWrite(`data: ${JSON.stringify({ type: 'process', ...proc })}\n\n`);
        }
      });
      if (!fullResponse && result.response) {
        fullResponse = result.response;
      }
    } else {
      // Fallback: sistema actual directo (si Core no está inicializado)
      const history = db.getMessages(conversationId);
      const messages = history.map(m => ({ role: m.role, content: m.content }));
      await chat(messages, (chunk, type) => {
        if (type === 'text') {
          fullResponse += chunk;
          safeWrite(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
        } else if (type === 'tool') {
          safeWrite(`data: ${JSON.stringify({ type: 'tool', content: chunk })}\n\n`);
        }
      });
    }

    db.addMessage(conversationId, 'assistant', fullResponse, null, richAttachments.length > 0 ? JSON.stringify(richAttachments) : null);

    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === conversationId);
    if (conv && conv.title === 'Nueva conversación') {
      const shortTitle = content.substring(0, 40) + (content.length > 40 ? '...' : '');
      db.updateConversationTitle(conversationId, shortTitle);
    }

    safeWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

    if (process.env.DEBUG_ATTACHMENTS === 'true' && attachments && attachments.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════════════════');
      console.log('📊 [DEBUG ATTACHMENTS] TABLA RESUMEN (chat.js — post-response)');
      console.log('═══════════════════════════════════════════════════════════════════');
      const responseMentionsImage = fullResponse && /imagen|foto|image|photo|veo|observo|detecto|puedo ver/i.test(fullResponse);
      const responseDeniesImage = fullResponse && /no (puedo|veo|tengo|es|hay)|no.*imagen|no.*foto|sin imagen/i.test(fullResponse);

      console.log('  ETAPA              │ ARCHIVO         │ DETALLE');
      console.log('  ───────────────────┼─────────────────┼─────────────────────────');
      console.log(`  1. Frontend        │ ${attachments[0]?.filename?.substring(0, 13) || '(sin nombre)'} │ mime=${attachments[0]?.mimeType}`);
      console.log(`  2. API (chat.js)   │                 │ ${attachments.length} attachment(s), ${attachments[0]?.base64?.length || 0} chars base64`);
      console.log(`  3. Pipeline P0     │                 │ (ver logs server)`);
      console.log(`  4. AgenticLoop     │                 │ (ver logs server)`);
      console.log(`  5. Provider        │                 │ (ver logs server)`);
      console.log(`  6. Modelo          │                 │ response ${fullResponse?.length || 0} chars`);
      console.log('  ───────────────────┼─────────────────┼─────────────────────────');
      console.log('');
      if (responseDeniesImage) {
        console.log('  🔴 DIAGNÓSTICO: El modelo NO DETECTA la imagen.');
      } else if (responseMentionsImage) {
        console.log('  🟢 DIAGNÓSTICO: El modelo SÍ DETECTA la imagen.');
      } else {
        console.log('  🟡 DIAGNÓSTICO: Respuesta ambigua — revisar logs completos arriba.');
        console.log('  Response:', (fullResponse || '').substring(0, 200));
      }
      console.log('═══════════════════════════════════════════════════════════════════\n');
    }
  } catch (err) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    safeWrite(`data: ${JSON.stringify({ type: 'process', step: 'Error', detail: err.message, level: 'error', ts: Date.now() })}\n\n`);
  }

  res.end();
});

module.exports = { router, setupRoutes };
