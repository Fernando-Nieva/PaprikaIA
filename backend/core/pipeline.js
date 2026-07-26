/**
 * Pipeline — Flujo central de conversación de Paprika (Integration Phase).
 *
 * Toda solicitud de chat pasa por este pipeline.
 * Cada paso es un módulo independiente, desacoplado, testeable.
 *
 * Flujo (único permitido):
 *
 *   Usuario
 *     ↓
 *   Analyzer              — interpreta el mensaje
 *     ↓
 *   MemoryClassifier      — clasifica recuerdos potenciales
 *     ↓
 *   GoalEngine            — extrae/actualiza objetivos
 *     ↓
 *   RelationshipEngine    — obtiene y prepara relación
 *     ↓
 *   EmotionEngine         — procesa estado emocional (pre-response)
 *     ↓
 *   MemorySearch          — recupera recuerdos relevantes
 *     ↓
 *   KnowledgeGraph        — obtiene entidades conocidas
 *     ↓
 *   ConflictResolver      — detecta y resuelve conflictos
 *     ↓
 *   ContextRanker         — rankea TODO el contexto disponible
 *     ↓
 *   AttentionEngine       — determina ventana de atención
 *     ↓
 *   PromptComposer        — ensambla system prompt optimizado
 *     ↓
 *   Proveedor IA          — genera respuesta
 *     ↓
 *   ResponseProcessor     — post-procesa respuesta
 *     ↓
 *   ReflectionEngine      — análisis interno post-respuesta
 *     ↓
 *   MemoryManager         — almacena/actualiza recuerdos
 *     ↓
 *   RelationshipEngine    — actualiza relación post-interacción
 *     ↓
 *   EmotionEngine         — actualiza emociones post-interacción
 *     ↓
 *   KnowledgeGraph        — extrae entidades y sugiere relaciones
 *     ↓
 *   Summarizer            — verifica si necesita resumen
 *     ↓
 *   GoalEngine            — registra progreso post-interacción
 *     ↓
 *   Responder al usuario
 *
 * Nota: Consolidation, decay, re-embedding y clustering NO corren aquí.
 *       Son responsabilidad exclusiva del Sleep Cycle (off-peak, async).
 *
 * Principios:
 * - El Analyzer es la fuente única de verdad para interpretar mensajes.
 * - El MemoryClassifier decide qué se almacena/actualiza/descarta.
 * - El AttentionEngine decide dónde enfocar la atención.
 * - El PromptComposer ensambla TODO en un system prompt optimizado.
 * - Ningún otro módulo analiza el mensaje por su cuenta.
 * - No hay dependencias circulares.
 */

'use strict';

const PipelineCache = require('./cache');
const MemoryTelemetry = require('./observability');
const { AgenticLoop } = require('./agentic');

/**
 * Default fallback values for each pipeline step.
 * When a step fails, the pipeline continues with these safe defaults.
 */
const STEP_DEFAULTS = {
  analysis: () => ({
    intent: 'unknown',
    topic: 'general',
    importance: 0.3,
    confidence: 0.3,
    intensity: 0.3,
    entities: { people: [], projects: [], places: [] },
    rawMessage: '',
    shouldRemember: false,
    messageCount: 0,
    emotionalState: { valence: 0, arousal: 0.3, dominant: 'neutral', confidence: 0.3 }
  }),
  classifiedMemories: () => ({ memories: [], discarded: [], reasoning: 'step failed' }),
  goalResults: () => [],
  relationship: () => ({
    trustLevel: 0.3, familiarity: 0.1, humorAllowed: 0.5,
    emotionalOpenness: 0.3, formalityLevel: 0.3, preferredStyle: 'informal',
    sensitiveTopics: [], favoriteTopics: [], insideJokes: [],
    conversationCount: 0, interactionFrequency: 0.5
  }),
  emotionalState: () => ({
    energy: 0.7, happiness: 0.8, empathy: 0.9, nostalgia: 0.3,
    curiosity: 0.8, trust: 0.5, enthusiasm: 0.7, serenity: 0.6, fatigue: 0.2
  }),
  searchResult: () => ({ memories: [], queryEmbedding: null }),
  rankedContext: () => ({ rankedMemories: [], scoredItems: [] }),
  attention: () => ({ primary: { type: 'general' }, urgency: 'normal', topicShift: false, emotionalEmergency: false }),
  systemPrompt: () => 'Sos Paprika, un asistente IA personal.',
  reflection: () => ({ reasoning: 'step failed', actions: [] }),
  memoryStats: () => ({ stored: 0, updated: 0, discarded: 0 }),
  entityStats: () => ({ added: 0, relationsSuggested: 0 }),
};

class Pipeline {
  /**
   * @param {Object} modules - Módulos inyectados del Core
   */
  constructor(modules) {
    this.analyzer = modules.analyzer;
    this.db = modules.db;
    this.classifier = modules.classifier;
    this.emotions = modules.emotions;
    this.memory = modules.memory;
    this.memorySearch = modules.memorySearch;
    this.workingMemory = modules.workingMemory;
    this.archiveMemory = modules.archiveMemory;
    this.personality = modules.personality;
    this.relationship = modules.relationship;
    this.context = modules.context;
    this.response = modules.response;
    this.summarizer = modules.summarizer;
    this.reflection = modules.reflection;
    this.actionExecutor = modules.actionExecutor;
    this.knowledge = modules.knowledge;
    this.graphRetriever = modules.graphRetriever;
    this.goals = modules.goals;
    this.attention = modules.attention;
    this.contextRanker = modules.contextRanker;
    this.conflictResolver = modules.conflictResolver;
    this.promptComposer = modules.promptComposer;
    this.selfAccess = modules.selfAccess;
    this.tools = modules.tools;
    this.telemetry = modules.telemetry || null;
    this.createAgenticLoop = modules.createAgenticLoop || null;
    this._mediaManager = modules.mediaManager || null;
    this._sttProvider = modules.sttProvider || null;
  }

  // ─── Error boundary helpers ──────────────────────────────

  /**
   * Processes multimodal attachments into content parts for the AI provider.
   *
   * @param {Array} attachments - Array of attachment objects { id, base64, mimeType }
   * @param {string} userId
   * @returns {Promise<Object>} { parts, imageIds, audioIds }
   */
  async _processAttachments(attachments, userId) {
    const parts = [];
    const imageIds = [];
    const audioIds = [];

    for (const att of attachments) {
      if (att.id && this._mediaManager) {
        const base64 = await this._mediaManager.readFileAsBase64(att.id);
        if (base64) {
          // Verify ownership
          const media = this._mediaManager.getMedia(att.id);
          if (media && media.user_id !== userId) {
            continue; // Skip files not owned by this user
          }
          if (base64.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${base64.mimeType};base64,${base64.data}` },
            });
            imageIds.push(att.id);
          } else if (base64.type === 'audio') {
            audioIds.push(att.id);
            if (this._sttProvider) {
              const transcript = await this._sttProvider.transcribe(base64.data, base64.mimeType);
              if (transcript) {
                parts.push({ type: 'text', text: `[Audio transcrito]: ${transcript}` });
              }
            }
          }
        }
      } else if (att.base64) {
        if (att.mimeType?.startsWith('image/')) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${att.mimeType};base64,${att.base64}` },
          });
        } else if (att.mimeType?.startsWith('audio/')) {
          if (this._sttProvider) {
            const transcript = await this._sttProvider.transcribe(att.base64, att.mimeType);
            if (transcript) {
              parts.push({ type: 'text', text: `[Audio transcrito]: ${transcript}` });
            }
          }
        }
      }
    }

    if (parts.length > 0 && !parts.some(p => p.type === 'text' && p.text)) {
      parts.unshift({ type: 'text', text: '[El usuario envió archivos adjuntos]' });
    }

    return { parts, imageIds, audioIds };
  }

  /**
   * Executes a pipeline step safely with try/catch.
   * On failure: logs the error, records to telemetry, returns the fallback default.
   *
   * @param {string} stepName - Name for logging (e.g. 'Paso 1/22 Analyzer')
   * @param {Function} fn - The step function to execute
   * @param {*} fallback - Default value if the step fails
   * @param {Object} [telemetryMeta] - Extra metadata for telemetry
   * @returns {*} Step result or fallback
   */
  _safeStep(stepName, fn, fallback, telemetryMeta = {}) {
    try {
      return fn();
    } catch (err) {
      this._logStepError(stepName, err, telemetryMeta);
      return fallback;
    }
  }

  /**
   * Executes an async pipeline step safely with try/catch.
   *
   * @param {string} stepName - Name for logging
   * @param {Function} fn - Async step function to execute
   * @param {*} fallback - Default value if the step fails
   * @param {Object} [telemetryMeta] - Extra metadata for telemetry
   * @returns {Promise<*>} Step result or fallback
   */
  async _safeStepAsync(stepName, fn, fallback, telemetryMeta = {}) {
    try {
      return await fn();
    } catch (err) {
      this._logStepError(stepName, err, telemetryMeta);
      return fallback;
    }
  }

  /**
   * Logs a step error with structured format and telemetry.
   * @private
   */
  _logStepError(stepName, err, meta = {}) {
    const errorDetail = {
      step: stepName,
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      ...meta,
    };
    console.error(`[Pipeline] ${stepName} FAILED:`, err.message);
    if (this.telemetry) {
      this.telemetry.counter(`pipeline.${stepName.replace(/\s/g, '_')}.errors`);
      this.telemetry.log('error', 'Pipeline', `${stepName} failed`, errorDetail);
    }
  }

  /**
   * Ejecuta el pipeline completo para un mensaje del usuario.
   *
   * @param {Object} params
   * @param {string} params.message - Mensaje del usuario
   * @param {number} params.conversationId - ID de la conversación
   * @param {string} params.userId - ID del usuario
   * @param {Function} params.getHistory - Función para obtener historial de mensajes
   * @param {Function} params.chatFn - Función de chat del proveedor (ollama.js)
   * @param {Function} params.onChunk - Callback para streaming SSE
   * @returns {Promise<Object>} { response, metadata }
   */
  async execute({ message, conversationId, userId, getHistory, chatFn, onChunk, onProcess, attachments }) {
    const history = getHistory();

    // ─── Telemetry: request-scoped trace ───
    const trace = this.telemetry ? this.telemetry.child(`req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) : null;
    if (trace) {
      this.telemetry.counter('pipelineExecutions');
      trace.start('pipeline');
    }

    // ─── Pipeline Cache: evita consultas repetidas a DB durante este ciclo ───
    const cache = new PipelineCache();

    // Invalidate Working Memory cache to ensure fresh data per request
    if (this.workingMemory && this.workingMemory.invalidateCache) {
      this.workingMemory.invalidateCache();
    }

    // Set cache on KnowledgeGraph and GraphRetriever for internal caching
    if (this.knowledge && this.knowledge.setCache) {
      this.knowledge.setCache(cache);
    }
    if (this.graphRetriever && this.graphRetriever.setCache) {
      this.graphRetriever.setCache(cache);
    }

    // ─── Working Memory: construir ventana limitada por tokens (scoring inteligente) ───
    let workingMessages = [];
    let toArchive = [];
    try {
      ({ messages: workingMessages, toArchive } = this.workingMemory.buildWindow(conversationId, {
        currentMessage: message,
        emotionalState: this.emotions.getState(),
      }));
    } catch (err) {
      console.error('[Pipeline] WorkingMemory.buildWindow failed:', err.message);
    }

    // ─── Archive Memory: contexto archivado para system prompt ───
    let archiveContext = '';
    try {
      archiveContext = this.archiveMemory.buildArchiveContext(conversationId, 500);
    } catch (err) {
      console.error('[Pipeline] ArchiveMemory.buildArchiveContext failed:', err.message);
    }

    const sendProcess = (step, detail) => {
      if (onProcess) onProcess({ step, detail, ts: Date.now() });
    };

    // ─── PASO 0: Multimodal pre-processing ───
    let multimodalContent = null;
    if (attachments && attachments.length > 0) {
      sendProcess('Paso 0/22', 'Procesando archivos adjuntos...');
      multimodalContent = await this._processAttachments(attachments, userId);
      sendProcess('Paso 0/22', `${multimodalContent.imageIds.length} imagen(es) | ${multimodalContent.audioIds.length} audio(s)`);

      // Replace the last user message content with multimodal parts
      if (multimodalContent.parts.length > 0) {
        const lastMsg = workingMessages[workingMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          lastMsg.content = multimodalContent.parts;
        }
      }
    }

    // ─── PASO 1: Analyzer — interpreta el mensaje ───
    sendProcess('Paso 1/22', 'Analizando mensaje...');
    const fullMessages = history.map(m => ({ role: m.role, content: m.content }));
    const analysis = this._safeStep('Paso 1 Analyzer', () =>
      this.analyzer.analyze(message, fullMessages),
      STEP_DEFAULTS.analysis(),
      { messageLength: message.length }
    );
    sendProcess('Paso 1/22', `Intención: ${analysis.intent} | Tema: ${analysis.topic} | Confianza: ${(analysis.confidence * 100).toFixed(0)}%`);

    // ─── PASO 2: MemoryClassifier — clasifica recuerdos potenciales ───
    sendProcess('Paso 2/22', 'Clasificando recuerdos...');
    const classifiedMemories = this._safeStep('Paso 2 Classifier', () =>
      this.classifier.classify(analysis, userId),
      STEP_DEFAULTS.classifiedMemories(),
      { intent: analysis.intent }
    );
    sendProcess('Paso 2/22', `${classifiedMemories.memories.length} recuerdo(s) clasificado(s) | ${classifiedMemories.discarded.length} descartado(s)`);

    // ─── PASO 3: GoalEngine — extrae/actualiza objetivos ───
    sendProcess('Paso 3/22', 'Buscando objetivos...');
    let goalResults = [];
    try {
      goalResults = this.goals.extractGoals(analysis, userId);
    } catch (err) {
      console.error('[Pipeline] GoalEngine extraction failed:', err.message);
    }
    sendProcess('Paso 3/22', `${goalResults.length} objetivo(s) detectado(s)`);

    // ─── PASO 4: RelationshipEngine — obtiene relación actual ───
    sendProcess('Paso 4/22', 'Obteniendo relación...');
    const relationship = this._safeStep('Paso 4 Relationship', () =>
      this.relationship.get(userId),
      STEP_DEFAULTS.relationship(),
      { userId }
    );
    sendProcess('Paso 4/22', `Confianza: ${((relationship.trust || relationship.trustLevel || 0) * 100).toFixed(0)}% | Familiaridad: ${((relationship.familiarity || 0) * 100).toFixed(0)}%`);

    // ─── PASO 5: EmotionEngine — procesa estado emocional (pre-response) ───
    sendProcess('Paso 5/22', 'Procesando emociones...');
    analysis.messageCount = history.length;
    this._safeStep('Paso 5 Emotions', () => this.emotions.process(analysis), null);
    const emotionalState = this._safeStep('Paso 5 Emotions getState', () =>
      this.emotions.getState(),
      STEP_DEFAULTS.emotionalState()
    );
    const KNOWN_EMOTIONS = ['energy','happiness','empathy','nostalgia','curiosity','trust','enthusiasm','serenity','fatigue'];
    const dominantEmotion = Object.entries(emotionalState)
      .filter(([k]) => KNOWN_EMOTIONS.includes(k))
      .sort((a, b) => b[1] - a[1])[0];
    sendProcess('Paso 5/22', `Emoción dominante: ${dominantEmotion ? dominantEmotion[0] : 'neutral'} (${dominantEmotion ? (dominantEmotion[1] * 100).toFixed(0) + '%' : '-'})`);

    // ─── PASO 6: MemorySearch — recupera candidatos relevantes (5 pools) ───
    sendProcess('Paso 6/22', 'Buscando recuerdos relevantes...');
    if (trace) trace.start('search');
    const searchResult = await this._safeStepAsync('Paso 6 MemorySearch', () =>
      this.memorySearch.search(message, userId, { limit: 30, contextTopic: analysis.topic }),
      STEP_DEFAULTS.searchResult(),
      { userId, topic: analysis.topic }
    );

    // MemorySearch now returns { memories, queryEmbedding }
    const memories = searchResult.memories || searchResult;
    let queryEmbedding = searchResult.queryEmbedding || null;

    // Fallback: generate query embedding if MemorySearch didn't return it
    if (!queryEmbedding && this.memorySearch.embedding && this.memorySearch.embedding.isAvailable()) {
      try {
        queryEmbedding = await this.memorySearch.embedding.generate(message);
      } catch (err) {
        console.error('[Pipeline] Fallback embedding generation failed:', err.message);
      }
    }
    sendProcess('Paso 6/22', `${memories.length} candidato(s) recuperado(s) | embedding: ${queryEmbedding ? 'sí' : 'no'}`);
    if (trace) {
      trace.end('search', { candidates: memories.length, embedding: !!queryEmbedding });
      this.telemetry.counter('memorySearches');
    }

    // ─── PASO 7: KnowledgeGraph + GraphRetriever — grafo de conocimiento ───
    sendProcess('Paso 7/22', 'Consultando grafo de conocimiento...');
    let knownEntities = [];
    let graphContext = { entities: [], relations: [], connections: [] };
    try {
      knownEntities = cache.getOrSet(
        `entities:${userId}`,
        () => this.knowledge.getEntitiesByUser(userId, { limit: 20 })
      );
      // Recuperar subgrafo relevante para el query actual
      graphContext = this.graphRetriever.retrieve(message, userId, { limit: 15, depth: 2 });
    } catch (err) {
      console.error('[Pipeline] Knowledge graph retrieval failed:', err.message);
    }
    sendProcess('Paso 7/22', `${knownEntities.length} entidad(es) | ${graphContext.connections.length} conexión(es)`);

    // ─── PASO 8: ConflictResolver — detecta y resuelve conflictos ───
    sendProcess('Paso 8/22', 'Detectando conflictos...');
    let conflictResult = { conflicts: [], actions: [], summary: 'No conflicts detected' };
    try {
      conflictResult = this.conflictResolver.resolve({
        analysis,
        memories,
        classifiedMemories,
        relationship
      });
      for (const action of conflictResult.actions) {
        if (action.type === 'update_memory' && action.data) {
          const { memoryId, updates } = action.data;
          if (memoryId && updates) {
            await this.memory.update(memoryId, updates);
          }
        }
      }
    } catch (err) {
      console.error('[Pipeline] ConflictResolver failed:', err.message);
    }
    sendProcess('Paso 8/22', `${conflictResult.conflicts.length} conflicto(s) detectado(s)`);

    // ─── PASO 9: GoalEngine — track progress on existing goals ───
    sendProcess('Paso 9/22', 'Actualizando progreso de objetivos...');
    let goalUpdates = [];
    try {
      goalUpdates = this.goals.trackProgress(analysis, userId);
    } catch (err) {
      console.error('[Pipeline] GoalEngine progress tracking failed:', err.message);
    }
    sendProcess('Paso 9/22', `${goalUpdates.length} objetivo(s) actualizado(s)`);

    // ─── PASO 10: ContextRanker — rankea todo el contexto ───
    sendProcess('Paso 10/22', 'Rankeando contexto...');
    if (trace) trace.start('rank');
    const summary = cache.getOrSet(
      `summary:${conversationId}`,
      () => this.summarizer.getLatestSummary(conversationId)
    );
    const goalsForContext = cache.getOrSet(
      `goals:context:${userId}`,
      () => this.goals.getGoalsForContext(userId)
    );
    const rankedContext = this._safeStep('Paso 10 ContextRanker', () =>
      this.contextRanker.rank({
        analysis, memories, relationship, emotionalState,
        knowledge: knownEntities, goals: goalsForContext, summary,
        history: workingMessages, classifiedMemories,
        query: message, queryEmbedding,
      }),
      STEP_DEFAULTS.rankedContext(),
      { memoriesCount: memories.length }
    );
    sendProcess('Paso 10/22', `${rankedContext.rankedMemories.length} memorias rankeadas`);
    if (trace) trace.end('rank', { ranked: rankedContext.rankedMemories.length, essential: rankedContext.rankedMemories.filter(m => m.type === 'personal_data' || m.type === 'relationship').length });

    // ─── PASO 11: AttentionEngine — determina ventana de atención ───
    sendProcess('Paso 11/22', 'Calculando ventana de atención...');
    const attention = this._safeStep('Paso 11 Attention', () =>
      this.attention.focus({
        analysis, memories: rankedContext.rankedMemories, relationship,
        emotionalState, goals: goalsForContext, knowledge: knownEntities,
        history: workingMessages
      }),
      STEP_DEFAULTS.attention()
    );
    sendProcess('Paso 11/22', `Foco: ${attention.primary?.type || 'general'} | Urgencia: ${attention.urgency || 'normal'}`);

    // ─── PASO 12: SelfAccess — genera estado interno de Paprika ───
    sendProcess('Paso 12/22', 'Generando autoconocimiento...');
    let selfState = null;
    try {
      selfState = this.selfAccess.getFullState(userId);
    } catch (err) {
      console.error('[Pipeline] SelfAccess failed:', err.message);
    }
    sendProcess('Paso 12/22', selfState ? 'Estado interno generado' : 'Sin estado interno');

    // ─── PASO 13: PromptComposer — ensambla system prompt ───
    sendProcess('Paso 13/22', 'Ensamblando system prompt...');
    const systemPrompt = this._safeStep('Paso 13 PromptComposer', () =>
      this.promptComposer.compose({
        attention, rankedContext, analysis, emotionalState,
        relationship, conflicts: conflictResult, summary,
        selfState, archiveContext, graphContext,
      }),
      STEP_DEFAULTS.systemPrompt(),
      { attention: attention.primary?.type }
    );
    sendProcess('Paso 13/22', `Prompt: ~${Math.ceil(systemPrompt.length / 4)} tokens`);

    // ─── PASO 14: Proveedor IA — genera respuesta (con agentic loop o tools) ───
    sendProcess('Paso 14/22', 'Generando respuesta con IA...');
    let rawResponse;
    let agenticMetadata = null;

    if (this.createAgenticLoop && this.tools) {
      // Agentic loop: planning → execution → reflection cycle (fresh instance per request)
      sendProcess('Paso 14/22', 'Iniciando agentic loop...');

      const agenticLoop = this.createAgenticLoop();

      // Wire SSE progress from agentic loop to pipeline onProcess
      agenticLoop._onProgress = (data) => {
        if (onProcess) {
          const msg = data.data?.message || data.event || 'progress';
          onProcess({ step: 'Agentic', detail: msg });
        }
      };

      const agenticResult = await this._safeStepAsync('Paso 14 AgenticLoop', () =>
        agenticLoop.execute({
          objective: message,
          context: workingMessages,
          analysis,
          systemPrompt,
          chatFn,
          onChunk,
        }),
        { response: '', metadata: {} },
        { message: message.substring(0, 100) }
      );

      rawResponse = agenticResult.response;
      agenticMetadata = agenticResult.metadata;

      // ─── Fallback: búsqueda web directa cuando el usuario pide contenido de internet ───
      const NEEDS_WEB = /\b(buscar|busca|buscame|buscá|buscáme|youtube|video|videos|noticias|actualidad|clima|temperatura|precio|cuánto cuesta|reseña|review|opinión|pelicula|serie|anime|música|canción|tutorial|resultado|partido|reddit|twitter|github|stackoverflow|documentacion|docu)\b/i;
      const webSearchUsed = agenticMetadata.toolCalls > 0 && agenticMetadata.fallbackSearch;
      if (NEEDS_WEB.test(message) && !webSearchUsed) {
        sendProcess('Paso 14/22', 'Búsqueda web directa...');
        try {
          if (onChunk) onChunk('\n🔍 Buscando en internet...\n', 'tool');
          const sm = this.tools && this.tools.searchManager;
          if (!sm) {
            console.error('[Pipeline] searchManager no disponible');
          } else {
            // ─── Limpiar el query: extraer intención real ───
            const cleanQuery = this._extractSearchQuery(message);
            console.log(`[Pipeline] Query original: "${message}" → Limpio: "${cleanQuery}"`);
            const searchResult = await sm.search(cleanQuery, { maxResults: 5 });
            if (searchResult && searchResult.results && searchResult.results.length > 0) {
              const lines = searchResult.results.map((r, i) => {
                const ytMatch = r.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                const ytId = ytMatch ? ytMatch[1] : null;
                const parts = [`[${i + 1}] ${r.title}`];
                parts.push(r.url);
                if (ytId) parts.push(`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`);
                else if (r.thumbnail) parts.push(r.thumbnail);
                if (r.snippet) parts.push(r.snippet.substring(0, 200));
                return parts.join('\n');
              });
              rawResponse = `Encontré estos resultados para "${message}":\n\n${lines.join('\n\n')}`;
              agenticMetadata = { ...agenticMetadata, toolCalls: 1, fallbackSearch: true };
            } else {
              rawResponse = `No encontré resultados para "${message}". Probá con otra búsqueda.`;
            }
          }
        } catch (err) {
          console.error('[Pipeline] Fallback web search failed:', err.message);
          rawResponse = `Error al buscar en internet: ${err.message}`;
        }
        // Streamear la respuesta final
        if (onChunk && rawResponse) {
          onChunk(rawResponse, 'text');
        }
      } else if (!NEEDS_WEB.test(message)) {
        // No es búsqueda web — streamear la respuesta del agentic loop
        if (onChunk && rawResponse) {
          onChunk(rawResponse, 'text');
        }
      }

      // Metadata (solo si no hubo fallback web search)
      if (onChunk && agenticMetadata && !agenticMetadata.fallbackSearch) {
        const toolCount = agenticMetadata.toolCalls || 0;
        const iterCount = agenticMetadata.iterations || 0;
        if (toolCount > 0) {
          onChunk(`\n🤖 Agentic: ${iterCount} iteraciones, ${toolCount} tool calls\n`, 'tool');
        }
      }

      sendProcess('Paso 14/22', `Agentic: ${agenticMetadata?.iterations || 0} iteraciones (${rawResponse.length} chars)`);
    } else if (this.tools) {
      // Legacy tool loop (fallback)
      let finalSystemPrompt = systemPrompt + '\n\n' + this.tools.getToolsPrompt();
      rawResponse = await chatFn(workingMessages, onChunk, { systemPrompt: finalSystemPrompt });

      const MAX_TOOL_ROUNDS = 3;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const toolCalls = this.tools.parseToolCalls(rawResponse);
        if (toolCalls.length === 0) break;

        sendProcess('Tools', `Ejecutando: ${toolCalls.map(t => t.name).join(', ')}`);
        if (onChunk) {
          for (const tc of toolCalls) {
            onChunk(`\n🔧 Herramienta: ${tc.name}\n`, 'tool');
          }
        }

        const { results, cleanText } = await this._safeStepAsync('Paso 14 ToolLoop', () =>
          this.tools.executeFromResponse(rawResponse),
          { results: [], cleanText: rawResponse },
          { round, tools: toolCalls.map(t => t.name) }
        );

        if (results.length === 0) break;

        const toolResultsText = results
          .map((r) => `[TOOL_RESULT:${r.tool}] ${r.success ? r.result : 'ERROR: ' + r.result}`)
          .join('\n\n');

        const toolMessages = [
          ...workingMessages,
          { role: 'assistant', content: cleanText || rawResponse },
          { role: 'system', content: `Resultados de herramientas:\n${toolResultsText}\n\nAhora respondé al usuario usando esta información. No vuelvas a llamar herramientas que ya ejecutaste.` },
        ];

        rawResponse = await chatFn(toolMessages, onChunk, { systemPrompt: finalSystemPrompt });

        if (onChunk) {
          onChunk(`\n🔄 Usando: tools (${toolCalls.map(t => t.name).join(', ')})\n`, 'tool');
        }
      }
    } else {
      rawResponse = await chatFn(workingMessages, onChunk, { systemPrompt });
    }

    sendProcess('Paso 14/22', `Respuesta generada (${(rawResponse || '').length} chars)`);

    // ─── PASO 15: ResponseProcessor — post-procesa respuesta ───
    sendProcess('Paso 15/22', 'Post-procesando respuesta...');
    const processedResponse = this._safeStep('Paso 15 ResponseProcessor', () =>
      this.response.process({ rawResponse, analysis, emotionalState }),
      rawResponse // fallback: raw response passthrough (string, not object)
    );

    // ─── PASO 16: ReflectionEngine — análisis interno post-respuesta ───
    sendProcess('Paso 16/22', 'Reflexionando...');
    if (trace) trace.start('reflection');
    const activeGoals = cache.getOrSet(
      `goals:active:${userId}`,
      () => this.goals.getActiveGoals(userId)
    );
    const reflection = this._safeStep('Paso 16 Reflection', () =>
      this.reflection.reflect({
        analysis, response: processedResponse, userId, conversationId,
        memories, classifiedMemories, emotionalState, relationship, activeGoals,
      }),
      STEP_DEFAULTS.reflection()
    );

    // Execute ALL reflection actions via ActionExecutor
    if (trace) {
      trace.end('reflection', { actions: reflection.actions.length });
      this.telemetry.counter('reflectionRuns');
    }
    if (reflection.actions && reflection.actions.length > 0) {
      const { results, undoLog } = this.actionExecutor.executeAll(reflection.actions, userId);

      // Log each action result to DB for debugging
      for (const r of results) {
        try {
          this.db.logReflectionAction(userId, r.type, r.success, r.detail || null, r.error || null, r.elapsed || 0);
        } catch {
          // Non-critical: logging failure should not block the pipeline
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      // Invalidar cache después de acciones de reflexión que modifican datos
      for (const action of reflection.actions) {
        if (action.type === 'entity_discovered' || action.type === 'entity_updated') {
          cache.invalidatePattern(`entities:${userId}`);
          cache.invalidatePattern(`relations:${userId}`);
        }
        if (action.type === 'relation_discovered' || action.type === 'relation_updated') {
          cache.invalidatePattern(`relations:${userId}`);
        }
        if (action.type === 'new_memory' || action.type === 'update_memory') {
          cache.invalidatePattern(`entities:${userId}`);
        }
      }

      sendProcess('Paso 16/22', `Reflexión: ${reflection.reasoning?.substring(0, 80) || 'ok'} | ${succeeded} OK, ${failed} fallida(s)`);
    } else {
      sendProcess('Paso 16/22', `Reflexión: ${reflection.reasoning?.substring(0, 80) || 'ok'} | 0 acciones`);
    }

    // ─── PASO 17: MemoryManager — almacena/actualiza recuerdos clasificados ───
    sendProcess('Paso 17/22', 'Almacenando recuerdos...');

    // Before storing, inject temporal types from reflection actions into classified memories.
    const temporalTypes = new Map();
    for (const action of (reflection.actions || [])) {
      if (action.type === 'temporal_classification' && action.data?.memoryContent && action.data?.temporalType) {
        temporalTypes.set(action.data.memoryContent.substring(0, 50), action.data.temporalType);
      }
    }
    if (temporalTypes.size > 0 && classifiedMemories?.memories) {
      for (const mem of classifiedMemories.memories) {
        if (mem.content && !mem.temporalType) {
          const prefix = mem.content.substring(0, 50);
          if (temporalTypes.has(prefix)) {
            mem.temporalType = temporalTypes.get(prefix);
          }
        }
      }
    }

    const memoryStats = await this._safeStepAsync('Paso 17 MemoryStore', () =>
      this.memory.store(classifiedMemories, userId),
      STEP_DEFAULTS.memoryStats(),
      { userId, memoriesCount: classifiedMemories?.memories?.length || 0 }
    );
    sendProcess('Paso 17/22', `Guardados: ${memoryStats.stored} | Actualizados: ${memoryStats.updated} | Descartados: ${memoryStats.discarded}`);

    // Invalidar cache después de modificar memorias
    if (memoryStats.stored > 0 || memoryStats.updated > 0) {
      cache.invalidatePattern(`entities:${userId}`);
      cache.invalidatePattern(`relations:${userId}`);
    }

    // ─── PASO 18: RelationshipEngine — actualiza relación post-interacción ───
    sendProcess('Paso 18/22', 'Actualizando relación...');
    this._safeStep('Paso 18 RelationshipUpdate', () =>
      this.relationship.update(userId, analysis, processedResponse),
      null,
      { userId }
    );
    cache.invalidate(`relationship:${userId}`);
    sendProcess('Paso 18/22', 'Relación actualizada');

    // ─── PASO 19: EmotionEngine — actualiza emociones post-interacción ───
    sendProcess('Paso 19/22', 'Actualizando emociones post-respuesta...');
    this._safeStep('Paso 19 EmotionUpdate', () =>
      this.emotions.update(analysis, processedResponse),
      null
    );
    sendProcess('Paso 19/22', 'Emociones actualizadas');

    // ─── PASO 20: KnowledgeGraph — extrae entidades ───
    sendProcess('Paso 20/22', 'Extrayendo entidades...');
    let entities = [];
    let entityStats = { added: 0, relationsSuggested: 0 };
    try {
      entities = this.knowledge.extractEntities(analysis);
      for (const entity of entities) {
        await this.knowledge.addEntity(userId, entity.name, entity.type, entity.metadata);
        entityStats.added++;
      }
      const suggestions = this.knowledge.suggestRelations(userId, entities);
      for (const s of suggestions) {
        this.knowledge.addRelation(userId, s.source, s.sourceType, s.target, s.targetType, s.relation, {}, s.confidence);
        entityStats.relationsSuggested++;
      }
    } catch (err) {
      console.error('[Pipeline] Knowledge extraction failed:', err.message);
    }
    // Invalidar cache después de agregar entidades/relaciones
    if (entityStats.added > 0 || entityStats.relationsSuggested > 0) {
      cache.invalidatePattern(`entities:${userId}`);
      cache.invalidatePattern(`relations:${userId}`);
    }
    sendProcess('Paso 20/22', `${entityStats.added} entidad(es) | ${entityStats.relationsSuggested} relación(es)`);

    // ─── PASO 21: Summarizer + ArchiveMemory — resumen y archivado ───
    sendProcess('Paso 21/22', 'Verificando resumen y archivado...');
    let summaryCreated = false;
    let archivedCount = 0;
    try {
      if (this.summarizer.shouldSummarize(conversationId)) {
        await this.summarizer.summarize(conversationId);
        summaryCreated = true;
      }
      // Archivar mensajes que excedieron la Working Memory
      if (toArchive && toArchive.length > 0) {
        const archiveResult = this.archiveMemory.archiveMessages(conversationId, toArchive);
        if (archiveResult) archivedCount = toArchive.length;
      }
    } catch (err) {
      console.error('[Pipeline] Summarizer/ArchiveMemory failed:', err.message);
    }
    const archDetail = archivedCount > 0 ? ` | ${archivedCount} mensajes archivados` : '';
    sendProcess('Paso 21/22', summaryCreated ? `Resumen creado${archDetail}` : `Sin resumen nuevo${archDetail}`);

    // ─── PASO 22: Retornar respuesta ───
    sendProcess('Paso 22/22', '✅ Pipeline completo');
    if (trace) {
      trace.end('pipeline');
      this.telemetry.log('info', 'Pipeline', 'Pipeline complete', trace.getTrace());
    }
    return {
      response: processedResponse,
      metadata: {
        analysis,
        emotionalState,
        attention: {
          primary: attention.primary,
          urgency: attention.urgency,
          topicShift: attention.topicShift,
          emotionalEmergency: attention.emotionalEmergency
        },
        memoriesUsed: memories.length,
        memoriesStored: memoryStats.stored,
        memoriesUpdated: memoryStats.updated,
        memoriesDiscarded: memoryStats.discarded,
        reflection: reflection.reasoning,
        reflectionActions: reflection.actions.length,
        entitiesDiscovered: entityStats.added,
        relationsSuggested: entityStats.relationsSuggested,
        goalsDetected: goalResults.length,
        goalsUpdated: goalUpdates.length,
        conflictsDetected: conflictResult.conflicts.length,
        conflictSummary: conflictResult.summary,
        summaryCreated,
        archivedMessages: archivedCount || 0,
        workingMemoryTokens: (() => { try { return this.workingMemory.getTokenCount(conversationId); } catch { return 0; } })(),
        cache: cache.getMetrics(),
        telemetry: trace ? trace.getTrace() : undefined,
        provider: null
      }
    };
  }

  _extractSearchQuery(message) {
    let q = message
      .replace(/paprika[,.]?\s*/gi, '')
      .replace(/por\s+favor[,.]?\s*/gi, '')
      .replace(/solo\s+quiero\s+(?:ver\s+)?/gi, '')
      .replace(/(?:quiero|quisiera|gustaria|me\s+gustaria)\s+(?:ver\s+)?/gi, '')
      .replace(/pasame|pasáme|mostrame|mostráme|muestra|muestreme\s+/gi, '')
      .replace(/(?:dame|dáme)\s+(?:el\s+)?(?:link|enlace|url)\s*(?:de\s+)?/gi, '')
      .replace(/(?:el\s+)?(?:link|enlace|url)\s*(?:de\s+)?/gi, '')
      .replace(/un\s+video\s+(?:de\s+)?(?:youtube\s+)?(?:que\s+sea\s+)?/gi, '')
      .replace(/una\s+(?:foto|imagen)\s+(?:de\s+)?/gi, '')
      .replace(/(?:buscar|busca|buscame|buscá|buscáme)\s+/gi, '')
      .replace(/(?:sobre|de\s+youtube|en\s+youtube|en\s+internet|en\s+la\s+web|online)\s*/gi, '')
      .replace(/(?:que\s+)?(?:tenga|tengan)\s+(?:buena|buen)\s+(?:vista|calidad|puntuación)\s*/gi, '')
      .replace(/[,.]?\s*(por\s+favor\s*)?$/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^(?:el|la|los|las|un|una|unos|unas|que|lo)\s+/gi, '')
      .replace(/\s+(?:que|lo|le)\s*$/gi, '')
      .trim();

    if (!q || q.length < 2) {
      q = message.replace(/[¿?¡!]/g, '').trim();
    }

    const wantsVideo = /\b(video|youtube|ver|tutorial|clase|música|canción|cancion|opening|anime|pelicula)\b/i.test(message);
    const wantsImage = /\b(foto|imagen|picture|wallpaper|fondo)\b/i.test(message);
    const wantsNews = /\b(noticias|actualidad|última\s+hora|noticia)\b/i.test(message);

    if (wantsVideo && !/video|youtube|tutorial|anime|pelicula/i.test(q)) q += ' video';
    if (wantsImage && !/imagen|foto|picture/i.test(q)) q += ' imagen';
    if (wantsNews && !/noticias|news/i.test(q)) q += ' noticias';
    if (/\b(cancion|canción)\b/i.test(message) && !/musica|música/i.test(q)) q += ' musica';

    return q;
  }
}

module.exports = Pipeline;
