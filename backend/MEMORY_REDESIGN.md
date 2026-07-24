# Memory System Redesign Plan — Paprika

## Architecture Analysis

### Current State
The memory system has 6 core modules:
- **MemoryManager** (storage/update) — 321 lines, 9 memory types
- **MemorySearch/HybridRetriever** (retrieval) — 724 lines, 6-factor scoring
- **MemoryClassifier** (extraction) — 600 lines, rule-based pattern matching
- **MemoryConsolidation** (merge/decay) — 619 lines, Union-Find + Jaccard merge
- **WorkingMemory** (current conversation) — 175 lines, token-limited window
- **ArchiveMemory** (old conversations) — 323 lines, extractive summaries
- **ReflectionEngine** (post-response) — 972 lines, 8 rule-based checks
- **ContextRanker** (final ranking) — 684 lines, 6-factor scoring

### DB Schema (memories table)
```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  user_id TEXT, type TEXT, content TEXT,
  embedding BLOB, importance REAL, confidence REAL,
  created_at DATETIME, last_accessed DATETIME,
  access_count INTEGER, decay_factor REAL
);
```

### Key Gaps Identified
1. **Reflection** generates actions but Pipeline doesn't execute them (steps 16→17 disconnect)
2. **Importance** is static — set once by classifier, only decays, never learns
3. **Compression** uses longest-content heuristic, not real summarization
4. **Sleep cycle** runs consolidation every message (expensive), no off-peak optimization
5. **Metadata** is minimal — no source conversation, no mention history, no semantic clusters
6. **Retrieval** has redundancy: MemorySearch.search() and MemoryManager.retrieve() coexist

---

## Design Decisions

### D1: Extend DB Schema (not replace)
**Decision:** ALTER TABLE memories to add new columns. Add new tables for clusters.
**Why:** Existing data must survive. SQLite supports ADD COLUMN IF NOT EXISTS via the existing migration pattern. No data loss, no migration scripts.

### D2: Reflection Engine stays rule-based
**Decision:** Keep the existing pattern-matching approach. Don't add LLM calls.
**Why:** The ReflectionEngine is synchronous and fast. Adding LLM calls would make it async, slow, and expensive. The current 8-check architecture is solid — we enhance the OUTPUT (what actions it produces) not the INPUT.

### D3: Importance uses multiplicative formula
**Decision:** `new_importance = base * frequency_factor * recency_factor * emotional_factor * goal_factor * relationship_factor`
**Why:** Multiplicative models naturally suppress irrelevant memories (any low factor pulls the whole score down) while preserving ones that score well across all dimensions. This matches how human memory works — you remember things that are frequent AND recent AND emotionally significant AND goal-relevant.

### D4: Sleep cycle uses conversation count trigger
**Decision:** Every N conversations (default: 10), run the full sleep cycle.
**Why:** Time-based triggers are unreliable (user might not chat for days). Conversation count is a natural proxy for "enough new data to process". The number 10 balances between: (a) enough new memories to justify consolidation, and (b) not too many to keep stale data.

### D5: Semantic clustering via embedding proximity
**Decision:** Use FastEmbed cosine similarity to group memories into semantic clusters. Store cluster assignments in a new `memory_clusters` table.
**Why:** This is how ChatGPT/Claude organize memories — by topic/theme, not just category. Two memories about "React" and "TypeScript" are semantically close even though they're different categories.

### D6: Memory Compression uses extractive summarization
**Decision:** When merging N memories, extract the most informative sentences from each, combine into a single richer memory.
**Why:** We can't call an LLM for every merge (expensive). Extractive summarization (selecting the best sentences) is fast, deterministic, and produces good results for short memory texts.

### D7: ContextRanker becomes the single retrieval orchestrator
**Decision:** Move all retrieval logic into ContextRanker.rank(). MemorySearch becomes a low-level retrieval primitive. ContextRanker calls MemorySearch, KnowledgeGraph, GoalEngine, RelationshipEngine, ReflectionEngine itself.
**Why:** Currently the Pipeline manually calls each module and passes results to ContextRanker. This creates tight coupling and makes it hard to add new retrieval sources. Centralizing orchestration in ContextRanker follows the Single Responsibility Principle.

---

## Implementation Plan

### Phase 1: Database Schema Extension
**Files:** `db.js`

Add to memories table:
```sql
ALTER TABLE memories ADD COLUMN source_conversation_id INTEGER;
ALTER TABLE memories ADD COLUMN last_verified DATETIME;
ALTER TABLE memories ADD COLUMN mentions INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN confidence_history TEXT DEFAULT '[]';
ALTER TABLE memories ADD COLUMN reason TEXT;
ALTER TABLE memories ADD COLUMN semantic_cluster_id INTEGER;
```

New table:
```sql
CREATE TABLE IF NOT EXISTS memory_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  label TEXT,
  centroid_embedding BLOB,
  memory_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

New table:
```sql
CREATE TABLE IF NOT EXISTS memory_sleep_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation_count_at_run INTEGER,
  memories_merged INTEGER DEFAULT 0,
  memories_decayed INTEGER DEFAULT 0,
  memories_removed INTEGER DEFAULT 0,
  clusters_updated INTEGER DEFAULT 0,
  importance_recalculated INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Phase 2: Reflection Engine Enhancement
**Files:** `core/reflection/index.js`

Add 3 new checks to the reflect() method:

1. **`_checkTemporalClassification(analysis, response)`**
   - Detect if new information is temporary (event, date) vs permanent (fact, preference)
   - Set `temporalType: 'temporary' | 'permanent' | 'evolving'` on memory actions
   - Reasoning: events/dates are temporary, preferences/facts are permanent, relationships evolve

2. **`_checkMemoryVerification(analysis, memories)`**
   - When user confirms something ("sí, exacto", "así es"), mark related memories as verified
   - Boost confidence of verified memories by +0.1
   - Update `last_verified` timestamp

3. **`_checkImportanceRecalculation(memories, emotionalState, goals, relationship)`**
   - For each existing memory, compute a new importance score based on current context
   - Only recalculate if the delta is > 0.05 (avoid noise)
   - Output: `UPDATE_MEMORY` actions with new importance values

Update action builders to include new metadata fields.

### Phase 3: Memory Compression (Enhanced Consolidation)
**Files:** `core/memory/consolidation.js`

Rewrite `_createMergedMemory(group)`:

1. **Extractive summarization:** For each memory in the group, extract the most information-dense sentence (longest sentence that isn't a duplicate of another)
2. **Combine:** Join extracted sentences with "; " separator
3. **Metadata merge:** Combine confidence_history, increment mentions, take max importance
4. **Cluster assignment:** Assign merged memory to the most relevant semantic cluster

Add new method: `_extractBestSentences(text, maxSentences = 3)`
- Split by sentence boundaries (. ! ?)
- Score each sentence by: length (longer = more info) + keyword density (entities, proper nouns)
- Return top N sentences

Add new method: `_assignToCluster(memory, userId)`
- If memory has embedding, find nearest cluster centroid
- If distance < threshold, assign to existing cluster
- Otherwise, create new cluster

### Phase 4: Dynamic Importance Recalculation
**Files:** `core/memory/importance.js` (NEW)

New module: `MemoryImportanceCalculator`

```
calculateImportance(memory, context) → number
```

Formula:
```
base = memory.importance (current value)
frequencyFactor = min(memory.mentions / 5, 1.0)  // 5+ mentions = max
recencyFactor = 1.0 - (daysSinceAccess / 90)     // linear decay over 90 days
emotionalFactor = emotionalWeight(memory, context) // 0-1 based on emotional context
goalFactor = goalRelevance(memory, context)         // 0-1 based on active goals
relationshipFactor = relationshipBoost(memory, context) // 0-1

newImportance = clamp(base * 0.2 + frequencyFactor * 0.2 + recencyFactor * 0.15
                    + emotionalFactor * 0.2 + goalFactor * 0.15 + relationshipFactor * 0.1)
```

`emotionalWeight(memory, context)`:
- If memory.content contains emotion keywords matching current user emotion → 1.0
- If memory.type is 'experience' or 'emotion' and user is emotional → 0.8
- Otherwise → 0.3

`goalRelevance(memory, context)`:
- Check if memory.content words overlap with any active goal content
- Weight by goal.priority
- Return max across all goals

### Phase 5: Memory Sleep Cycle
**Files:** `core/memory/sleep.js` (NEW)

New module: `MemorySleepCycle`

```
class MemorySleepCycle {
  constructor(db, memoryManager, memorySearch, memoryConsolidation, 
              importanceCalculator, embeddingService, knowledgeGraph)
  
  shouldRun(userId) → boolean
  // Returns true if conversationsSinceLastRun >= config.sleepInterval (default 10)
  
  run(userId) → SleepResult
  // Full sleep cycle:
  // 1. Re-ranking: recalculate importance for all memories
  // 2. Consolidation: merge similar memories (existing logic)
  // 3. Cleanup: remove obsolete memories
  // 4. Re-embedding: regenerate embeddings for memories that lost theirs
  // 5. Cluster update: recompute semantic clusters
  // 6. Log results
}
```

Trigger: In Pipeline step 22, after consolidation:
```js
if (this.sleepCycle.shouldRun(userId)) {
  const sleepResult = await this.sleepCycle.run(userId);
  // Log to memory_sleep_log table
}
```

### Phase 6: Memory Metadata Enrichment
**Files:** `core/memory/index.js`, `core/memory/classifier.js`

Update MemoryManager.store() to accept and persist new fields:
- `source_conversation_id` — which conversation created this memory
- `reason` — why this memory was stored (from classifier reasoning)
- `mentions` — starts at 1, incremented on update

Update MemoryClassifier._makeDecision() to:
- Pass `source_conversationId` through to the memory
- When updating existing memory, increment `mentions` counter
- Append to `confidence_history` array: `{confidence, timestamp}`

Update MemoryManager.update() to:
- Append to `confidence_history` when confidence changes
- Update `last_verified` when memory is confirmed by user

### Phase 7: ContextRanker as Orchestrator
**Files:** `core/context/ranker.js`, `core/pipeline.js`

Enhance ContextRanker.rank() to accept and process:
```js
rank({
  // Existing inputs
  analysis, memories, relationship, emotionalState, 
  knowledge, goals, summary, history, classifiedMemories,
  // New inputs
  reflectionActions,    // from ReflectionEngine
  semanticClusters,     // from MemoryClusters
  graphContext,         // from GraphRetriever
})
```

Add to ranking formula:
- **Reflection boost:** memories mentioned in reflection actions get +0.1
- **Cluster coherence:** memories in the same cluster as other high-ranking memories get +0.05
- **Verification bonus:** verified memories (last_verified is recent) get +0.05

Simplify Pipeline steps 6-10:
- Pipeline calls ContextRanker with ALL raw data
- ContextRanker internally calls MemorySearch, KnowledgeGraph, etc.
- Pipeline receives fully ranked context

### Phase 8: Retrieval Deduplication
**Files:** `core/memory/index.js`, `core/pipeline.js`

- Remove MemoryManager.retrieve() — it's superseded by MemorySearch.search()
- Remove MemoryManager.searchByContent() — keep only for MemoryClassifier internal use
- Pipeline step 6 uses ONLY MemorySearch.search()
- MemorySearch.search() becomes the single retrieval entry point

---

## File Change Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `db.js` | ALTER TABLE + 2 new tables | ~40 |
| `core/memory/importance.js` | NEW | ~120 |
| `core/memory/sleep.js` | NEW | ~200 |
| `core/reflection/index.js` | Add 3 checks + update builders | ~150 |
| `core/memory/consolidation.js` | Rewrite merge + cluster assignment | ~100 |
| `core/memory/index.js` | Metadata enrichment + remove retrieve() | ~80 |
| `core/memory/classifier.js` | Pass source_conversation + mentions | ~30 |
| `core/context/ranker.js` | Add new inputs + scoring factors | ~80 |
| `core/pipeline.js` | Simplify steps 6-10 + add sleep trigger | ~60 |
| `core/index.js` | Wire new modules | ~20 |

**Total estimated:** ~880 lines changed/added across 10 files.

---

## Execution Order

1. **Phase 1** (DB) — Foundation, no dependencies
2. **Phase 6** (Metadata) — Extends existing store/update, no new modules
3. **Phase 2** (Reflection) — Enhances existing module, depends on Phase 6 for new fields
4. **Phase 4** (Importance Calculator) — New module, depends on Phase 1 schema
5. **Phase 3** (Compression) — Enhances existing consolidation, depends on Phase 1 + Phase 4
6. **Phase 5** (Sleep Cycle) — New module, depends on Phase 3 + Phase 4
7. **Phase 7** (ContextRanker) — Enhances existing ranker, depends on Phase 2 + Phase 5
8. **Phase 8** (Dedup) — Cleanup, depends on Phase 7
9. **Wire in core/index.js + pipeline.js** — Final integration
