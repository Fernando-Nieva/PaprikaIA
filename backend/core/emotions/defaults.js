/**
 * Default emotional state values for Paprika.
 * These serve as the baseline (homeostasis) that the Emotion Engine
 * decays toward over time. All values are 0-1.
 *
 * Emotional states are NOT real emotions — they are tuning variables
 * that modify the tone of generated responses.
 */

const DEFAULT_EMOTIONAL_STATE = {
  energy: 0.7,
  happiness: 0.8,
  empathy: 0.9,
  nostalgia: 0.3,
  curiosity: 0.8,
  trust: 0.5,
  enthusiasm: 0.7,
  serenity: 0.6,
  fatigue: 0.2,
};

module.exports = { DEFAULT_EMOTIONAL_STATE };
