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
  async execute({ message, conversationId, userId, getHistory, chatFn, onChunk, onProcess }) {
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
    const { messages: workingMessages, toArchive } = this.workingMemory.buildWindow(conversationId, {
      currentMessage: message,
      emotionalState: this.emotions.getState(),
    });

    // ─── Archive Memory: contexto archivado para system prompt ───
    const archiveContext = this.archiveMemory.buildArchiveContext(conversationId, 500);

    const sendProcess = (step, detail) => {
      if (onProcess) onProcess({ step, detail, ts: Date.now() });
    };

    // ─── PASO 1: Analyzer — interpreta el mensaje ───
    sendProcess('Paso 1/22', 'Analizando mensaje...');
    const fullMessages = history.map(m => ({ role: m.role, content: m.content }));
    const analysis = this.analyzer.analyze(message, fullMessages);
    sendProcess('Paso 1/22', `Intención: ${analysis.intent} | Tema: ${analysis.topic} | Confianza: ${(analysis.confidence * 100).toFixed(0)}%`);

    // ─── PASO 2: MemoryClassifier — clasifica recuerdos potenciales ───
    sendProcess('Paso 2/22', 'Clasificando recuerdos...');
    const classifiedMemories = this.classifier.classify(analysis, userId);
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
    const relationship = this.relationship.get(userId);
    sendProcess('Paso 4/22', `Confianza: ${((relationship.trust || 0) * 100).toFixed(0)}% | Familiaridad: ${((relationship.familiarity || 0) * 100).toFixed(0)}%`);

    // ─── PASO 5: EmotionEngine — procesa estado emocional (pre-response) ───
    sendProcess('Paso 5/22', 'Procesando emociones...');
    analysis.messageCount = history.length;
    this.emotions.process(analysis);
    const emotionalState = this.emotions.getState();
    const dominantEmotion = Object.entries(emotionalState).sort((a, b) => b[1] - a[1])[0];
    sendProcess('Paso 5/22', `Emoción dominante: ${dominantEmotion ? dominantEmotion[0] : 'neutral'} (${dominantEmotion ? (dominantEmotion[1] * 100).toFixed(0) + '%' : '-'})`);

    // ─── PASO 6: MemorySearch — recupera candidatos relevantes (5 pools) ───
    sendProcess('Paso 6/22', 'Buscando recuerdos relevantes...');
    if (trace) trace.start('search');
    const searchResult = await this.memorySearch.search(message, userId, {
      limit: 30,
      contextTopic: analysis.topic
    });

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
    const rankedContext = this.contextRanker.rank({
      analysis,
      memories,
      relationship,
      emotionalState,
      knowledge: knownEntities,
      goals: goalsForContext,
      summary,
      history: workingMessages,
      classifiedMemories,
      query: message,
      queryEmbedding,
    });
    sendProcess('Paso 10/22', `${rankedContext.rankedMemories.length} memorias rankeadas`);
    if (trace) trace.end('rank', { ranked: rankedContext.rankedMemories.length, essential: rankedContext.rankedMemories.filter(m => m.type === 'personal_data' || m.type === 'relationship').length });

    // ─── PASO 11: AttentionEngine — determina ventana de atención ───
    sendProcess('Paso 11/22', 'Calculando ventana de atención...');
    const attention = this.attention.focus({
      analysis,
      memories: rankedContext.rankedMemories,
      relationship,
      emotionalState,
      goals: goalsForContext,
      knowledge: knownEntities,
      history: workingMessages
    });
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
    const systemPrompt = this.promptComposer.compose({
      attention,
      rankedContext,
      analysis,
      emotionalState,
      relationship,
      conflicts: conflictResult,
      summary,
      selfState,
      archiveContext,
      graphContext,
    });
    sendProcess('Paso 13/22', `Prompt: ~${Math.ceil(systemPrompt.length / 4)} tokens`);

    // ─── PASO 14: Proveedor IA — genera respuesta (con soporte de tools) ───
    sendProcess('Paso 14/22', 'Generando respuesta con IA...');
    let finalSystemPrompt = systemPrompt;
    if (this.tools) {
      finalSystemPrompt = systemPrompt + '\n\n' + this.tools.getToolsPrompt();
    }
    let rawResponse = await chatFn(workingMessages, onChunk, { systemPrompt: finalSystemPrompt });
    sendProcess('Paso 14/22', `Respuesta generada (${rawResponse.length} chars)`);

    // Tool loop: detectar, ejecutar, re-generar (máx 3 iteraciones)
    if (this.tools) {
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

        const { results, cleanText } = await this.tools.executeFromResponse(rawResponse);

        const toolResultsText = results
          .map((r) => `[TOOL_RESULT:${r.tool}] ${r.success ? r.result : 'ERROR: ' + r.result}`)
          .join('\n\n');

        const toolMessages = [
          ...workingMessages,
          { role: 'assistant', content: cleanText || rawResponse },
          { role: 'system', content: `Resultados de herramientas:\n${toolResultsText}\n\nAhora respondé al usuario usando esta información. No vuelvas a llamar herramientas que ya ejecutaste.` },
        ];

        rawResponse = await chatFn(toolMessages, onChunk, { systemPrompt });

        if (onChunk) {
          onChunk(`\n🔄 Usando: tools (${toolCalls.map(t => t.name).join(', ')})\n`, 'tool');
        }
      }
    }

    // ─── PASO 15: ResponseProcessor — post-procesa respuesta ───
    sendProcess('Paso 15/22', 'Post-procesando respuesta...');
    const processedResponse = this.response.process({
      rawResponse,
      analysis,
      emotionalState
    });

    // ─── PASO 16: ReflectionEngine — análisis interno post-respuesta ───
    sendProcess('Paso 16/22', 'Reflexionando...');
    if (trace) trace.start('reflection');
    const activeGoals = cache.getOrSet(
      `goals:active:${userId}`,
      () => this.goals.getActiveGoals(userId)
    );
    const reflection = this.reflection.reflect({
      analysis,
      response: processedResponse,
      userId,
      conversationId,
      memories,
      classifiedMemories,
      emotionalState,
      relationship,
      activeGoals,
    });

    // Execute ALL reflection actions via ActionExecutor
    if (trace) {
      trace.end('reflection', { actions: reflection.actions.length });
      this.telemetry.counter('reflectionRuns');
    }
    if (reflection.actions && reflection.actions.length > 0) {
      const { results, undoLog } = this.actionExecutor.executeAll(reflection.actions, userId);

      // Log each action result to DB for debugging
      for (const r of results) {
        this.db.logReflectionAction(userId, r.type, r.success, r.detail || null, r.error || null, r.elapsed || 0);
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
    // Reflection generates temporal_classification actions BEFORE step 17 runs,
    // so we extract the types and attach them to the memories about to be stored.
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

    const memoryStats = await this.memory.store(classifiedMemories, userId);
    sendProcess('Paso 17/22', `Guardados: ${memoryStats.stored} | Actualizados: ${memoryStats.updated} | Descartados: ${memoryStats.discarded}`);

    // Invalidar cache después de modificar memorias
    if (memoryStats.stored > 0 || memoryStats.updated > 0) {
      cache.invalidatePattern(`entities:${userId}`);
      cache.invalidatePattern(`relations:${userId}`);
    }

    // ─── PASO 18: RelationshipEngine — actualiza relación post-interacción ───
    sendProcess('Paso 18/22', 'Actualizando relación...');
    this.relationship.update(userId, analysis, processedResponse);
    cache.invalidate(`relationship:${userId}`);
    sendProcess('Paso 18/22', 'Relación actualizada');

    // ─── PASO 19: EmotionEngine — actualiza emociones post-interacción ───
    sendProcess('Paso 19/22', 'Actualizando emociones post-respuesta...');
    this.emotions.update(analysis, processedResponse);
    sendProcess('Paso 19/22', 'Emociones actualizadas');

    // ─── PASO 20: KnowledgeGraph — extrae entidades ───
    sendProcess('Paso 20/22', 'Extrayendo entidades...');
    const entities = this.knowledge.extractEntities(analysis);
    let entityStats = { added: 0, relationsSuggested: 0 };
    try {
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
        workingMemoryTokens: this.workingMemory.getTokenCount(conversationId),
        cache: cache.getMetrics(),
        telemetry: trace ? trace.getTrace() : undefined,
        provider: null
      }
    };
  }
}

module.exports = Pipeline;
