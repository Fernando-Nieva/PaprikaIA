const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Column sets: avoid SELECT * everywhere ───
const MEMORY_CORE = 'id, user_id, type, content, importance, confidence, created_at, last_accessed, access_count, decay_factor, source_conversation_id, last_verified, mentions, confidence_history, reason, semantic_cluster_id, temporal_type';
const MEMORY_FULL = MEMORY_CORE + ', embedding';

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT 'Nueva conversación',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS emotional_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    energy REAL DEFAULT 0.7,
    happiness REAL DEFAULT 0.8,
    empathy REAL DEFAULT 0.9,
    nostalgia REAL DEFAULT 0.3,
    curiosity REAL DEFAULT 0.8,
    trust REAL DEFAULT 0.5,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'event', 'emotion', 'relationship', 'person', 'project', 'goal', 'date', 'personal_data', 'experience')),
    content TEXT NOT NULL,
    embedding BLOB,
    importance REAL DEFAULT 0.5,
    confidence REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
    access_count INTEGER DEFAULT 0,
    decay_factor REAL DEFAULT 1.0
  );

  CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    trust_level REAL DEFAULT 0.3,
    familiarity REAL DEFAULT 0.1,
    humor_allowed REAL DEFAULT 0.5,
    emotional_openness REAL DEFAULT 0.3,
    conversation_count INTEGER DEFAULT 0,
    preferences TEXT DEFAULT '{}',
    last_interaction DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    message_range_start INTEGER,
    message_range_end INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS personality_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_type TEXT NOT NULL,
    description TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Paprika Phase 4: Reflection Log
  CREATE TABLE IF NOT EXISTS reflection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    conversation_id INTEGER,
    reflection TEXT NOT NULL,
    action_type TEXT,
    action_detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
  );

  -- Paprika Phase 4: Knowledge Graph Entities
  CREATE TABLE IF NOT EXISTS knowledge_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name, entity_type)
  );

  -- Paprika Phase 4: Knowledge Graph Relations
  CREATE TABLE IF NOT EXISTS knowledge_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    source_entity_id INTEGER NOT NULL,
    target_entity_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    confidence REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id) ON DELETE CASCADE
  );

  -- Paprika Phase 5: User Goals
  CREATE TABLE IF NOT EXISTS user_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'personal',
    priority REAL DEFAULT 0.5,
    progress REAL DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned', 'paused')),
    mentions INTEGER DEFAULT 1,
    first_mentioned DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_mentioned DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    abandoned_at DATETIME,
    related_memories TEXT DEFAULT '[]',
    related_entities TEXT DEFAULT '[]',
    milestones TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Paprika Phase 4: Memory Decay Log
  CREATE TABLE IF NOT EXISTS memory_decay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL,
    old_importance REAL,
    new_importance REAL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );

  -- Paprika Memory Architecture: Archive Summaries (Level 3)
  CREATE TABLE IF NOT EXISTS archive_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    message_range_start INTEGER,
    message_range_end INTEGER,
    token_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  -- Paprika Reflection: Action execution log
  CREATE TABLE IF NOT EXISTS reflection_action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    detail TEXT,
    error TEXT,
    elapsed_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Paprika Multimodal: media uploads
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    thumbnail_path TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Paprika Phase 4: Safe column migration ───

function addColumnIfNotExists(table, column, definition) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.find(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (e) {
    // column already exists or table doesn't exist yet
  }
}

// Expand relationships table
addColumnIfNotExists('relationships', 'sensitive_topics', "TEXT DEFAULT '[]'");
addColumnIfNotExists('relationships', 'favorite_topics', "TEXT DEFAULT '[]'");
addColumnIfNotExists('relationships', 'nicknames', "TEXT DEFAULT '{}'");
addColumnIfNotExists('relationships', 'preferred_style', "TEXT DEFAULT 'informal'");
addColumnIfNotExists('relationships', 'formality_level', 'REAL DEFAULT 0.3');
addColumnIfNotExists('relationships', 'inside_jokes', "TEXT DEFAULT '[]'");
addColumnIfNotExists('relationships', 'interaction_frequency', 'REAL DEFAULT 0.5');

// Expand emotional_state table
addColumnIfNotExists('emotional_state', 'enthusiasm', 'REAL DEFAULT 0.7');
addColumnIfNotExists('emotional_state', 'serenity', 'REAL DEFAULT 0.6');
addColumnIfNotExists('emotional_state', 'fatigue', 'REAL DEFAULT 0.2');

// ─── Paprika Memory Redesign: New metadata columns ───

addColumnIfNotExists('memories', 'source_conversation_id', 'INTEGER');
addColumnIfNotExists('memories', 'last_verified', 'DATETIME');
addColumnIfNotExists('memories', 'mentions', 'INTEGER DEFAULT 1');
addColumnIfNotExists('memories', 'confidence_history', "TEXT DEFAULT '[]'");
addColumnIfNotExists('memories', 'reason', 'TEXT');
addColumnIfNotExists('memories', 'semantic_cluster_id', 'INTEGER');
addColumnIfNotExists('memories', 'temporal_type', "TEXT DEFAULT 'permanent'");

// ─── Paprika Memory Redesign: Semantic Clusters ───

// ─── Paprika Knowledge Graph v2: Entity embeddings + weights ───

addColumnIfNotExists('knowledge_entities', 'embedding', 'BLOB');
addColumnIfNotExists('knowledge_entities', 'importance', 'REAL DEFAULT 0.5');
addColumnIfNotExists('knowledge_entities', 'frequency', 'INTEGER DEFAULT 1');
addColumnIfNotExists('knowledge_entities', 'emotional_weight', 'REAL DEFAULT 0.0');
addColumnIfNotExists('knowledge_entities', 'last_mentioned', 'DATETIME');

// ─── Paprika Multimodal: attachments column on messages ───

addColumnIfNotExists('messages', 'attachments', "TEXT");

// ─── Paprika Knowledge Graph v2: Relation temporal + weights ───

addColumnIfNotExists('knowledge_relations', 'temporal_type', "TEXT DEFAULT 'present'");
addColumnIfNotExists('knowledge_relations', 'start_time', 'DATETIME');
addColumnIfNotExists('knowledge_relations', 'end_time', 'DATETIME');
addColumnIfNotExists('knowledge_relations', 'weight', 'REAL DEFAULT 0.5');
addColumnIfNotExists('knowledge_relations', 'mention_count', 'INTEGER DEFAULT 1');

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    label TEXT,
    centroid_embedding BLOB,
    memory_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memory_sleep_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    conversation_count_at_run INTEGER,
    memories_merged INTEGER DEFAULT 0,
    memories_decayed INTEGER DEFAULT 0,
    memories_removed INTEGER DEFAULT 0,
    clusters_updated INTEGER DEFAULT 0,
    importance_recalculated INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── SQLite Indexes: eliminate full table scans ───

db.exec(`
  -- messages: conversations always query by conversation_id
  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

  -- memories: heavy query patterns
  CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type);
  CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories(user_id, importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_user_last_accessed ON memories(user_id, last_accessed);
  CREATE INDEX IF NOT EXISTS idx_memories_user_created_at ON memories(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_cluster ON memories(user_id, semantic_cluster_id);
  CREATE INDEX IF NOT EXISTS idx_memories_embedding_pending ON memories(user_id, embedding) WHERE embedding IS NULL;

  -- knowledge_entities: user lookups + type filter
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_user_id ON knowledge_entities(user_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_user_type ON knowledge_entities(user_id, entity_type);

  -- knowledge_relations: user lookups + entity lookups
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_user_id ON knowledge_relations(user_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_source ON knowledge_relations(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target ON knowledge_relations(target_entity_id);

  -- user_goals: user lookups + status filter
  CREATE INDEX IF NOT EXISTS idx_user_goals_user_id ON user_goals(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_goals_user_status ON user_goals(user_id, status);

  -- archive_summaries: conversation lookups
  CREATE INDEX IF NOT EXISTS idx_archive_summaries_conv ON archive_summaries(conversation_id);

  -- conversation_summaries: conversation lookups
  CREATE INDEX IF NOT EXISTS idx_conv_summaries_conv ON conversation_summaries(conversation_id);

  -- reflection_log: user lookups
  CREATE INDEX IF NOT EXISTS idx_reflection_log_user_id ON reflection_log(user_id);

  -- memory_decay_log: memory lookups
  CREATE INDEX IF NOT EXISTS idx_memory_decay_log_memory_id ON memory_decay_log(memory_id);

  -- memory_clusters: user lookups
  CREATE INDEX IF NOT EXISTS idx_memory_clusters_user_id ON memory_clusters(user_id);

  -- memory_sleep_log: user lookups
  CREATE INDEX IF NOT EXISTS idx_memory_sleep_log_user_id ON memory_sleep_log(user_id);

  -- reflection_action_log: user lookups + time filtering
  CREATE INDEX IF NOT EXISTS idx_reflection_action_log_user ON reflection_action_log(user_id, created_at);

  -- knowledge_entities: embedding + weight columns
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_embedding ON knowledge_entities(user_id, embedding) WHERE embedding IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_importance ON knowledge_entities(user_id, importance DESC);

  -- knowledge_entities: entities needing embedding (partial index)
  CREATE INDEX IF NOT EXISTS idx_knowledge_entities_pending_emb ON knowledge_entities(user_id) WHERE embedding IS NULL;

  -- knowledge_relations: temporal + weight indexes
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_temporal ON knowledge_relations(user_id, temporal_type);
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_weight ON knowledge_relations(user_id, weight DESC);

  -- knowledge_relations: composite for findRelation (user+source+target+type)
  CREATE INDEX IF NOT EXISTS idx_knowledge_relations_find ON knowledge_relations(user_id, source_entity_id, target_entity_id, relation_type);

  -- memories: unclustered memories needing assignment (partial index)
  CREATE INDEX IF NOT EXISTS idx_memories_unclustered ON memories(user_id) WHERE semantic_cluster_id IS NULL AND embedding IS NOT NULL;

  -- memory_sleep_log: latest log per user (composite for ORDER BY)
  CREATE INDEX IF NOT EXISTS idx_memory_sleep_log_user_time ON memory_sleep_log(user_id, created_at DESC);

  -- media: user lookups + type filter
  CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
`);

// ─── FTS5 Full-Text Search for memories ───

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    user_id,
    content,
    content=memories,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );

  -- Triggers to keep FTS index in sync with memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, user_id, content) VALUES (new.id, new.user_id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, user_id, content) VALUES('delete', old.id, old.user_id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, user_id, content) VALUES('delete', old.id, old.user_id, old.content);
    INSERT INTO memories_fts(rowid, user_id, content) VALUES (new.id, new.user_id, new.content);
  END;
`);

module.exports = {
  db,

  getConversations() {
    return db.prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC').all();
  },

  createConversation(title = 'Nueva conversación') {
    const result = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title);
    return { id: result.lastInsertRowid, title };
  },

  deleteConversation(id) {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  },

  getMessages(conversationId) {
    return db.prepare('SELECT id, role, content, tool_name, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);
  },

  addMessage(conversationId, role, content, toolName = null, attachments = null) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, tool_name, attachments) VALUES (?, ?, ?, ?, ?)').run(conversationId, role, content, toolName, attachments);
    db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
  },

  updateConversationTitle(id, title) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  },

  // ─── Paprika Core: Emotional State ───

  getEmotionalState() {
    return db.prepare('SELECT id, energy, happiness, empathy, nostalgia, curiosity, trust, enthusiasm, serenity, fatigue, updated_at FROM emotional_state ORDER BY id DESC LIMIT 1').get();
  },

  getEmotionalStateFull() {
    const state = db.prepare('SELECT energy, happiness, empathy, nostalgia, curiosity, trust, enthusiasm, serenity, fatigue FROM emotional_state ORDER BY id DESC LIMIT 1').get();
    if (!state) return null;
    return {
      energy: state.energy,
      happiness: state.happiness,
      empathy: state.empathy,
      nostalgia: state.nostalgia,
      curiosity: state.curiosity,
      trust: state.trust,
      enthusiasm: state.enthusiasm,
      serenity: state.serenity,
      fatigue: state.fatigue,
    };
  },

  setEmotionalState(state) {
    const existing = this.getEmotionalState();
    if (existing) {
      db.prepare(`
        UPDATE emotional_state
        SET energy = ?, happiness = ?, empathy = ?, nostalgia = ?, curiosity = ?, trust = ?,
            enthusiasm = ?, serenity = ?, fatigue = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        state.energy, state.happiness, state.empathy, state.nostalgia, state.curiosity, state.trust,
        state.enthusiasm ?? 0.7, state.serenity ?? 0.6, state.fatigue ?? 0.2, existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO emotional_state (energy, happiness, empathy, nostalgia, curiosity, trust, enthusiasm, serenity, fatigue)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.energy, state.happiness, state.empathy, state.nostalgia, state.curiosity, state.trust,
        state.enthusiasm ?? 0.7, state.serenity ?? 0.6, state.fatigue ?? 0.2
      );
    }
  },

  // ─── Paprika Core: Memories ───

  addMemory(userId, type, content, embedding = null, importance = 0.5, confidence = 0.5) {
    const result = db.prepare(`
      INSERT INTO memories (user_id, type, content, embedding, importance, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, type, content, embedding, importance, confidence);
    return { lastInsertRowid: result.lastInsertRowid };
  },

  getMemoriesByUser(userId, limit = 20) {
    return db.prepare(`
      SELECT ${MEMORY_FULL} FROM memories
      WHERE user_id = ?
      ORDER BY importance DESC, last_accessed DESC
      LIMIT ?
    `).all(userId, limit);
  },

  searchMemories(userId, query) {
    return db.prepare(`
      SELECT ${MEMORY_CORE} FROM memories
      WHERE user_id = ? AND content LIKE ?
      ORDER BY importance DESC
      LIMIT 10
    `).all(userId, `%${query}%`);
  },

  updateMemoryContent(memoryId, content) {
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, memoryId);
  },

  updateMemoryImportance(memoryId, importance) {
    db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(importance, memoryId);
  },

  touchMemory(memoryId) {
    db.prepare(`
      UPDATE memories
      SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1
      WHERE id = ?
    `).run(memoryId);
  },

  updateMemoryEmbedding(memoryId, embedding) {
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embedding, memoryId);
  },

  getMemoriesWithoutEmbedding(userId, limit = 100) {
    return db.prepare(`
      SELECT ${MEMORY_CORE} FROM memories
      WHERE user_id = ? AND embedding IS NULL
      ORDER BY importance DESC
      LIMIT ?
    `).all(userId, limit);
  },

  getMemoryById(memoryId) {
    return db.prepare(`SELECT ${MEMORY_FULL} FROM memories WHERE id = ?`).get(memoryId);
  },

  // ─── Paprika Core: Relationships ───

  getRelationship(userId) {
    return db.prepare('SELECT id, user_id, trust_level, familiarity, humor_allowed, emotional_openness, conversation_count, preferences, last_interaction, sensitive_topics, favorite_topics, nicknames, preferred_style, formality_level, inside_jokes, interaction_frequency FROM relationships WHERE user_id = ?').get(userId);
  },

  getRelationshipFull(userId) {
    const rel = this.getRelationship(userId);
    if (!rel) return null;
    return {
      userId: rel.user_id,
      trustLevel: rel.trust_level,
      familiarity: rel.familiarity,
      humorAllowed: rel.humor_allowed,
      emotionalOpenness: rel.emotional_openness,
      conversationCount: rel.conversation_count,
      preferences: JSON.parse(rel.preferences || '{}'),
      sensitiveTopics: JSON.parse(rel.sensitive_topics || '[]'),
      favoriteTopics: JSON.parse(rel.favorite_topics || '[]'),
      nicknames: JSON.parse(rel.nicknames || '{}'),
      preferredStyle: rel.preferred_style,
      formalityLevel: rel.formality_level,
      insideJokes: JSON.parse(rel.inside_jokes || '[]'),
      interactionFrequency: rel.interaction_frequency,
      lastInteraction: rel.last_interaction,
      createdAt: rel.created_at,
    };
  },

  updateRelationshipField(userId, field, value) {
    const allowedFields = [
      'trust_level', 'familiarity', 'humor_allowed', 'emotional_openness',
      'conversation_count', 'preferences', 'sensitive_topics', 'favorite_topics',
      'nicknames', 'preferred_style', 'formality_level', 'inside_jokes',
      'interaction_frequency', 'last_interaction'
    ];
    if (!allowedFields.includes(field)) {
      throw new Error(`Invalid relationship field: ${field}`);
    }
    const isJsonField = ['preferences', 'sensitive_topics', 'favorite_topics', 'nicknames', 'inside_jokes'].includes(field);
    const val = isJsonField && typeof value === 'object' ? JSON.stringify(value) : value;
    db.prepare(`UPDATE relationships SET ${field} = ? WHERE user_id = ?`).run(val, userId);
  },

  upsertRelationship(userId, data) {
    const existing = this.getRelationship(userId);
    if (existing) {
      db.prepare(`
        UPDATE relationships
        SET trust_level = ?, familiarity = ?, humor_allowed = ?, emotional_openness = ?,
            conversation_count = conversation_count + 1, preferences = ?, last_interaction = CURRENT_TIMESTAMP,
            sensitive_topics = ?, favorite_topics = ?, nicknames = ?,
            preferred_style = ?, formality_level = ?, inside_jokes = ?, interaction_frequency = ?
        WHERE user_id = ?
      `).run(
        data.trustLevel, data.familiarity, data.humorAllowed, data.emotionalOpenness,
        JSON.stringify(data.preferences || {}),
        JSON.stringify(data.sensitiveTopics || []),
        JSON.stringify(data.favoriteTopics || []),
        JSON.stringify(data.nicknames || {}),
        data.preferredStyle || 'informal',
        data.formalityLevel ?? 0.3,
        JSON.stringify(data.insideJokes || []),
        data.interactionFrequency ?? 0.5,
        userId
      );
    } else {
      db.prepare(`
        INSERT INTO relationships (user_id, trust_level, familiarity, humor_allowed, emotional_openness,
          preferences, sensitive_topics, favorite_topics, nicknames,
          preferred_style, formality_level, inside_jokes, interaction_frequency, last_interaction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        userId,
        data.trustLevel || 0.3, data.familiarity || 0.1, data.humorAllowed || 0.5, data.emotionalOpenness || 0.3,
        JSON.stringify(data.preferences || {}),
        JSON.stringify(data.sensitiveTopics || []),
        JSON.stringify(data.favoriteTopics || []),
        JSON.stringify(data.nicknames || {}),
        data.preferredStyle || 'informal',
        data.formalityLevel ?? 0.3,
        JSON.stringify(data.insideJokes || []),
        data.interactionFrequency ?? 0.5
      );
    }
  },

  addInsideJoke(userId, joke) {
    const rel = this.getRelationship(userId);
    if (!rel) return;
    const jokes = JSON.parse(rel.inside_jokes || '[]');
    if (!jokes.includes(joke)) {
      jokes.push(joke);
      db.prepare('UPDATE relationships SET inside_jokes = ? WHERE user_id = ?').run(JSON.stringify(jokes), userId);
    }
  },

  addFavoriteTopic(userId, topic) {
    const rel = this.getRelationship(userId);
    if (!rel) return;
    const topics = JSON.parse(rel.favorite_topics || '[]');
    if (!topics.includes(topic)) {
      topics.push(topic);
      db.prepare('UPDATE relationships SET favorite_topics = ? WHERE user_id = ?').run(JSON.stringify(topics), userId);
    }
  },

  addSensitiveTopic(userId, topic) {
    const rel = this.getRelationship(userId);
    if (!rel) return;
    const topics = JSON.parse(rel.sensitive_topics || '[]');
    if (!topics.includes(topic)) {
      topics.push(topic);
      db.prepare('UPDATE relationships SET sensitive_topics = ? WHERE user_id = ?').run(JSON.stringify(topics), userId);
    }
  },

  setNickname(userId, key, value) {
    const rel = this.getRelationship(userId);
    if (!rel) return;
    const nicknames = JSON.parse(rel.nicknames || '{}');
    nicknames[key] = value;
    db.prepare('UPDATE relationships SET nicknames = ? WHERE user_id = ?').run(JSON.stringify(nicknames), userId);
  },

  // ─── Paprika Core: Conversation Summaries ───

  addConversationSummary(conversationId, summary, rangeStart, rangeEnd) {
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, summary, message_range_start, message_range_end)
      VALUES (?, ?, ?, ?)
    `).run(conversationId, summary, rangeStart, rangeEnd);
  },

  getLatestSummary(conversationId) {
    return db.prepare(`
      SELECT summary FROM conversation_summaries
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversationId)?.summary || null;
  },

  getSummariesByConversation(conversationId) {
    return db.prepare(`
      SELECT id, conversation_id, summary, message_range_start, message_range_end, created_at FROM conversation_summaries
      WHERE conversation_id = ?
      ORDER BY created_at DESC
    `).all(conversationId);
  },

  markMessagesSummarized(conversationId, messageRangeEnd) {
    const existing = db.prepare(`
      SELECT message_range_end FROM conversation_summaries
      WHERE conversation_id = ?
      ORDER BY message_range_end DESC
      LIMIT 1
    `).get(conversationId);
    if (!existing || messageRangeEnd > existing.message_range_end) {
      db.prepare(`
        UPDATE conversation_summaries
        SET message_range_end = ?
        WHERE conversation_id = ? AND message_range_end = (
          SELECT MAX(message_range_end) FROM conversation_summaries WHERE conversation_id = ?
        )
      `).run(messageRangeEnd, conversationId, conversationId);
    }
  },

  // ─── Paprika Core: Personality Log ───

  addPersonalityLog(changeType, description, oldValue = null, newValue = null) {
    db.prepare(`
      INSERT INTO personality_log (change_type, description, old_value, new_value)
      VALUES (?, ?, ?, ?)
    `).run(changeType, description, oldValue, newValue);
  },

  // ─── Paprika Phase 4: Reflection Log ───

  addReflection(userId, conversationId, reflection, actionType = null, actionDetail = null) {
    const result = db.prepare(`
      INSERT INTO reflection_log (user_id, conversation_id, reflection, action_type, action_detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, conversationId, reflection, actionType, actionDetail);
    return { lastInsertRowid: result.lastInsertRowid };
  },

  getReflections(userId, limit = 20) {
    return db.prepare(`
      SELECT id, user_id, conversation_id, reflection, action_type, action_detail, created_at FROM reflection_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit);
  },

  // ─── Paprika Phase 4: Knowledge Graph ───

  addEntity(userId, name, entityType, metadata = {}, options = {}) {
    const { importance = 0.5, emotionalWeight = 0.0, embedding = null } = options;
    const result = db.prepare(`
      INSERT INTO knowledge_entities (user_id, name, entity_type, metadata, importance, emotional_weight, embedding, last_mentioned)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, name, entity_type) DO UPDATE SET
        metadata = excluded.metadata,
        importance = MAX(knowledge_entities.importance, excluded.importance),
        emotional_weight = MAX(ABS(knowledge_entities.emotional_weight), ABS(excluded.emotional_weight)),
        embedding = COALESCE(excluded.embedding, knowledge_entities.embedding),
        frequency = knowledge_entities.frequency + 1,
        last_mentioned = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, name, entityType, JSON.stringify(metadata), importance, emotionalWeight, embedding);
    return { lastInsertRowid: result.lastInsertRowid };
  },

  getEntity(userId, name, entityType) {
    return db.prepare(`
      SELECT id, user_id, name, entity_type, metadata, importance, frequency, emotional_weight, embedding, last_mentioned, created_at, updated_at FROM knowledge_entities
      WHERE user_id = ? AND name = ? AND entity_type = ?
    `).get(userId, name, entityType);
  },

  getEntitiesByUser(userId, limit = 50) {
    return db.prepare(`
      SELECT id, user_id, name, entity_type, metadata, importance, frequency, emotional_weight, embedding, last_mentioned, created_at, updated_at FROM knowledge_entities
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(userId, limit);
  },

  addRelation(userId, sourceId, targetId, relationType, metadata = {}, confidence = 0.5, options = {}) {
    const { temporalType = 'present', startTime = null, endTime = null, weight = 0.5 } = options;
    const result = db.prepare(`
      INSERT INTO knowledge_relations (user_id, source_entity_id, target_entity_id, relation_type, metadata, confidence, temporal_type, start_time, end_time, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, sourceId, targetId, relationType, JSON.stringify(metadata), confidence, temporalType, startTime, endTime, weight);
    return { lastInsertRowid: result.lastInsertRowid };
  },

  getRelationsByUser(userId, limit = 50) {
    return db.prepare(`
      SELECT kr.*, ke1.name AS source_name, ke1.entity_type AS source_type,
             ke2.name AS target_name, ke2.entity_type AS target_type
      FROM knowledge_relations kr
      JOIN knowledge_entities ke1 ON kr.source_entity_id = ke1.id
      JOIN knowledge_entities ke2 ON kr.target_entity_id = ke2.id
      WHERE kr.user_id = ?
      ORDER BY kr.weight DESC, kr.created_at DESC
      LIMIT ?
    `).all(userId, limit);
  },

  getRelationsForEntity(entityId) {
    return db.prepare(`
      SELECT kr.*, ke1.name AS source_name, ke1.entity_type AS source_type,
             ke2.name AS target_name, ke2.entity_type AS target_type
      FROM knowledge_relations kr
      JOIN knowledge_entities ke1 ON kr.source_entity_id = ke1.id
      JOIN knowledge_entities ke2 ON kr.target_entity_id = ke2.id
      WHERE kr.source_entity_id = ? OR kr.target_entity_id = ?
      ORDER BY kr.weight DESC, kr.confidence DESC
    `).all(entityId, entityId);
  },

  // ─── Paprika Phase 4: Memory Decay ───

  logMemoryDecay(memoryId, oldImportance, newImportance, reason) {
    db.prepare(`
      INSERT INTO memory_decay_log (memory_id, old_importance, new_importance, reason)
      VALUES (?, ?, ?, ?)
    `).run(memoryId, oldImportance, newImportance, reason);
  },

  getMemoriesNeedingDecay(userId, daysSinceAccess = 30) {
    return db.prepare(`
      SELECT ${MEMORY_CORE} FROM memories
      WHERE user_id = ? AND last_accessed < datetime('now', '-' || ? || ' days')
        AND importance > 0.1
      ORDER BY last_accessed ASC
    `).all(userId, daysSinceAccess);
  },

  applyDecay(userId, decayFactor = 0.9) {
    const oldMemories = this.getMemoriesNeedingDecay(userId);
    const updateStmt = db.prepare('UPDATE memories SET importance = ? WHERE id = ?');
    const now = new Date().toISOString();

    const applyDecayTransaction = db.transaction((memories) => {
      for (const mem of oldMemories) {
        const newImportance = Math.max(0.05, mem.importance * decayFactor);
        this.logMemoryDecay(mem.id, mem.importance, newImportance, `decay applied (factor=${decayFactor}, last_accessed=${mem.last_accessed})`);
        updateStmt.run(newImportance, mem.id);
      }
    });

    applyDecayTransaction(oldMemories);
    return oldMemories.length;
  },

  // ─── Paprika Phase 5: User Goals ───

  getGoalsByUser(userId, limit = 20) {
    return db.prepare(`
      SELECT id, user_id, content, category, priority, progress, status, mentions, first_mentioned, last_mentioned, completed_at, abandoned_at, related_memories, related_entities, milestones, metadata, created_at, updated_at FROM user_goals
      WHERE user_id = ?
      ORDER BY priority DESC, last_mentioned DESC
      LIMIT ?
    `).all(userId, limit).map(row => ({
      ...row,
      milestones: JSON.parse(row.milestones || '[]'),
      relatedEntities: JSON.parse(row.related_entities || '[]'),
      relatedMemories: JSON.parse(row.related_memories || '[]'),
    }));
  },

  getGoalById(goalId) {
    const row = db.prepare('SELECT id, user_id, content, category, priority, progress, status, mentions, first_mentioned, last_mentioned, completed_at, abandoned_at, related_memories, related_entities, milestones, metadata, created_at, updated_at FROM user_goals WHERE id = ?').get(goalId);
    if (!row) return null;
    return {
      ...row,
      milestones: JSON.parse(row.milestones || '[]'),
      relatedEntities: JSON.parse(row.related_entities || '[]'),
      relatedMemories: JSON.parse(row.related_memories || '[]'),
      metadata: row.metadata,
    };
  },

  addGoal(data) {
    const result = db.prepare(`
      INSERT INTO user_goals (user_id, content, category, priority, progress, status,
        mentions, first_mentioned, last_mentioned, related_memories, related_entities,
        milestones, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.user_id,
      data.content,
      data.category || 'personal',
      data.priority || 0.5,
      data.progress || 0,
      data.status || 'active',
      data.mentions || 1,
      data.first_mentioned || new Date().toISOString(),
      data.last_mentioned || new Date().toISOString(),
      data.related_memories || '[]',
      data.related_entities || '[]',
      data.milestones || '[]',
      data.metadata || '{}'
    );
    return { lastInsertRowid: result.lastInsertRowid };
  },

  updateGoal(goalId, updates) {
    const allowedFields = [
      'content', 'category', 'priority', 'progress', 'status',
      'mentions', 'last_mentioned', 'completed_at', 'abandoned_at',
      'related_memories', 'related_entities', 'milestones', 'metadata',
    ];
    const setClauses = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(typeof value === 'object' ? JSON.stringify(value) : value);
      }
    }
    if (setClauses.length === 0) return;
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(goalId);
    db.prepare(`UPDATE user_goals SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  },

  // ─── Archive Summaries (Memory Level 3) ───

  addArchiveSummary(conversationId, summary, rangeStart, rangeEnd) {
    const tokenCount = Math.ceil((summary || '').length / 4);
    db.prepare(`
      INSERT INTO archive_summaries (conversation_id, summary, message_range_start, message_range_end, token_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, summary, rangeStart || 0, rangeEnd || 0, tokenCount);
  },

  getArchivesByConversation(conversationId) {
    return db.prepare(
      'SELECT id, conversation_id, summary, message_range_start, message_range_end, token_count, created_at FROM archive_summaries WHERE conversation_id = ? ORDER BY created_at DESC'
    ).all(conversationId);
  },

  getLatestArchive(conversationId) {
    return db.prepare(
      'SELECT id, conversation_id, summary, message_range_start, message_range_end, token_count, created_at FROM archive_summaries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(conversationId);
  },

  deleteArchiveById(archiveId) {
    db.prepare('DELETE FROM archive_summaries WHERE id = ?').run(archiveId);
  },

  // ─── Knowledge Graph: entity helpers ───

  getEntitiesByType(userId, entityType) {
    return db.prepare(
      'SELECT id, user_id, name, entity_type, metadata, created_at, updated_at FROM knowledge_entities WHERE user_id = ? AND entity_type = ? ORDER BY updated_at DESC'
    ).all(userId, entityType);
  },

  countRelationsForEntity(entityId) {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM knowledge_relations WHERE source_entity_id = ? OR target_entity_id = ?'
    ).get(entityId, entityId);
    return row ? row.count : 0;
  },

  // ─── Knowledge Graph v2: Entity weight operations ───

  updateEntityWeights(entityId, { importance, emotionalWeight, frequency }) {
    const sets = [];
    const params = [];
    if (importance !== undefined) { sets.push('importance = ?'); params.push(importance); }
    if (emotionalWeight !== undefined) { sets.push('emotional_weight = ?'); params.push(emotionalWeight); }
    if (frequency !== undefined) { sets.push('frequency = ?'); params.push(frequency); }
    if (sets.length === 0) return;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(entityId);
    db.prepare(`UPDATE knowledge_entities SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  updateEntityEmbedding(entityId, embedding) {
    db.prepare('UPDATE knowledge_entities SET embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(embedding, entityId);
  },

  incrementEntityFrequency(entityId) {
    db.prepare('UPDATE knowledge_entities SET frequency = frequency + 1, last_mentioned = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(entityId);
  },

  getEntitiesWithoutEmbedding(userId, limit = 20) {
    return db.prepare(`
      SELECT id, user_id, name, entity_type, metadata FROM knowledge_entities
      WHERE user_id = ? AND embedding IS NULL
      ORDER BY frequency DESC, updated_at DESC
      LIMIT ?
    `).all(userId, limit);
  },

  // ─── Knowledge Graph v2: Relation weight operations ───

  updateRelationWeight(relationId, weight) {
    db.prepare('UPDATE knowledge_relations SET weight = ?, mention_count = mention_count + 1 WHERE id = ?').run(weight, relationId);
  },

  updateRelationTemporal(relationId, { temporalType, startTime, endTime }) {
    const sets = [];
    const params = [];
    if (temporalType !== undefined) { sets.push('temporal_type = ?'); params.push(temporalType); }
    if (startTime !== undefined) { sets.push('start_time = ?'); params.push(startTime); }
    if (endTime !== undefined) { sets.push('end_time = ?'); params.push(endTime); }
    if (sets.length === 0) return;
    params.push(relationId);
    db.prepare(`UPDATE knowledge_relations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  // ─── Knowledge Graph v2: Consistency verification ───

  getOrphanedRelations(userId) {
    return db.prepare(`
      SELECT kr.id FROM knowledge_relations kr
      WHERE kr.user_id = ? AND (
        NOT EXISTS (SELECT 1 FROM knowledge_entities WHERE id = kr.source_entity_id)
        OR NOT EXISTS (SELECT 1 FROM knowledge_entities WHERE id = kr.target_entity_id)
      )
    `).all(userId);
  },

  getDuplicateEntities(userId) {
    return db.prepare(`
      SELECT name, entity_type, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM knowledge_entities
      WHERE user_id = ?
      GROUP BY user_id, name, entity_type
      HAVING count > 1
    `).all(userId);
  },

  deleteRelation(relationId) {
    db.prepare('DELETE FROM knowledge_relations WHERE id = ?').run(relationId);
  },

  deleteEntity(entityId) {
    db.prepare('DELETE FROM knowledge_entities WHERE id = ?').run(entityId);
  },

  getEntityById(entityId) {
    return db.prepare('SELECT * FROM knowledge_entities WHERE id = ?').get(entityId);
  },

  // ─── Knowledge Graph v2: Entity consolidation ───

  updateEntityMetadata(entityId, metadata, importance, emotionalWeight, frequency) {
    db.prepare(`
      UPDATE knowledge_entities
      SET metadata = ?, importance = ?, emotional_weight = ?, frequency = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(metadata), importance, emotionalWeight, frequency, entityId);
  },

  redirectEntityRelations(fromEntityId, toEntityId) {
    db.prepare('UPDATE knowledge_relations SET source_entity_id = ? WHERE source_entity_id = ?').run(toEntityId, fromEntityId);
    db.prepare('UPDATE knowledge_relations SET target_entity_id = ? WHERE target_entity_id = ?').run(toEntityId, fromEntityId);
  },

  deleteDuplicateRelations(userId) {
    db.prepare(`
      DELETE FROM knowledge_relations
      WHERE id NOT IN (
        SELECT MIN(id) FROM knowledge_relations
        WHERE user_id = ?
        GROUP BY source_entity_id, target_entity_id, relation_type
      ) AND user_id = ?
    `).run(userId, userId);
  },

  // ─── Knowledge Graph v2: Relation lookup ───

  findRelation(userId, sourceId, targetId, relationType) {
    return db.prepare(`
      SELECT id, user_id, source_entity_id, target_entity_id, relation_type, metadata, confidence, temporal_type, weight, mention_count, created_at
      FROM knowledge_relations
      WHERE user_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
    `).get(userId, sourceId, targetId, relationType);
  },

  // ─── Memory Redesign: Enhanced metadata operations ───

  touchMemoryVerified(memoryId) {
    db.prepare('UPDATE memories SET last_verified = CURRENT_TIMESTAMP WHERE id = ?').run(memoryId);
  },

  incrementMemoryMentions(memoryId) {
    db.prepare('UPDATE memories SET mentions = mentions + 1 WHERE id = ?').run(memoryId);
  },

  appendConfidenceHistory(memoryId, confidence) {
    const row = db.prepare('SELECT confidence_history FROM memories WHERE id = ?').get(memoryId);
    const history = JSON.parse(row?.confidence_history || '[]');
    history.push({ confidence, timestamp: new Date().toISOString() });
    if (history.length > 20) history.splice(0, history.length - 20);
    db.prepare('UPDATE memories SET confidence_history = ? WHERE id = ?').run(JSON.stringify(history), memoryId);
  },

  updateMemoryTemporalType(memoryId, temporalType) {
    db.prepare('UPDATE memories SET temporal_type = ? WHERE id = ?').run(temporalType, memoryId);
  },

  updateMemoryCluster(memoryId, clusterId) {
    db.prepare('UPDATE memories SET semantic_cluster_id = ? WHERE id = ?').run(clusterId, memoryId);
  },

  getMemoriesByCluster(userId, clusterId, limit = 50) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND semantic_cluster_id = ? ORDER BY importance DESC LIMIT ?`
    ).all(userId, clusterId, limit);
  },

  // ─── Memory Redesign: Semantic Clusters ───

  getClustersByUser(userId) {
    return db.prepare(
      'SELECT id, user_id, label, centroid_embedding, memory_count, created_at, updated_at FROM memory_clusters WHERE user_id = ? ORDER BY memory_count DESC'
    ).all(userId);
  },

  getClusterById(clusterId) {
    return db.prepare('SELECT id, user_id, label, centroid_embedding, memory_count, created_at, updated_at FROM memory_clusters WHERE id = ?').get(clusterId);
  },

  createCluster(userId, label, centroidEmbedding) {
    const result = db.prepare(
      'INSERT INTO memory_clusters (user_id, label, centroid_embedding, memory_count) VALUES (?, ?, ?, 0)'
    ).run(userId, label, centroidEmbedding);
    return { id: result.lastInsertRowid };
  },

  updateClusterCentroid(clusterId, centroidEmbedding, memoryCount, label) {
    const sets = ['centroid_embedding = ?', 'memory_count = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const vals = [centroidEmbedding, memoryCount];
    if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
    vals.push(clusterId);
    db.prepare(`UPDATE memory_clusters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  getUnclusteredMemories(userId, limit = 50) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND semantic_cluster_id IS NULL AND embedding IS NOT NULL ORDER BY importance DESC LIMIT ?`
    ).all(userId, limit);
  },

  // ─── Memory Redesign: Sleep Log ───

  addSleepLog(data) {
    return db.prepare(`
      INSERT INTO memory_sleep_log (user_id, conversation_count_at_run, memories_merged, memories_decayed,
        memories_removed, clusters_updated, importance_recalculated, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.userId, data.conversationCount, data.merged || 0, data.decayed || 0,
      data.removed || 0, data.clustersUpdated || 0, data.importanceRecalculated || 0, data.durationMs || 0);
  },

  getLatestSleepLog(userId) {
    return db.prepare(
      'SELECT id, user_id, conversation_count_at_run, memories_merged, memories_decayed, memories_removed, clusters_updated, importance_recalculated, duration_ms, created_at FROM memory_sleep_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(userId);
  },

  getSleepLogCount(userId) {
    const row = db.prepare('SELECT COUNT(*) as count FROM memory_sleep_log WHERE user_id = ?').get(userId);
    return row ? row.count : 0;
  },

  // ─── Reflection Action Log ───

  logReflectionAction(userId, actionType, success, detail, error, elapsedMs) {
    db.prepare(`
      INSERT INTO reflection_action_log (user_id, action_type, success, detail, error, elapsed_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, actionType, success ? 1 : 0, detail || null, error || null, elapsedMs || 0);
  },

  // ─── Memory Redesign: Bulk operations for sleep cycle ───

  getAllMemoriesForUser(userId, limit = 500) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? ORDER BY importance DESC LIMIT ?`
    ).all(userId, limit);
  },

  deleteMemoryById(memoryId) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
  },

  // ─── Memory Redesign: Direct field updates (eliminate db.prepare in modules) ───

  updateMemorySourceConversation(memoryId, conversationId) {
    db.prepare('UPDATE memories SET source_conversation_id = ? WHERE id = ?').run(conversationId, memoryId);
  },

  updateMemoryReason(memoryId, reason) {
    db.prepare('UPDATE memories SET reason = ? WHERE id = ?').run(reason, memoryId);
  },

  updateMemoryMentionsCount(memoryId, mentions) {
    db.prepare('UPDATE memories SET mentions = ? WHERE id = ?').run(mentions, memoryId);
  },

  updateMemoryConfidenceHistory(memoryId, history) {
    db.prepare('UPDATE memories SET confidence_history = ? WHERE id = ?').run(JSON.stringify(history), memoryId);
  },

  // ─── SQL-WHERE helpers: eliminate JS-side filtering ───

  getMemoriesByType(userId, type, limit = 200) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND type = ? ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(userId, type, limit);
  },

  getMemoriesSince(userId, cutoffDate, limit = 500) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND last_accessed >= ? ORDER BY last_accessed DESC LIMIT ?`
    ).all(userId, cutoffDate, limit);
  },

  getMemoriesImportant(userId, minImportance = 0.5, limit = 200) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND importance >= ? ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(userId, minImportance, limit);
  },

  getMemoriesByTypes(userId, types, limit = 200) {
    const placeholders = types.map(() => '?').join(',');
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND type IN (${placeholders}) ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(userId, ...types, limit);
  },

  getMemoriesEssential(userId, essentialTypes, minImportance = 0.5, limit = 50) {
    const placeholders = essentialTypes.map(() => '?').join(',');
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND (type IN (${placeholders}) OR importance >= ?) ORDER BY importance DESC, last_accessed DESC LIMIT ?`
    ).all(userId, ...essentialTypes, minImportance, limit);
  },

  getMemoriesByIds(memoryIds) {
    if (!memoryIds.length) return [];
    const placeholders = memoryIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE id IN (${placeholders})`
    ).all(...memoryIds);
  },

  getMemoriesByUserAndType(userId, type) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND type = ? ORDER BY created_at DESC`
    ).all(userId, type);
  },

  getMemoriesByDateRange(userId, startDate, endDate, limit = 500) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`
    ).all(userId, startDate, endDate, limit);
  },

  // ─── Knowledge Graph: SQL-WHERE helpers ───

  getEntitiesByUserFiltered(userId, { type, search, limit = 50 } = {}) {
    let sql = 'SELECT id, user_id, name, entity_type, metadata, created_at, updated_at FROM knowledge_entities WHERE user_id = ?';
    const params = [userId];
    if (type) { sql += ' AND entity_type = ?'; params.push(type); }
    if (search) { sql += ' AND LOWER(name) LIKE ?'; params.push(`%${search.toLowerCase()}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  },

  getRelationsByUserFiltered(userId, { relationType, limit = 50 } = {}) {
    let sql = `SELECT kr.id, kr.user_id, kr.source_entity_id, kr.target_entity_id, kr.relation_type, kr.metadata, kr.confidence, kr.created_at,
               ke1.name AS source_name, ke1.entity_type AS source_type,
               ke2.name AS target_name, ke2.entity_type AS target_type
      FROM knowledge_relations kr
      JOIN knowledge_entities ke1 ON kr.source_entity_id = ke1.id
      JOIN knowledge_entities ke2 ON kr.target_entity_id = ke2.id
      WHERE kr.user_id = ?`;
    const params = [userId];
    if (relationType) { sql += ' AND kr.relation_type = ?'; params.push(relationType); }
    sql += ' ORDER BY kr.created_at DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params);
  },

  // ─── FTS5 Full-Text Search ───

  searchMemoriesFTS(userId, query, limit = 20) {
    if (!query || !query.trim()) return [];
    const sanitized = query.replace(/['"]/g, ' ').trim();
    if (!sanitized) return [];
    const terms = sanitized.split(/\s+/).filter(w => w.length > 1);
    if (terms.length === 0) return [];
    const ftsQuery = terms.join(' AND ');
    return db.prepare(`
      SELECT m.id, m.user_id, m.type, m.content, m.importance, m.confidence,
             m.created_at, m.last_accessed, m.access_count, m.decay_factor,
             m.source_conversation_id, m.last_verified, m.mentions, m.confidence_history,
             m.reason, m.semantic_cluster_id, m.temporal_type
      FROM memories m
      JOIN memories_fts fts ON fts.rowid = m.id
      WHERE m.user_id = ? AND memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(userId, ftsQuery, limit);
  },

  // ─── Semantic search: memories with embeddings for cosine similarity ───

  getMemoriesWithEmbedding(userId, limit = 500) {
    return db.prepare(
      `SELECT ${MEMORY_FULL} FROM memories WHERE user_id = ? AND embedding IS NOT NULL ORDER BY last_accessed DESC LIMIT ?`
    ).all(userId, limit);
  },

  getRecentMemories(userId, days = 7, limit = 50) {
    return db.prepare(
      `SELECT ${MEMORY_CORE} FROM memories WHERE user_id = ? AND last_accessed >= datetime('now', '-' || ? || ' days') ORDER BY last_accessed DESC LIMIT ?`
    ).all(userId, days, limit);
  }
};
