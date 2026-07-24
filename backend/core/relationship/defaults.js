/**
 * Default relationship values for new users.
 *
 * Every field here represents a property tracked by the RelationshipEngine.
 * Values are chosen to represent a first-contact scenario:
 * low trust, low familiarity, neutral humor, cautious formality.
 */

const DEFAULT_RELATIONSHIP = {
  // ── Core metrics (0-1) ──
  trustLevel: 0.3,
  familiarity: 0.1,
  humorAllowed: 0.5,
  emotionalOpenness: 0.3,

  // ── Interaction stats ──
  conversationCount: 0,
  interactionFrequency: 0.5,
  lastInteraction: null,

  // ── Topic tracking ──
  topicsDiscussed: [],
  sensitiveTopics: [],
  favoriteTopics: [],

  // ── Personalization ──
  nicknames: {},
  preferredStyle: 'informal',
  formalityLevel: 0.3,
  insideJokes: [],

  // ── Legacy preferences (kept for backwards compat) ──
  preferences: {
    responseLength: 'medio',
    formality: 'baja'
  }
};

module.exports = { DEFAULT_RELATIONSHIP };
