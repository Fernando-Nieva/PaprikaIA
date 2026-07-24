/**
 * MemoryClassifier — Clasificador de recuerdos
 *
 * Transforma el análisis del Analyzer en recuerdos estructurados.
 * Decide si un recuerdo es nuevo, actualiza uno existente o debe descartarse.
 *
 * Categorías de memoria:
 * - preference: gustos, preferencias del usuario
 * - relationship: información sobre personas cercanas al usuario
 * - person: nombres, datos de personas
 * - project: proyectos, archivos, trabajo
 * - goal: objetivos, metas del usuario
 * - date: fechas importantes, eventos futuros
 * - personal_data: datos personales (nombre, edad, ubicación)
 * - experience: experiencias vividas, anécdotas
 * - event: eventos, situaciones
 *
 * Flujo:
 * 1. Recibe análisis del Analyzer
 * 2. Clasifica la información en categorías
 * 3. Decide acción: new | update | discard
 * 4. Genera recuerdos estructurados para MemoryManager
 *
 * El MemoryClassifier NO almacena — solo clasifica y estructura.
 * El MemoryManager se encarga del almacenamiento.
 */

const MEMORY_CATEGORIES = {
  preference: {
    label: 'preferencia',
    patterns: [
      /me\s+(gusta|encanta|amo|adoro)\s+/i,
      /no\s+me\s+(gusta|gustan|encanta|gusta)\s+/i,
      /odio\s+/i,
      /mi\s+(color|comida|pelicula|cancion|artista|genero)\s+(favorito|favorita|favoritos|favoritas)\s+es/i,
      /prefiero\s+/i,
      /me\s+quedo\s+con\s+/i
    ],
    extractFrom: ['me gusta', 'me encanta', 'amo', 'odio', 'prefiero', 'mi favorito']
  },

  person: {
    label: 'persona',
    patterns: [
      /me\s+llamo\s+(\w+)/i,
      /soy\s+(\w+)/i,
      /mi\s+(amigo|amiga|novio|novia|esposo|esposa|hermano|hermana|mamá|papá|abuelo|abuela|hijo|hija)\s+(se|llama|es)\s+(\w+)/i,
      /hablé\s+con\s+(\w+)/i,
      /conocí\s+a\s+(\w+)/i
    ],
    extractFrom: ['me llamo', 'soy', 'mi amigo', 'hablé con', 'conocí a']
  },

  relationship: {
    label: 'relación',
    patterns: [
      /mi\s+(amigo|amiga|novio|novia|esposo|esposa|hermano|hermana|mamá|papá)\s+/i,
      /(ella|él)\s+es\s+muy\s+/i,
      /la\s+relación\s+con\s+/i,
      /nos\s+(lleamos|llevamos|va|va bien|va mal)/i
    ],
    extractFrom: ['mi amigo', 'ella es', 'la relación']
  },

  personal_data: {
    label: 'dato personal',
    patterns: [
      /me\s+llamo\s+(\w+)/i,
      /tengo\s+(\d+)\s+años/i,
      /vivo\s+en\s+(\w+)/i,
      /soy\s+de\s+(\w+)/i,
      /nací\s+en\s+/i,
      /trabajo\s+en\s+/i,
      /estudio\s+en\s+/i,
      /mi\s+(email|telefono|celular|dirección)\s+es/i
    ],
    extractFrom: ['me llamo', 'tengo ... años', 'vivo en', 'soy de']
  },

  project: {
    label: 'proyecto',
    patterns: [
      /estoy\s+(trabajando|haciendo|creando|desarrollando)\s+en\s+/i,
      /mi\s+proyecto\s+/i,
      /el\s+proyecto\s+/i,
      /la\s+app\s+/i,
      /el\s+sitio\s+web\s+/i,
      /el\s+programa\s+/i,
      /necesito\s+(hacer|crear|desarrollar)\s+/i
    ],
    extractFrom: ['estoy trabajando', 'mi proyecto', 'el proyecto']
  },

  goal: {
    label: 'objetivo',
    patterns: [
      /quiero\s+(hacer|aprender|conseguir|lograr|obtener|tener)/i,
      /necesito\s+(hacer|aprender|conseguir|lograr)/i,
      /mi\s+objetivo\s+es/i,
      /mi\s+meta\s+es/i,
      /voy\s+a\s+(hacer|aprender|conseguir|lograr)/i,
      /planeo\s+(hacer|aprender|conseguir)/i,
      /soñar?\s+con\s+/i
    ],
    extractFrom: ['quiero', 'necesito', 'mi objetivo', 'mi meta', 'voy a']
  },

  date: {
    label: 'fecha',
    patterns: [
      /el\s+(\d{1,2})\s+de\s+(\w+)/i,
      /mañana\s+/i,
      /la\s+semana\s+(que\s+vienne|pasada|entrante)/i,
      /el\s+(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\s+(que\s+vienne|pasado)/i,
      /en\s+(\w+)\s+(vienne|pasado)/i,
      /cumpleaños\s+de\s+/i,
      /aniversario\s+/i
    ],
    extractFrom: ['el ... de', 'mañana', 'la semana', 'cumpleaños']
  },

  experience: {
    label: 'experiencia',
    patterns: [
      /ayer\s+/i,
      /hoy\s+(me\s+pasó|sucedió|ocurrió|experimenté)/i,
      /una\s+vez\s+/i,
      /me\s+acuerdo\s+de\s+cuando/i,
      /la\s+vez\s+pasada\s+/i,
      /tengo\s+una\s+historia/i,
      /te\s+cuento\s+/i,
      /me\s+paso\s+/i
    ],
    extractFrom: ['ayer', 'me pasó', 'una vez', 'me acuerdo']
  },

  event: {
    label: 'evento',
    patterns: [
      /hay\s+(un|una)\s+(evento|fiesta|reunión|encuentro|show|concierto)/i,
      /voy\s+a\s+(ir|asistir|ir\s+a)/i,
      /el\s+(próximo|siguiente)\s+(evento|fiesta|reunión)/i,
      /se\s+(viene|acerca)\s+el\s+/i,
      /es\s+(mi|el)\s+(cumpleaños|aniversario)/i
    ],
    extractFrom: ['hay un evento', 'voy a ir', 'se viene']
  }
};

// Umbrales de decisión
const DECISION_THRESHOLDS = {
  minConfidence: 0.4,      // Confianza mínima del Analyzer para considerar guardado
  minImportance: 0.4,      // Importancia mínima para recordar
  updateSimilarity: 0.7,   // Similitud para considerar que un recuerdo se actualiza
  highConfidence: 0.7      // Alta confianza = guardado directo
};

class MemoryClassifier {
  /**
   * @param {CoreConfig} config - Configuración centralizada
   * @param {MemoryManager} memoryManager - Para buscar recuerdos existentes
   */
  constructor(config, memoryManager) {
    this.config = config;
    this.memoryManager = memoryManager;
  }

  /**
   * Clasifica el análisis y retorna recuerdos estructurados.
   *
   * @param {Object} analysis - Output del MessageAnalyzer
   * @param {string} userId - ID del usuario
   * @returns {Object} { memories: Array, discarded: Array, reasoning: string }
   */
  classify(analysis, userId) {
    const result = {
      memories: [],
      discarded: [],
      reasoning: ''
    };

    // Si la confianza es muy baja, descartar
    if (analysis.confidence < DECISION_THRESHOLDS.minConfidence) {
      result.discarded.push({
        content: analysis.rawMessage,
        reason: `Confianza muy baja (${analysis.confidence} < ${DECISION_THRESHOLDS.minConfidence})`
      });
      result.reasoning = `Confianza ${analysis.confidence} por debajo del umbral ${DECISION_THRESHOLDS.minConfidence}`;
      return result;
    }

    // Extract implicit identity FIRST — identity info must always be stored
    // even if the overall message importance is low (e.g., "Soy Fernando")
    const implicitPersonal = this._extractImplicitIdentity(analysis.rawMessage, analysis);

    // Si la importancia es muy baja, descartar (PERO solo si no hay info de identidad)
    if (analysis.importance < DECISION_THRESHOLDS.minImportance && !implicitPersonal) {
      result.discarded.push({
        content: analysis.rawMessage,
        reason: `Importancia muy baja (${analysis.importance} < ${DECISION_THRESHOLDS.minImportance})`
      });
      result.reasoning = `Importancia ${analysis.importance} por debajo del umbral ${DECISION_THRESHOLDS.minImportance}`;
      return result;
    }

    // Clasificar en categorías
    const candidates = this._extractCandidates(analysis);

    // Add implicit identity candidate if found
    if (implicitPersonal) {
      implicitPersonal._isImplicit = true;
      candidates.unshift(implicitPersonal);
    }

    // Para cada candidato, decidir: new | update | discard
    for (const candidate of candidates) {
      // Skip person/personal_data categories from explicit patterns
      // if implicit identity was already extracted (avoid duplicates)
      if (implicitPersonal && !candidate._isImplicit &&
          (candidate.category === 'person' || candidate.category === 'personal_data')) {
        continue;
      }
      const decision = this._makeDecision(candidate, analysis, userId);

      if (decision.action === 'discard') {
        result.discarded.push({
          ...candidate,
          reason: decision.reason
        });
      } else {
        result.memories.push({
          ...candidate,
          action: decision.action,
          existingId: decision.existingId || null
        });
      }
    }

    // Generar reasoning
    result.reasoning = this._generateReasoning(candidates, result.memories, result.discarded);

    return result;
  }

  /**
   * Extrae candidatos a memoria del análisis.
   */
  _extractCandidates(analysis) {
    const candidates = [];
    const message = analysis.rawMessage;
    const lower = message.toLowerCase();

    // Verificar cada categoría
    for (const [category, config] of Object.entries(MEMORY_CATEGORIES)) {
      for (const pattern of config.patterns) {
        if (pattern.test(message)) {
          // Extraer contenido relevante
          const content = this._extractContent(message, lower, category, analysis);

          if (content) {
            candidates.push({
              category,
              categoryLabel: config.label,
              content,
              rawMessage: message,
              importance: analysis.importance,
              confidence: analysis.confidence,
              topic: analysis.topic,
              entities: analysis.entities
            });
          }

          // Un candidato por categoría (la primera coincidencia)
          break;
        }
      }
    }

    // Si no se detectó ninguna categoría, buscar entidades genéricas
    if (candidates.length === 0) {
      if (analysis.entities.people.length > 0) {
        for (const person of analysis.entities.people) {
          candidates.push({
            category: 'person',
            categoryLabel: 'persona',
            content: `Persona mencionada: ${person}`,
            rawMessage: message,
            importance: analysis.importance,
            confidence: analysis.confidence,
            topic: analysis.topic,
            entities: analysis.entities
          });
        }
      }

      if (analysis.entities.projects.length > 0) {
        for (const project of analysis.entities.projects) {
          candidates.push({
            category: 'project',
            categoryLabel: 'proyecto',
            content: `Proyecto/archivo mencionado: ${project}`,
            rawMessage: message,
            importance: analysis.importance,
            confidence: analysis.confidence,
            topic: analysis.topic,
            entities: analysis.entities
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Detecta información implícita del usuario en el mensaje.
   * Captura patrones que el usuario dice sobre sí mismo sin un patrón explícito.
   *
   * @param {string} message - Mensaje original
   * @param {Object} analysis - Análisis del Analyzer
   * @returns {Object|null} Candidato a memoria o null
   */
  _extractImplicitIdentity(message, analysis) {
    const lower = message.toLowerCase();

    // Self-introduction patterns (variations of "soy X")
    const soyMatch = message.match(/\bsoy\s+(\w+(?:\s+\w+)?)\b/i);
    if (soyMatch) {
      const name = soyMatch[1].trim();
      // Filter out common false positives
      const falsePositives = ['yo', 'el', 'ella', 'tu', 'usted', 'nosotros', 'ellos'];
      if (!falsePositives.includes(name.toLowerCase())) {
        return {
          category: 'personal_data',
          categoryLabel: 'dato personal',
          content: `El usuario se identifica como: ${name}`,
          rawMessage: message,
          importance: Math.max(analysis.importance, 0.8),
          confidence: Math.max(analysis.confidence, 0.7),
          topic: analysis.topic,
          entities: analysis.entities
        };
      }
    }

    // "Dime quien soy" / "Quien soy" / self-identity questions
    if (/\b(dime\s+quien\s+soy|quien\s+soy|como\s+me\s+llamo|sabes\s+quien\s+soy)\b/i.test(lower)) {
      return {
        category: 'personal_data',
        categoryLabel: 'dato personal',
        content: `El usuario pregunta sobre su propia identidad: "${message.substring(0, 100)}"`,
        rawMessage: message,
        importance: Math.max(analysis.importance, 0.7),
        confidence: Math.max(analysis.confidence, 0.6),
        topic: analysis.topic,
        entities: analysis.entities
      };
    }

    // User says their name with context ("Tuya", "Fernando", etc.)
    // Check if the message contains what looks like a self-reference with a name
    const namePatterns = [
      /\b(?:me\s+llamo|soy|mi\s+nombre\s+es|a\s+mi\s+llaman)\s+(\w+)/i,
      /\b(?:hola\s+soy|hey\s+soy|buenas\s+soy)\s+(\w+)/i,
    ];
    for (const pattern of namePatterns) {
      const match = message.match(pattern);
      if (match) {
        return {
          category: 'personal_data',
          categoryLabel: 'dato personal',
          content: `Nombre del usuario: ${match[1]}`,
          rawMessage: message,
          importance: Math.max(analysis.importance, 0.85),
          confidence: Math.max(analysis.confidence, 0.75),
          topic: analysis.topic,
          entities: analysis.entities
        };
      }
    }

    // User asking Paprika to remember something about them
    if (/\b(recuerda|acordate|guarda|no\s+olvides|importante\s+que)\b/i.test(lower)) {
      return {
        category: 'personal_data',
        categoryLabel: 'dato personal',
        content: `Usuario pide recordar: "${message.substring(0, 100)}"`,
        rawMessage: message,
        importance: Math.max(analysis.importance, 0.8),
        confidence: Math.max(analysis.confidence, 0.7),
        topic: analysis.topic,
        entities: analysis.entities
      };
    }

    return null;
  }

  /**
   * Extrae el contenido relevante para una categoría.
   */
  _extractContent(message, lower, category, analysis) {
    switch (category) {
      case 'preference': {
        const match = message.match(/(?:me\s+(?:gusta|encanta|amo|adoro|odio))\s+(.+)/i);
        if (match) return `Le gusta: ${match[1].trim()}`;
        const prefMatch = message.match(/prefiero\s+(.+)/i);
        if (prefMatch) return `Prefiere: ${prefMatch[1].trim()}`;
        return null;
      }

      case 'personal_data': {
        const nameMatch = message.match(/me\s+llamo\s+(\w+)/i);
        if (nameMatch) return `Se llama: ${nameMatch[1]}`;
        const ageMatch = message.match(/tengo\s+(\d+)\s+años/i);
        if (ageMatch) return `Tiene ${ageMatch[1]} años`;
        const placeMatch = message.match(/vivo\s+en\s+(.+)/i);
        if (placeMatch) return `Vive en: ${placeMatch[1].trim()}`;
        const fromMatch = message.match(/soy\s+de\s+(.+)/i);
        if (fromMatch) return `Es de: ${fromMatch[1].trim()}`;
        return null;
      }

      case 'person': {
        const nameMatch = message.match(/(?:me\s+llamo|soy)\s+(\w+)/i);
        if (nameMatch) return `Nombre: ${nameMatch[1]}`;
        const friendMatch = message.match(/(?:mi\s+(?:amigo|amiga))\s+(?:se\s+llama\s+)?(\w+)/i);
        if (friendMatch) return `Amigo/a: ${friendMatch[1]}`;
        const talkMatch = message.match(/hablé\s+con\s+(\w+)/i);
        if (talkMatch) return `Habló con: ${talkMatch[1]}`;
        return null;
      }

      case 'goal': {
        const wantMatch = message.match(/quiero\s+(.+)/i);
        if (wantMatch) return `Quiere: ${wantMatch[1].trim()}`;
        const needMatch = message.match(/necesito\s+(.+)/i);
        if (needMatch) return `Necesita: ${needMatch[1].trim()}`;
        const goalMatch = message.match(/(?:mi\s+(?:objetivo|meta)\s+es)\s+(.+)/i);
        if (goalMatch) return `Objetivo: ${goalMatch[1].trim()}`;
        return null;
      }

      case 'project': {
        const projMatch = message.match(/(?:estoy\s+(?:trabajando|haciendo|creando)\s+(?:en\s+)?)?(.+?)(?:\.|$)/i);
        if (projMatch) return `Proyecto: ${projMatch[1].trim()}`;
        return null;
      }

      case 'date': {
        const dateMatch = message.match(/(?:el\s+)?(\d{1,2}\s+de\s+\w+)/i);
        if (dateMatch) return `Fecha: ${dateMatch[1]}`;
        const whenMatch = message.match(/(mañana|la\s+semana\s+(?:que\s+vienne|pasada))/i);
        if (whenMatch) return `Cuándo: ${whenMatch[1]}`;
        return null;
      }

      case 'experience': {
        const expMatch = message.match(/(?:ayer|me\s+paso|me\s+paso|una\s+vez)\s+(.+)/i);
        if (expMatch) return `Experiencia: ${expMatch[1].trim()}`;
        return `Experiencia relatada: ${message.substring(0, 100)}`;
      }

      case 'event': {
        const eventMatch = message.match(/(?:hay\s+(?:un|una)\s+)?(evento|fiesta|reunión|show|concierto)\s*(.*)/i);
        if (eventMatch) return `Evento: ${eventMatch[1]} ${eventMatch[2] || ''}`.trim();
        return null;
      }

      case 'relationship': {
        const relMatch = message.match(/(?:mi\s+)?(amigo|amiga|novio|novia|esposo|esposa|hermano|hermana|mamá|papá)\s+(.+)/i);
        if (relMatch) return `${relMatch[1]}: ${relMatch[2].trim()}`;
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Decide si un candidato es nuevo, actualiza uno existente, o se descarta.
   *
   * @param {Object} candidate - Candidato a memoria
   * @param {Object} analysis - Análisis completo
   * @param {string} userId - ID del usuario
   * @returns {Object} { action: 'new'|'update'|'discard', existingId?, reason? }
   */
  _makeDecision(candidate, analysis, userId) {
    // Buscar recuerdos existentes similares
    let existingMemories = this.memoryManager.searchByContent(candidate.content, userId);

    // For identity categories, also search by category to catch similar info
    // (e.g., "El usuario se identifica como: Fernando" vs "Nombre: Fernando")
    if (existingMemories.length === 0 &&
        (candidate.category === 'personal_data' || candidate.category === 'person')) {
      const categoryMemories = this.memoryManager.getByCategory(userId, candidate.category);
      existingMemories = categoryMemories;
    }

    if (existingMemories.length === 0) {
      return {
        action: 'new',
        reason: 'No existe recuerdo similar'
      };
    }

    // Verificar si hay un recuerdo muy similar
    for (const existing of existingMemories) {
      const similarity = this._calculateSimilarity(candidate.content, existing.content);

      // For identity categories, also check if names match (lower threshold)
      const nameMatch = this._namesMatch(candidate.content, existing.content);
      const isSimilar = similarity > DECISION_THRESHOLDS.updateSimilarity || nameMatch;

      if (isSimilar) {
        // Asegurar que confidence sean números válidos
        const existingConf = typeof existing.confidence === 'number' ? existing.confidence : 0;
        const existingImp = typeof existing.importance === 'number' ? existing.importance : 0;

        // Actualizar si la confianza del nuevo análisis es mayor o igual
        // For identity, always update with the latest info
        if (candidate.category === 'personal_data' || candidate.category === 'person' ||
            (analysis.confidence >= existingConf && analysis.importance >= existingImp)) {
          return {
            action: 'update',
            existingId: existing.id,
            reason: nameMatch ? 'Nombre coincide, actualizando' : `Similaridad ${similarity.toFixed(2)}`
          };
        } else {
          return {
            action: 'discard',
            reason: `Similaridad ${similarity.toFixed(2)}, recuerdo existente tiene mayor confianza/importancia`
          };
        }
      }
    }

    // Si hay recuerdos parcialmente similares pero no lo suficiente, crear nuevo
    return {
      action: 'new',
      reason: 'Recuerdos existentes no son lo suficientemente similares'
    };
  }

  /**
   * Check if two memory contents refer to the same person's name.
   * Handles variations like "El usuario se identifica como: Fernando" vs "Nombre: Fernando".
   */
  _namesMatch(content1, content2) {
    const extractName = (text) => {
      const match = text.match(/(?:identifica como|Nombre(?: del usuario)?:|Se llama:|llaman:)\s*(\w+)/i);
      return match ? match[1].toLowerCase() : null;
    };
    const name1 = extractName(content1);
    const name2 = extractName(content2);
    return name1 && name2 && name1 === name2;
  }

  /**
   * Calcula similitud básica entre dos textos (Jaccard simplificado).
   */
  _calculateSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Genera un reasoning del proceso de clasificación.
   */
  _generateReasoning(candidates, memories, discarded) {
    const parts = [];

    if (candidates.length === 0) {
      parts.push('No se detectaron candidatos a memoria');
    } else {
      parts.push(`${candidates.length} candidato(s) detectado(s)`);

      if (memories.length > 0) {
        const newMemories = memories.filter(m => m.action === 'new');
        const updatedMemories = memories.filter(m => m.action === 'update');
        if (newMemories.length > 0) parts.push(`${newMemories.length} nuevo(s)`);
        if (updatedMemories.length > 0) parts.push(`${updatedMemories.length} actualizado(s)`);
      }

      if (discarded.length > 0) {
        parts.push(`${discarded.length} descartado(s)`);
      }
    }

    return parts.join(', ');
  }
}

module.exports = MemoryClassifier;
