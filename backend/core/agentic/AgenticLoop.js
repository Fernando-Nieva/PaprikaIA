'use strict';

/**
 * AgenticLoop — Orquestador del ciclo PRAL (Perceive → Reason → Act → Learn).
 *
 * Reemplaza el tool loop fijo de 3 rondas con un ciclo dinámico:
 *   1. PLANIFICAR: TaskPlanner descompone el objetivo
 *   2. EJECUTAR: Tool calls en secuencia
 *   3. REFLEXIONAR: ReflectionEngine evalúa progreso
 *   4. DECIDIR: continuar / completar / preguntar / fallback
 *   5. REPETIR hasta completar o max iterations
 *
 * Para tareas simples, el loop se salta el planning y va directo
 * a ejecución + reflexión (1-2 rondas).
 *
 * Seguridad:
 *   - Max iterations configurable (default 10)
 *   - Max tool calls por ronda (default 5)
 *   - Timeout absoluto (default 60s)
 *   - Detección de loops infinitos
 */

const TaskPlanner = require('./TaskPlanner');
const ReflectionEngine = require('./ReflectionEngine');
const ProgressTracker = require('./ProgressTracker');

const DEFAULT_CONFIG = {
  maxIterations: 10,
  maxToolsPerRound: 5,
  absoluteTimeout: 60000,
  enablePlanning: true,
  enableReflection: true,
};

class AgenticLoop {
  /**
   * @param {Object} params
   * @param {Function} params.chatFn — Función de chat del proveedor IA
   * @param {Object} params.toolExecutor — Instancia de ToolExecutor
   * @param {Object} [params.config]
   * @param {Function} [params.onProgress] — Callback SSE
   * @param {Function} [params.onToolCall] — Callback para tool calls individuales
   */
  constructor({ chatFn, toolExecutor, config = {}, onProgress, onToolCall }) {
    this.chatFn = chatFn;
    this.toolExecutor = toolExecutor;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._onProgress = onProgress || (() => {});
    this._onToolCall = onToolCall || (() => {});

    this.planner = new TaskPlanner(chatFn, {
      maxSteps: 8,
    });
    this.reflection = new ReflectionEngine(chatFn, {
      maxConsecutiveErrors: 3,
      maxStaleIterations: 3,
    });
    this.progress = new ProgressTracker(this._onProgress);

    this._metrics = {
      totalIterations: 0,
      totalToolCalls: 0,
      planningUsed: false,
      decisions: { complete: 0, continue: 0, ask_user: 0, fallback: 0 },
    };
  }

  /**
   * Ejecuta el agentic loop para un objetivo.
   *
   * @param {Object} params
   * @param {string} params.objective — Objetivo del usuario
   * @param {Array} params.context — Mensajes de contexto
   * @param {Object} params.analysis — Análisis del analyzer
   * @param {string} params.systemPrompt — System prompt base
   * @param {Function} [params.chatFn] — ChatFn override (runtime)
   * @param {Function} [params.onChunk] — Chunk streaming callback for SSE
   * @returns {Promise<{ response: string, metadata: Object }>}
   */
  async execute({ objective, context, analysis, systemPrompt, chatFn, onChunk }) {
    // Allow runtime chatFn override
    const llm = chatFn || this.chatFn;
    if (!llm) {
      return {
        response: 'Error: chatFn no disponible para agentic loop',
        metadata: { agentic: true, error: 'no chatFn' },
      };
    }
    const startTime = Date.now();
    this.reflection.reset();
    this.progress.reset();
    this._metrics = {
      totalIterations: 0,
      totalToolCalls: 0,
      planningUsed: false,
      decisions: { complete: 0, continue: 0, ask_user: 0, fallback: 0 },
    };

    // ─── Phase 1: Planning ───
    let plan = null;
    if (this.config.enablePlanning) {
      this.progress.emitProgress('Planificando tarea...');
      // Temporarily set chatFn on planner for this execution
      this.planner.chatFn = llm;
      plan = await this.planner.plan(objective, context, analysis);

      if (plan && plan.complex) {
        this._metrics.planningUsed = true;
        this.progress.init(plan.objective || objective, plan.steps);
        this.progress.emitProgress(`Plan: ${plan.steps.length} pasos`);
      }
    }

    // ─── Phase 2: Execute loop ───
    let currentResponse = '';
    let allToolResults = [];
    let actionHistory = [];
    let finalDecision = null;

    const isComplex = plan && plan.complex;
    const maxIter = isComplex
      ? Math.min(this.config.maxIterations, plan.steps.length)
      : Math.min(this.config.maxIterations, 3); // Simple tasks: max 3 rounds

    for (let iteration = 0; iteration < maxIter; iteration++) {
      this._metrics.totalIterations++;
      const iterStart = Date.now();

      // Check absolute timeout
      if (Date.now() - startTime > this.config.absoluteTimeout) {
        finalDecision = {
          decision: 'fallback',
          reasoning: 'Timeout absoluto alcanzado',
        };
        break;
      }

      // Current step description
      const stepDesc = isComplex && plan.steps[iteration]
        ? plan.steps[iteration].description
        : `Ronda ${iteration + 1}`;

      if (isComplex) {
        this.progress.startStep(iteration + 1, stepDesc);
      }

      // ─── Generate response with tool calls ───
      const messages = this._buildMessages(context, currentResponse, allToolResults, objective);
      const toolsPrompt = this.toolExecutor.getToolsPrompt();
      const iterSystemPrompt = systemPrompt + '\n\n' + toolsPrompt;

      if (process.env.DEBUG_ATTACHMENTS === 'true') {
        console.log('\n─── [DEBUG ATTACHMENTS] Etapa 4: AgenticLoop._buildMessages ───');
        console.log('  context.length:', context.length);
        console.log('  messages.length:', messages.length);
        const userMsgs = messages.filter(m => m.role === 'user');
        console.log('  user messages count:', userMsgs.length);
        userMsgs.forEach((m, i) => {
          console.log(`  userMsg[${i}]: content type=${typeof m.content}, isArray=${Array.isArray(m.content)}`);
          if (Array.isArray(m.content)) {
            console.log(`    parts count: ${m.content.length}`);
            m.content.forEach((p, j) => {
              console.log(`    part[${j}]: type=${p.type}`, p.type === 'image_url' ? `url_len=${p.image_url?.url?.length}, prefix=${p.image_url?.url?.substring(0, 20)}` : p.type === 'text' ? `text="${p.text?.substring(0, 60)}"` : '?');
            });
          } else {
            console.log(`    content (trunc): ${String(m.content).substring(0, 80)}`);
          }
        });
      }

      this.progress.emitProgress(`Generando: ${stepDesc}`);

      let rawResponse;
      try {
        if (process.env.DEBUG_ATTACHMENTS === 'true') {
          console.log('\n─── [DEBUG ATTACHMENTS] Etapa 4b: Llamando llm() ───');
          console.log('  Enviando', messages.length, 'mensajes al provider');
          const hasMultimodal = messages.some(m => Array.isArray(m.content));
          console.log('  ¿Algún mensaje con content array (multimodal)?', hasMultimodal);
        }
        rawResponse = await llm(messages, null, {
          systemPrompt: iterSystemPrompt,
        });
      } catch (err) {
        console.error(`[AgenticLoop] Chat error on iteration ${iteration}: ${err.message}`);
        finalDecision = {
          decision: 'fallback',
          reasoning: `Error de chat: ${err.message}`,
        };
        break;
      }

      // ─── Execute tools ───
      const toolCalls = this.toolExecutor.parseToolCalls(rawResponse);
      if (toolCalls.length === 0) {
        // No tools → this is the final response
        currentResponse = rawResponse;
        finalDecision = {
          decision: 'complete',
          reasoning: 'Sin tool calls — respuesta final',
          quality: 'high',
        };
        // NO streamear — el pipeline se encarga de streamear
        break;
      }

      // Limit tools per round
      const limitedCalls = toolCalls.slice(0, this.config.maxToolsPerRound);

      // Report tool calls
      for (const tc of limitedCalls) {
        this._onToolCall({ name: tc.name, args: tc.args, iteration });
        this.progress.logAction({
          type: 'tool',
          description: `${tc.name}(${JSON.stringify(tc.args).substring(0, 100)})`,
          metadata: { iteration, tool: tc.name },
        });
      }

      // Execute only the limited tool calls (not all from rawResponse)
      let iterResults = [];
      let cleanText = '';
      try {
        const execResults = [];
        for (const tc of limitedCalls) {
          const result = await this.toolExecutor.execute(tc.name, tc.args);
          if (result !== undefined) {
            execResults.push(result);
          }
        }
        iterResults = execResults;
        // Extract clean text by removing tool call blocks from rawResponse
        cleanText = rawResponse.replace(
          /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g,
          ''
        ).trim();
      } catch (err) {
        console.error(`[AgenticLoop] Tool execution error: ${err.message}`);
        finalDecision = {
          decision: 'fallback',
          reasoning: `Error en ejecución de herramientas: ${err.message}`,
        };
        break;
      }
      allToolResults = [...allToolResults, ...iterResults];
      this._metrics.totalToolCalls += iterResults.length;

      // Store the clean text (response without tool calls)
      if (cleanText && cleanText.trim()) {
        currentResponse = cleanText;
      }

      // Report results
      for (const r of iterResults) {
        this.progress.logAction({
          type: 'tool',
          description: `${r.tool}: ${r.success ? 'OK' : 'ERROR'}`,
          metadata: { success: r.success, tool: r.tool },
        });
      }

      if (isComplex) {
        const summary = iterResults
          .map(r => `${r.tool}: ${r.success ? 'OK' : 'ERR'}`)
          .join(', ');
        this.progress.completeStep(iteration + 1, summary);
      }

      actionHistory.push({
        iteration: iteration + 1,
        tools: limitedCalls.map(t => t.name),
        resultsCount: iterResults.length,
        successCount: iterResults.filter(r => r.success).length,
      });

      // ─── Phase 3: Reflection ───
      if (this.config.enableReflection) {
        this.progress.emitProgress('Reflexionando...');
        // Temporarily set chatFn on reflection for this execution
        this.reflection.chatFn = llm;

        const reflection = await this.reflection.reflect({
          objective,
          plan: plan && plan.complex ? plan.steps : [],
          actionHistory,
          toolResults: iterResults,
          currentResponse,
        });

        this._metrics.decisions[reflection.decision] =
          (this._metrics.decisions[reflection.decision] || 0) + 1;

        if (reflection.decision === 'complete') {
          finalDecision = reflection;
          break;
        } else if (reflection.decision === 'fallback') {
          finalDecision = reflection;
          break;
        } else if (reflection.decision === 'ask_user') {
          finalDecision = reflection;
          break;
        }
        // 'continue' → loop again
      }
    }

    // ─── Phase 4: Final response ───
    if (!finalDecision) {
      finalDecision = {
        decision: 'fallback',
        reasoning: 'Max iteraciones alcanzadas',
      };
    }

    // Generate final response if we don't have one
    if (!currentResponse || finalDecision.decision !== 'complete') {
      const finalMessages = this._buildFinalMessages(
        context, currentResponse, allToolResults, objective, finalDecision
      );

      try {
        currentResponse = await llm(finalMessages, onChunk, {
          systemPrompt: systemPrompt + '\n\nGenerá la respuesta final al usuario. No uses herramientas.',
        });
      } catch (err) {
        console.error(`[AgenticLoop] Final response error: ${err.message}`);
        if (!currentResponse) {
          currentResponse = 'Disculpá, tuve un problema procesando tu pedido.';
        }
      }
    }

    // Report completion
    this.progress.complete(
      finalDecision.decision === 'complete',
      finalDecision.reasoning
    );

    return {
      response: currentResponse,
      metadata: {
        agentic: true,
        iterations: this._metrics.totalIterations,
        toolCalls: this._metrics.totalToolCalls,
        planningUsed: this._metrics.planningUsed,
        decision: finalDecision.decision,
        reasoning: finalDecision.reasoning,
        quality: finalDecision.quality,
        duration: Date.now() - startTime,
        actionHistory,
      },
    };
  }

  /**
   * Construye mensajes para una iteración del loop.
   */
  _buildMessages(context, currentResponse, toolResults, objective) {
    const messages = [...context];

    if (currentResponse) {
      messages.push({ role: 'assistant', content: currentResponse });
    }

    if (toolResults.length > 0) {
      const resultsText = toolResults
        .slice(-10) // Últimos 10 resultados
        .map(r => `[TOOL_RESULT:${r.tool}] ${r.success ? r.result : 'ERROR: ' + r.result}`)
        .join('\n\n');

      messages.push({
        role: 'system',
        content: `Resultados de herramientas:\n${resultsText}\n\nUsá esta información para continuar con el objetivo: "${objective}". No vuelvas a llamar herramientas que ya ejecutaste.`,
      });
    }

    return messages;
  }

  /**
   * Construye mensajes para la respuesta final.
   */
  _buildFinalMessages(context, currentResponse, toolResults, objective, decision) {
    const messages = [...context];

    if (currentResponse) {
      messages.push({ role: 'assistant', content: currentResponse });
    }

    if (toolResults.length > 0) {
      const resultsText = toolResults
        .map(r => `[TOOL_RESULT:${r.tool}] ${r.success ? r.result : 'ERROR: ' + r.result}`)
        .join('\n\n');

      messages.push({
        role: 'system',
        content: `Información recopilada:\n${resultsText}\n\nGenerá la respuesta final al usuario basándote en esta información. Objetivo: "${objective}"`,
      });
    }

    if (decision && decision.question) {
      messages.push({
        role: 'system',
        content: `Necesitás preguntarle al usuario: ${decision.question}`,
      });
    }

    return messages;
  }

  /**
   * Retorna métricas del loop.
   * @returns {Object}
   */
  getMetrics() {
    return {
      ...this._metrics,
      reflection: this.reflection.getMetrics(),
    };
  }
}

module.exports = AgenticLoop;
