/**
 * GraphRetriever — Recuperación de subgrafos relevantes para contexto.
 *
 * Dado un query o una entidad, recupera el subgrafo relevante del KnowledgeGraph
 * y lo formatea para inyectar en el system prompt. A diferencia de
 * KnowledgeGraph.getEntitiesByUser() que retorna entidades aisladas,
 * GraphRetriever retorna entidades CON sus relaciones, formando un grafo
 * coherente que mejora el razonamiento del modelo de IA.
 *
 * ¿Cómo el grafo mejora el razonamiento?
 *
 *   Sin grafo:  "Fernando usa React" (memoria aislada)
 *   Con grafo:  Fernando → usa → React
 *               Fernando → desarrolla → Paprika
 *               Paprika → utiliza → Groq
 *               Paprika → utiliza → Gemini
 *               Fernando → trabaja_en → [organización]
 *
 *   Esto permite al modelo inferir:
 *   - Fernando es desarrollador full-stack
 *   - Paprika depende de proveedores de IA
 *   - Si Groq falla, Gemini es el fallback
 *
 * Consumido por:
 *   - Pipeline (Step 7): enriquece contexto pre-response
 *   - PromptComposer: sección [KNOWLEDGE] mejorada con relaciones
 */

'use strict';

const DEFAULT_CONFIG = {
  maxEntities: 15,         // Máximo de entidades centrales
  maxRelations: 30,        // Máximo de relaciones a mostrar
  traversalDepth: 2,       // Profundidad de BFS para vecinos
  minConfidence: 0.3,      // Confianza mínima de relaciones
  minWeight: 0.2,          // Peso mínimo de relaciones
  contextTokenBudget: 400, // Presupuesto de tokens para el grafo
  useSemanticMatching: true, // Usar embeddings para matching semántico
  temporalFilter: null,     // Filtrar por tipo temporal: 'past', 'present', 'future', null=todos
};

class GraphRetriever {
  /**
   * @param {Object} knowledgeGraph - Instancia de KnowledgeGraph
   * @param {Object} db - Capa de base de datos (db.js)
   * @param {Object} [config={}] - Configuración
   * @param {Object} [embeddingService] - MemoryEmbeddingService (opcional)
   */
  constructor(knowledgeGraph, db, config = {}, embeddingService = null) {
    this.kg = knowledgeGraph;
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embedding = embeddingService;
    this._cache = null;
  }

  /**
   * Inyecta PipelineCache para evitar queries redundantes por request.
   * @param {Object} cache - Instancia de PipelineCache
   */
  setCache(cache) {
    this._cache = cache;
  }

  // ─────────────────────────────────────────────
  //  API pública
  // ─────────────────────────────────────────────

  /**
   * Recupera el subgrafo relevante para un query dado.
   * Busca entidades relacionadas con el query y sus vecinos.
   *
   * @param {string} query - Texto del mensaje del usuario
   * @param {string} userId
   * @param {Object} [options]
   * @param {number}  [options.limit] - Máximo de entidades
   * @param {number}  [options.depth] - Profundidad de traversión
   * @param {string}  [options.focusType] - Tipo de entidad a priorizar
   * @param {string}  [options.temporalType] - Filtrar por tipo temporal
   * @returns {{ entities: Array, relations: Array, connections: Array }}
   */
  retrieve(query, userId, options = {}) {
    const limit = options.limit || this.config.maxEntities;
    const depth = options.depth || this.config.traversalDepth;
    const temporalFilter = options.temporalType || this.config.temporalFilter;

    // 1. Buscar entidades que matcheen el query
    const matchedEntities = this._findMatchingEntities(query, userId, limit);

    if (matchedEntities.length === 0) {
      return { entities: [], relations: [], connections: [] };
    }

    // 2. Traversar vecinos (BFS de profundidad limitada)
    const allEntityIds = new Set(matchedEntities.map(e => e.id));
    const allRelations = [];

    for (const entity of matchedEntities) {
      const { entities: neighbors, relations } = this._getNeighbors(entity.id, userId, depth);
      for (const n of neighbors) {
        if (allEntityIds.size < limit * 2) {
          allEntityIds.add(n.id);
        }
      }
      allRelations.push(...relations);
    }

    // 3. Deduplicar y filtrar relaciones por confianza y peso
    let uniqueRelations = this._deduplicateRelations(allRelations)
      .filter(r => r.confidence >= this.config.minConfidence)
      .filter(r => (r.weight || 0.5) >= this.config.minWeight);

    // Apply temporal filter if specified
    if (temporalFilter) {
      uniqueRelations = uniqueRelations.filter(r => r.temporal_type === temporalFilter);
    }

    // Sort by composite weight (confidence * weight)
    uniqueRelations.sort((a, b) => {
      const weightA = (a.confidence || 0.5) * (a.weight || 0.5);
      const weightB = (b.confidence || 0.5) * (b.weight || 0.5);
      return weightB - weightA;
    });

    uniqueRelations = uniqueRelations.slice(0, this.config.maxRelations);

    // 4. Recuperar todas las entidades involucradas
    const allEntities = this._getEntitiesByIds([...allEntityIds], userId);

    // 5. Priorizar: entidades del query primero, luego por peso compuesto
    const prioritized = this._prioritizeEntities(allEntities, uniqueRelations, matchedEntities);

    // 6. Construir conexiones formateadas
    const connections = this._buildConnections(prioritized, uniqueRelations);

    return {
      entities: prioritized.slice(0, limit),
      relations: uniqueRelations,
      connections,
    };
  }

  // ─────────────────────────────────────────────
  //  Búsqueda de entidades
  // ─────────────────────────────────────────────

  /**
   * Busca entidades que coincidan con el query.
   * Combina búsqueda por nombre (substring), por tipo, y semántica (embeddings).
   *
   * @param {string} query
   * @param {string} userId
   * @param {number} limit
   * @returns {Array<Object>} Entidades ordenadas por relevancia
   */
  _findMatchingEntities(query, userId, limit) {
    const cacheKey = `kg:entities:${userId}`;
    const allEntities = this._cache
      ? this._cache.getOrSet(cacheKey, () => this.db.getEntitiesByUser(userId, 500))
      : this.db.getEntitiesByUser(userId, 500);
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = [];

    for (const entity of allEntities) {
      let score = 0;
      const nameLower = entity.name.toLowerCase();

      // Match exacto del nombre
      if (queryLower.includes(nameLower)) {
        score += 10;
      }

      // Match parcial de palabras
      for (const word of queryWords) {
        if (nameLower.includes(word)) {
          score += 3;
        }
      }

      // Bonus por importancia (frecuencia + importancia base)
      const importance = entity.importance || 0.5;
      const frequency = entity.frequency || 1;
      const frequencyBonus = Math.min(frequency * 0.1, 2); // Max +2
      score += importance + frequencyBonus;

      // Bonus por peso emocional (entidades emocionales son más relevantes)
      const emotionalWeight = Math.abs(entity.emotional_weight || 0);
      score += emotionalWeight * 2;

      if (score > 0) {
        scored.push({
          ...entity,
          metadata: this.kg._parseMetadata(entity.metadata),
          _matchScore: score,
        });
      }
    }

    // Semantic matching using embeddings if available
    if (this.config.useSemanticMatching && this.embedding && this.embedding.isAvailable()) {
      this._semanticMatch(query, scored, allEntities);
    }

    // Ordenar por score de match
    scored.sort((a, b) => b._matchScore - a._matchScore);

    return scored.slice(0, limit);
  }

  /**
   * Enhances entity scores using embedding similarity.
   * NOTE: Currently a no-op because retriever is sync and embedding generation is async.
   * TODO: Make retriever async to enable full semantic matching.
   *
   * @param {string} query
   * @param {Array} scored - Entities with _matchScore
   * @param {Array} allEntities - All entities from DB
   */
  _semanticMatch(query, scored, allEntities) {
    // Semantic matching requires async embedding generation.
    // Since retriever is sync, we rely on text matching which is already quite good.
  }

  // ─────────────────────────────────────────────
  //  Traversión del grafo
  // ─────────────────────────────────────────────

  /**
   * Obtiene los vecinos de una entidad (BFS de profundidad limitada).
   *
   * @param {number} entityId
   * @param {string} userId
   * @param {number} depth
   * @returns {{ entities: Array, relations: Array }}
   */
  _getNeighbors(entityId, userId, depth) {
    const visited = new Set([entityId]);
    const resultEntities = [];
    const resultRelations = [];

    let frontier = [entityId];

    for (let d = 0; d < depth; d++) {
      const nextFrontier = [];

      for (const currentId of frontier) {
        const cacheKey = `kg:relations:${currentId}`;
        const relations = this._cache
          ? this._cache.getOrSet(cacheKey, () => this.db.getRelationsForEntity(currentId) || [])
          : this.db.getRelationsForEntity(currentId) || [];

        for (const rel of relations) {
          const neighborId = rel.source_entity_id === currentId
            ? rel.target_entity_id
            : rel.source_entity_id;

          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push(neighborId);
            resultEntities.push({ id: neighborId });

            resultRelations.push({
              source_id: rel.source_entity_id,
              source_name: rel.source_name,
              source_type: rel.source_type,
              target_id: rel.target_entity_id,
              target_name: rel.target_name,
              target_type: rel.target_type,
              relation_type: rel.relation_type,
              confidence: rel.confidence || 0.5,
              weight: rel.weight || 0.5,
              temporal_type: rel.temporal_type || 'present',
              mention_count: rel.mention_count || 1,
            });
          }
        }
      }

      frontier = nextFrontier;
    }

    return { entities: resultEntities, relations: resultRelations };
  }

  /**
   * Recupera entidades completas por sus IDs.
   *
   * @param {Array<number>} ids
   * @param {string} userId
   * @returns {Array<Object>}
   */
  _getEntitiesByIds(ids, userId) {
    if (ids.length === 0) return [];

    const cacheKey = `kg:entities:${userId}`;
    const allEntities = this._cache
      ? this._cache.getOrSet(cacheKey, () => this.db.getEntitiesByUser(userId, 1000))
      : this.db.getEntitiesByUser(userId, 1000);
    const idSet = new Set(ids);

    return allEntities
      .filter(e => idSet.has(e.id))
      .map(e => ({
        ...e,
        metadata: this.kg._parseMetadata(e.metadata),
      }));
  }

  // ─────────────────────────────────────────────
  //  Formateo
  // ─────────────────────────────────────────────

  /**
   * Prioriza entidades: las del query primero, luego por peso compuesto.
   *
   * @param {Array} entities
   * @param {Array} relations
   * @param {Array} queryEntities - Entidades que matchearon el query
   * @returns {Array} Entidades priorizadas
   */
  _prioritizeEntities(entities, relations, queryEntities) {
    const queryIds = new Set(queryEntities.map(e => e.id));

    // Calcular peso compuesto por entidad
    const entityWeights = new Map();
    for (const r of relations) {
      const relWeight = (r.confidence || 0.5) * (r.weight || 0.5);

      // Accumulate weight for both source and target
      const sourceCurrent = entityWeights.get(r.source_id) || 0;
      entityWeights.set(r.source_id, sourceCurrent + relWeight);

      const targetCurrent = entityWeights.get(r.target_id) || 0;
      entityWeights.set(r.target_id, targetCurrent + relWeight);
    }

    return entities.sort((a, b) => {
      // Primero: entidades del query
      const aIsQuery = queryIds.has(a.id) ? 1 : 0;
      const bIsQuery = queryIds.has(b.id) ? 1 : 0;
      if (aIsQuery !== bIsQuery) return bIsQuery - aIsQuery;

      // Después: por peso compuesto (relaciones * importancia * frecuencia)
      const aWeight = (entityWeights.get(a.id) || 0) * (a.importance || 0.5) * Math.min((a.frequency || 1) * 0.2, 2);
      const bWeight = (entityWeights.get(b.id) || 0) * (b.importance || 0.5) * Math.min((b.frequency || 1) * 0.2, 2);

      // Bonus por peso emocional
      const aEmotional = Math.abs(a.emotional_weight || 0) * 2;
      const bEmotional = Math.abs(b.emotional_weight || 0) * 2;

      return (bWeight + bEmotional) - (aWeight + aEmotional);
    });
  }

  /**
   * Deduplica relaciones (mismo source+target+type).
   *
   * @param {Array} relations
   * @returns {Array}
   */
  _deduplicateRelations(relations) {
    const seen = new Map();

    for (const r of relations) {
      const key = `${r.source_id}:${r.target_id}:${r.relation_type}`;
      const reverseKey = `${r.target_id}:${r.source_id}:${r.relation_type}`;

      if (!seen.has(key) && !seen.has(reverseKey)) {
        seen.set(key, r);
      } else {
        // Mantener la de mayor peso compuesto
        const existing = seen.get(key) || seen.get(reverseKey);
        if (existing) {
          const existingWeight = (existing.confidence || 0.5) * (existing.weight || 0.5);
          const newWeight = (r.confidence || 0.5) * (r.weight || 0.5);
          if (newWeight > existingWeight) {
            seen.set(key, r);
          }
        }
      }
    }

    return [...seen.values()];
  }

  /**
   * Construye conexiones formateadas para el prompt.
   * Formato: "Fernando → usa → React [0.8]"
   * Incluye peso y tipo temporal si es relevante.
   *
   * @param {Array} entities
   * @param {Array} relations
   * @returns {Array<string>}
   */
  _buildConnections(entities, relations) {
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const connections = [];

    for (const r of relations) {
      const source = entityMap.get(r.source_id);
      const target = entityMap.get(r.target_id);

      if (source && target) {
        const relLabel = this._relationLabel(r.relation_type);
        const weight = r.weight || 0.5;
        const temporal = r.temporal_type || 'present';

        // Build connection string with metadata
        let conn = `${source.name} → ${relLabel} → ${target.name}`;

        // Add temporal indicator if not present
        if (temporal !== 'present') {
          const temporalLabel = temporal === 'past' ? '[pasado]' : '[futuro]';
          conn += ` ${temporalLabel}`;
        }

        // Add weight indicator for high/low confidence
        if (weight >= 0.8) {
          conn += ' ★'; // High weight
        } else if (weight < 0.3) {
          conn += ' ○'; // Low weight
        }

        connections.push(conn);
      }
    }

    return connections;
  }

  /**
   * Convierte un tipo de relación a un label legible.
   *
   * @param {string} relationType
   * @returns {string}
   */
  _relationLabel(relationType) {
    const labels = {
      knows: 'conoce',
      works_at: 'trabaja_en',
      studies_at: 'estudia_en',
      uses: 'usa',
      likes: 'le_gusta',
      lives_in: 'vive_en',
      created: 'creó',
      mentioned_with: 'mencionado_junto_a',
      related_to: 'relacionado_con',
      develops: 'desarrolla',
      utilizes: 'utiliza',
      depends_on: 'depende_de',
    };
    return labels[relationType] || relationType;
  }
}

module.exports = GraphRetriever;
