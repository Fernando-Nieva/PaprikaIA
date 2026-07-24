/**
 * SemanticSearch — Fase 4 (stub)
 *
 * Búsqueda de recuerdos por significado usando embeddings.
 * En Fase 1 retorna array vacío (no hay recuerdos que buscar).
 * En Fase 4 se implementará con fastembed o alternativa ligera.
 */

class SemanticSearch {
  constructor(db) {
    this.db = db;
  }

  /**
   * Busca recuerdos semánticamente similares al query.
   *
   * @param {string} query - Texto de búsqueda (mensaje del usuario)
   * @param {string} userId - ID del usuario
   * @param {number} topK - Cantidad máxima de resultados
   * @returns {Array} Recuerdos relevantes ordenados por similitud
   */
  search(query, userId, topK = 5) {
    // Fase 1: no hay recuerdos, retornar vacío
    return [];

    // Fase 4: lógica completa con embeddings
    // const queryEmbedding = await this.embedder.embed(query);
    // const memories = this.db.getMemoriesByUser(userId);
    // const scored = memories.map(m => ({
    //   ...m,
    //   similarity: cosineSimilarity(queryEmbedding, m.embedding)
    // }));
    // return scored
    //   .sort((a, b) => b.similarity - a.similarity)
    //   .slice(0, topK);
  }

  /**
   * Genera un embedding para un texto.
   * @param {string} text
   * @returns {Float32Array}
   */
  async embed(text) {
    // Fase 4: usar fastembed
    return new Float32Array(384); // placeholder
  }
}

module.exports = SemanticSearch;
