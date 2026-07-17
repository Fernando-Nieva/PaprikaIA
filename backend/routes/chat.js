const express = require('express');
const router = express.Router();
const db = require('../db');
const { chat } = require('../ollama');

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
  const { content } = req.body;

  db.addMessage(conversationId, 'user', content);

  const history = db.getMessages(conversationId);
  const messages = history.map(m => ({
    role: m.role,
    content: m.content
  }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '';

  try {
    await chat(messages, (chunk, type) => {
      if (type === 'text') {
        fullResponse += chunk;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`);
      } else if (type === 'tool') {
        res.write(`data: ${JSON.stringify({ type: 'tool', content: chunk })}\n\n`);
      }
    });

    db.addMessage(conversationId, 'assistant', fullResponse);

    const conversations = db.getConversations();
    const conv = conversations.find(c => c.id === conversationId);
    if (conv && conv.title === 'Nueva conversación') {
      const shortTitle = content.substring(0, 40) + (content.length > 40 ? '...' : '');
      db.updateConversationTitle(conversationId, shortTitle);
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
  }

  res.end();
});

module.exports = router;
