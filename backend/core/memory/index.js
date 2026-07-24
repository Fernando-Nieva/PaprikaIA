/**
 * MemoryManager — Gestor de recuerdos
 *
 * Responsabilidad: almacenar, actualizar y recuperar recuerdos.
 * NO interpreta mensajes — eso lo hace el MemoryClassifier.
 * NO rankea — eso lo hace ContextRanker.
 *
 * Flujo:
 * 1. MemoryClassifier clasifica el análisis en recuerdos estructurados
 * 2. MemoryManager almacena/actualiza esos recuerdos en SQLite
 * 3. MemorySearch recupera candidatos, ContextRanker los rankea
 *
 * Almacén:
 * - Historial de mensajes (ya existente, nivel 1)
 * - Recuerdos estructurados con categorías (nivel 2, nuevo)
 *
 * Cada recuerdo tiene:
 * - category: preference|person|relationship|personal_data|project|goal|date|experience|event
 * - content: texto descriptivo del recuerdo
 * - importance: 0-1
 * - confidence: confianza del análisis que lo generó
 * - metadata: entidades, tema, etc.
 */

class MemoryManager {
  /**
   * @param {Object} db - Capa de base de datos
   * @param {CoreConfig} config - Configuración centralizada
   * @param {MemoryEmbeddingService} [embeddingService] - Servicio de embeddings (opcional)
   */
  constructor(db, config, embeddingService = null, knowledgeGraph = null) {
    this.db = db;
    this.config = config;
    this.embedding = embeddingService;
    this.knowledgeGraph = knowledgeGraph;
  }

  // ─────────────────────────────────────────────
  //  Almacenamiento — Unified store
  // ─────────────────────────────────────────────

  /**
   * Almacena uno o varios recuerdos clasificados.
   * Acepta tanto un solo recuerdo como el output completo de MemoryClassifier.
   * Genera embeddings automáticamente (individual o por lote).
   *
   * @param {Object|Array} input - Recuerdo estructurado o classifiedMemories
   * @param {string} userId - ID del usuario
   * @param {Object} [meta] - Metadata adicional (solo para store individual)
   * @returns {Promise<Object>} { stored, updated, discarded } o { id, ...memory, userId }
   */
  async store(input, userId, meta = {}) {
    // Detect if this is a classified batch or a single memory
    if (input && input.memories && Array.isArray(input.memories)) {
      return this._storeBatch(input, userId);
    }
    return this._storeSingle(input, userId, meta);
  }

  /**
   * Stores a single memory with optional metadata.
   * @private
   */
  async _storeSingle(memory, userId, meta = {}) {
    try {
      let embeddingBuffer = null;

      if (this.embedding && this.embedding.isAvailable() && memory.content) {
        const vector = await this.embedding.generate(memory.content);
        if (vector) {
          embeddingBuffer = this.embedding.toBuffer(vector);
        } else {
          console.warn(`[Memory] Embedding generation returned null for memory: ${memory.content.substring(0, 50)}...`);
        }
      }

      const result = this.db.addMemory(
        userId,
        memory.category,
        memory.content,
        embeddingBuffer,
        memory.importance || 0.5,
        memory.confidence || 0.5
      );

      const memoryId = result.lastInsertRowid;

      if (meta.sourceConversationId) {
        this.db.updateMemorySourceConversation(memoryId, meta.sourceConversationId);
      }
      if (meta.reason) {
        this.db.updateMemoryReason(memoryId, meta.reason);
      }
      if (meta.temporalType) {
        this.db.updateMemoryTemporalType(memoryId, meta.temporalType);
      }
      if (memory.confidence) {
        this.db.appendConfidenceHistory(memoryId, memory.confidence);
      }

      return { id: memoryId, ...memory, userId };
    } catch (err) {
      console.error('Error almacenando recuerdo:', err.message);
      return null;
    }
  }

  /**
   * Stores a batch of classified memories with batch embedding optimization.
   * @private
   */
  async _storeBatch(classifiedMemories, userId) {
    const stats = { stored: 0, updated: 0, discarded: 0 };
    const toStore = classifiedMemories.memories || [];

    if (this.embedding && this.embedding.isAvailable() && toStore.length > 0) {
      const contents = toStore.map(m => m.content || '');
      const embeddings = await this.embedding.generateBatch(contents);

      let embeddingSuccesses = 0;
      let embeddingFailures = 0;

      for (let i = 0; i < toStore.length; i++) {
        const memory = toStore[i];
        const embeddingBuffer = embeddings[i] ? this.embedding.toBuffer(embeddings[i]) : null;
        if (embeddingBuffer) {
          embeddingSuccesses++;
        } else {
          embeddingFailures++;
        }

        if (memory.action === 'new') {
          try {
            const result = this.db.addMemory(
              userId,
              memory.category,
              memory.content,
              embeddingBuffer,
              memory.importance || 0.5,
              memory.confidence || 0.5
            );
            const memId = result.lastInsertRowid;
            stats.stored++;
            if (memory.reason) {
              this.db.updateMemoryReason(memId, memory.reason);
            }
            if (memory.temporalType) {
              this.db.updateMemoryTemporalType(memId, memory.temporalType);
            }
            if (memory.confidence) {
              this.db.appendConfidenceHistory(memId, memory.confidence);
            }
            if (this.knowledgeGraph && memory.content) {
              try {
                await this.knowledgeGraph.extractFromMemory(userId, memory.content, {
                  memoryType: memory.category,
                  isGoal: memory.category === 'goal'
                });
              } catch (err) {
                console.error('[Memory] Knowledge extraction failed:', err.message);
              }
            }
          } catch (err) {
            console.error('Error almacenando recuerdo:', err.message);
          }
        } else if (memory.action === 'update' && memory.existingId) {
          try {
            this.db.updateMemoryContent(memory.existingId, memory.content);
            if (embeddingBuffer) {
              this.db.updateMemoryEmbedding(memory.existingId, embeddingBuffer);
            }
            if (memory.importance !== undefined) {
              this.db.updateMemoryImportance(memory.existingId, memory.importance);
            }
            if (memory.confidence) {
              this.db.appendConfidenceHistory(memory.existingId, memory.confidence);
            }
            this.db.incrementMemoryMentions(memory.existingId);
            this.db.touchMemory(memory.existingId);
            stats.updated++;
          } catch (err) {
            console.error('Error actualizando recuerdo:', err.message);
          }
        }
      }

      if (embeddingFailures > 0) {
        console.warn(`[Memory] Batch embeddings: ${embeddingSuccesses} succeeded, ${embeddingFailures} failed`);
      }
    } else {
      for (const memory of toStore) {
        if (memory.action === 'new') {
          const stored = await this._storeSingle(memory, userId);
          if (stored) stats.stored++;
        } else if (memory.action === 'update' && memory.existingId) {
          const updated = await this.update(memory.existingId, {
            content: memory.content,
            importance: memory.importance
          });
          if (updated) stats.updated++;
        }
      }
    }

    stats.discarded = (classifiedMemories.discarded || []).length;
    return stats;
  }

  /**
   * Actualiza un recuerdo existente. Regenera embedding si el contenido cambió.
   *
   * @param {number} memoryId - ID del recuerdo a actualizar
   * @param {Object} updates - Campos a actualizar
   * @returns {Promise<boolean>} true si se actualizó correctamente
   */
  async update(memoryId, updates) {
    try {
      if (updates.content) {
        this.db.updateMemoryContent(memoryId, updates.content);

        if (this.embedding && this.embedding.isAvailable()) {
          const vector = await this.embedding.generate(updates.content);
          if (vector) {
            const buffer = this.embedding.toBuffer(vector);
            this.db.updateMemoryEmbedding(memoryId, buffer);
          } else {
            console.warn(`[Memory] Embedding regeneration failed for memory ${memoryId}`);
          }
        }
      }
      if (updates.importance !== undefined) {
        this.db.updateMemoryImportance(memoryId, updates.importance);
      }
      if (updates.confidence !== undefined) {
        this.db.appendConfidenceHistory(memoryId, updates.confidence);
      }
      if (updates.temporalType) {
        this.db.updateMemoryTemporalType(memoryId, updates.temporalType);
      }
      this.db.incrementMemoryMentions(memoryId);
      this.db.touchMemory(memoryId);
      return true;
    } catch (err) {
      console.error('Error actualizando recuerdo:', err.message);
      return false;
    }
  }

  /**
   * Genera y almacena embeddings para memorias que no los tienen.
   * Ejecuta en lotes para no bloquear el event loop.
   * Also processes the pending queue from failed embeddings.
   *
   * @param {string} userId - ID del usuario
   * @param {number} [batchSize=10] - Memorias por lote
   * @returns {Promise<{processed: number, queueProcessed: number}>} Resultados del backfill
   */
  async backfillEmbeddings(userId, batchSize = 10) {
    if (!this.embedding || !this.embedding.isAvailable()) return { processed: 0, queueProcessed: 0 };

    let totalProcessed = 0;
    let hasMore = true;

    while (hasMore) {
      const memories = this.db.getMemoriesWithoutEmbedding(userId, batchSize);
      if (memories.length === 0) {
        hasMore = false;
        break;
      }

      const contents = memories.map(m => m.content || '');
      const embeddings = await this.embedding.generateBatch(contents);

      let batchSuccesses = 0;
      let batchFailures = 0;

      for (let i = 0; i < memories.length; i++) {
        if (embeddings[i]) {
          const buffer = this.embedding.toBuffer(embeddings[i]);
          this.db.updateMemoryEmbedding(memories[i].id, buffer);
          batchSuccesses++;
        } else {
          batchFailures++;
        }
      }

      totalProcessed += batchSuccesses;

      if (batchFailures > 0) {
        console.warn(`[Embedding] Backfill batch: ${batchSuccesses} ok, ${batchFailures} failed (queued for retry)`);
      }

      if (memories.length < batchSize) {
        hasMore = false;
      }
    }

    // Process pending queue
    let queueProcessed = 0;
    if (this.embedding._pendingQueue && this.embedding._pendingQueue.length > 0) {
      console.log(`[Embedding] Processing ${this.embedding._pendingQueue.length} queued items...`);
      const queueResult = await this.embedding.processQueue(async (item, embedding) => {
        // Find memory by content and update embedding
        const memories = this.db.searchMemories(userId, item.text);
        if (memories.length > 0) {
          const buffer = this.embedding.toBuffer(embedding);
          this.db.updateMemoryEmbedding(memories[0].id, buffer);
        }
      });
      queueProcessed = queueResult.processed;
    }

    const metrics = this.embedding.getMetrics();
    console.log(`[Embedding] Backfill completado: ${totalProcessed} nuevos, ${queueProcessed} de cola | Métricas: ${JSON.stringify(metrics)}`);

    return { processed: totalProcessed, queueProcessed };
  }

  // ─────────────────────────────────────────────
  //  Recuperación
  // ─────────────────────────────────────────────

  /**
   * Busca recuerdos por contenido (para MemoryClassifier).
   *
   * @param {string} query - Texto de búsqueda
   * @param {string} userId - ID del usuario
   * @returns {Array} Recuerdos similares
   */
  searchByContent(query, userId) {
    try {
      let results = this.db.searchMemoriesFTS(userId, query, 10);
      if (results.length === 0) {
        results = this.db.searchMemories(userId, query);
      }
      return results.map(m => ({
        id: m.id,
        category: m.type,
        content: m.content,
        importance: m.importance,
        confidence: m.confidence,
        createdAt: m.created_at
      }));
    } catch {
      return [];
    }
  }

  /**
   * Retorna todos los recuerdos de un usuario.
   *
   * @param {string} userId - ID del usuario
   * @param {number} limit - Límite de resultados
   * @returns {Array}
   */
  getAll(userId, limit = 50) {
    try {
      return this.db.getMemoriesByUser(userId, limit);
    } catch {
      return [];
    }
  }

  /**
   * Retorna recuerdos por categoría.
   *
   * @param {string} userId - ID del usuario
   * @param {string} category - Categoría a filtrar
   * @returns {Array}
   */
  getByCategory(userId, category) {
    try {
      return this.db.getMemoriesByType(userId, category, 100);
    } catch {
      return [];
    }
  }
}

module.exports = MemoryManager;
