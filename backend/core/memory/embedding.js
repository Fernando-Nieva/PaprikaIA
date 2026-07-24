/**
 * MemoryEmbeddingService — Servicio de embeddings para memoria semántica
 *
 * Genera embeddings locales usando FastEmbed (ONNX runtime).
 * No depende de APIs externas — todo corre en la máquina local.
 *
 * Responsabilidades:
 *   1. Generar embeddings a partir de texto (generate)
 *   2. Calcular similitud coseno entre dos vectores (cosineSimilarity)
 *   3. Buscar memorias por similitud semántica (searchByEmbedding)
 *   4. Serializar/deserializar embeddings para SQLite (toBuffer/fromBuffer)
 *
 * Modelo por defecto: fast-all-MiniLM-L6-v2 (384 dims, ~23MB, inglés)
 * Modelo multilingual: fast-multilingual-e5-large (1024 dims, ~500MB, ES/EN/...)
 *
 * El primer uso descarga el modelo automáticamente (~2-10 seg depending on model).
 * Los subsiguientes usos cargan desde local_cache/.
 */

'use strict';

const EMBEDDING_CONFIG = {
  defaultModel: 'allMiniLML6V2',
  fallbackModel: 'allMiniLML6V2',
  cacheDir: 'local_cache',
  batchSize: 64,
  maxTextLength: 512,
  retryAttempts: 3,
  retryDelayMs: 1000,
  maxQueueSize: 1000,
};

class MemoryEmbeddingService {
  constructor(config = {}) {
    this.config = { ...EMBEDDING_CONFIG, ...config };
    this._embedder = null;
    this._initPromise = null;
    this._modelDimensions = 0;
    this._pendingQueue = [];
    this._metrics = {
      generated: 0,
      retried: 0,
      queued: 0,
      failed: 0,
      batchesProcessed: 0,
      queueProcessed: 0,
      queueFailed: 0,
    };
  }

  // ─────────────────────────────────────────────
  //  Inicialización lazy del modelo
  // ─────────────────────────────────────────────

  /**
   * Inicializa el modelo de embeddings de forma lazy.
   * Se ejecuta una sola vez; las llamadas subsiguientes reutilizan la instancia.
   *
   * @param {string} [modelName] - Nombre del modelo (override)
   * @returns {Promise<void>}
   */
  async _ensureInitialized(modelName) {
    if (this._embedder) return;

    if (this._initPromise) {
      await this._initPromise;
      return;
    }

    this._initPromise = this._loadModel(modelName || this.config.defaultModel);
    await this._initPromise;
  }

  /**
   * Carga el modelo con fallback automático.
   * Intenta el modelo preferido; si falla, intenta el fallback.
   *
   * @param {string} modelName
   * @returns {Promise<void>}
   */
  async _loadModel(modelName) {
    const { FlagEmbedding, EmbeddingModel } = require('fastembed');

    const models = {
      allMiniLML6V2: EmbeddingModel.AllMiniLML6V2,
      bgeSmallEN: EmbeddingModel.BGESmallEN,
      bgeBaseEN: EmbeddingModel.BGEBaseEN,
      bgeSmallENV15: EmbeddingModel.BGESmallENV15,
      mle5Large: EmbeddingModel.MLE5Large,
    };

    const target = models[modelName];
    const fallback = models[this.config.fallbackModel];

    try {
      console.log(`[Embedding] Inicializando modelo: ${modelName}...`);
      this._embedder = await FlagEmbedding.init({
        model: target,
        cacheDir: this.config.cacheDir,
        showDownloadProgress: true,
      });

      this._modelDimensions = this._getDimensions(modelName);
      console.log(`[Embedding] Modelo listo: ${modelName} (${this._modelDimensions} dims)`);
    } catch (err) {
      console.warn(`[Embedding] Error con modelo ${modelName}: ${err.message}`);

      if (target !== fallback) {
        console.log(`[Embedding] Intentando modelo fallback: ${this.config.fallbackModel}...`);
        try {
          this._embedder = await FlagEmbedding.init({
            model: fallback,
            cacheDir: this.config.cacheDir,
            showDownloadProgress: true,
          });
          this._modelDimensions = this._getDimensions(this.config.fallbackModel);
          console.log(`[Embedding] Modelo fallback listo: ${this.config.fallbackModel} (${this._modelDimensions} dims)`);
        } catch (fallbackErr) {
          console.error(`[Embedding] Error con modelo fallback: ${fallbackErr.message}`);
          console.error('[Embedding] Embeddings deshabilitados. Búsqueda semántica no disponible.');
          this._initPromise = null;
          return;
        }
      } else {
        console.error('[Embedding] Embeddings deshabilitados. Búsqueda semántica no disponible.');
        this._initPromise = null;
      }
    }
  }

  /**
   * Retorna dimensiones del modelo según nombre.
   *
   * @param {string} modelName
   * @returns {number}
   */
  _getDimensions(modelName) {
    const dims = {
      allMiniLML6V2: 384,
      bgeSmallEN: 384,
      bgeBaseEN: 768,
      bgeSmallENV15: 384,
      mle5Large: 1024,
    };
    return dims[modelName] || 384;
  }

  // ─────────────────────────────────────────────
  //  Retry helper
  // ─────────────────────────────────────────────

  /**
   * Sleep helper for retry delays.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Executes an async operation with retry logic and exponential backoff.
   * On final failure, queues the item and returns null.
   *
   * @param {string} text - Text that failed (for queue storage)
   * @param {Function} operation - Async function to retry
   * @param {string} label - Label for logging
   * @returns {Promise<Float32Array|null>}
   */
  async _withRetry(text, operation, label) {
    const maxAttempts = this.config.retryAttempts + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await operation();
        if (attempt > 0) {
          this._metrics.retried++;
          console.log(`[Embedding] ${label} succeeded after ${attempt + 1} attempts`);
        }
        return result;
      } catch (err) {
        const isLast = attempt === maxAttempts - 1;
        if (!isLast) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          console.warn(`[Embedding] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
          await this._sleep(delay);
        } else {
          console.error(`[Embedding] ${label} failed after ${maxAttempts} attempts: ${err.message}`);
          this._metrics.failed++;
          this._queueFailed(text, err.message);
        }
      }
    }
    return null;
  }

  /**
   * Adds a failed embedding to the pending queue for later retry.
   * @param {string} text
   * @param {string} error
   */
  _queueFailed(text, error) {
    if (this._pendingQueue.length >= this.config.maxQueueSize) {
      console.warn(`[Embedding] Queue full (${this.config.maxQueueSize}), dropping oldest entry`);
      this._pendingQueue.shift();
    }
    this._pendingQueue.push({
      text,
      error,
      attempts: 0,
      created: Date.now(),
    });
    this._metrics.queued++;
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Genera embedding para un texto individual.
   * Retries up to 3 times with exponential backoff before queuing.
   *
   * @param {string} text - Texto a embeber (max ~512 tokens)
   * @returns {Promise<Float32Array|null>} Vector normalizado, o null si el modelo no está disponible
   */
  async generate(text) {
    if (!text || !text.trim()) return null;

    try {
      await this._ensureInitialized();
    } catch (err) {
      console.error('[Embedding] Error inicializando:', err.message);
      return null;
    }

    if (!this._embedder) return null;

    const truncated = text.substring(0, this.config.maxTextLength * 4);

    return this._withRetry(
      truncated,
      async () => {
        const embedding = await this._embedder.queryEmbed(truncated);
        this._metrics.generated++;
        return embedding;
      },
      'generate'
    );
  }

  /**
   * Genera embeddings para múltiples textos (batch).
   * Retries the entire batch first; on failure, falls back to individual items.
   * Individual failures are queued for later retry.
   *
   * @param {string[]} texts - Array de textos
   * @returns {Promise<Float32Array[]>} Array de embeddings (mismo orden)
   */
  async generateBatch(texts) {
    if (!texts || texts.length === 0) return [];

    try {
      await this._ensureInitialized();
    } catch (err) {
      console.error('[Embedding] Error inicializando batch:', err.message);
      return texts.map(() => null);
    }

    if (!this._embedder) return texts.map(() => null);

    const truncated = texts.map(t => (t || '').substring(0, this.config.maxTextLength * 4));
    const maxAttempts = this.config.retryAttempts + 1;

    // Try batch first
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const results = [];
        for await (const batch of this._embedder.embed(truncated, this.config.batchSize)) {
          results.push(...batch);
        }
        if (attempt > 0) {
          this._metrics.retried++;
          console.log(`[Embedding] Batch succeeded after ${attempt + 1} attempts`);
        }
        this._metrics.batchesProcessed++;
        return results;
      } catch (err) {
        const isLast = attempt === maxAttempts - 1;
        if (!isLast) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          console.warn(`[Embedding] Batch attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
          await this._sleep(delay);
        } else {
          console.warn(`[Embedding] Batch failed, falling back to individual items: ${err.message}`);
        }
      }
    }

    // Batch failed: fall back to individual items with retry
    const results = new Array(texts.length).fill(null);
    for (let i = 0; i < truncated.length; i++) {
      const embedding = await this._withRetry(
        truncated[i],
        async () => {
          const emb = await this._embedder.queryEmbed(truncated[i]);
          return emb;
        },
        `batch-item-${i}`
      );
      if (embedding) {
        results[i] = embedding;
      }
    }

    this._metrics.batchesProcessed++;
    return results;
  }

  /**
   * Calcula similitud coseno entre dos vectores.
   * Ambos deben tener la misma dimensión.
   *
   * @param {Float32Array|number[]} a - Vector A
   * @param {Float32Array|number[]} b - Vector B
   * @returns {number} Similitud coseno (-1 a 1, normalizado ~0 a 1 para embeddings positivos)
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Busca memorias por similitud semántica.
   *
   * @param {Float32Array|number[]} queryEmbedding - Embedding del query
   * @param {Array} memories - Memorias de la DB (con campo embedding como Buffer|null)
   * @param {Object} [options]
   * @param {number} [options.limit=10] - Máximo de resultados
   * @param {number} [options.minScore=0] - Score mínimo de similitud
   * @returns {Array} Memorias con campo _semanticScore, ordenadas por similitud desc
   */
  searchByEmbedding(queryEmbedding, memories, options = {}) {
    const { limit = 10, minScore = 0 } = options;

    if (!queryEmbedding || !memories || memories.length === 0) return [];

    const scored = [];
    let dimensionMismatches = 0;

    for (const memory of memories) {
      if (!memory.embedding) continue;

      const memEmbedding = this.fromBuffer(memory.embedding);
      if (!memEmbedding) {
        dimensionMismatches++;
        continue;
      }

      const score = this.cosineSimilarity(queryEmbedding, memEmbedding);
      if (score >= minScore) {
        scored.push({ ...memory, _semanticScore: score });
      }
    }

    if (dimensionMismatches > 0) {
      console.warn(`[Embedding] ${dimensionMismatches}/${memories.length} embeddings skipped (dimension mismatch)`);
    }

    scored.sort((a, b) => b._semanticScore - a._semanticScore);
    return scored.slice(0, limit);
  }

  // ─────────────────────────────────────────────
  //  Queue processing
  // ─────────────────────────────────────────────

  /**
   * Processes the pending queue by retrying failed embeddings.
   * Calls processFn(item, embedding) for each successfully generated embedding.
   *
   * @param {Function} processFn - Async function(item, embedding) to handle the result
   * @returns {Promise<{processed: number, failed: number}>}
   */
  async processQueue(processFn) {
    const results = { processed: 0, failed: 0 };
    const remaining = [];

    for (const item of this._pendingQueue) {
      item.attempts++;

      if (item.attempts > this.config.retryAttempts + 1) {
        console.error(`[Embedding] Queue item exceeded max attempts, discarding: ${item.text.substring(0, 50)}...`);
        results.failed++;
        this._metrics.queueFailed++;
        continue;
      }

      try {
        const embedding = await this.generate(item.text);
        if (embedding) {
          await processFn(item, embedding);
          results.processed++;
          this._metrics.queueProcessed++;
        } else {
          remaining.push(item);
          results.failed++;
        }
      } catch (err) {
        console.error(`[Embedding] Queue processing error: ${err.message}`);
        remaining.push(item);
        results.failed++;
      }
    }

    this._pendingQueue = remaining;

    if (results.processed > 0 || results.failed > 0) {
      console.log(`[Embedding] Queue processed: ${results.processed} ok, ${results.failed} failed, ${this._pendingQueue.length} remaining`);
    }

    return results;
  }

  // ─────────────────────────────────────────────
  //  Serialización para SQLite
  // ─────────────────────────────────────────────

  /**
   * Convierte Float32Array a Buffer para almacenar en SQLite BLOB.
   *
   * @param {Float32Array} embedding
   * @returns {Buffer|null}
   */
  toBuffer(embedding) {
    if (!embedding) return null;
    try {
      return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    } catch (err) {
      console.error('[Embedding] toBuffer conversion failed:', err.message);
      return null;
    }
  }

  /**
   * Convierte Buffer de SQLite a Float32Array.
   *
   * @param {Buffer} buffer
   * @returns {Float32Array|null}
   */
  fromBuffer(buffer) {
    if (!buffer) return null;
    try {
      if (buffer instanceof Float32Array) return buffer;
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
      const arr = new Float32Array(arrayBuffer);

      // Validate dimensions against current model
      if (this._modelDimensions > 0 && arr.length !== this._modelDimensions) {
        console.warn(`[Embedding] Dimension mismatch: expected ${this._modelDimensions}, got ${arr.length}. Stale embedding from different model.`);
        return null;
      }

      return arr;
    } catch (err) {
      console.error('[Embedding] fromBuffer conversion failed:', err.message);
      return null;
    }
  }

  /**
   * Retorna si el servicio está disponible (modelo cargado).
   *
   * @returns {boolean}
   */
  isAvailable() {
    return this._embedder !== null;
  }

  /**
   * Retorna dimensiones del modelo actual.
   *
   * @returns {number}
   */
  getDimensions() {
    return this._modelDimensions;
  }

  /**
   * Returns current metrics and queue status.
   *
   * @returns {Object}
   */
  getMetrics() {
    return {
      ...this._metrics,
      queueSize: this._pendingQueue.length,
      isAvailable: this.isAvailable(),
      dimensions: this._modelDimensions,
    };
  }

  /**
   * Returns the pending queue for inspection.
   *
   * @returns {Array}
   */
  getPendingQueue() {
    return [...this._pendingQueue];
  }
}

module.exports = MemoryEmbeddingService;
