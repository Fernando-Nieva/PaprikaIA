/**
 * PaprikaCore — Orquestador central del sistema cognitivo (Fase 4).
 *
 * Inicializa todos los módulos y expone el Pipeline como punto de entrada único.
 * Todas las solicitudes de chat pasan por Core antes de llegar al proveedor IA.
 *
 * Uso:
 *   const core = require('./core')(db);
 *   const result = await core.processMessage({ message, conversationId, ... });
 *
 * Arquitectura Fase 4 — Capa Cognitiva:
 *
 *   Frontend → Express → PaprikaCore.processMessage() → Pipeline (22 pasos)
 *                                                         ↓
 *                                               ┌── Pre-response ──┐
 *                                               │  Analyzer         │
 *                                               │  MemoryClassifier │
 *                                               │  Relationship     │
 *                                               │  Emotions (pre)   │
 *                                               │  MemorySearch     │
 *                                               │  Personality      │
 *                                               └───────────────────┘
 *                                                         ↓
 *                                               ┌── AI Provider ───┐
 *                                               │  chatFn(messages) │
 *                                               └───────────────────┘
 *                                                         ↓
 *                                               ┌─ Post-response ──┐
 *                                               │  ResponseProcess  │
 *                                               │  Reflection       │
 *                                               │  MemoryManager    │
 *                                               │  Relationship     │
 *                                               │  Emotions (post)  │
 *                                               │  KnowledgeGraph   │
 *                                               │  Summarizer       │
 *                                               └───────────────────┘
 *                                                         ↓
 *                                               ┌── Off-peak ──────┐
 *                                               │  SleepCycle (async)│
 *                                               │  Consolidation    │
 *                                               │  Decay            │
 *                                               │  Re-embedding     │
 *                                               │  Clustering       │
 *                                               └───────────────────┘
 *
 * Sleep Cycle:
 *   - Se ejecuta DESPUÉS del pipeline, nunca durante.
 *   - Trigger: cada N conversaciones o por scheduler periódico.
 *   - El usuario NUNCA espera el Sleep Cycle.
 *   - Corre async con guard anti-concorrencia.
 *
 * Configuración:
 *   Ningún módulo lee config.json directamente.
 *   Todos acceden vía CoreConfig (fuente única de verdad).
 *
 * Módulos activos (Fase 4):
 *   - Analyzer: análisis de mensajes con confidence/reasoning
 *   - PersonalityEngine: system prompt modular desde personality.json
 *   - MemoryClassifier: clasifica recuerdos en 9 categorías
 *   - MemoryManager: almacena/actualiza recuerdos
 *   - MemorySearch: recuperación inteligente con scoring
 *   - EmotionEngine: estado emocional persistente con decay
 *   - RelationshipEngine: evolución del vínculo por usuario
 *   - ReflectionEngine: análisis interno post-respuesta
 *   - KnowledgeGraph: entidad-reación para grafo de conocimiento
 *   - Summarizer: resúmenes automáticos de conversaciones
 *   - ContextBuilder: ensamblaje de contexto (preparado para futuro)
 *   - ResponseProcessor: post-procesamiento de respuestas
 *   - SleepCycle: mantenimiento off-peak (consolidation, decay, re-embed, clustering)
 */

const path = require('path');
const CoreConfig = require('./config');
const Pipeline = require('./pipeline');
const MessageAnalyzer = require('./analyzer');
const MemoryClassifier = require('./memory/classifier');
const MemoryManager = require('./memory');
const MemorySearch = require('./memory/search');
const MemoryConsolidation = require('./memory/consolidation');
const MemoryEmbeddingService = require('./memory/embedding');
const MemoryImportance = require('./memory/importance');
const MemorySleepCycle = require('./memory/sleep');
const WorkingMemoryManager = require('./memory/working');
const ArchiveMemoryManager = require('./memory/archive');
const EmotionEngine = require('./emotions');
const PersonalityEngine = require('./personality');
const RelationshipEngine = require('./relationship');
const ContextBuilder = require('./context');
const ResponseProcessor = require('./response');
const Summarizer = require('./summarizer');
const { ReflectionEngine } = require('./reflection');
const ActionExecutor = require('./reflection/executor');
const KnowledgeGraph = require('./knowledge');
const GraphRetriever = require('./knowledge/retriever');
const AttentionEngine = require('./attention');
const { ContextRanker } = require('./context/ranker');
const ConflictResolver = require('./conflict');
const GoalEngine = require('./goals');
const PromptComposer = require('./prompt');
const SelfAccess = require('./self');
const ToolExecutor = require('./tools');
const MemoryTelemetry = require('./observability');
const { SearchManager } = require('./web');
const CodeExecutor = require('./executor');
const { AgenticLoop } = require('./agentic');
const MediaManager = require('./multimodal/MediaManager');
const STTProvider = require('./multimodal/STTProvider');

const DEFAULT_SLEEP_THRESHOLD = 10;

class PaprikaCore {
  /**
   * @param {Object} database - Capa de base de datos (db.js)
   */
  constructor(database) {
    this.db = database;

    // CoreConfig: fuente única de verdad para configuración
    this.config = new CoreConfig();

    // ─── Telemetry (observability) ───
    this.telemetry = new MemoryTelemetry({ debug: process.env.PAPRIKA_DEBUG === '1' });

    // ─── Módulos基础 (no dependencies between these) ───
    this.analyzer = new MessageAnalyzer(this.config);
    this.personality = new PersonalityEngine(this.config);

    // ─── Módulos con persistencia ───
    this.emotions = new EmotionEngine(database, this.config);

    // ─── Embedding service (lazy init, se descarga el modelo al primer uso) ───
    this.embedding = new MemoryEmbeddingService();

    // ─── RelationshipEngine ───
    this.relationship = new RelationshipEngine(database, this.config);

    // ─── GoalEngine ───
    this.goals = new GoalEngine(database, this.config);

    // ─── KnowledgeGraph (inicializado antes de MemoryManager para auto-extracción) ───
    this.knowledge = new KnowledgeGraph(database, this.config, this.embedding);
    this.graphRetriever = new GraphRetriever(this.knowledge, database, {}, this.embedding);

    this.memory = new MemoryManager(database, this.config, this.embedding, this.knowledge);
    this.memorySearch = new MemorySearch(database, this.config, this.embedding, this.goals, this.relationship);
    this.memoryConsolidation = new MemoryConsolidation(database, this.config, this.embedding);

    // ─── Importance Calculator + Sleep Cycle ───
    this.memoryImportance = new MemoryImportance();
    this.memorySleepCycle = new MemorySleepCycle(database, this.memoryConsolidation, this.memoryImportance, this.embedding, {}, this.telemetry);

    // ─── Memory Architecture: Working Memory + Archive Memory ───
    this.workingMemory = new WorkingMemoryManager(database);
    this.archiveMemory = new ArchiveMemoryManager(database);

    // ─── MemoryClassifier necesita MemoryManager ───
    this.classifier = new MemoryClassifier(this.config, this.memory);

    // ─── Módulos derivados ───
    this.context = new ContextBuilder(
      this.config,
      this.personality,
      this.emotions,
      this.relationship,
      this.memory
    );
    this.response = new ResponseProcessor(this.config, this.personality);
    this.summarizer = new Summarizer(database, this.config);
    this.reflection = new ReflectionEngine(database, {});
    this.actionExecutor = new ActionExecutor({
      db: database,
      emotions: this.emotions,
      knowledge: this.knowledge,
      memory: this.memory,
    });

    // ─── Integration modules ───
    this.attention = new AttentionEngine();
    this.contextRanker = new ContextRanker({}, this.embedding);
    this.conflictResolver = new ConflictResolver(database);
    this.promptComposer = new PromptComposer(this.personality, this.config);

    // ─── SelfAccess — acceso al estado interno de Paprika ───
    this.selfAccess = new SelfAccess({
      personality: this.personality,
      emotions: this.emotions,
      relationship: this.relationship,
      goals: this.goals,
      memory: this.memory,
      memorySearch: this.memorySearch,
      knowledge: this.knowledge,
    });

    // ─── SearchManager — búsqueda web externa (SearXNG) ───
    this.searchManager = new SearchManager();
    this.searchManager.init().catch(err => {
      console.warn(`   ⚠ SearchManager: no disponible (${err.message || 'init failed'})`);
    });

    // ─── CodeExecutor — ejecución segura de código JavaScript ───
    this.codeExecutor = new CodeExecutor({ timeout: 5000 });

    // ─── ToolExecutor — herramientas de sistema para Paprika ───
    this.tools = new ToolExecutor({
      baseDir: path.join(__dirname, '..'),
      searchManager: this.searchManager,
      codeExecutor: this.codeExecutor,
    });

    // ─── Multimodal — upload, images, audio ───
    this.media = new MediaManager(database, {
      uploadDir: path.join(__dirname, '../uploads'),
    });
    this.media.init().catch(err => {
      console.warn(`   ⚠ MediaManager init failed: ${err.message}`);
    });

    // ─── STT (speech-to-text) si API key configurada ───
    this.stt = null;
    if (process.env.GROQ_API_KEY) {
      this.stt = new STTProvider({
        provider: 'groq',
        apiKey: process.env.GROQ_API_KEY,
      });
    } else if (process.env.OPENAI_API_KEY) {
      this.stt = new STTProvider({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
      });
    }

    // ─── AgenticLoop — factory para ciclo PRAL por request ───
    this._agenticLoopConfig = {
      toolExecutor: this.tools,
      config: {
        maxIterations: 10,
        maxToolsPerRound: 5,
        absoluteTimeout: 60000,
        enablePlanning: true,
        enableReflection: true,
      },
    };

    // ─── Capabilities: model knowledge + auto-selection ───
    const { setupCapabilities, ModelSelector } = require('./capabilities');
    const { getModelRegistry } = require('../providers/modelRegistry');
    const { getHealthManager } = require('../providers/healthManager');
    this._modelRegistry = getModelRegistry();
    this._healthManager = getHealthManager();

    // CapabilityManager now reads directly from ModelRegistry
    this._capabilityManager = setupCapabilities();
    this._modelSelector = new ModelSelector(this._capabilityManager, {
      preferredChat: process.env.PREFERRED_CHAT_MODEL ? { provider: process.env.PREFERRED_CHAT_PROVIDER || 'ollama', model: process.env.PREFERRED_CHAT_MODEL } : null,
      preferredVision: process.env.PREFERRED_VISION_MODEL ? { provider: process.env.PREFERRED_VISION_PROVIDER || 'gemini', model: process.env.PREFERRED_VISION_MODEL } : null,
      preferredAudio: process.env.PREFERRED_AUDIO_MODEL ? { provider: process.env.PREFERRED_AUDIO_PROVIDER || 'groq', model: process.env.PREFERRED_AUDIO_MODEL } : null,
    });

    // ─── Execution planner + Provider manager (priority-based fallback) ───
    const { ExecutionPlanner } = require('../providers/executionPlanner');
    const { ProviderManager } = require('../providers/providerManager');
    const { createProviderInstances } = require('../providers');
    this._executionPlanner = new ExecutionPlanner({
      capabilityManager: this._capabilityManager,
      modelRegistry: this._modelRegistry,
      healthManager: this._healthManager,
      defaultTimeout: parseInt(process.env.PAPRIKA_PROVIDER_TIMEOUT_MS, 10) || 60000,
    });
    this._providerManager = new ProviderManager({
      providers: createProviderInstances(),
      defaultTimeout: parseInt(process.env.PAPRIKA_PROVIDER_TIMEOUT_MS, 10) || 60000,
      healthManager: this._healthManager,
      modelRegistry: this._modelRegistry,
    });

    // ─── Pipeline (sin módulos de maintenance — esos son del SleepCycle) ───
    this.pipeline = new Pipeline({
      analyzer: this.analyzer,
      db: database,
      classifier: this.classifier,
      emotions: this.emotions,
      memory: this.memory,
      memorySearch: this.memorySearch,
      workingMemory: this.workingMemory,
      archiveMemory: this.archiveMemory,
      personality: this.personality,
      relationship: this.relationship,
      context: this.context,
      response: this.response,
      summarizer: this.summarizer,
      reflection: this.reflection,
      actionExecutor: this.actionExecutor,
      knowledge: this.knowledge,
      graphRetriever: this.graphRetriever,
      goals: this.goals,
      attention: this.attention,
      contextRanker: this.contextRanker,
      conflictResolver: this.conflictResolver,
      promptComposer: this.promptComposer,
      selfAccess: this.selfAccess,
      tools: this.tools,
      telemetry: this.telemetry,
      createAgenticLoop: () => new AgenticLoop(this._agenticLoopConfig),
      mediaManager: this.media,
      sttProvider: this.stt,
      capabilityManager: this._capabilityManager,
      modelSelector: this._modelSelector,
      executionPlanner: this._executionPlanner,
      providerManager: this._providerManager,
    });

    // ─── Sleep Cycle: conversation counter + async trigger ───
    this._conversationCounters = new Map();
    this._sleepThreshold = DEFAULT_SLEEP_THRESHOLD;
    this._sleepScheduler = null;

    console.log('🧠 PaprikaCore — Integration Phase');
    console.log('   ✓ Analyzer: activo (confidence + reasoning)');
    console.log('   ✓ PersonalityEngine: activo (personality.json)');
    console.log('   ✓ MemoryClassifier: activo (9 categorías, new/update/discard)');
    console.log('   ✓ MemoryManager: activo (unified store/update + embeddings)');
    console.log('   ✓ MemorySearch: activo (HybridRetriever: semántica + goals + relación)');
    console.log('   ✓ SleepCycle: activo (consolidation, decay, re-embed, clustering — off-peak)');
    console.log('   ✓ WorkingMemory: activo (ventana por tokens, 3 niveles)');
    console.log('   ✓ ArchiveMemory: activo (resúmenes de conversaciones antiguas)');
    console.log('   ✓ MemoryEmbeddingService: activo (FastEmbed, lazy init)');
    console.log('   ✓ EmotionEngine: activo (9 dimensiones, decay, persistencia)');
    console.log('   ✓ RelationshipEngine: activo (gradual, cache, DB)');
    console.log('   ✓ ReflectionEngine: activo (10 checks, acciones post-respuesta)');
    console.log('   ✓ ActionExecutor: activo (10 action types, rollback, logging)');
    console.log('   ✓ KnowledgeGraph: activo (entidades + relaciones + extractor)');
    console.log('   ✓ GraphRetriever: activo (subgrafos, traversión BFS, prompt format)');
    console.log('   ✓ Summarizer: activo (extractive, auto)');
    console.log('   ✓ GoalEngine: activo (discovery, tracking, milestones)');
    console.log('   ✓ AttentionEngine: activo (attention window, urgency)');
    console.log('   ✓ ContextRanker: activo (10-factor scoring + semantic similarity)');
    console.log('   ✓ ConflictResolver: activo (4 conflict types, auto-resolve)');
    console.log('   ✓ PromptComposer: activo (12 sections, token budget)');
    console.log('   ✓ SelfAccess: activo (estado interno accesible)');
    console.log('   ✓ ToolExecutor: activo (13 herramientas de sistema + web + código)');
    console.log('   ✓ SearchManager: activo (búsqueda web via SearXNG)');
    console.log('   ✓ CodeExecutor: activo (sandbox aislado, 5s timeout)');
    console.log('   ✓ AgenticLoop: activo (PRAL cycle, planning + reflection)');
    console.log('   ✓ MemoryTelemetry: activo (trazas, métricas, logs estructurados)');
    console.log('   ✓ MediaManager: activo (upload, images, audio)');
    console.log('   ✓ STTProvider: activo (' + (this.stt ? this.stt.provider : 'no API key') + ')');
    console.log(`   ⏱ Sleep threshold: cada ${this._sleepThreshold} conversaciones`);

    // Backfill de embeddings para memorias existentes sin embedding
    this._backfillEmbeddings();

    // Auto-discover all provider models (Ollama, Groq, Gemini, OpenRouter)
    this._syncAllModels();
  }

  /**
   * Sync all provider models into the ModelRegistry.
   * Non-blocking; logs results at startup.
   */
  async _syncAllModels() {
    try {
      const results = await this._modelRegistry.syncAll();
      for (const [provider, result] of Object.entries(results)) {
        if (result.error) {
          console.log(`   ⚠ ${provider} sync: ${result.error}`);
        } else if (result.added?.length > 0) {
          console.log(`   ✓ ${provider} sync: +${result.added.length} modelos: ${result.added.join(', ')}`);
        } else if (result.available === false) {
          console.log(`   ○ ${provider}: no disponible (sin API key o sin conexión)`);
        } else {
          console.log(`   ✓ ${provider}: sincronizado`);
        }
      }
    } catch (err) {
      console.log(`   ⚠ Model sync falló (no crítico): ${err.message}`);
    }
  }

  /**
   * Genera embeddings para memorias antiguas que no los tienen.
   * Se ejecuta de forma asíncrona al iniciar, sin bloquear el servidor.
   */
  async _backfillEmbeddings() {
    try {
      const defaultUserId = 'default';
      const result = await this.memory.backfillEmbeddings(defaultUserId);
      if (result.processed > 0 || result.queueProcessed > 0) {
        console.log(`[Embedding] Backfill: ${result.processed} nuevos, ${result.queueProcessed} de cola`);
      }
      const metrics = this.embedding.getMetrics();
      if (metrics.queueSize > 0) {
        console.warn(`[Embedding] ${metrics.queueSize} embeddings en cola para reintento`);
      }
    } catch (err) {
      console.warn('[Embedding] Backfill falló (no crítico):', err.message);
    }
  }

  // ─────────────────────────────────────────────
  //  Public API: processMessage
  // ─────────────────────────────────────────────

  /**
   * Procesa un mensaje del usuario a través del pipeline completo.
   * Después del pipeline, dispara el Sleep Cycle de forma asíncrona si es necesario.
   *
   * @param {Object} params
   * @param {string} params.message - Mensaje del usuario
   * @param {number} params.conversationId - ID de la conversación
   * @param {string} params.userId - ID del usuario
   * @param {Function} params.getHistory - Función para obtener historial
   * @param {Function} params.chatFn - Función de chat del proveedor
   * @param {Function} params.onChunk - Callback para streaming
   * @returns {Promise<Object>} { response, metadata }
   */
  async processMessage({ message, conversationId, userId, getHistory, chatFn, onChunk, onProcess, attachments }) {
    const result = await this.pipeline.execute({
      message,
      conversationId,
      userId,
      getHistory,
      chatFn,
      onChunk,
      onProcess,
      attachments
    });

    // Fire-and-forget: check if sleep cycle should run
    this._tickSleep(userId);

    return result;
  }

  // ─────────────────────────────────────────────
  //  Sleep Cycle: trigger logic
  // ─────────────────────────────────────────────

  /**
   * Increments the conversation counter for a user and triggers
   * the sleep cycle when the threshold is reached.
   *
   * The sleep cycle runs asynchronously — the user never waits.
   *
   * @param {string} userId
   * @private
   */
  _tickSleep(userId) {
    const count = (this._conversationCounters.get(userId) || 0) + 1;
    this._conversationCounters.set(userId, count);

    if (count >= this._sleepThreshold) {
      this._conversationCounters.set(userId, 0);
      this.triggerSleep(userId);
    }
  }

  /**
   * Manually trigger a sleep cycle for a user.
   * Runs asynchronously with concurrency guard.
   *
   * @param {string} userId
   * @param {Object} [context] — { emotionalState, activeGoals, relationship }
   */
  triggerSleep(userId, context = {}) {
    this.telemetry.counter('sleepCycles');
    this.memorySleepCycle.triggerAsync(userId, context);
  }

  /**
   * Start a periodic scheduler that checks all known users
   * and triggers sleep cycles as needed.
   *
   * @param {number} [intervalMs=300000] — check interval (default: 5 min)
   */
  startSleepScheduler(intervalMs = 300_000) {
    if (this._sleepScheduler) {
      clearInterval(this._sleepScheduler);
    }

    this._sleepScheduler = setInterval(() => {
      for (const [userId, count] of this._conversationCounters) {
        if (count >= this._sleepThreshold && !this.memorySleepCycle.isRunning(userId)) {
          this._conversationCounters.set(userId, 0);
          this.triggerSleep(userId);
        }
      }
    }, intervalMs);

    console.log(`[SleepCycle] Scheduler activo: cada ${intervalMs / 1000}s`);
  }

  /**
   * Stop the periodic scheduler.
   */
  stopSleepScheduler() {
    if (this._sleepScheduler) {
      clearInterval(this._sleepScheduler);
      this._sleepScheduler = null;
    }
  }

  /**
   * Configure the conversation threshold for sleep cycle triggering.
   *
   * @param {number} threshold — conversations between sleep cycles
   */
  setSleepThreshold(threshold) {
    this._sleepThreshold = Math.max(1, threshold);
    console.log(`[SleepCycle] Threshold actualizado: cada ${this._sleepThreshold} conversaciones`);
  }

  // ─────────────────────────────────────────────
  //  Status & Config
  // ─────────────────────────────────────────────

  /**
   * Retorna el estado actual de todos los módulos.
   * Útil para debugging y monitoreo.
   */
  getStatus() {
    return {
      phase: 'Integration',
      config: this.config.getSummary(),
      modules: {
        analyzer: 'active (confidence + reasoning)',
        classifier: 'active (9 categories, new/update/discard)',
        personality: 'active (personality.json)',
        memory: 'active (unified store/update + embeddings)',
        memorySearch: 'active (HybridRetriever: semantic + goalAlignment + relationship)',
        sleepCycle: `active (threshold=${this._sleepThreshold}, running=${this.memorySleepCycle.isRunning('default')})`,
        embedding: `active (${this.embedding.isAvailable() ? 'modelo cargado' : 'pendiente init'}, queue=${this.embedding._pendingQueue.length}, metrics=${JSON.stringify(this.embedding.getMetrics())})`,
        emotions: 'active (9 dimensions, decay, persistence)',
        relationship: 'active (gradual, cache, DB)',
        reflection: 'active (10 checks, post-response actions)',
        actionExecutor: 'active (10 action types, rollback, logging)',
        knowledge: 'active (entities + relations)',
        summarizer: 'active (extractive, auto)',
        goals: 'active (discovery, tracking, milestones)',
        attention: 'active (attention window, urgency)',
        contextRanker: 'active (10-factor scoring + semantic similarity)',
        conflictResolver: 'active (4 conflict types, auto-resolve)',
        promptComposer: 'active (12 sections, token budget)',
      },
      sleep: {
        threshold: this._sleepThreshold,
        counters: Object.fromEntries(this._conversationCounters),
        schedulerActive: this._sleepScheduler !== null,
      },
      emotionalState: this.emotions.getState(),
      telemetry: this.telemetry.getSnapshot(),
    };
  }

  /**
   * Recarga la configuración desde disco.
   */
  reloadConfig() {
    this.config.reload();
    this.personality.reload();
  }

  /**
   * Returns the telemetry instance for API exposure.
   * @returns {MemoryTelemetry}
   */
  getTelemetry() {
    return this.telemetry;
  }
}

/**
 * Factory function para inicializar Core con la capa de DB.
 * @param {Object} database - db.js module
 * @returns {PaprikaCore}
 */
function createCore(database) {
  return new PaprikaCore(database);
}

module.exports = createCore;
