/**
 * ContextRanker
 *
 * Evaluates and scores ALL pieces of information available to Paprika before a
 * response is generated. It answers: "Given what I know right now, what matters
 * most for this specific message?"
 *
 * This is the SOLE ranking authority. MemorySearch returns raw candidates only;
 * all scoring happens here.
 *
 * Formula (v2 — with semantic similarity):
 *   score = (semantic * 0.30) + (base * 0.15) + (topic * 0.20)
 *         + (emotional * 0.12) + (relationship * 0.10) + (goal * 0.08)
 *         + (entity * 0.08) + (reflection * 0.05) + (cluster * 0.03)
 *         + (verification * 0.04)
 *
 * When embeddings are unavailable, semantic falls back to keyword overlap
 * provided by MemorySearch as `keywordScore` on each candidate.
 */

const DEFAULT_CONFIG = {
  maxMemories: 8,
  maxGoals: 5,
  maxEntities: 6,
  defaultBudget: 2000,
  maxBudget: 4000,
  minRelevanceScore: 0.1,
};

const SCORE_WEIGHTS = {
  semantic: 0.30,
  base: 0.15,
  topic: 0.20,
  emotional: 0.12,
  relationship: 0.10,
  goal: 0.08,
  entity: 0.08,
  reflection: 0.05,
  cluster: 0.03,
  verification: 0.04,
};

class ContextRanker {
  /**
   * @param {Object} config
   * @param {Object} [embeddingService] — FastEmbed service for cosine similarity
   */
  constructor(config = {}, embeddingService = null) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embedding = embeddingService;
  }

  /**
   * Main entry — ranks everything and produces the unified context output.
   *
   * @param {Object} params
   * @param {Object}  params.analysis          — from Analyzer
   * @param {Array}   params.memories          — raw candidates from MemorySearch (no scores)
   * @param {Object}  params.relationship      — from RelationshipEngine
   * @param {Object}  params.emotionalState    — from EmotionEngine
   * @param {Array}   params.knowledge         — from KnowledgeGraph
   * @param {Array}   params.goals             — from GoalEngine
   * @param {string}  params.summary           — from Summarizer
   * @param {Array}   params.history           — recent messages
   * @param {Object}  params.classifiedMemories — from MemoryClassifier
   * @param {Array}   [params.reflectionActions] — from ReflectionEngine
   * @param {Array}   [params.semanticClusters]  — from memory_clusters table
   * @param {Object}  [params.graphContext]      — from GraphRetriever
   * @param {string}  [params.query]            — original query text for keyword fallback
   * @param {Float32Array} [params.queryEmbedding] — pre-computed query embedding
   * @returns {Object} ranked context
   */
  rank({
    analysis = {},
    memories = [],
    relationship = {},
    emotionalState = {},
    knowledge = [],
    goals = [],
    summary = '',
    history = [],
    classifiedMemories = {},
    reflectionActions = [],
    semanticClusters = [],
    graphContext = null,
    query = '',
    queryEmbedding = null,
  } = {}) {
    // Merge classified memories into the pool if provided
    const allMemories = [
      ...memories,
      ...(classifiedMemories.memories || []),
    ];

    const topic = analysis.topic || analysis.intent || '';
    const context = {
      topic,
      emotionalState,
      analysis,
      relationship,
      goals,
      knowledge,
      summary,
      history,
      reflectionActions,
      semanticClusters,
      query,
      queryEmbedding,
    };

    // Essential categories that must always survive ranking
    const essentialCategories = ['personal_data', 'relationship', 'person'];
    const essentialThreshold = 0.85;

    // Separate essential vs non-essential memories
    const essential = allMemories.filter(
      (m) => essentialCategories.includes(m.type) || (m.importance || 0) >= essentialThreshold
    );
    const nonEssential = allMemories.filter(
      (m) => !essentialCategories.includes(m.type) && (m.importance || 0) < essentialThreshold
    );

    // Score & rank non-essential memories
    const scoredNonEssential = nonEssential
      .map((m) => ({ ...m, contextualScore: this._scoreMemory(m, context) }))
      .filter((m) => m.contextualScore >= this.config.minRelevanceScore)
      .sort((a, b) => b.contextualScore - a.contextualScore);

    // Essential memories always survive, scored for ordering within themselves
    const scoredEssential = essential
      .map((m) => ({ ...m, contextualScore: this._scoreMemory(m, context) }))
      .sort((a, b) => b.contextualScore - a.contextualScore);

    // Merge: essential first, then non-essential, respect maxMemories
    const remainingBudget = Math.max(2, this.config.maxMemories - scoredEssential.length);
    const scoredMemories = [
      ...scoredEssential,
      ...scoredNonEssential.slice(0, remainingBudget),
    ];

    // --- Score & rank goals ---
    const scoredGoals = goals
      .map((g) => ({ ...g, relevanceScore: this._scoreGoal(g, context) }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.maxGoals);

    // --- Score & rank knowledge entities ---
    const scoredEntities = knowledge
      .map((e) => ({ ...e, relevanceScore: this._scoreEntity(e, context) }))
      .filter((e) => e.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, this.config.maxEntities);

    // --- Emotional & relationship context ---
    const emotionalContext = this._assessEmotionalContext(emotionalState, analysis);
    const relationshipContext = this._assessRelationshipContext(relationship, analysis);

    // --- Attention focus ---
    const attentionFocus = this._determineAttentionFocus(
      analysis,
      scoredMemories,
      scoredGoals,
      scoredEntities,
    );

    // --- Context budget ---
    const contextBudget = this._calculateContextBudget(history, summary);

    return {
      rankedMemories: scoredMemories,
      rankedGoals: scoredGoals,
      relevantEntities: scoredEntities,
      emotionalContext,
      relationshipContext,
      attentionFocus,
      contextBudget,
      reflectionActions,
      semanticClusters,
    };
  }

  // ---------------------------------------------------------------------------
  // Individual scorers
  // ---------------------------------------------------------------------------

  /**
   * Contextual relevance score for a single memory.
   *
   * Formula:
   *   score = (semantic * 0.30) + (base * 0.15) + (topic * 0.20)
   *         + (emotional * 0.12) + (relationship * 0.10) + (goal * 0.08)
   *         + (entity * 0.08) + (reflection * 0.05) + (cluster * 0.03)
   *         + (verification * 0.04)
   *
   * @param {Object} memory
   * @param {Object} context
   * @returns {number} score between ~0 and ~1
   */
  _scoreMemory(memory, { topic, emotionalState, analysis, relationship, goals, knowledge, reflectionActions, semanticClusters, query, queryEmbedding }) {
    const semanticScore = this._semanticSimilarity(memory, query, queryEmbedding);
    const baseScore = (memory.importance || 0.5) * (memory.confidence || 0.5);
    const topicScore = this._topicMatch(memory.type, topic);
    const emotionalScore = this._emotionalResonance(memory, emotionalState, analysis);
    const relBoost = this._relationshipBoost(memory, relationship);
    const goalScore = this._goalAlignment(memory, goals);
    const entityScore = this._entityOverlap(memory, analysis, knowledge);
    const reflectionBoost = this._reflectionBoost(memory, reflectionActions);
    const clusterCoherence = this._clusterCoherence(memory, semanticClusters);
    const verificationBonus = this._verificationBonus(memory);

    return (
      semanticScore * SCORE_WEIGHTS.semantic +
      baseScore * SCORE_WEIGHTS.base +
      topicScore * SCORE_WEIGHTS.topic +
      emotionalScore * SCORE_WEIGHTS.emotional +
      relBoost * SCORE_WEIGHTS.relationship +
      goalScore * SCORE_WEIGHTS.goal +
      entityScore * SCORE_WEIGHTS.entity +
      reflectionBoost * SCORE_WEIGHTS.reflection +
      clusterCoherence * SCORE_WEIGHTS.cluster +
      verificationBonus * SCORE_WEIGHTS.verification
    );
  }

  /**
   * Semantic similarity between a memory and the current query.
   *
   * Uses embedding cosine similarity when available.
   * Falls back to keyword Jaccard overlap via `memory.keywordScore`
   * (computed by MemorySearch during candidate retrieval).
   *
   * @param {Object} memory
   * @param {string} query
   * @param {Float32Array|null} queryEmbedding
   * @returns {number} 0–1
   */
  _semanticSimilarity(memory, query, queryEmbedding) {
    // Primary: cosine similarity via embeddings
    if (queryEmbedding && memory.embedding && this.embedding) {
      const memEmbedding = this.embedding.fromBuffer(memory.embedding);
      if (memEmbedding) {
        return Math.max(0, this.embedding.cosineSimilarity(queryEmbedding, memEmbedding));
      }
    }

    // Fallback: keyword score computed by MemorySearch during retrieval
    if (typeof memory.keywordScore === 'number') {
      return memory.keywordScore;
    }

    // Last resort: simple token overlap
    if (query && memory.content) {
      const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const contentWords = new Set(memory.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      if (queryWords.size === 0 || contentWords.size === 0) return 0;
      let intersection = 0;
      for (const w of queryWords) { if (contentWords.has(w)) intersection++; }
      return intersection / new Set([...queryWords, ...contentWords]).size;
    }

    return 0;
  }

  /**
   * Relevance of a goal to the current message.
   */
  _scoreGoal(goal, context) {
    const priority = goal.priority || 0.5;
    const progress = goal.progress || 0;

    let relevance = priority;

    if (goal.status === 'active' || goal.status === 'in_progress') {
      relevance += 0.2;
    }

    const goalText = (goal.goal || goal.content || '').toLowerCase();
    const topicText = (context.topic || '').toLowerCase();
    if (goalText && topicText && topicText.includes(goalText)) {
      relevance += 0.3;
    }

    const entities = context.analysis?.entities || {};
    const allEntities = [
      ...(entities.people || []),
      ...(entities.places || []),
      ...(entities.things || []),
    ];
    for (const entity of allEntities) {
      if (goalText.includes(entity.toLowerCase())) {
        relevance += 0.2;
        break;
      }
    }

    if (progress > 0 && progress < 1) {
      relevance += 0.1;
    }

    return Math.min(relevance, 1);
  }

  /**
   * Relevance of a knowledge graph entity to the current context.
   */
  _scoreEntity(entity, context) {
    let score = 0;

    const entityName = (entity.name || '').toLowerCase();
    const topic = (context.topic || '').toLowerCase();

    if (topic && entityName && topic.includes(entityName)) {
      score += 0.6;
    }

    const analysisEntities = context.analysis?.entities || {};
    const allAnalysisEntities = [
      ...(analysisEntities.people || []),
      ...(analysisEntities.places || []),
      ...(analysisEntities.things || []),
    ];
    for (const e of allAnalysisEntities) {
      if (entityName && e.toLowerCase() === entityName) {
        score += 0.4;
        break;
      }
    }

    const recentMemories = context.analysis?.recentMemories || [];
    for (const mem of recentMemories) {
      if (entityName && (mem.content || '').toLowerCase().includes(entityName)) {
        score += 0.15;
        break;
      }
    }

    const relationCount = entity.relations?.length || 0;
    if (relationCount > 3) score += 0.1;
    if (relationCount > 6) score += 0.1;

    return Math.min(score, 1);
  }

  _assessEmotionalContext(emotionalState, analysis) {
    const userEmotion = analysis.emotionalState || {};
    const paprikaEmotion = emotionalState || {};

    const userIntensity = analysis.intensity || userEmotion.confidence || 0;
    const shouldAttune = userIntensity > 0.4;
    const dominantEmotion = userEmotion.dominant || null;
    const energy = paprikaEmotion.energy || 0.5;

    const empathyLevel = shouldAttune
      ? Math.min(userIntensity * 1.2, 1)
      : paprikaEmotion.empathy || 0.3;

    const nostalgiaActive = paprikaEmotion.nostalgia > 0.5 || dominantEmotion === 'nostalgia';

    let suggestedTone = 'neutral';
    if (dominantEmotion === 'sadness' || dominantEmotion === 'grief') {
      suggestedTone = 'comforting';
    } else if (dominantEmotion === 'joy' || dominantEmotion === 'excitement') {
      suggestedTone = 'enthusiastic';
    } else if (dominantEmotion === 'anger' || dominantEmotion === 'frustration') {
      suggestedTone = 'calming';
    } else if (dominantEmotion === 'anxiety' || dominantEmotion === 'fear') {
      suggestedTone = 'reassuring';
    } else if (nostalgiaActive) {
      suggestedTone = 'warm';
    }

    return {
      userIntensity,
      dominantEmotion,
      shouldAttune,
      energy,
      empathyLevel,
      nostalgiaActive,
      suggestedTone,
    };
  }

  _assessRelationshipContext(relationship, analysis) {
    const trustLevel = relationship.trustLevel || 0.5;
    const familiarity = relationship.familiarity || 0.5;
    const humorAllowed = relationship.humorAllowed !== false;
    const sensitiveTopics = relationship.sensitiveTopics || [];
    const favoriteTopics = relationship.favoriteTopics || [];

    const currentTopic = (analysis.topic || '').toLowerCase();
    const isSensitiveTopic = sensitiveTopics.some(
      (t) => currentTopic.includes(t.toLowerCase()),
    );
    const isFavoriteTopic = favoriteTopics.some(
      (t) => currentTopic.includes(t.toLowerCase()),
    );

    let formalityLevel = 'neutral';
    if (familiarity > 0.7) formalityLevel = 'casual';
    else if (familiarity < 0.3) formalityLevel = 'formal';

    const allowVulnerability = trustLevel > 0.6;
    const effectiveHumorAllowed = humorAllowed && trustLevel > 0.4 && !isSensitiveTopic;
    const needsBoundaries = isSensitiveTopic && trustLevel < 0.6;

    return {
      trustLevel,
      familiarity,
      formalityLevel,
      isSensitiveTopic,
      isFavoriteTopic,
      allowVulnerability,
      humorAllowed: effectiveHumorAllowed,
      needsBoundaries,
    };
  }

  _determineAttentionFocus(analysis, memories, goals, knowledge) {
    const entities = analysis.entities || {};
    const emotionalState = analysis.emotionalState || {};
    const emotionalIntensity = analysis.intensity || emotionalState.confidence || 0;

    const hasEntity =
      (entities.people && entities.people.length > 0) ||
      (entities.places && entities.places.length > 0) ||
      (entities.things && entities.things.length > 0);

    if (hasEntity) {
      const entityNames = [
        ...(entities.people || []),
        ...(entities.places || []),
        ...(entities.things || []),
      ];
      return `Entity focus: ${entityNames.join(', ')}`;
    }

    if (emotionalIntensity > 0.6) {
      const emotion = emotionalState.dominant || 'emotional';
      return `Emotional support — user expressing ${emotion}`;
    }

    if (analysis.topic && analysis.sensitive) {
      return `Sensitive topic: ${analysis.topic} — exercise caution`;
    }

    const activeGoals = goals.filter(
      (g) => g.status === 'active' || g.status === 'in_progress',
    );
    if (activeGoals.length > 0) {
      const goalLabel = activeGoals[0].goal || activeGoals[0].content || 'active goal';
      return `Goal progress: ${goalLabel}`;
    }

    if (analysis.topic) {
      return `Topic: ${analysis.topic}`;
    }

    return analysis.intent
      ? `Intent: ${analysis.intent}`
      : 'General conversation';
  }

  _calculateContextBudget(history, summary) {
    const { defaultBudget, maxBudget } = this.config;

    let budget = defaultBudget;

    if (history && history.length > 20) {
      budget += 400;
    } else if (history && history.length > 10) {
      budget += 200;
    }

    if (summary && summary.length > 500) {
      budget += 300;
    } else if (summary && summary.length > 200) {
      budget += 150;
    }

    return Math.min(budget, maxBudget);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _topicMatch(memoryCategory, topic) {
    if (!memoryCategory || !topic) return 0;

    const cat = memoryCategory.toLowerCase();
    const top = topic.toLowerCase();

    if (top.includes(cat) || cat.includes(top)) return 1.0;

    const relatedMap = {
      person: ['family', 'friend', 'relationship', 'people', 'social', 'talk', 'chat'],
      relationship: ['person', 'family', 'friend', 'love', 'partner', 'social'],
      experience: ['memory', 'remember', 'back when', 'nostalgia', 'past', 'story'],
      preference: ['like', 'favorite', 'prefer', 'enjoy', 'taste', 'opinion'],
      personal_data: ['birthday', 'age', 'name', 'info', 'detail', 'about'],
      event: ['happened', 'occurred', 'incident', 'occasion', 'celebration'],
      hobby: ['hobby', 'interest', 'activity', 'fun', 'leisure'],
      location: ['place', 'city', 'country', 'where', 'live', 'visit'],
      emotional: ['feel', 'emotion', 'mood', 'happy', 'sad', 'angry', 'anxious'],
      goal: ['goal', 'plan', 'objective', 'target', 'ambition', 'want'],
    };

    const keywords = relatedMap[cat] || [];
    for (const keyword of keywords) {
      if (top.includes(keyword)) return 0.5;
    }

    return 0;
  }

  _emotionalResonance(memory, emotionalState, analysis) {
    const userEmotion = analysis?.emotionalState || {};
    const confidence = userEmotion.confidence || 0;

    if (confidence <= 0.5) return 0;

    const emotionType = userEmotion.dominant || '';
    const memType = (memory.type || '').toLowerCase();

    if (['person', 'relationship', 'experience'].includes(memType)) {
      return 0.8;
    }

    if (memType === 'personal_data') {
      return 0.5;
    }

    if (memType === 'emotional') {
      return 0.7;
    }

    if (
      (emotionType === 'sadness' || emotionType === 'grief') &&
      memory.content &&
      /\b(mom|dad|friend|partner|pet|loss|miss|passed|died)\b/i.test(memory.content)
    ) {
      return 0.9;
    }

    if (
      (emotionType === 'joy' || emotionType === 'excitement') &&
      ['hobby', 'experience', 'event'].includes(memType)
    ) {
      return 0.7;
    }

    return 0;
  }

  _entityOverlap(memory, analysis, knowledge) {
    let score = 0;
    const memLower = (memory.content || '').toLowerCase();

    const entities = analysis?.entities || {};
    for (const person of entities.people || []) {
      if (memLower.includes(person.toLowerCase())) {
        score = Math.max(score, 0.8);
      }
    }
    for (const place of entities.places || []) {
      if (memLower.includes(place.toLowerCase())) {
        score = Math.max(score, 0.6);
      }
    }
    for (const thing of entities.things || []) {
      if (memLower.includes(thing.toLowerCase())) {
        score = Math.max(score, 0.5);
      }
    }

    for (const entity of knowledge || []) {
      const entityName = (entity.name || '').toLowerCase();
      if (entityName && memLower.includes(entityName)) {
        score = Math.max(score, 0.7);
      }
    }

    return score;
  }

  _goalAlignment(memory, goals) {
    if (!goals || goals.length === 0) return 0;

    let maxScore = 0;
    const memLower = (memory.content || '').toLowerCase();

    for (const goal of goals) {
      const goalText = (goal.goal || goal.content || '').toLowerCase();
      if (!goalText) continue;

      if (memLower.includes(goalText)) {
        maxScore = Math.max(maxScore, goal.priority || 0.5);
        continue;
      }

      const goalWords = goalText.split(/\s+/).filter((w) => w.length > 3);
      for (const word of goalWords) {
        if (memLower.includes(word)) {
          maxScore = Math.max(maxScore, (goal.priority || 0.5) * 0.6);
          break;
        }
      }
    }

    return maxScore;
  }

  _reflectionBoost(memory, reflectionActions) {
    if (!reflectionActions || reflectionActions.length === 0) return 0;

    const memId = memory.id;
    const memContent = (memory.content || '').toLowerCase();

    for (const action of reflectionActions) {
      if (action.memoryId === memId || action.targetMemoryId === memId) {
        return 1.0;
      }

      const actionContent = (action.content || action.newContent || '').toLowerCase();
      if (actionContent && memContent && actionContent === memContent) {
        return 0.9;
      }

      if (action.type === 'verify_memory') {
        const targetContent = (action.targetContent || '').toLowerCase();
        if (targetContent && memContent.includes(targetContent)) {
          return 0.7;
        }
      }
    }

    return 0;
  }

  _clusterCoherence(memory, semanticClusters) {
    if (!semanticClusters || semanticClusters.length === 0 || !memory.semantic_cluster_id) return 0;

    const cluster = semanticClusters.find(c => c.id === memory.semantic_cluster_id);
    if (!cluster) return 0;

    const count = cluster.memory_count || 1;
    if (count >= 10) return 1.0;
    if (count >= 5) return 0.7;
    if (count >= 3) return 0.4;
    return 0.2;
  }

  _verificationBonus(memory) {
    const mentions = memory.mentions || 1;
    if (mentions >= 5) return 1.0;
    if (mentions >= 3) return 0.7;
    if (mentions >= 2) return 0.4;
    return 0;
  }

  _relationshipBoost(memory, relationship) {
    const memContent = (memory.content || '').toLowerCase();
    let boost = 0;

    if (relationship.sensitiveTopics) {
      for (const topic of relationship.sensitiveTopics) {
        if (memContent.includes(topic.toLowerCase())) {
          boost = relationship.trustLevel > 0.5 ? 0.3 : -0.3;
          break;
        }
      }
    }

    if (relationship.favoriteTopics) {
      for (const topic of relationship.favoriteTopics) {
        if (memContent.includes(topic.toLowerCase())) {
          boost = 0.5;
          break;
        }
      }
    }

    return boost;
  }
}

module.exports = { ContextRanker, DEFAULT_CONFIG, SCORE_WEIGHTS };
