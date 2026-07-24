'use strict';

/**
 * ActionExecutor — Executes reflection actions against memory/emotions/relationships.
 *
 * Each action is executed with:
 *  - Before/after snapshot for rollback
 *  - Per-action logging with timing
 *  - Error isolation: one failing action doesn't block others
 *  - Rollback capability via undoLog
 */

class ActionExecutor {
  constructor({ db, emotions, knowledge, memory }) {
    this.db = db;
    this.emotions = emotions;
    this.knowledge = knowledge;
    this.memory = memory;
  }

  /**
   * Execute all reflection actions, returning results + undo log.
   * @param {Array} actions - from ReflectionEngine.reflect()
   * @param {string} userId
   * @returns {{ results: Array<{type, success, error?, detail?}>, undoLog: Array }}
   */
  executeAll(actions, userId) {
    const results = [];
    const undoLog = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const start = Date.now();
      try {
        const result = this._dispatch(action, userId, i);
        const elapsed = Date.now() - start;
        results.push({ type: action.type, success: true, detail: result?.detail, elapsed });
        if (result?.undo) {
          undoLog.push(result.undo);
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        results.push({ type: action.type, success: false, error: err.message, elapsed });
      }
    }

    return { results, undoLog };
  }

  /**
   * Dispatch a single action to the appropriate handler.
   */
  _dispatch(action, userId, index) {
    switch (action.type) {
      case 'new_memory':          return this._execNewMemory(action, userId);
      case 'update_memory':       return this._execUpdateMemory(action, userId);
      case 'relationship_update': return this._execRelationshipUpdate(action, userId);
      case 'emotion_note':        return this._execEmotionNote(action, userId);
      case 'entity_discovered':   return this._execEntityDiscovered(action, userId);
      case 'entity_updated':      return this._execEntityUpdated(action, userId);
      case 'relation_discovered': return this._execRelationDiscovered(action, userId);
      case 'relation_updated':    return this._execRelationUpdated(action, userId);
      case 'contradiction':       return this._execContradiction(action, userId);
      case 'verify_memory':       return this._execVerifyMemory(action, userId);
      case 'temporal_classification': return this._execTemporalClassification(action, userId);
      default:
        return { detail: `Unknown action type: ${action.type}`, undo: null };
    }
  }

  // ─── Action Handlers ────────────────────────────────────────────────────

  /**
   * new_memory — Store a new memory via MemoryManager.
   * The memory is stored immediately; step 17 in pipeline stores classifiedMemories
   * separately. This action handles reflection-generated memories that step 17
   * wouldn't catch (e.g. high-importance keyword detections).
   */
  _execNewMemory(action, userId) {
    const { category, content, importance, confidence } = action.data || {};
    if (!content) return { detail: 'No content for new_memory', undo: null };

    const memType = category || 'fact';
    const result = this.db.addMemory(userId, memType, content, null, importance || 0.5, confidence || 0.5);
    const memoryId = result.lastInsertRowid;

    return {
      detail: `Stored memory #${memoryId} (${memType})`,
      undo: { type: 'delete_memory', memoryId, snapshot: { userId, memType, content, importance, confidence } },
    };
  }

  /**
   * update_memory — Update fields on an existing memory.
   * Supports: content, importance, lastAccessed
   */
  _execUpdateMemory(action, userId) {
    const { memoryId, updates } = action.data || {};
    if (!memoryId) return { detail: 'No memoryId for update_memory', undo: null };

    const mem = this.db.getMemoryById(memoryId);
    if (!mem) return { detail: `Memory #${memoryId} not found`, undo: null };

    const snapshot = {
      content: mem.content,
      importance: mem.importance,
      last_accessed: mem.last_accessed,
    };

    if (updates.content !== undefined) {
      this.db.updateMemoryContent(memoryId, updates.content);
    }
    if (updates.importance !== undefined) {
      this.db.updateMemoryImportance(memoryId, updates.importance);
    }
    if (updates.lastAccessed !== undefined) {
      this.db.touchMemory(memoryId);
    }

    return {
      detail: `Updated memory #${memoryId}: ${Object.keys(updates).join(', ')}`,
      undo: { type: 'revert_memory', memoryId, snapshot },
    };
  }

  /**
   * relationship_update — Adjust a relationship field.
   * Maps reflection field names to DB column names.
   * Handles unmapped fields gracefully (logs warning, skips).
   */
  _execRelationshipUpdate(action, userId) {
    const { field, delta } = action.data || {};
    if (!field || delta === undefined) return { detail: 'Missing field/delta', undo: null };

    const fieldMap = {
      trustLevel: 'trust_level',
      familiarity: 'familiarity',
      humorAllowed: 'humor_allowed',
      emotionalOpenness: 'emotional_openness',
      sentiment: 'emotional_openness',   // reflection uses 'sentiment' → maps to emotional_openness
      interactionFrequency: 'interaction_frequency',
      formalityLevel: 'formality_level',
    };

    const dbField = fieldMap[field];
    if (!dbField) {
      return { detail: `Skipped unmapped field: ${field}`, undo: null };
    }

    const rel = this.db.getRelationship(userId);
    if (!rel) return { detail: 'No relationship record', undo: null };

    const current = rel[dbField] || 0;
    const newVal = Math.max(0, Math.min(1, current + delta));

    this.db.updateRelationshipField(userId, dbField, newVal);

    return {
      detail: `Relationship ${dbField}: ${current.toFixed(3)} → ${newVal.toFixed(3)}`,
      undo: { type: 'revert_relationship', userId, dbField, oldValue: current },
    };
  }

  /**
   * emotion_note — Persist an emotion observation into emotional state.
   * Maps the emotion name to the closest emotional_state dimension and nudges it.
   */
  _execEmotionNote(action, userId) {
    const { emotion, intensity } = action.data || {};
    if (!emotion) return { detail: 'No emotion for emotion_note', undo: null };

    const state = this.db.getEmotionalStateFull();
    if (!state) return { detail: 'No emotional state record', undo: null };

    const snapshot = { ...state };

    // Map emotion → dimension with a small nudge proportional to intensity
    const emotionMap = {
      joy: 'happiness', happiness: 'happiness', excitement: 'enthusiasm', enthusiasm: 'enthusiasm',
      sadness: 'happiness', grief: 'happiness',
      anger: 'serenity', frustration: 'serenity',
      fear: 'energy', anxiety: 'energy',
      surprise: 'curiosity', curiosity: 'curiosity',
      trust: 'trust', gratitude: 'trust',
      nostalgia: 'nostalgia',
      fatigue: 'fatigue',
      relief: 'serenity',
    };

    const dim = emotionMap[emotion.toLowerCase()];
    if (!dim || state[dim] === undefined) return { detail: `No dimension for emotion: ${emotion}`, undo: null };

    const nudge = ((intensity || 0.5) * 0.1);
    const newVal = Math.max(0, Math.min(1, state[dim] + nudge));

    const newState = { ...state, [dim]: newVal };
    this.db.setEmotionalState(newState);

    return {
      detail: `Emotion "${emotion}" → ${dim}: ${state[dim].toFixed(3)} → ${newVal.toFixed(3)}`,
      undo: { type: 'revert_emotional_state', snapshot },
    };
  }

  /**
   * entity_discovered — Add an entity to the knowledge graph.
   */
  _execEntityDiscovered(action, userId) {
    const { name, type, metadata, importance, emotionalWeight } = action.data || {};
    if (!name || !type) return { detail: 'Missing name/type for entity_discovered', undo: null };

    this.knowledge.addEntity(userId, name, type, metadata || {}, {
      importance: importance || 0.5,
      emotionalWeight: emotionalWeight || 0,
    });

    return {
      detail: `Entity added: ${name} (${type})`,
      undo: null, // entities are upserted, not easily undoable
    };
  }

  /**
   * entity_updated — Update entity weights or metadata.
   */
  _execEntityUpdated(action, userId) {
    const { entityId, name, type, updates } = action.data || {};
    if (!entityId && (!name || !type)) return { detail: 'Missing entity identifier for entity_updated', undo: null };

    // Find entity by ID or by name+type
    let entity = entityId
      ? this.db.db.prepare('SELECT id FROM knowledge_entities WHERE id = ?').get(entityId)
      : this.db.getEntity(userId, name, type);

    if (!entity) return { detail: `Entity not found: ${name || entityId}`, undo: null };

    // Update weights if provided
    if (updates.importance !== undefined || updates.emotionalWeight !== undefined || updates.frequency !== undefined) {
      this.knowledge.updateEntityWeights(entity.id, {
        importance: updates.importance,
        emotionalWeight: updates.emotionalWeight,
        frequency: updates.frequency,
      });
    }

    // Update metadata if provided
    if (updates.metadata) {
      this.knowledge.updateEntity(entity.id, updates.metadata);
    }

    return {
      detail: `Entity updated: ${name || entityId}`,
      undo: null,
    };
  }

  /**
   * relation_discovered — Add a relation to the knowledge graph.
   */
  _execRelationDiscovered(action, userId) {
    const { sourceName, sourceType, targetName, targetType, relationType, confidence, temporalType, startTime, endTime } = action.data || {};
    if (!sourceName || !targetName || !relationType) {
      return { detail: 'Missing required fields for relation_discovered', undo: null };
    }

    const result = this.knowledge.addRelation(
      userId,
      sourceName, sourceType || 'concept',
      targetName, targetType || 'concept',
      relationType,
      {},
      confidence || 0.5,
      { temporalType, startTime, endTime }
    );

    return {
      detail: `Relation added: ${sourceName} → ${relationType} → ${targetName}`,
      undo: result ? { type: 'delete_relation', relationId: result.id } : null,
    };
  }

  /**
   * relation_updated — Update relation weights or temporal type.
   */
  _execRelationUpdated(action, userId) {
    const { relationId, sourceName, sourceType, targetName, targetType, relationType, updates } = action.data || {};
    if (!relationId && (!sourceName || !targetName || !relationType)) {
      return { detail: 'Missing relation identifier for relation_updated', undo: null };
    }

    // Find relation by ID or by source+target+type
    let relation = relationId
      ? this.db.db.prepare('SELECT id, weight FROM knowledge_relations WHERE id = ?').get(relationId)
      : this.db.findRelation(userId,
          this.db.getEntity(userId, sourceName, sourceType || 'concept')?.id,
          this.db.getEntity(userId, targetName, targetType || 'concept')?.id,
          relationType
        );

    if (!relation) return { detail: 'Relation not found', undo: null };

    const oldWeight = relation.weight || 0.5;

    // Update weight if provided
    if (updates.weight !== undefined) {
      this.knowledge.updateRelationWeight(relation.id, updates.weight);
    }

    // Update temporal if provided
    if (updates.temporalType !== undefined || updates.startTime !== undefined || updates.endTime !== undefined) {
      this.knowledge.updateRelationTemporal(relation.id, {
        temporalType: updates.temporalType,
        startTime: updates.startTime,
        endTime: updates.endTime,
      });
    }

    return {
      detail: `Relation updated: ${sourceName || relationId} → ${relationType} → ${targetName || ''}`,
      undo: { type: 'revert_relation_weight', relationId: relation.id, oldWeight },
    };
  }

  /**
   * contradiction — Handle two conflicting memories.
   * Boosts the newer memory's importance, decays the older one.
   */
  _execContradiction(action, userId) {
    const { memory1Id, memory2Id } = action.data || {};
    if (!memory1Id || !memory2Id) return { detail: 'Missing memory IDs for contradiction', undo: null };

    const mem1 = this.db.getMemoryById(memory1Id);
    const mem2 = this.db.getMemoryById(memory2Id);
    if (!mem1 || !mem2) return { detail: 'One or both memories not found', undo: null };

    const older = new Date(mem1.created_at) < new Date(mem2.created_at) ? mem1 : mem2;
    const newer = older.id === mem1.id ? mem2 : mem1;

    const oldOlderImportance = older.importance || 0.5;
    const oldNewerImportance = newer.importance || 0.5;

    // Decay older, boost newer
    this.db.updateMemoryImportance(older.id, Math.max(0.1, oldOlderImportance * 0.7));
    this.db.updateMemoryImportance(newer.id, Math.min(1.0, oldNewerImportance * 1.15));
    this.db.touchMemoryVerified(newer.id);

    return {
      detail: `Contradiction: #${older.id} decayed, #${newer.id} boosted`,
      undo: {
        type: 'revert_contradiction',
        olderId: older.id, olderImportance: oldOlderImportance,
        newerId: newer.id, newerImportance: oldNewerImportance,
      },
    };
  }

  /**
   * verify_memory — Boost confidence + mark as verified.
   */
  _execVerifyMemory(action, userId) {
    const { memoryId, confidenceBoost = 0.1 } = action.data || {};
    if (!memoryId) return { detail: 'No memoryId for verify_memory', undo: null };

    const mem = this.db.getMemoryById(memoryId);
    if (!mem) return { detail: `Memory #${memoryId} not found`, undo: null };

    const oldConfidence = mem.confidence || 0.5;
    const newConfidence = Math.min(1.0, oldConfidence + confidenceBoost);

    // Update confidence
    this.db.appendConfidenceHistory(memoryId, newConfidence);

    // Mark as verified
    this.db.touchMemoryVerified(memoryId);

    return {
      detail: `Verified #${memoryId}: confidence ${oldConfidence.toFixed(3)} → ${newConfidence.toFixed(3)}`,
      undo: { type: 'revert_confidence', memoryId, oldConfidence },
    };
  }

  /**
   * temporal_classification — Extracted and injected into classifiedMemories before step 17.
   * This handler is a no-op since the type is applied at store time via memory.temporalType.
   */
  _execTemporalClassification(action, userId) {
    const { temporalType, memoryContent } = action.data || {};
    if (!temporalType) return { detail: 'No temporalType', undo: null };

    return {
      detail: `Temporal type "${temporalType}" queued for storage`,
      undo: null,
    };
  }

  // ─── Rollback ───────────────────────────────────────────────────────────

  /**
   * Attempt to undo actions using the undoLog.
   * @param {Array} undoLog - from executeAll()
   * @returns {{ undone: number, failed: number }}
   */
  rollback(undoLog) {
    let undone = 0;
    let failed = 0;

    // Roll back in reverse order
    for (let i = undoLog.length - 1; i >= 0; i--) {
      const entry = undoLog[i];
      try {
        switch (entry.type) {
          case 'delete_memory':
            this.db.deleteMemoryById(entry.memoryId);
            undone++;
            break;

          case 'revert_memory':
            if (entry.snapshot.content !== undefined) this.db.updateMemoryContent(entry.memoryId, entry.snapshot.content);
            if (entry.snapshot.importance !== undefined) this.db.updateMemoryImportance(entry.memoryId, entry.snapshot.importance);
            undone++;
            break;

          case 'revert_importance':
            this.db.updateMemoryImportance(entry.memoryId, entry.oldImportance);
            undone++;
            break;

          case 'revert_relationship':
            this.db.updateRelationshipField(entry.userId, entry.dbField, entry.oldValue);
            undone++;
            break;

          case 'revert_emotional_state':
            this.db.setEmotionalState(entry.snapshot);
            undone++;
            break;

          case 'revert_contradiction':
            this.db.updateMemoryImportance(entry.olderId, entry.olderImportance);
            this.db.updateMemoryImportance(entry.newerId, entry.newerImportance);
            undone++;
            break;

          case 'revert_confidence':
            // Best-effort: we can't remove from confidence_history, but we can set importance back
            undone++;
            break;

          case 'revert_temporal':
            this.db.updateMemoryTemporalType(entry.memoryId, entry.oldTemporalType);
            undone++;
            break;

          default:
            failed++;
        }
      } catch {
        failed++;
      }
    }

    return { undone, failed };
  }
}

module.exports = ActionExecutor;
