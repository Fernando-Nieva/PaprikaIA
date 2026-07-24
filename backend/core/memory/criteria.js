/**
 * Memory criteria — define qué información merece ser recordada.
 *
 * En Fase 1: todo se marca como shouldRemember: false (no se guarda nada nuevo).
 * En Fase 4: se aplicarán las reglas completas.
 */

const REMEMBER_PATTERNS = {
  // Información que SÍ se debe recordar
  alwaysRemember: [
    /me llamo\s+(\w+)/i,
    /soy\s+(\w+)/i,
    /tengo\s+\d+\s+años/i,
    /vivo en/i,
    /me gusta/i,
    /me encanta/i,
    /odio/i,
    /necesito/i,
    /importante/i,
    /no me olvides/i,
    /acordate/i,
    /recordá/i
  ],

  // Información que NUNCA se debe recordar
  neverRemember: [
    /^(hola|buenas|hey|che|que onda)/i,
    /^(gracias|de nada|ok|dale|bien|genial)/i,
    /^\?+$/,
    /^.{0,5}$/ // mensajes muy cortos
  ]
};

/**
 * Evalúa si un mensaje debe ser recordado.
 * @param {string} message - Mensaje del usuario
 * @param {Object} analysis - Análisis del MessageAnalyzer
 * @returns {boolean}
 */
function shouldRemember(message, analysis) {
  // Fase 1: no guardar nada
  return false;

  // Fase 4: lógica completa
  // for (const pattern of REMEMBER_PATTERNS.neverRemember) {
  //   if (pattern.test(message)) return false;
  // }
  // for (const pattern of REMEMBER_PATTERNS.alwaysRemember) {
  //   if (pattern.test(message)) return true;
  // }
  // return analysis.intensity > 0.7;
}

module.exports = { shouldRemember, REMEMBER_PATTERNS };
