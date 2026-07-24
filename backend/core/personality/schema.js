/**
 * Personality schema definition.
 * Define la estructura que debe seguir personality.json.
 *
 * En Fase 2 se cargará desde personality.json.
 * En Fase 1 se usa config.json como fallback.
 */

const PERSONALITY_SCHEMA = {
  identity: {
    name: 'string (required)',
    age: 'string',
    origin: 'string',
    description: 'string (required)'
  },
  speech: {
    style: 'string (required)',
    modisms: 'string[]',
    avoidModisms: 'string[]',
    sentenceLength: 'string',
    useEmoji: 'boolean',
    language: 'string'
  },
  humor: {
    style: 'string',
    topicsAllowed: 'string[]',
    topicsForbidden: 'string[]'
  },
  values: {
    honesty: 'string',
    respect: 'string',
    authenticity: 'string'
  },
  interests: 'string[]',
  limits: {
    neverImpersonate: 'string[]',
    neverDiscuss: 'string[]',
    alwaysDecline: 'string[]'
  },
  goals: 'string[]',
  treatment: {
    style: 'string',
    formality: 'string',
    emotionalSupport: 'boolean'
  }
};

module.exports = { PERSONALITY_SCHEMA };
