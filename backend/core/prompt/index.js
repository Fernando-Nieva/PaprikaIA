/**
 * PromptComposer — Fase 5: Ensamblaje final del system prompt.
 *
 * Módulo FINAL antes de enviar al proveedor IA. Toda la información cognitiva
 * converge aquí: atención, contexto rankeado, análisis, emociones, relación,
 * conflictos y resumen. Compone el system prompt óptimo respetando un
 * presupuesto de tokens.
 *
 * Reemplaza la llamada directa a PersonalityEngine.buildSystemPrompt() en el
 * pipeline. Es el punto único donde TODA la información se ensambla.
 *
 * Secciones del prompt:
 *   [IDENTITY]        — Identidad de Paprika (siempre incluida)
 *   [SPEECH]          — Estilo de habla (siempre incluida)
 *   [CURRENT STATE]   — Emociones + atención + urgencia
 *   [RELATIONSHIP]    — Descripción dinámica del vínculo
 *   [ACTIVE GOALS]    — Objetivos relevantes al contexto
 *   [RELEVANT MEMORIES]— Top memorias rankeadas por atención
 *   [KNOWLEDGE]       — Entidades conocidas y relaciones
 *   [SUMMARY]         — Resumen de la conversación
 *   [CONFLICTS]       — Conflictos detectados (si los hay)
 *   [RULES]           — Reglas de comportamiento (siempre incluida)
 *   [LIMITS]          — Límites duros (siempre incluida)
 *   [SUPPRESSION]     — Qué NO enfocar (si hay suppressiones)
 *
 * Consumido por:
 *   - Pipeline: compose() reemplaza buildSystemPrompt()
 *   - ContextBuilder: se integra como paso final del ensamblaje
 *
 * Principio clave: gestión de presupuesto de tokens.
 *   Cada sección recibe una asignación según pesos de atención.
 *   El total no supera contextBudget (default 2000 tokens).
 */

const DEFAULT_CONFIG = {
  totalBudget: 2000,
  maxBudget: 4000,
  charsPerToken: 4,
  sectionSeparator: '\n\n',
};

class PromptComposer {
  /**
   * @param {PersonalityEngine} personality — Motor de personalidad para secciones base
   * @param {Object} config — Configuración (CoreConfig o config plano)
   */
  constructor(personality, config) {
    this.personality = personality;
    this.config = {
      ...DEFAULT_CONFIG,
      ...(config && config.getPrompt ? config.getPrompt() : config || {}),
    };
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Compone el system prompt completo a partir de toda la información cognitiva.
   *
   * @param {Object} params
   * @param {Object}  params.attention     — De AttentionEngine: { primary, secondary, suppressed, urgency }
   * @param {Object}  params.rankedContext — De ContextRanker: { rankedMemories, rankedGoals, relevantEntities, emotionalContext, relationshipContext, contextBudget }
   * @param {Object}  params.analysis      — De MessageAnalyzer
   * @param {Object}  params.emotionalState — De EmotionEngine
   * @param {Object}  params.relationship  — De RelationshipEngine
   * @param {Object}  params.conflicts     — De ConflictResolver: { conflicts, actions }
   * @param {string}  params.summary       — De Summarizer
   * @returns {string} System prompt completo optimizado para tokens
   */
  compose({ attention = {}, rankedContext = {}, analysis = {}, emotionalState = {}, relationship = {}, conflicts = null, summary = null, selfState = null, archiveContext = null, graphContext = null }) {
    const budget = rankedContext.contextBudget || this.config.totalBudget;
    const allocations = this._allocateBudget(attention, budget);

    const sections = [];

    // 1. Identidad (siempre presente)
    sections.push(this._buildIdentitySection(allocations));

    // 2. Fecha y hora actual (siempre presente)
    sections.push(this._buildTimeSection(allocations));

    // 3. Forma de hablar (siempre presente)
    sections.push(this._buildSpeechSection(allocations));

    // 3. Estado interno de Paprika (autoconocimiento)
    if (selfState) {
      sections.push(this._buildSelfStateSection(selfState, allocations));
    }

    // 4. Estado actual
    sections.push(this._buildCurrentStateSection(attention, emotionalState, analysis, allocations));

    // 5. Relación
    const relSection = this._buildRelationshipSection(relationship, attention, allocations);
    if (relSection) sections.push(relSection);

    // 6. Objetivos activos
    if (rankedContext.rankedGoals && rankedContext.rankedGoals.length > 0) {
      sections.push(this._buildGoalsSection(rankedContext, attention, allocations));
    }

    // 7. Memorias relevantes
    if (rankedContext.rankedMemories && rankedContext.rankedMemories.length > 0) {
      sections.push(this._buildMemoriesSection(rankedContext, attention, allocations));
    }

    // 8. Contexto archivado (Memory Level 3)
    if (archiveContext) {
      sections.push(this._buildArchiveSection(archiveContext, allocations));
    }

    // 9. Entidades conocidas + grafo de conocimiento
    const hasKnowledge = (rankedContext.relevantEntities && rankedContext.relevantEntities.length > 0)
      || (graphContext && graphContext.connections && graphContext.connections.length > 0);
    if (hasKnowledge) {
      sections.push(this._buildKnowledgeSection(rankedContext, allocations, graphContext));
    }

    // 10. Resumen
    if (summary) {
      sections.push(this._buildSummarySection(summary, allocations));
    }

    // 11. Conflictos
    if (conflicts && conflicts.conflicts && conflicts.conflicts.length > 0) {
      sections.push(this._buildConflictSection(conflicts, allocations));
    }

    // 12. Reglas (siempre al final)
    sections.push(this._buildRulesSection(allocations));

    // 13. Límites (siempre al final)
    sections.push(this._buildLimitsSection(allocations));

    // 14. Supresión
    if (attention.suppressed && attention.suppressed.length > 0) {
      sections.push(this._buildSuppressionSection(attention, allocations));
    }

    const composed = sections.filter(Boolean).join(this.config.sectionSeparator);

    // Asegurar que no exceda el presupuesto total
    return this._truncateToBudget(composed, budget);
  }

  // ─────────────────────────────────────────────
  //  Secciones del prompt
  // ─────────────────────────────────────────────

  /**
   * Sección: Identidad — quién es Paprika.
   * Siempre presente. ~200 tokens asignados.
   *
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildIdentitySection(allocations) {
    if (!this.personality) return '';

    const text = this.personality.buildIdentitySection
      ? this.personality.buildIdentitySection()
      : '';

    return this._truncateToBudget(text, allocations.identity || 200);
  }

  /**
   * Sección: Fecha y hora actual — contexto temporal para Paprika.
   * Siempre presente. ~50 tokens asignados.
   * Incluye: fecha, hora, día de la semana, zona horaria.
   *
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildTimeSection(allocations) {
    const now = new Date();

    const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    const dayName = days[now.getDay()];
    const day = now.getDate();
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    const text = `Fecha y hora actual: ${dayName} ${day} de ${month} de ${year}, ${hours}:${minutes} (${timezone})`;

    return this._truncateToBudget(text, allocations.time || 50);
  }

  /**
   * Sección: Forma de hablar — estilo, modismos, energía.
   * Siempre presente. ~150 tokens asignados.
   *
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildSpeechSection(allocations) {
    if (!this.personality) return '';

    const text = this.personality.buildSpeechSection
      ? this.personality.buildSpeechSection()
      : '';

    return this._truncateToBudget(text, allocations.speech || 150);
  }

  /**
   * Sección: Estado interno de Paprika — autoconocimiento.
   * Incluye identidad, emociones, relación, memorias, objetivos, etc.
   *
   * @param {Object} selfState — Output de SelfAccess.getFullState()
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildSelfStateSection(selfState, allocations) {
    if (!selfState) return '';

    const lines = [];

    // Identity
    if (selfState.identity) {
      const id = selfState.identity;
      lines.push(`Sos ${id.name}. ${id.description || ''}`);
      if (id.essence) lines.push(`Tu esencia: ${id.essence}`);
    }

    // Emotional state
    if (selfState.emotional && selfState.emotional.description) {
      lines.push(`Estado emocional: ${selfState.emotional.description}`);
    }

    // Relationship
    if (selfState.relationship && selfState.relationship.description) {
      lines.push(`Relación con el usuario: ${selfState.relationship.description}`);
    }

    // Memories about the user
    if (selfState.memories && selfState.memories.length > 0) {
      lines.push('Lo que sabés sobre el usuario:');
      for (const mem of selfState.memories) {
        lines.push(`- [${mem.category}] ${mem.content}`);
      }
    }

    // Active goals
    if (selfState.goals && selfState.goals.length > 0) {
      lines.push('Objetivos del usuario:');
      for (const goal of selfState.goals) {
        const pct = Math.round((goal.progress || 0) * 100);
        lines.push(`- ${goal.content} (${pct}%)`);
      }
    }

    // Known entities
    if (selfState.knowledge && selfState.knowledge.entities && selfState.knowledge.entities.length > 0) {
      lines.push(`Entidades conocidas: ${selfState.knowledge.entities.map(e => `${e.name}(${e.type})`).join(', ')}`);
    }

    const text = lines.join('\n');
    return this._truncateToBudget(text, allocations.selfState || 400);
  }

  /**
   * Sección: Estado actual — emociones + atención + urgencia.
   *
   * @param {Object} attention — { primary, secondary, urgency }
   * @param {Object} emotionalState — Estado emocional del EmotionEngine
   * @param {Object} analysis — Output del Analyzer
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildCurrentStateSection(attention, emotionalState, analysis, allocations) {
    const lines = [];

    // Estado emocional
    const emotionText = this._formatEmotionalState(emotionalState);
    if (emotionText) lines.push(emotionText);

    // Foco de atención
    if (attention.primary) {
      const focus = typeof attention.primary === 'string'
        ? attention.primary
        : attention.primary.type || attention.primary.description || '';
      if (focus) lines.push(`Atención principal: ${focus}`);
    }

    if (attention.secondary) {
      const secondary = typeof attention.secondary === 'string'
        ? attention.secondary
        : attention.secondary.type || attention.secondary.description || '';
      if (secondary) lines.push(`Atención secundaria: ${secondary}`);
    }

    // Urgencia
    if (attention.urgency && attention.urgency > 0.5) {
      lines.push('Urgencia alta en esta interacción.');
    }

    const text = lines.join('\n');
    return this._truncateToBudget(text, allocations.currentState || 100);
  }

  /**
   * Sección: Relación — descripción dinámica del vínculo con el usuario.
   *
   * @param {Object} relationship — Del RelationshipEngine
   * @param {Object} attention — Atención actual (para ajustar énfasis)
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string|null}
   */
  _buildRelationshipSection(relationship, attention, allocations) {
    const text = this._formatRelationship(relationship, attention);
    if (!text) return null;

    return this._truncateToBudget(text, allocations.relationship || 150);
  }

  /**
   * Sección: Objetivos activos relevantes al contexto actual.
   *
   * @param {Object} rankedContext — { rankedGoals }
   * @param {Object} attention — Atención actual
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildGoalsSection(rankedContext, attention, allocations) {
    const goals = rankedContext.rankedGoals || [];
    const text = this._formatGoals(goals);

    return this._truncateToBudget(text, allocations.goals || 100);
  }

  /**
   * Sección: Memorias relevantes rankeadas.
   * Sección más grande del prompt — su asignación varía con la atención.
   *
   * @param {Object} rankedContext — { rankedMemories }
   * @param {Object} attention — Atención actual
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildMemoriesSection(rankedContext, attention, allocations) {
    const memories = rankedContext.rankedMemories || [];
    const text = this._formatMemories(memories);

    return this._truncateToBudget(text, allocations.memories || 500);
  }

  /**
   * Sección: Conocimiento — entidades conocidas y sus relaciones.
   *
   * @param {Object} rankedContext — { relevantEntities }
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildKnowledgeSection(rankedContext, allocations, graphContext = null) {
    const lines = [];

    // Grafo de conocimiento con conexiones (si está disponible)
    if (graphContext && graphContext.connections && graphContext.connections.length > 0) {
      lines.push('Grafo de conocimiento:');
      for (const conn of graphContext.connections) {
        lines.push(`  ${conn}`);
      }
    }

    // Entidades relevantes (formato compacto)
    const entities = rankedContext.relevantEntities || [];
    if (entities.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Entidades conocidas:');
      for (const e of entities.slice(0, 10)) {
        const relCount = e.relations ? e.relations.length : 0;
        const relInfo = relCount > 0 ? ` (${relCount} relaciones)` : '';
        lines.push(`  - ${e.name} [${e.entity_type || e.type}]${relInfo}`);
      }
    }

    if (lines.length === 0) return '';
    const text = lines.join('\n');
    return this._truncateToBudget(text, allocations.knowledge || 200);
  }

  /**
   * Sección: Resumen de la conversación.
   *
   * @param {string} summary — Resumen del Summarizer
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildSummarySection(summary, allocations) {
    if (!summary) return '';
    const text = `Resumen de la conversación anterior:\n${summary}`;
    return this._truncateToBudget(text, allocations.summary || 200);
  }

  /**
   * Sección: Archive — contexto de conversaciones antiguas archivadas.
   * Memory Level 3: resúmenes de interacciones que ya no caben en Working Memory.
   *
   * @param {string} archiveContext — Texto archivado formateado por ArchiveMemoryManager
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildArchiveSection(archiveContext, allocations) {
    if (!archiveContext) return '';
    const text = `Contexto de conversaciones anteriores:\n${archiveContext}`;
    return this._truncateToBudget(text, allocations.archive || 300);
  }

  /**
   * Sección: Reglas de comportamiento.
   * Siempre presente. ~200 tokens asignados.
   *
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildRulesSection(allocations) {
    if (!this.personality) return '';

    const text = this.personality.buildRulesSection
      ? this.personality.buildRulesSection()
      : '';

    if (!text) return '';
    return this._truncateToBudget(`Reglas:\n${text}`, allocations.rules || 200);
  }

  /**
   * Sección: Límites duros.
   * Siempre presente. ~100 tokens asignados.
   *
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildLimitsSection(allocations) {
    if (!this.personality) return '';

    const text = this.personality.buildLimitsSection
      ? this.personality.buildLimitsSection()
      : '';

    return this._truncateToBudget(text, allocations.limits || 100);
  }

  /**
   * Sección: Qué NO enfocar (supresión de atención).
   *
   * @param {Object} attention — { suppressed: Array<string> }
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildSuppressionSection(attention, allocations) {
    const suppressed = attention.suppressed || [];
    if (suppressed.length === 0) return '';

    const items = suppressed.map((s) => {
      if (typeof s === 'string') return `- No enfocar en: ${s}`;
      const label = s.type || s.description || s.topic || String(s);
      return `- No enfocar en: ${label}`;
    });

    const text = `Evita enfocarte en estos temas ahora:\n${items.join('\n')}`;
    return this._truncateToBudget(text, allocations.suppression || 50);
  }

  /**
   * Sección: Conflictos detectados.
   *
   * @param {Object} conflicts — { conflicts: Array<Object> }
   * @param {Object} allocations — Presupuestos por sección
   * @returns {string}
   */
  _buildConflictSection(conflicts, allocations) {
    const items = conflicts.conflicts || [];
    if (items.length === 0) return '';

    const lines = items.map((c) => {
      const desc = c.description || c.message || c.text || JSON.stringify(c);
      return `- ${desc}`;
    });

    const text = `Conflictos detectados que debés tener en cuenta:\n${lines.join('\n')}`;
    const budget = Math.min(allocations.rules || 200, 150);
    return this._truncateToBudget(text, budget);
  }

  // ─────────────────────────────────────────────
  //  Gestión de presupuesto de tokens
  // ─────────────────────────────────────────────

  /**
   * Asigna presupuesto de tokens a cada sección del prompt.
   * Secciones fijas siempre reciben su mínimo.
   * Secciones dinámicas se ajustan según el tipo de atención primaria.
   *
   * @param {Object} attention — { primary: { type } }
   * @param {number} totalBudget — Presupuesto total en tokens
   * @returns {Object} Asignaciones por sección { sectionName: tokenBudget }
   */
  _allocateBudget(attention, totalBudget) {
    // Secciones fijas
    const fixed = {
      identity: 200,
      time: 50,
      speech: 150,
      selfState: 400,
      rules: 200,
      limits: 100,
    };
    const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0);

    // Resto disponible para secciones dinámicas
    const dynamic = Math.max(totalBudget - fixedTotal, 0);

    const allocations = { ...fixed };

    const primaryType = attention && attention.primary
      ? (typeof attention.primary === 'string' ? attention.primary : attention.primary.type || '')
      : '';

    // Asignación dinámica según foco de atención primaria
    if (primaryType === 'goal') {
      allocations.goals = Math.min(dynamic * 0.25, 300);
      allocations.memories = Math.min(dynamic * 0.40, 500);
      allocations.relationship = Math.min(dynamic * 0.10, 150);
    } else if (primaryType === 'emotion') {
      allocations.memories = Math.min(dynamic * 0.35, 400);
      allocations.relationship = Math.min(dynamic * 0.25, 300);
      allocations.goals = Math.min(dynamic * 0.10, 150);
    } else if (primaryType === 'entity') {
      allocations.memories = Math.min(dynamic * 0.40, 500);
      allocations.knowledge = Math.min(dynamic * 0.25, 300);
      allocations.goals = Math.min(dynamic * 0.10, 150);
    } else {
      // Default: balance general
      allocations.memories = Math.min(dynamic * 0.40, 500);
      allocations.goals = Math.min(dynamic * 0.15, 200);
      allocations.relationship = Math.min(dynamic * 0.10, 150);
    }

    // Lo que quede para knowledge y summary (si no fueron asignados arriba)
    if (!allocations.knowledge) {
      allocations.knowledge = Math.min(dynamic * 0.15, 200);
    }
    if (!allocations.summary) {
      allocations.summary = Math.min(dynamic * 0.15, 200);
    }

    allocations.currentState = 100;
    allocations.archive = 300;
    allocations.suppression = 50;

    return allocations;
  }

  /**
   * Trunca texto para que no exceda un presupuesto de tokens.
   * Estimación: ~4 caracteres por token (aproximado para español).
   *
   * @param {string} text — Texto a truncar
   * @param {number} tokenBudget — Presupuesto máximo en tokens
   * @returns {string} Texto truncado o intacto
   */
  _truncateToBudget(text, tokenBudget) {
    if (!text) return '';
    const maxChars = tokenBudget * (this.config.charsPerToken || 4);
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars - 3) + '...';
  }

  /**
   * Estima la cantidad de tokens en un texto.
   *
   * @param {string} text
   * @returns {number} Tokens estimados
   */
  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / (this.config.charsPerToken || 4));
  }

  // ─────────────────────────────────────────────
  //  Formateadores de contenido
  // ─────────────────────────────────────────────

  /**
   * Formatea el estado emocional como texto descriptivo.
   *
   * @param {Object} state — Estado emocional del EmotionEngine
   * @returns {string}
   */
  _formatEmotionalState(state) {
    if (!state) return '';

    const parts = [];

    if (state.energy !== undefined) {
      const energyPct = Math.round(state.energy * 10);
      if (energyPct >= 7) parts.push('con mucha energía');
      else if (energyPct >= 4) parts.push('con energía moderada');
      else parts.push('con poca energía');
    }

    if (state.happiness !== undefined) {
      const happyPct = Math.round(state.happiness * 10);
      if (happyPct >= 7) parts.push('de buen humor');
      else if (happyPct >= 4) parts.push('de humor neutral');
      else parts.push('con humor bajo');
    }

    if (state.empathy !== undefined && state.empathy >= 0.7) {
      parts.push('muy empática');
    }

    if (state.nostalgia !== undefined && state.nostalgia >= 0.7) {
      parts.push('un poco nostálgica');
    }

    if (state.curiosity !== undefined && state.curiosity >= 0.7) {
      parts.push('muy curiosa');
    }

    if (parts.length === 0) return '';
    return `Estado actual: ${parts.join(', ')}.`;
  }

  /**
   * Formatea la relación con el usuario como texto descriptivo.
   *
   * @param {Object} rel — Relación del RelationshipEngine
   * @param {Object} attention — Atención actual
   * @returns {string|null}
   */
  _formatRelationship(rel, attention) {
    if (!rel || rel.trustLevel === undefined) return null;

    const lines = [];

    const trustPct = Math.round((rel.trustLevel || 0.5) * 100);
    const famPct = Math.round((rel.familiarity || 0.5) * 100);

    if (trustPct >= 70) {
      lines.push('Tenés mucha confianza con este usuario');
    } else if (trustPct >= 40) {
      lines.push('La confianza con el usuario está creciendo');
    } else {
      lines.push('Aún estás construyendo confianza con el usuario');
    }

    if (famPct >= 70) {
      lines.push('Son bastante cercanos, podés ser más directa y relajada');
    } else if (famPct >= 40) {
      lines.push('Hay buena familiaridad, manteniendo un tono amigable');
    }

    if (rel.formalityLevel > 0.6) {
      lines.push('Mantené un tono más formal');
    } else if (rel.formalityLevel < 0.3) {
      lines.push('Tratalo de forma informal');
    }

    if (rel.humorAllowed === false) {
      lines.push('Evitá el humor en esta interacción');
    }

    if (rel.allowVulnerability) {
      lines.push('Podés ser vulnerable y abierta');
    }

    if (rel.needsBoundaries) {
      lines.push('Cuidado: el usuario puede estar en un tema sensible');
    }

    // Ajustar énfasis según atención
    if (attention && attention.primary && attention.primary.type === 'emotion') {
      lines.push('Priorizá la conexión emocional sobre la información');
    }

    if (lines.length === 0) return null;
    return `Relación: ${lines.join('. ')}.`;
  }

  /**
   * Formatea una lista de objetivos activos.
   *
   * @param {Array<Object>} goals — Objetivos rankeados
   * @returns {string}
   */
  _formatGoals(goals) {
    if (!goals || goals.length === 0) return '';

    const priorityLabel = (p) => {
      if (p >= 0.7) return 'alta';
      if (p >= 0.4) return 'media';
      return 'baja';
    };

    const lines = goals.map((g) => {
      const content = g.content || g.goal || '';
      const pct = Math.round((g.progress || 0) * 100);
      const prio = priorityLabel(g.priority || 0);
      const category = g.category || '';
      const catLabel = category ? ` [${category}]` : '';
      return `- ${content}${catLabel} — progreso: ${pct}%, prioridad ${prio}`;
    });

    return `Objetivos activos:\n${lines.join('\n')}`;
  }

  /**
   * Formatea una lista de memorias relevantes.
   *
   * @param {Array<Object>} memories — Memorias rankeadas
   * @returns {string}
   */
  _formatMemories(memories) {
    if (!memories || memories.length === 0) return '';

    const identityTypes = ['personal_data', 'person'];
    const identityMemories = memories.filter(m => identityTypes.includes(m.type));
    const otherMemories = memories.filter(m => !identityTypes.includes(m.type));

    const lines = [];

    // User identity section — always presented clearly
    if (identityMemories.length > 0) {
      lines.push('Sobre el usuario:');
      for (const m of identityMemories) {
        const content = this._cleanIdentityContent(m.content || '');
        lines.push(`  - ${content}`);
      }
    }

    // Other memories
    if (otherMemories.length > 0) {
      lines.push('Recuerdos relevantes:');
      for (const m of otherMemories) {
        const content = m.content || '';
        const type = m.type || '';
        const typeLabel = type ? ` [${type}]` : '';
        const score = m.contextualScore ? ` (${Math.round(m.contextualScore * 100)}%)` : '';
        lines.push(`  - ${content}${typeLabel}${score}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Clean identity content for clearer prompt presentation.
   * Converts internal format to natural language.
   */
  _cleanIdentityContent(content) {
    // "El usuario se identifica como: X" → "Se llama X"
    let cleaned = content.replace(/El usuario se identifica como:\s*/i, 'Se llama ');
    // "Nombre del usuario: X" → "Se llama X"
    cleaned = cleaned.replace(/Nombre del usuario:\s*/i, 'Se llama ');
    // "Nombre: X" → keep as is (already clear)
    // "Se llama: X" → keep as is
    // "Vive en: X" → keep as is
    // "Es de: X" → keep as is
    return cleaned;
  }

  /**
   * Formatea una lista de entidades conocidas.
   *
   * @param {Array<Object>} entities — Entidades rankeadas
   * @returns {string}
   */
  _formatEntities(entities) {
    if (!entities || entities.length === 0) return '';

    const lines = entities.map((e) => {
      const name = e.name || '';
      const type = e.entity_type || e.type || '';
      const typeLabel = type ? ` [${type}]` : '';
      const relCount = e.relations ? e.relations.length : 0;
      const relLabel = relCount > 0 ? ` (${relCount} relaciones)` : '';
      return `- ${name}${typeLabel}${relLabel}`;
    });

    return `Conocimiento sobre el usuario:\n${lines.join('\n')}`;
  }
}

module.exports = PromptComposer;
