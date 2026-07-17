const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');

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
`);

module.exports = {
  getConversations() {
    return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
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
    return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);
  },

  addMessage(conversationId, role, content, toolName = null) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, tool_name) VALUES (?, ?, ?, ?)').run(conversationId, role, content, toolName);
    db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
  },

  updateConversationTitle(id, title) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  }
};
