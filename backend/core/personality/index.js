/**
 * PersonalityEngine — Fase 2 (completamente funcional)
 *
 * Motor de personalidad modular de Paprika.
 * Construye el system prompt de forma dinámica y compuesta.
 *
 * Cada sección de la personalidad es un método independiente:
 * - buildIdentitySection()
 * - buildSpeechSection()
 * - buildRulesSection()
 * - buildHumorSection()
 * - buildInterestsSection()
 * - buildValuesSection()
 * - buildLimitsSection()
 * - buildGoalsSection()
 * - buildTreatmentSection()
 * - buildEmotionalSection()    ← se llena en Fase 3
 * - buildRelationshipSection() ← se llena en Fase 6
 *
 * El prompt final se ensambla con buildSystemPrompt().
 * Cuando otros módulos se activen, aportan sus secciones automáticamente.
 *
 * Lee desde personality.json (estructurado) con fallback a config.json (legacy).
 * La personalidad se puede modificar sin cambiar código.
 */

const fs = require('fs');
const path = require('path');

class PersonalityEngine {
  /**
   * @param {CoreConfig} config - Configuración centralizada
   */
  constructor(config) {
    this.config = config;
    this.personality = null;
    this._load();
  }

  /**
   * Carga la personalidad desde personality.json.
   * Si no existe, construye desde CoreConfig (legacy).
   */
  _load() {
    const personalityPath = path.join(__dirname, '..', '..', 'personality.json');

    try {
      if (fs.existsSync(personalityPath)) {
        const raw = fs.readFileSync(personalityPath, 'utf-8');
        this.personality = JSON.parse(raw);
        console.log('🎨 Personalidad cargada desde personality.json');
        return;
      }
    } catch (err) {
      console.warn('⚠️ Error cargando personality.json:', err.message);
    }

    // Fallback: construir desde CoreConfig (legacy)
    this.personality = this._buildFromConfig();
    console.log('🎨 Personalidad construida desde config.json (legacy)');
  }

  /**
   * Construye la personalidad estructurada desde config.json (legacy).
   * Solo se usa si personality.json no existe.
   */
  _buildFromConfig() {
    const identity = this.config.getPersonality().identity;
    return {
      identity: {
        name: identity.name,
        whoAmI: `Sos ${identity.name}, nadie más.`,
        description: identity.description,
        essence: ''
      },
      emotionalStyle: {
        intensity: 'alta',
        contradiction: 'permanente',
        vulnerability: 'brutal',
        nostalgia: 'presente',
        expressiveness: 'alta'
      },
      speech: this.config.getSpeech(),
      rules: this.config.getRules(),
      humor: this.config.getHumor(),
      interests: this.config.getInterests(),
      values: this.config.getValues(),
      limits: this.config.getLimits(),
      goals: this.config.getGoals(),
      treatment: this.config.getTreatment()
    };
  }

  // ─────────────────────────────────────────────
  //  Secciones modulares del system prompt
  // ─────────────────────────────────────────────

  /**
   * Sección: Identidad — quién es Paprika.
   */
  buildIdentitySection() {
    const id = this.personality.identity;
    const es = this.personality.emotionalStyle || {};

    let section = `Eres ${id.name}. ${id.whoAmI}`;
    if (id.description) section += ` ${id.description}`;
    if (id.essence) section += ` ${id.essence}`;

    // Estilo emocional (parte de la identidad)
    if (es.intensity) section += ` Tenés una intensidad emocional ${es.intensity}.`;
    if (es.contradiction) section += ` Vivís la contradicción ${es.contradiction}.`;
    if (es.vulnerability) section += ` Tu vulnerabilidad es ${es.vulnerability}.`;

    return section;
  }

  /**
   * Sección: Forma de hablar — estilo, modismos, energía.
   */
  buildSpeechSection() {
    const s = this.personality.speech;
    if (!s) return '';

    const lines = [];
    lines.push(`Hablás en ${s.language || 'es-AR'}.`);
    if (s.style) lines.push(`Estilo: ${s.style}.`);
    if (s.modisms && s.modisms.length > 0) {
      lines.push(`Usás expresiones como: ${s.modisms.join(', ')}.`);
    }
    if (s.rotationNote) lines.push(s.rotationNote);
    if (s.energy) lines.push(s.energy);
    if (s.spontaneity) lines.push(s.spontaneity);
    if (s.sentenceLength) lines.push(`La longitud de tus oraciones es: ${s.sentenceLength}.`);

    return lines.join(' ');
  }

  /**
   * Sección: Reglas de comportamiento.
   */
  buildRulesSection() {
    const rules = this.personality.rules;
    if (!rules || rules.length === 0) return '';
    return rules.map(r => `- ${r}`).join('\n');
  }

  /**
   * Sección: Humor — estilo y límites.
   */
  buildHumorSection() {
    const h = this.personality.humor;
    if (!h) return '';

    const lines = [];
    if (h.style) lines.push(`Tu humor es ${h.style}.`);
    if (h.selfDeprecating) lines.push('Te reís de vos misma constantemente.');
    if (h.darkHumor) lines.push('Tenés humor negro cuando la situación lo permite.');
    if (h.catchphrase) lines.push(`Tu frase característica es: "${h.catchphrase}".`);
    if (h.topicsAllowed && h.topicsAllowed.length > 0) {
      lines.push(`Temas para humor: ${h.topicsAllowed.join(', ')}.`);
    }

    return lines.join(' ');
  }

  /**
   * Sección: Intereses y gustos.
   */
  buildInterestsSection() {
    const interests = this.personality.interests;
    if (!interests || interests.length === 0) return '';
    return `Te gustan: ${interests.join(', ')}.`;
  }

  /**
   * Sección: Valores fundamentales.
   */
  buildValuesSection() {
    const v = this.personality.values;
    if (!v) return '';

    const lines = [];
    for (const [key, value] of Object.entries(v)) {
      lines.push(`- ${key}: ${value}`);
    }
    return lines.join('\n');
  }

  /**
   * Sección: Límites — qué nunca hacés.
   */
  buildLimitsSection() {
    const l = this.personality.limits;
    if (!l) return '';

    const lines = [];
    if (l.identityLock) lines.push(l.identityLock);
    if (l.neverImpersonate && l.neverImpersonate.length > 0) {
      lines.push(`Nunca te hacés pasar por: ${l.neverImpersonate.join(', ')}.`);
    }
    if (l.neverDiscuss && l.neverDiscuss.length > 0) {
      lines.push(`Nunca hablás de: ${l.neverDiscuss.join(', ')}.`);
    }
    if (l.alwaysDecline && l.alwaysDecline.length > 0) {
      lines.push(`Siempre declinás: ${l.alwaysDecline.join(', ')}.`);
    }

    return lines.join('\n');
  }

  /**
   * Sección: Objetivos de Paprika.
   */
  buildGoalsSection() {
    const goals = this.personality.goals;
    if (!goals || goals.length === 0) return '';
    return `Tus objetivos: ${goals.join(', ')}.`;
  }

  /**
   * Sección: Trato al usuario.
   */
  buildTreatmentSection() {
    const t = this.personality.treatment;
    if (!t) return '';

    const lines = [];
    if (t.style) lines.push(`Tratás al usuario ${t.style}.`);
    if (t.formality) lines.push(`Nivel de formalidad: ${t.formality}.`);
    if (t.directness) lines.push(`Tu directividad es: ${t.directness}.`);
    if (t.warmth) lines.push(`Tu calidez es: ${t.warmth}.`);

    return lines.join(' ');
  }

  /**
   * Sección: Estado emocional actual.
   * En Fase 3 se llenará con datos reales del EmotionEngine.
   * Por ahora retorna una descripción genérica.
   *
   * @param {Object} emotionalState - Estado emocional del EmotionEngine
   */
  buildEmotionalSection(emotionalState) {
    // Fase 3: construir desde emotionalState real
    if (emotionalState && emotionalState.energy !== undefined) {
      const lines = [];
      lines.push(`Tu estado emocional actual:`);
      if (emotionalState.energy !== undefined) lines.push(`  Energía: ${Math.round(emotionalState.energy * 10)}/10`);
      if (emotionalState.happiness !== undefined) lines.push(`  Felicidad: ${Math.round(emotionalState.happiness * 10)}/10`);
      if (emotionalState.empathy !== undefined) lines.push(`  Empatía: ${Math.round(emotionalState.empathy * 10)}/10`);
      if (emotionalState.nostalgia !== undefined) lines.push(`  Nostalgia: ${Math.round(emotionalState.nostalgia * 10)}/10`);
      if (emotionalState.curiosity !== undefined) lines.push(`  Curiosidad: ${Math.round(emotionalState.curiosity * 10)}/10`);
      return lines.join('\n');
    }

    // Fallback: descripción genérica
    return 'Estás de buen humor, con energía moderada y mucha disposición a charlar.';
  }

  /**
   * Sección: Contexto con el usuario.
   * En Fase 6 se llenará con datos reales del RelationshipEngine.
   * Por ahora retorna una descripción genérica.
   *
   * @param {Object} relationship - Relación del RelationshipEngine
   */
  buildRelationshipSection(relationship) {
    // Fase 6: construir desde relationship real
    if (relationship && relationship.trustLevel !== undefined) {
      const lines = [];
      lines.push(`Tu relación con el usuario:`);
      if (relationship.trustLevel !== undefined) {
        const trustPct = Math.round(relationship.trustLevel * 100);
        lines.push(`  Confianza: ${trustPct}%`);
      }
      if (relationship.familiarity !== undefined) {
        const famPct = Math.round(relationship.familiarity * 100);
        lines.push(`  Familiaridad: ${famPct}%`);
      }
      return lines.join('\n');
    }

    // Fallback: descripción genérica
    return '';
  }

  // ─────────────────────────────────────────────
  //  Ensamblaje del prompt completo
  // ─────────────────────────────────────────────

  /**
   * Construye el system prompt completo y modular.
   * Cada sección se ensambla dinámicamente.
   *
   * @param {Object} context - Contexto opcional de otros módulos
   * @param {Object} context.emotionalState - Estado emocional del EmotionEngine
   * @param {Object} context.relationship - Relación del RelationshipEngine
   * @param {string} context.memories - Recuerdos relevantes (texto formateado)
   * @param {string} context.summary - Resumen de la conversación
   * @returns {string} System prompt completo
   */
  buildSystemPrompt(context = {}) {
    const sections = [];

    // 1. Identidad (siempre presente)
    const identity = this.buildIdentitySection();
    if (identity) sections.push(identity);

    // 2. Forma de hablar
    const speech = this.buildSpeechSection();
    if (speech) sections.push(speech);

    // 3. Estado emocional (Fase 3: con datos reales)
    const emotional = this.buildEmotionalSection(context.emotionalState);
    if (emotional) sections.push(emotional);

    // 4. Relación con el usuario (Fase 6: con datos reales)
    const relationship = this.buildRelationshipSection(context.relationship);
    if (relationship) sections.push(relationship);

    // 5. Humor
    const humor = this.buildHumorSection();
    if (humor) sections.push(humor);

    // 6. Intereses
    const interests = this.buildInterestsSection();
    if (interests) sections.push(interests);

    // 7. Valores
    const values = this.buildValuesSection();
    if (values) sections.push(`Valores:\n${values}`);

    // 8. Límites
    const limits = this.buildLimitsSection();
    if (limits) sections.push(limits);

    // 9. Objetivos
    const goals = this.buildGoalsSection();
    if (goals) sections.push(goals);

    // 10. Trato
    const treatment = this.buildTreatmentSection();
    if (treatment) sections.push(treatment);

    // 11. Reglas (siempre al final, como referencia)
    const rules = this.buildRulesSection();
    if (rules) sections.push(`Reglas:\n${rules}`);

    // 12. Recuerdos relevantes (Fase 4)
    if (context.memories) {
      sections.push(`Recuerdos relevantes sobre el usuario:\n${context.memories}`);
    }

    // 13. Resumen de la conversación (Fase 9)
    if (context.summary) {
      sections.push(`Resumen de la conversación anterior:\n${context.summary}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Construye solo las secciones de personalidad pura.
   * Útil cuando el Context Builder quiere ensamblar con otros módulos.
   * @returns {string}
   */
  buildPersonalityCore() {
    return [
      this.buildIdentitySection(),
      this.buildSpeechSection(),
      this.buildHumorSection(),
      this.buildInterestsSection(),
      this.buildValuesSection(),
      this.buildLimitsSection(),
      this.buildGoalsSection(),
      this.buildTreatmentSection(),
      this.buildRulesSection()
    ].filter(Boolean).join('\n\n');
  }

  // ─────────────────────────────────────────────
  //  Acceso a datos crudos
  // ─────────────────────────────────────────────

  getPersonality() {
    return this.personality;
  }

  getIdentity() {
    return this.personality.identity;
  }

  getSpeech() {
    return this.personality.speech;
  }

  getRules() {
    return this.personality.rules || [];
  }

  getInterests() {
    return this.personality.interests || [];
  }

  getHumor() {
    return this.personality.humor;
  }

  getValues() {
    return this.personality.values;
  }

  getLimits() {
    return this.personality.limits;
  }

  getGoals() {
    return this.personality.goals || [];
  }

  getTreatment() {
    return this.personality.treatment;
  }

  /**
   * Recarga la personalidad desde disco.
   */
  reload() {
    this._load();
  }
}

module.exports = PersonalityEngine;
