/**
 * EntityExtractor — Extracción de entidades desde texto libre (memorias).
 *
 * A diferencia de KnowledgeGraph.extractEntities() que opera sobre el output
 * del MessageAnalyzer, este módulo extrae entidades directamente del contenido
 * de texto de las memorias almacenadas. Permite que cada memoria generente
 * entidades automáticamente al ser almacenada.
 *
 * Tipos de entidad detectados:
 *   - person: nombres propios con contexto ("Fernando", "mi amigo Carlos")
 *   - place: ciudades, países, lugares mencionados
 *   - technology: frameworks, lenguajes, herramientas conocidas
 *   - organization: empresas, universidades
 *   - project: proyectos mencionados con contexto
 *   - goal: objetivos del usuario detectados en texto
 *
 * Consumido por:
 *   - KnowledgeGraph: enriquecimiento automático de entidades desde memorias
 *   - MemoryManager: al momento de almacenar una memoria
 */

'use strict';

// ─── Patrones de extracción ──────────────────────────────────────────

const PERSON_PATTERNS = [
  // "mi amigo Fernando", "mi novia Ana", "mi jefe Carlos"
  /\b(?:mi\s+)?(?:amigo|amiga|novio|novia|jefe|jefa|compañero|compañera|hermano|hermana|padre|madre|hijo|hija|primo|prima|tío|tía|sobrino|sobrina)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})\b/g,
  // "Fernando me dijo", "Carlos dijo que"
  /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,1})\s+(?:me\s+dijo|dijo|preguntó|me\s+pidió|me\s+cuenta|cuenta|comentó|explicó|sugirió|recomendó)/g,
  // "hablé con Fernando", "quiero hablar con Ana"
  /\b(?:habl(?:é|ar|o)|convers(?:é|ar|o)|contact(?:é|ar|o)|llam(?:é|ar|o)|escrib(?:í|ir|o))\s+con\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,1})\b/g,
  // "soy Fernando" — self-identification (lower priority)
  /\bsoy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g,
];

const PLACE_PATTERNS = [
  // "vivo en Buenos Aires", "en Córdoba", "de Rosario"
  /\b(?:vivo\s+en|en|de|desde|para|hacia|cerca\s+de|alrededor\s+de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})\b/g,
  // "Buenos Aires", "San Pablo" — city names (2+ capitalized words)
  /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g,
  // Countries
  /\b(?:Argentina|Brasil|Chile|Colombia|México|España|Estados\s+Unidos|Uruguay|Perú|Bolivia|Venezuela|Ecuador|Paraguay)\b/gi,
];

const PROJECT_PATTERNS = [
  // "mi proyecto Paprika", "el proyecto X", "trabajando en Paprika"
  /\b(?:mi\s+)?(?:proyecto|app|aplicación|sitio|página|sistema|plataforma)\s+(?:se\s+llama\s+)?(?:\"?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,3})\"?)/g,
  // "estoy trabajando en Paprika", "desarrollando X"
  /\b(?:trabajando\s+en|desarrollando|creando|construyendo|programando)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,2})\b/g,
];

const GOAL_PATTERNS = [
  // "quiero aprender React", "necesito aprender X"
  /\b(?:quiero|necesito|voy\s+a|mi\s+objetivo\s+es|mi\s+meta\s+es|planeo|pienso)\s+(?:aprender|hacer|lograr|conseguir|crear|desarrollar|mejorar|terminar)\s+(.{3,40})/gi,
];

// Stopwords que no deben ser entidades
const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'esto', 'eso', 'aquí', 'ahí', 'allí', 'muy', 'mucho', 'poco',
  'todo', 'nada', 'algo', 'alguien', 'nadie', 'siempre', 'nunca',
  'bien', 'mal', 'mejor', 'peor', 'ahora', 'antes', 'después',
  'también', 'solo', 'solamente', 'después', 'luego', 'pronto',
  'como', 'cómo', 'cuándo', 'dónde', 'quién', 'cuál', 'por qué',
  'porque', 'entonces', 'pero', 'sino', 'aunque', 'mientras',
  'si', 'caso', 'vez', 'veces', 'dia', 'día', 'días', 'ano', 'años',
  'mes', 'meses', 'hora', 'horas', 'minuto', 'minutos',
]);

class EntityExtractor {
  /**
   * @param {Object} knowledgeGraph - Instancia de KnowledgeGraph
   */
  constructor(knowledgeGraph) {
    this.kg = knowledgeGraph;
    // Reutilizar patrones de tecnologías del KnowledgeGraph
    this._techPatterns = this._buildTechPatterns();
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Extrae entidades del contenido de texto de una memoria.
   * No persiste — retorna la lista de entidades detectadas.
   *
   * @param {string} text - Contenido de la memoria
   * @param {Object} [context] - Contexto adicional (analysis output, memory type, etc.)
   * @returns {Array<{ name: string, type: string, confidence: number, source: string }>}
   */
  extractFromText(text, context = {}) {
    if (!text || text.trim().length < 5) return [];

    const entities = [];
    const seen = new Set();

    // 1. Personas
    const persons = this._extractPersons(text);
    for (const name of persons) {
      const key = `person:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: 'person', confidence: 0.6, source: 'text' });
      }
    }

    // 2. Lugares
    const places = this._extractPlaces(text);
    for (const name of places) {
      const key = `place:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: 'place', confidence: 0.5, source: 'text' });
      }
    }

    // 3. Tecnologías
    const techs = this._extractTechnologies(text);
    for (const name of techs) {
      const key = `technology:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: 'technology', confidence: 0.7, source: 'text' });
      }
    }

    // 4. Proyectos
    const projects = this._extractProjects(text);
    for (const name of projects) {
      const key = `project:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: 'project', confidence: 0.5, source: 'text' });
      }
    }

    // 5. Organizaciones
    const orgs = this.kg._extractOrganizations(text);
    for (const name of orgs) {
      const key = `organization:${name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: 'organization', confidence: 0.5, source: 'text' });
      }
    }

    // 6. Objetivos (solo si el contexto indica un goal)
    if (context.memoryType === 'goal' || context.isGoal) {
      const goals = this._extractGoals(text);
      for (const name of goals) {
        const key = `goal:${name.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ name, type: 'goal', confidence: 0.6, source: 'text' });
        }
      }
    }

    return entities;
  }

  /**
   * Extrae entidades y las persiste en el grafo.
   * Calcula peso emocional para cada entidad.
   *
   * @param {string} userId
   * @param {string} text - Contenido de la memoria
   * @param {Object} [context] - Contexto adicional
   * @returns {Promise<Array<Object>>} Entidades persistidas
   */
  async extractAndPersist(userId, text, context = {}) {
    const entities = this.extractFromText(text, context);
    const persisted = [];

    for (const entity of entities) {
      try {
        // Calculate emotional weight for this entity
        const emotionalWeight = this._calculateEntityEmotionalWeight(text, entity);

        const result = await this.kg.addEntity(userId, entity.name, entity.type, {
          source: 'memory_extractor',
          confidence: entity.confidence,
          ...context,
        }, {
          importance: entity.confidence || 0.5,
          emotionalWeight,
        });

        if (result) {
          persisted.push({ ...entity, id: result.id, emotionalWeight });
        }
      } catch (err) {
        console.error(`[EntityExtractor] Failed to persist entity "${entity.name}" (${entity.type}): ${err.message}`);
      }
    }

    return persisted;
  }

  // ─────────────────────────────────────────────
  //  Extractores internos
  // ─────────────────────────────────────────────

  /**
   * Extrae nombres de personas del texto.
   *
   * @param {string} text
   * @returns {Array<string>} Nombres normalizados
   */
  _extractPersons(text) {
    const found = [];

    for (const pattern of PERSON_PATTERNS) {
      let match;
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const name = (match[1] || '').trim();
        if (this._isValidEntityName(name)) {
          found.push(this._normalizeName(name));
        }
      }
    }

    return [...new Set(found)];
  }

  /**
   * Extrae lugares del texto.
   *
   * @param {string} text
   * @returns {Array<string>}
   */
  _extractPlaces(text) {
    const found = [];

    for (const pattern of PLACE_PATTERNS) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const name = (match[1] || match[0]).trim();
        if (this._isValidEntityName(name) && name.length > 3) {
          found.push(this._normalizeName(name));
        }
      }
    }

    return [...new Set(found)];
  }

  /**
   * Extrae tecnologías del texto.
   * Reutiliza la lógica de KnowledgeGraph pero con más cobertura.
   *
   * @param {string} text
   * @returns {Array<string>}
   */
  _extractTechnologies(text) {
    const found = new Set();

    for (const { pattern, name } of this._techPatterns) {
      if (pattern.test(text)) {
        found.add(name);
      }
    }

    return [...found];
  }

  /**
   * Extrae proyectos del texto.
   *
   * @param {string} text
   * @returns {Array<string>}
   */
  _extractProjects(text) {
    const found = [];

    for (const pattern of PROJECT_PATTERNS) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const name = (match[1] || '').trim();
        if (this._isValidEntityName(name) && name.length > 2) {
          found.push(this._normalizeName(name));
        }
      }
    }

    return [...new Set(found)];
  }

  /**
   * Extrae objetivos del texto.
   *
   * @param {string} text
   * @returns {Array<string>}
   */
  _extractGoals(text) {
    const found = [];

    for (const pattern of GOAL_PATTERNS) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const name = (match[1] || '').trim().replace(/[.,;:!?]+$/, '');
        if (name.length > 3) {
          found.push(name);
        }
      }
    }

    return [...new Set(found)];
  }

  // ─────────────────────────────────────────────
  //  Utilidades
  // ─────────────────────────────────────────────

  /**
   * Valida que un nombre de entidad sea válido.
   *
   * @param {string} name
   * @returns {boolean}
   */
  _isValidEntityName(name) {
    if (!name || name.length < 2) return false;
    const lower = name.toLowerCase();
    if (STOPWORDS.has(lower)) return false;
    if (/^\d+$/.test(name)) return false;
    if (/^[a-záéíóúñ]+$/.test(name) && name.length < 4) return false;
    return true;
  }

  /**
   * Normaliza un nombre: primera letra mayúscula, resto minúsculas.
   *
   * @param {string} name
   * @returns {string}
   */
  _normalizeName(name) {
    if (!name) return '';
    return name
      .trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Construye patrones de tecnologías para extracción rápida.
   *
   * @returns {Array<{ pattern: RegExp, name: string }>}
   */
  _buildTechPatterns() {
    const techs = [
      'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Nuxt',
      'Python', 'JavaScript', 'TypeScript', 'Java', 'C++', 'Rust', 'Go', 'Ruby', 'PHP', 'Swift', 'Kotlin',
      'Node.js', 'Deno', 'Bun', 'Express', 'Fastify', 'NestJS',
      'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'SQLite', 'Supabase', 'Firebase',
      'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Vercel', 'Netlify',
      'Git', 'GitHub', 'GitLab', 'Bitbucket',
      'Tailwind', 'Bootstrap', 'Material UI', 'Chakra',
      'OpenAI', 'Gemini', 'Claude', 'Ollama', 'HuggingFace',
      'FastEmbed', 'SQLite', 'better-sqlite3',
    ];

    return techs.map(name => ({
      pattern: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      name,
    }));
  }

  /**
   * Calculates emotional weight for an entity based on surrounding text.
   * Positive emotions increase weight, negative emotions decrease it.
   *
   * @param {string} text - Full text context
   * @param {Object} entity - Entity being extracted
   * @returns {number} -1 to 1
   */
  _calculateEntityEmotionalWeight(text, entity) {
    const emotionalWords = {
      positive: ['amor', 'alegría', 'felicidad', 'éxito', 'orgullo', 'entusiasmo', 'pasión', 'gratitud', 'esperanza', 'inspiración', 'genial', 'increíble', 'fantástico', 'excelente', 'perfecto'],
      negative: ['tristeza', 'enojo', 'frustración', 'miedo', 'ansiedad', 'preocupación', 'decepción', 'soledad', 'culpa', 'arrepentimiento', 'terrible', 'horrible', 'peor', 'odio', 'problema'],
    };

    const lowerText = text.toLowerCase();
    let score = 0;

    // Check for emotional words near the entity name
    for (const word of emotionalWords.positive) {
      if (lowerText.includes(word)) score += 0.1;
    }
    for (const word of emotionalWords.negative) {
      if (lowerText.includes(word)) score -= 0.1;
    }

    // Boost for personal relationships
    if (entity.type === 'person') {
      const relationshipWords = ['amigo', 'amiga', 'novio', 'novia', 'familia', 'hermano', 'padre'];
      if (relationshipWords.some(w => lowerText.includes(w))) {
        score += 0.2;
      }
    }

    return Math.min(Math.max(score, -1), 1);
  }
}

module.exports = EntityExtractor;
