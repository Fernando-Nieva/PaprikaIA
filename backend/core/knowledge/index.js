/**
 * KnowledgeGraph — Fase 4: Grafo de conocimiento estructurado.
 *
 * Representa relaciones entre entidades extraídas de conversaciones.
 * No es una base de datos de grafos completa, sino una estructura
 * ligera que permite rastrear entidades, sus relaciones, y sugerir
 * conexiones basadas en co-ocurrencia y contexto.
 *
 * Tipos de entidad: person, place, project, technology, organization, concept, goal
 * Tipos de relación: knows, works_at, studies_at, uses, likes, lives_in,
 *                    created, mentioned_with, related_to
 *
 * Consumido por:
 * - Pipeline (futuro): enriquecer contexto con entidades conocidas
 * - ContextBuilder: entidad info para system prompt
 * - MemoryManager: correlacionar memorias con entidades
 *
 * Dependencias: db.js (knowledge_entities, knowledge_relations)
 */

'use strict';

const ENTITY_TYPES = ['person', 'place', 'project', 'technology', 'organization', 'concept', 'goal'];

const RELATION_TYPES = ['knows', 'works_at', 'studies_at', 'uses', 'likes', 'lives_in', 'created', 'mentioned_with', 'related_to'];

const TEMPORAL_TYPES = ['past', 'present', 'future'];

const EMOTION_KEYWORDS = {
  positive: ['amor', 'alegría', 'felicidad', 'éxito', 'orgullo', 'entusiasmo', 'pasión', 'gratitud', 'esperanza', 'inspiración'],
  negative: ['tristeza', 'enojo', 'frustración', 'miedo', 'ansiedad', 'preocupación', 'decepción', 'soledad', 'culpa', 'arrepentimiento'],
  neutral: ['neutro', 'normal', 'tranquilo', 'calmado'],
};

class KnowledgeGraph {
  /**
   * @param {Object} db - Capa de base de datos (db.js)
   * @param {CoreConfig} config - Configuración centralizada
   * @param {Object} [embeddingService] - MemoryEmbeddingService (opcional)
   */
  constructor(db, config, embeddingService = null) {
    this.db = db;
    this.config = config;
    this.embedding = embeddingService;
    this.maxBreadth = 3;
    this._cache = null; // Set via setCache() for pipeline-level caching
  }

  /**
   * Sets the pipeline cache for this instance.
   * Called by Pipeline before execution to enable caching.
   *
   * @param {PipelineCache} cache
   */
  setCache(cache) {
    this._cache = cache;
  }

  // ─────────────────────────────────────────────
  //  Gestión de entidades
  // ─────────────────────────────────────────────

  /**
   * Agrega una entidad al grafo. Si ya existe (mismo user+name+type),
   * actualiza metadata y updated_at (upsert en DB).
   * Genera embedding si el servicio está disponible.
   *
   * @param {string} userId
   * @param {string} name - Nombre de la entidad (normalizado a minúsculas)
   * @param {string} entityType - Tipo: person|place|project|technology|organization|concept
   * @param {Object} metadata - Datos adicionales libres
   * @param {Object} [options] - Opciones adicionales
   * @param {number} [options.importance] - Importancia 0-1
   * @param {number} [options.emotionalWeight] - Peso emocional (-1 a 1)
   * @returns {Object} { id } de la entidad creada/actualizada
   */
  async addEntity(userId, name, entityType, metadata = {}, options = {}) {
    if (!ENTITY_TYPES.includes(entityType)) {
      throw new Error(`Tipo de entidad inválido: ${entityType}. Tipos válidos: ${ENTITY_TYPES.join(', ')}`);
    }
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Nombre de entidad no puede estar vacío');

    const safeMetadata = {
      ...metadata,
      lastMentioned: new Date().toISOString()
    };

    // Generate embedding for entity name + context
    let embedding = null;
    if (this.embedding && this.embedding.isAvailable()) {
      try {
        const embeddingText = `${normalizedName} ${entityType} ${metadata.source || ''}`.trim();
        const vector = await this.embedding.generate(embeddingText);
        if (vector) {
          embedding = this.embedding.toBuffer(vector);
        }
      } catch (err) {
        console.error(`[Knowledge] Embedding generation failed for entity ${normalizedName}: ${err.message}`);
      }
    }

    // Calculate emotional weight from metadata
    const emotionalWeight = options.emotionalWeight !== undefined
      ? options.emotionalWeight
      : this._calculateEmotionalWeight(safeMetadata);

    return this.db.addEntity(userId, normalizedName, entityType, safeMetadata, {
      importance: options.importance || 0.5,
      emotionalWeight,
      embedding,
    });
  }

  /**
   * Obtiene una entidad específica por nombre y tipo.
   *
   * @param {string} userId
   * @param {string} name
   * @param {string} entityType
   * @returns {Object|null} Entidad o null
   */
  getEntity(userId, name, entityType) {
    const entity = this.db.getEntity(userId, name.trim(), entityType);
    if (!entity) return null;
    return {
      ...entity,
      metadata: this._parseMetadata(entity.metadata),
    };
  }

  /**
   * Retorna entidades de un usuario con filtros opcionales.
   *
   * @param {string} userId
   * @param {Object} options
   * @param {string} [options.type] - Filtrar por tipo de entidad
   * @param {number} [options.limit=50] - Límite de resultados
   * @param {string} [options.search] - Buscar por nombre (parcial, case-insensitive)
   * @returns {Array<Object>} Entidades encontradas
   */
  getEntitiesByUser(userId, options = {}) {
    const limit = options.limit || 50;
    const cacheKey = `entities:${userId}:${limit}`;

    const fetchFn = () => {
      const entities = this.db.getEntitiesByUserFiltered(userId, {
        type: options.type,
        search: options.search,
        limit,
      });

      return entities.map(e => ({
        ...e,
        metadata: this._parseMetadata(e.metadata),
      }));
    };

    if (this._cache) {
      return this._cache.getOrSet(cacheKey, fetchFn);
    }
    return fetchFn();
  }

  /**
   * Actualiza metadata de una entidad existente.
   *
   * @param {number} entityId
   * @param {Object} updates - Campos a actualizar en metadata (se mergea)
   * @returns {void}
   */
  updateEntity(entityId, updates) {
    const existing = this.db.getEntityById(entityId);
    if (!existing) return;

    const current = this._parseMetadata(existing.metadata);
    const merged = { ...current, ...updates, lastMentioned: new Date().toISOString() };

    this.db.updateEntityMetadata(
      entityId,
      merged,
      existing.importance || 0.5,
      existing.emotional_weight || 0,
      existing.frequency || 1
    );
  }

  /**
   * Actualiza los pesos de una entidad (importancia, emocional, frecuencia).
   *
   * @param {number} entityId
   * @param {Object} weights - { importance, emotionalWeight, frequency }
   */
  updateEntityWeights(entityId, weights) {
    this.db.updateEntityWeights(entityId, weights);
  }

  /**
   * Incrementa la frecuencia de una entidad (llamado cuando se menciona).
   *
   * @param {number} entityId
   */
  incrementEntityFrequency(entityId) {
    this.db.incrementEntityFrequency(entityId);
  }

  // ─────────────────────────────────────────────
  //  Gestión de relaciones
  // ─────────────────────────────────────────────

  /**
   * Agrega una relación entre dos entidades.
   * Crea las entidades si no existen aún.
   * Soporta relaciones temporales y pesos.
   *
   * @param {string} userId
   * @param {string} sourceName
   * @param {string} sourceType
   * @param {string} targetName
   * @param {string} targetType
   * @param {string} relationType - Tipo de relación
   * @param {Object} metadata - Datos adicionales
   * @param {number} [confidence=0.5] - Confianza de la relación (0-1)
   * @param {Object} [options] - Opciones adicionales
   * @param {string} [options.temporalType='present'] - 'past', 'present', 'future'
   * @param {string} [options.startTime] - Fecha de inicio (ISO)
   * @param {string} [options.endTime] - Fecha de fin (ISO)
   * @param {number} [options.weight] - Peso compuesto 0-1
   * @returns {Object|null} { id } de la relación o null si falla
   */
  addRelation(userId, sourceName, sourceType, targetName, targetType, relationType, metadata = {}, confidence = 0.5, options = {}) {
    if (!RELATION_TYPES.includes(relationType)) {
      throw new Error(`Tipo de relación inválido: ${relationType}. Tipos válidos: ${RELATION_TYPES.join(', ')}`);
    }

    if (options.temporalType && !TEMPORAL_TYPES.includes(options.temporalType)) {
      throw new Error(`Tipo temporal inválido: ${options.temporalType}. Tipos válidos: ${TEMPORAL_TYPES.join(', ')}`);
    }

    const clampedConfidence = Math.min(Math.max(confidence, 0), 1);

    // Crear entidades si no existen
    const source = this._ensureEntity(userId, sourceName.trim(), sourceType);
    const target = this._ensureEntity(userId, targetName.trim(), targetType);

    if (!source || !target) return null;

    // Calculate composite weight
    const weight = options.weight !== undefined
      ? Math.min(Math.max(options.weight, 0), 1)
      : this._calculateRelationWeight(clampedConfidence, metadata);

    return this.db.addRelation(userId, source.id, target.id, relationType, metadata, clampedConfidence, {
      temporalType: options.temporalType || 'present',
      startTime: options.startTime || null,
      endTime: options.endTime || null,
      weight,
    });
  }

  /**
   * Retorna todas las relaciones de una entidad (entrantes y salientes).
   *
   * @param {number} entityId
   * @returns {Array<Object>} Relaciones con nombres de entidades resueltos
   */
  getRelationsForEntity(entityId) {
    const relations = this.db.getRelationsForEntity(entityId) || [];
    return relations.map(r => ({
      ...r,
      metadata: this._parseMetadata(r.metadata)
    }));
  }

  /**
   * Retorna todas las relaciones de un usuario con filtros.
   *
   * @param {string} userId
   * @param {Object} options
   * @param {number} [options.limit=50]
   * @param {string} [options.relationType] - Filtrar por tipo de relación
   * @param {string} [options.temporalType] - Filtrar por tipo temporal
   * @returns {Array<Object>}
   */
  getRelationsByUser(userId, options = {}) {
    const limit = options.limit || 50;
    const cacheKey = `relations:${userId}:${limit}`;

    const fetchFn = () => {
      const relations = this.db.getRelationsByUserFiltered(userId, {
        relationType: options.relationType,
        limit,
      });

      let filtered = relations.map(r => ({
        ...r,
        metadata: this._parseMetadata(r.metadata)
      }));

      // Filter by temporal type if specified
      if (options.temporalType) {
        filtered = filtered.filter(r => r.temporal_type === options.temporalType);
      }

      return filtered;
    };

    if (this._cache) {
      return this._cache.getOrSet(cacheKey, fetchFn);
    }
    return fetchFn();
  }

  /**
   * Actualiza el peso de una relación basado en menciones.
   *
   * @param {number} relationId
   * @param {number} newWeight - Nuevo peso compuesto
   */
  updateRelationWeight(relationId, newWeight) {
    this.db.updateRelationWeight(relationId, Math.min(Math.max(newWeight, 0), 1));
  }

  /**
   * Actualiza el tipo temporal de una relación.
   *
   * @param {number} relationId
   * @param {Object} temporal - { temporalType, startTime, endTime }
   */
  updateRelationTemporal(relationId, temporal) {
    if (temporal.temporalType && !TEMPORAL_TYPES.includes(temporal.temporalType)) {
      throw new Error(`Tipo temporal inválido: ${temporal.temporalType}`);
    }
    this.db.updateRelationTemporal(relationId, temporal);
  }

  // ─────────────────────────────────────────────
  //  Descubrimiento
  // ─────────────────────────────────────────────

  /**
   * Extrae entidades potenciales del output del Analyzer.
   * Convierte datos del análisis en estructura de entidad para el grafo.
   *
   * @param {Object} analysis - Output de MessageAnalyzer.analyze()
   * @returns {Array<Object>} [{ name, type, metadata }]
   */
  extractEntities(analysis) {
    const entities = [];

    // Personas
    for (const person of (analysis.entities?.people || [])) {
      entities.push({
        name: person,
        type: 'person',
        metadata: { source: 'analysis', confidence: analysis.confidence || 0.5 }
      });
    }

    // Lugares
    for (const place of (analysis.entities?.places || [])) {
      entities.push({
        name: place,
        type: 'place',
        metadata: { source: 'analysis', confidence: analysis.confidence || 0.5 }
      });
    }

    // Proyectos
    for (const project of (analysis.entities?.projects || [])) {
      entities.push({
        name: project,
        type: 'project',
        metadata: { source: 'analysis', confidence: analysis.confidence || 0.5 }
      });
    }

    // Tecnologías (por tema y por patrón en el mensaje)
    if (analysis.topic === 'technology' || this._hasTechKeywords(analysis.rawMessage || '')) {
      const techs = this._extractTechnologies(analysis.rawMessage || '');
      for (const tech of techs) {
        entities.push({
          name: tech,
          type: 'technology',
          metadata: { source: 'topic', confidence: 0.6 }
        });
      }
    }

    // Organizaciones (empresas, universidades mencionadas)
    const orgs = this._extractOrganizations(analysis.rawMessage || '');
    for (const org of orgs) {
      entities.push({
        name: org,
        type: 'organization',
        metadata: { source: 'analysis', confidence: 0.5 }
      });
    }

    // Conceptos (temas abstractos del análisis)
    if (analysis.topic) {
      entities.push({
        name: analysis.topic,
        type: 'concept',
        metadata: { source: 'topic', confidence: analysis.confidence || 0.5 }
      });
    }

    return entities;
  }

  /**
   * Extrae entidades desde el contenido de una memoria almacenada.
   * Usa EntityExtractor para análisis de texto profundo.
   *
   * @param {string} userId
   * @param {string} text - Contenido de la memoria
   * @param {Object} [context] - { memoryType, isGoal, ... }
   * @returns {Array<Object>} Entidades extraídas y persistidas
   */
  extractFromMemory(userId, text, context = {}) {
    if (!this._entityExtractor) {
      const EntityExtractor = require('./extractor');
      this._entityExtractor = new EntityExtractor(this);
    }
    return this._entityExtractor.extractAndPersist(userId, text, context);
  }

  /**
   * Sugiere relaciones potenciales basándose en co-ocurrencia de entidades
   * y contexto del análisis. No persiste — retorna sugerencias para revisión.
   *
   * @param {string} userId
   * @param {Array<Object>} entities - Entidades extraídas (de extractEntities)
   * @returns {Array<Object>} Sugerencias de relación
   */
  suggestRelations(userId, entities) {
    const suggestions = [];
    const seen = new Set();

    for (const entity of entities) {
      // Persona + tecnología → "uses"
      if (entity.type === 'person') {
        for (const tech of entities.filter(e => e.type === 'technology')) {
          const key = `uses:${entity.name}:${tech.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            suggestions.push({
              source: entity.name, sourceType: 'person',
              target: tech.name, targetType: 'technology',
              relation: 'uses', confidence: 0.4
            });
          }
        }

        // Persona + lugar → "lives_in"
        for (const place of entities.filter(e => e.type === 'place')) {
          const key = `lives_in:${entity.name}:${place.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            suggestions.push({
              source: entity.name, sourceType: 'person',
              target: place.name, targetType: 'place',
              relation: 'lives_in', confidence: 0.3
            });
          }
        }

        // Persona + organización → "works_at" (baja confianza)
        for (const org of entities.filter(e => e.type === 'organization')) {
          const key = `works_at:${entity.name}:${org.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            suggestions.push({
              source: entity.name, sourceType: 'person',
              target: org.name, targetType: 'organization',
              relation: 'works_at', confidence: 0.25
            });
          }
        }

        // Persona + persona → "knows" (si hay más de una persona)
        for (const other of entities.filter(e => e.type === 'person' && e.name !== entity.name)) {
          const key = `knows:${entity.name}:${other.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            suggestions.push({
              source: entity.name, sourceType: 'person',
              target: other.name, targetType: 'person',
              relation: 'knows', confidence: 0.35
            });
          }
        }
      }

      // Proyecto + tecnología → "uses"
      if (entity.type === 'project') {
        for (const tech of entities.filter(e => e.type === 'technology')) {
          const key = `uses:${entity.name}:${tech.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            suggestions.push({
              source: entity.name, sourceType: 'project',
              target: tech.name, targetType: 'technology',
              relation: 'uses', confidence: 0.45
            });
          }
        }
      }

      // Cualquier entidad + cualquier entidad → "mentioned_with" (fallback)
      for (const other of entities) {
        if (other.name === entity.name && other.type === entity.type) continue;
        const key = `mentioned_with:${entity.name}:${other.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({
            source: entity.name, sourceType: entity.type,
            target: other.name, targetType: other.type,
            relation: 'mentioned_with', confidence: 0.2
          });
        }
      }
    }

    // Deduplicar y ordenar por confianza
    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  // ─────────────────────────────────────────────
  //  Consultas
  // ─────────────────────────────────────────────

  /**
   * Retorna toda la información conocida sobre una entidad:
   * sus datos, todas sus relaciones entrantes y salientes.
   *
   * @param {string} userId
   * @param {string} entityName
   * @returns {Object|null} { entity, relations } o null si no existe
   */
  getEntityContext(userId, entityName) {
    const entities = this.db.getEntitiesByUser(userId, 500);
    const match = entities.find(e => e.name.toLowerCase() === entityName.toLowerCase().trim());

    if (!match) return null;

    const relations = this.getRelationsForEntity(match.id);

    return {
      entity: {
        ...match,
        metadata: this._parseMetadata(match.metadata)
      },
      relations: relations.map(r => ({
        from: r.source_name,
        fromType: r.source_type,
        to: r.target_name,
        toType: r.target_type,
        relation: r.relation_type,
        confidence: r.confidence,
        temporalType: r.temporal_type,
        weight: r.weight,
        metadata: r.metadata
      }))
    };
  }

  /**
   * Encuentra el camino más corto entre dos entidades usando BFS.
   * Profundidad máxima: 3 saltos.
   *
   * @param {string} userId
   * @param {string} fromName - Nombre de entidad origen
   * @param {string} toName - Nombre de entidad destino
   * @param {number} [maxDepth=3] - Profundidad máxima de búsqueda
   * @returns {Array<Object>|null} [{ from, fromType, relation, to, toType }] o null
   */
  getRelationPath(userId, fromName, toName, maxDepth = 3) {
    const entities = this.db.getEntitiesByUser(userId, 500);
    const fromEntity = entities.find(e => e.name.toLowerCase() === fromName.toLowerCase().trim());
    const toEntity = entities.find(e => e.name.toLowerCase() === toName.toLowerCase().trim());

    if (!fromEntity || !toEntity) return null;
    if (fromEntity.id === toEntity.id) return [];

    // Construir grafo de adyacencia en memoria
    const adjacency = new Map();
    for (const entity of entities) {
      adjacency.set(entity.id, []);
    }

    const relations = this.db.getRelationsByUser(userId, 5000);
    for (const rel of relations) {
      const src = adjacency.get(rel.source_entity_id);
      const tgt = adjacency.get(rel.target_entity_id);
      if (src) src.push({ targetId: rel.target_entity_id, relation: rel.relation_type, sourceName: rel.source_name, targetName: rel.target_name, sourceType: rel.source_type, targetType: rel.target_type, weight: rel.weight || 0.5 });
      if (tgt) tgt.push({ targetId: rel.source_entity_id, relation: rel.relation_type, sourceName: rel.target_name, targetName: rel.source_name, sourceType: rel.target_type, targetType: rel.source_type, weight: rel.weight || 0.5 });
    }

    // BFS
    const visited = new Set([fromEntity.id]);
    const queue = [{ id: fromEntity.id, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift();

      if (current.path.length >= maxDepth) continue;

      const neighbors = adjacency.get(current.id) || [];
      for (const neighbor of neighbors) {
        if (neighbor.targetId === toEntity.id) {
          return [...current.path, {
            from: neighbor.sourceName,
            fromType: neighbor.sourceType,
            relation: neighbor.relation,
            to: neighbor.targetName,
            toType: neighbor.targetType,
            weight: neighbor.weight
          }];
        }

        if (!visited.has(neighbor.targetId)) {
          visited.add(neighbor.targetId);
          queue.push({
            id: neighbor.targetId,
            path: [...current.path, {
              from: neighbor.sourceName,
              fromType: neighbor.sourceType,
              relation: neighbor.relation,
              to: neighbor.targetName,
              toType: neighbor.targetType,
              weight: neighbor.weight
            }]
          });
        }
      }
    }

    return null; // No hay camino
  }

  // ─────────────────────────────────────────────
  //  Mantenimiento
  // ─────────────────────────────────────────────

  /**
   * Consolida entidades duplicadas (mismo nombre, diferente tipo).
   * Mergea metadata y actualiza relaciones para apuntar a la entidad sobreviviente.
   *
   * @param {string} userId
   * @returns {number} Cantidad de entidades consolidadas (eliminadas)
   */
  consolidateEntities(userId) {
    const entities = this.db.getEntitiesByUser(userId, 1000);
    const byName = new Map();

    // Agrupar por nombre normalizado
    for (const entity of entities) {
      const key = entity.name.toLowerCase().trim();
      if (!byName.has(key)) {
        byName.set(key, []);
      }
      byName.get(key).push(entity);
    }

    let consolidated = 0;

    for (const [name, group] of byName) {
      if (group.length <= 1) continue;

      // Determinar entidad sobreviviente (la de mayor updated_at o mayor id)
      group.sort((a, b) => {
        if (a.updated_at > b.updated_at) return -1;
        if (a.updated_at < b.updated_at) return 1;
        return b.id - a.id;
      });

      const survivor = group[0];
      const duplicates = group.slice(1);

      // Merge metadata de todos los duplicados en el sobreviviente
      let mergedMeta = this._parseMetadata(survivor.metadata);
      let maxImportance = survivor.importance || 0.5;
      let maxEmotionalWeight = Math.abs(survivor.emotional_weight || 0);
      let totalFrequency = survivor.frequency || 1;

      for (const dup of duplicates) {
        const dupMeta = this._parseMetadata(dup.metadata);
        mergedMeta = { ...dupMeta, ...mergedMeta };
        mergedMeta.sources = [...new Set([
          ...(mergedMeta.sources || []),
          ...(dupMeta.sources || []),
          dup.entity_type
        ])];

        // Merge weights
        maxImportance = Math.max(maxImportance, dup.importance || 0.5);
        maxEmotionalWeight = Math.max(maxEmotionalWeight, Math.abs(dup.emotional_weight || 0));
        totalFrequency += dup.frequency || 1;

        // Redirigir relaciones del duplicado al sobreviviente
        this.db.redirectEntityRelations(dup.id, survivor.id);

        // Eliminar duplicado
        this.db.deleteEntity(dup.id);
        consolidated++;
      }

      // Actualizar metadata y pesos del sobreviviente
      this.db.updateEntityMetadata(survivor.id, mergedMeta, maxImportance, maxEmotionalWeight, totalFrequency);

      // Eliminar relaciones duplicadas (mismo source, target, type)
      this.db.deleteDuplicateRelations(userId);
    }

    return consolidated;
  }

  /**
   * Verifica la consistencia del grafo y corrige problemas.
   * Detecta: entidades huérfanas, relaciones duplicadas, pesos inconsistentes.
   *
   * @param {string} userId
   * @returns {Object} { orphanedRelations, duplicateEntities, fixedIssues }
   */
  verifyConsistency(userId) {
    const report = {
      orphanedRelations: 0,
      duplicateEntities: 0,
      fixedIssues: 0,
      details: [],
    };

    // 1. Detect and remove orphaned relations
    const orphaned = this.db.getOrphanedRelations(userId);
    if (orphaned.length > 0) {
      for (const rel of orphaned) {
        try {
          this.db.deleteRelation(rel.id);
          report.fixedIssues++;
        } catch (err) {
          console.error(`[Knowledge] Failed to delete orphaned relation ${rel.id}: ${err.message}`);
        }
      }
      report.orphanedRelations = orphaned.length;
      report.details.push(`Removed ${orphaned.length} orphaned relations`);
    }

    // 2. Detect and merge duplicate entities
    const duplicates = this.db.getDuplicateEntities(userId);
    if (duplicates.length > 0) {
      for (const dup of duplicates) {
        const ids = dup.ids.split(',').map(Number);
        // Keep the first one, merge the rest
        const survivorId = ids[0];
        for (let i = 1; i < ids.length; i++) {
          try {
            // Redirect relations
            this.db.redirectEntityRelations(ids[i], survivorId);
            // Delete duplicate
            this.db.deleteEntity(ids[i]);
            report.fixedIssues++;
          } catch (err) {
            console.error(`[Knowledge] Failed to merge duplicate entity ${ids[i]}: ${err.message}`);
          }
        }
        report.duplicateEntities++;
        report.details.push(`Merged ${ids.length} duplicate entities for "${dup.name}"`);
      }
    }

    // 3. Verify relation weights are within bounds
    const relations = this.db.getRelationsByUser(userId, 10000);
    for (const rel of relations) {
      if (rel.weight < 0 || rel.weight > 1) {
        try {
          const clampedWeight = Math.min(Math.max(rel.weight, 0), 1);
          this.db.updateRelationWeight(rel.id, clampedWeight);
          report.fixedIssues++;
        } catch (err) {
          console.error(`[Knowledge] Failed to fix relation weight ${rel.id}: ${err.message}`);
        }
      }
    }

    if (report.fixedIssues > 0) {
      console.log(`[Knowledge] Consistency check: ${report.fixedIssues} issues fixed`);
    }

    return report;
  }

  /**
   * Backfill embeddings for entities that don't have them.
   *
   * @param {string} userId
   * @param {number} [batchSize=10]
   * @returns {Promise<number>} Number of entities processed
   */
  async backfillEntityEmbeddings(userId, batchSize = 10) {
    if (!this.embedding || !this.embedding.isAvailable()) return 0;

    let totalProcessed = 0;
    let hasMore = true;

    while (hasMore) {
      const entities = this.db.getEntitiesWithoutEmbedding(userId, batchSize);
      if (entities.length === 0) {
        hasMore = false;
        break;
      }

      const contents = entities.map(e => `${e.name} ${e.entity_type}`.trim());
      const embeddings = await this.embedding.generateBatch(contents);

      for (let i = 0; i < entities.length; i++) {
        if (embeddings[i]) {
          const buffer = this.embedding.toBuffer(embeddings[i]);
          this.db.updateEntityEmbedding(entities[i].id, buffer);
          totalProcessed++;
        }
      }

      if (entities.length < batchSize) {
        hasMore = false;
      }
    }

    if (totalProcessed > 0) {
      console.log(`[Knowledge] Backfill: ${totalProcessed} entity embeddings generated`);
    }

    return totalProcessed;
  }

  /**
   * Retorna estadísticas del grafo para un usuario.
   *
   * @param {string} userId
   * @returns {Object} { entities, relations, byType, byRelation, avgConfidence, avgWeight, temporalDistribution }
   */
  getStats(userId) {
    const cacheKey = `stats:${userId}`;

    const fetchFn = () => {
      const entities = this.db.getEntitiesByUser(userId, 10000);
      const relations = this.db.getRelationsByUser(userId, 10000);

      const byType = {};
      for (const e of entities) {
        byType[e.entity_type] = (byType[e.entity_type] || 0) + 1;
      }

      const byRelation = {};
      const temporalDistribution = { past: 0, present: 0, future: 0 };
      let totalConfidence = 0;
      let totalWeight = 0;

      for (const r of relations) {
        byRelation[r.relation_type] = (byRelation[r.relation_type] || 0) + 1;
        totalConfidence += r.confidence || 0.5;
        totalWeight += r.weight || 0.5;
        if (r.temporal_type && temporalDistribution[r.temporal_type] !== undefined) {
          temporalDistribution[r.temporal_type]++;
        }
      }

      return {
        entities: entities.length,
        relations: relations.length,
        byType,
        byRelation,
        avgConfidence: relations.length > 0
          ? Math.round((totalConfidence / relations.length) * 100) / 100
          : 0,
        avgWeight: relations.length > 0
          ? Math.round((totalWeight / relations.length) * 100) / 100
          : 0,
        temporalDistribution,
      };
    };

    if (this._cache) {
      return this._cache.getOrSet(cacheKey, fetchFn);
    }
    return fetchFn();
  }

  // ─────────────────────────────────────────────
  //  Métodos internos: utilidades
  // ─────────────────────────────────────────────

  /**
   * Asegura que una entidad exista. La crea si no existe.
   * @param {string} userId
   * @param {string} name
   * @param {string} type
   * @returns {Object|null} Entidad (con id)
   */
  _ensureEntity(userId, name, type) {
    let entity = this.db.getEntity(userId, name, type);
    if (entity) return entity;

    const result = this.db.addEntity(userId, name, type, { source: 'auto_created' });
    if (result && result.lastInsertRowid) {
      return { id: result.lastInsertRowid, name, entity_type: type };
    }
    return null;
  }

  /**
   * Parsea metadata de string JSON a objeto.
   * @param {string|Object} metadata
   * @returns {Object}
   */
  _parseMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object') return metadata;
    try {
      return JSON.parse(metadata);
    } catch (err) {
      console.warn(`[Knowledge] Failed to parse metadata: ${err.message}`);
      return {};
    }
  }

  /**
   * Calculates emotional weight from metadata keywords.
   * @param {Object} metadata
   * @returns {number} -1 to 1
   */
  _calculateEmotionalWeight(metadata) {
    const text = JSON.stringify(metadata).toLowerCase();
    let score = 0;

    for (const keyword of EMOTION_KEYWORDS.positive) {
      if (text.includes(keyword)) score += 0.1;
    }
    for (const keyword of EMOTION_KEYWORDS.negative) {
      if (text.includes(keyword)) score -= 0.1;
    }

    return Math.min(Math.max(score, -1), 1);
  }

  /**
   * Calculates composite relation weight from confidence and metadata.
   * @param {number} confidence
   * @param {Object} metadata
   * @returns {number} 0-1
   */
  _calculateRelationWeight(confidence, metadata) {
    // Base weight from confidence
    let weight = confidence;

    // Boost for explicit relations (not just mentioned_with)
    if (metadata.relation_type !== 'mentioned_with') {
      weight = Math.min(weight + 0.1, 1);
    }

    return Math.min(Math.max(weight, 0), 1);
  }

  /**
   * Verifica si el mensaje contiene palabras clave de tecnología.
   * @param {string} message
   * @returns {boolean}
   */
  _hasTechKeywords(message) {
    const lower = message.toLowerCase();
    const techWords = ['programar', 'código', 'software', 'hardware', 'algoritmo', 'servidor', 'base de datos', 'api', 'deploy', 'compilar', 'debug', 'repository'];
    return techWords.some(w => lower.includes(w));
  }

  /**
   * Extrae nombres de tecnologías del texto.
   * @param {string} message
   * @returns {Array<string>}
   */
  _extractTechnologies(message) {
    const techPatterns = [
      /\b(React|Vue|Angular|Svelte|Next\.js|Nuxt)\b/gi,
      /\b(Python|JavaScript|TypeScript|Java|C\+\+|Rust|Go|Ruby|PHP|Swift|Kotlin)\b/gi,
      /\b(Node\.?js|Deno|Bun|Express|Fastify|NestJS)\b/gi,
      /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite|Supabase|Firebase)\b/gi,
      /\b(Docker|Kubernetes|AWS|Azure|GCP|Vercel|Netlify)\b/gi,
      /\b(Git|GitHub|GitLab|Bitbucket)\b/gi,
      /\b(Tailwind|Bootstrap|Material\.UI|Chakra)\b/gi,
      /\b(OpenAI|Gemini|Claude|Ollama|HuggingFace)\b/gi
    ];

    const found = new Set();
    for (const pattern of techPatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        found.add(match[1]);
      }
    }
    return [...found];
  }

  /**
   * Extrae posibles organizaciones del texto.
   * @param {string} message
   * @returns {Array<string>}
   */
  _extractOrganizations(message) {
    const orgPatterns = [
      /\b(?:en|trabajo\s+en|estudio\s+en|soy\s+de)\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g,
      /\b(Universidad\s+de\s+[A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/gi,
      /\b(Empresa\s+de\s+[A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/gi
    ];

    const found = [];
    for (const pattern of orgPatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        const name = match[1] || match[0];
        const trimmed = name.trim();
        if (trimmed.length > 2 && !found.includes(trimmed)) {
          found.push(trimmed);
        }
      }
    }
    return found;
  }
}

module.exports = KnowledgeGraph;
