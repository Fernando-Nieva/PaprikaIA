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
  res.json(db.getMessages(parseInt(req.params.id)));
});

router.post('/conversations/:id/messages', async (req, res) => {
  const conversationId = parseInt(req.params.id);
  const { content, attachments } = req.body;

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

  try {
    if (core) {
      // Paprika Core pipeline: pasa por analyzer → emotions → memory → context → provider → response processor
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
          }
        },
        onProcess: (proc) => {
          safeWrite(`data: ${JSON.stringify({ type: 'process', ...proc })}\n\n`);
        }
      });
      fullResponse = result.response;
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

    db.addMessage(conversationId, 'assistant', fullResponse);

    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === conversationId);
    if (conv && conv.title === 'Nueva conversación') {
      const shortTitle = content.substring(0, 40) + (content.length > 40 ? '...' : '');
      db.updateConversationTitle(conversationId, shortTitle);
    }

    safeWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
  }

  res.end();
});

module.exports = { router, setupRoutes };
