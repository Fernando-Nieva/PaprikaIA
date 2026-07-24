const express = require('express');
const router = express.Router();

let core = null;

function setupUserRoutes(paprikaCore) {
  core = paprikaCore;
}

router.get('/user/:userId/info', (req, res) => {
  if (!core) {
    return res.status(503).json({ error: 'Core not initialized' });
  }

  const userId = req.params.userId || 'default';
  const info = {};

  try {
    info.memories = core.memory.getAll(userId, 100).map(m => ({
      id: m.id,
      category: m.type,
      content: m.content,
      importance: m.importance,
      confidence: m.confidence,
      createdAt: m.created_at,
      lastAccessed: m.last_accessed,
      accessCount: m.access_count,
    }));
  } catch { info.memories = []; }

  try {
    const rel = core.relationship.get(userId);
    const summary = core.relationship.getRelationshipSummary(userId);
    info.relationship = {
      trust: summary.trustLevel,
      familiarity: summary.familiarity,
      formality: summary.formalityLevel,
      conversationCount: summary.conversationCount,
      favoriteTopics: summary.favoriteTopics || [],
      insideJokes: summary.insideJokes || 0,
      description: summary.description,
      bondLevel: summary.bondLevel,
    };
  } catch { info.relationship = {}; }

  try {
    info.emotions = core.emotions.getState();
  } catch { info.emotions = {}; }

  try {
    info.knowledge = core.knowledge.getEntitiesByUser(userId, { limit: 50 }).map(e => ({
      name: e.name,
      type: e.entity_type,
      confidence: e.confidence,
    }));
  } catch { info.knowledge = []; }

  try {
    info.goals = core.goals.getActiveGoals(userId).map(g => ({
      content: g.content || g.goal,
      category: g.category,
      progress: g.progress || 0,
      priority: g.priority,
      status: g.status,
    }));
  } catch { info.goals = []; }

  try {
    info.stats = {
      totalMemories: info.memories.length,
      personalData: info.memories.filter(m => m.category === 'personal_data').length,
      preferences: info.memories.filter(m => m.category === 'preference').length,
      experiences: info.memories.filter(m => m.category === 'experience').length,
      relationships: info.memories.filter(m => m.category === 'relationship').length,
      projects: info.memories.filter(m => m.category === 'project').length,
      goals: info.goals.length,
      entities: info.knowledge.length,
    };
  } catch { info.stats = {}; }

  res.json(info);
});

module.exports = { router: router, setupUserRoutes };
