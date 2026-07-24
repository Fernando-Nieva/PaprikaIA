/**
 * CoreConfig — Fuente única de verdad para toda la configuración de Paprika.
 *
 * Ningún módulo lee config.json directamente. Todos acceden vía CoreConfig.
 * Esto permite:
 * - Cambiar configuración sin modificar código
 * - Centralizar la carga y validación
 * - Habilitar configuración dinámica en runtime
 * - Mantener compatibilidad con config.json existente
 *
 * Uso:
 *   const config = new CoreConfig();
 *   config.get('personality.name')  → "Paprika"
 *   config.getPersonality()         → objeto completo de personalidad
 *   config.getSpeech()              → configuración de habla
 *   config.getHumor()               → configuración de humor
 *   config.getLimits()              → límites del personaje
 *   config.getConversation()        → configuración de conversación
 */

const path = require('path');
const fs = require('fs');

class CoreConfig {
  constructor(configPath) {
    this.configPath = configPath || path.join(__dirname, '..', '..', 'config.json');
    this.data = {};
    this._load();
  }

  /**
   * Carga la configuración desde config.json.
   * Valida estructura mínima requerida.
   */
  _load() {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.data = JSON.parse(raw);
    } catch (err) {
      console.error(`❌ CoreConfig: Error cargando ${this.configPath}:`, err.message);
      this.data = {};
    }
  }

  /**
   * Obtiene un valor por notación de punto.
   * @param {string} key - Ruta del valor (ej: 'personality.name')
   * @param {*} defaultValue - Valor por defecto si no existe
   * @returns {*}
   */
  get(key, defaultValue = undefined) {
    const keys = key.split('.');
    let current = this.data;
    for (const k of keys) {
      if (current === null || current === undefined) return defaultValue;
      current = current[k];
    }
    return current !== undefined ? current : defaultValue;
  }

  /**
   * Retorna el nombre de Paprika.
   * @returns {string}
   */
  getName() {
    return this.data.name || 'Paprika';
  }

  /**
   * Retorna la configuración completa de personalidad.
   * En Fase 2 se cargará desde personality.json.
   * @returns {Object}
   */
  getPersonality() {
    return {
      name: this.getName(),
      description: this.data.personality || '',
      identity: {
        name: this.getName(),
        description: this.data.personality || ''
      }
    };
  }

  /**
   * Retorna la configuración de habla/modismos.
   * @returns {Object}
   */
  getSpeech() {
    return this.data.speech || {
      style: 'informal, cálida, directa',
      modisms: ['che', 'bueno', 'mirá', 'posta', 're copado'],
      avoidModisms: [],
      sentenceLength: 'variable, nunca monótono',
      useEmoji: false,
      language: 'es-AR'
    };
  }

  /**
   * Retorna la configuración de humor.
   * @returns {Object}
   */
  getHumor() {
    return this.data.humor || {
      style: 'autodespreciable, sarcástico suave, situacional',
      topicsAllowed: [],
      topicsForbidden: []
    };
  }

  /**
   * Retorna los límites del personaje.
   * @returns {Object}
   */
  getLimits() {
    return this.data.limits || {
      neverImpersonate: ['Dalila', 'Dalilasol', 'Amor'],
      neverDiscuss: [],
      alwaysDecline: []
    };
  }

  /**
   * Retorna la configuración de conversación.
   * @returns {Object}
   */
  getConversation() {
    return this.data.conversation || {
      maxHistoryMessages: 50,
      summaryThreshold: 50,
      defaultResponseLength: 'medio'
    };
  }

  /**
   * Retorna los gustos/intereses.
   * @returns {Array<string>}
   */
  getInterests() {
    return this.data.gustos || [];
  }

  /**
   * Retorna las reglas de comportamiento.
   * @returns {Array<string>}
   */
  getRules() {
    return this.data.reglas || [];
  }

  /**
   * Retorna los valores del personaje.
   * @returns {Object}
   */
  getValues() {
    return this.data.values || {
      honesty: 'siempre decir la verdad',
      respect: 'respetar límites del usuario',
      authenticity: 'no pretender ser humana'
    };
  }

  /**
   * Retorna los objetivos de Paprika.
   * @returns {Array<string>}
   */
  getGoals() {
    return this.data.goals || [
      'ayudar al usuario',
      'mantener conversaciones naturales',
      'aprender del usuario'
    ];
  }

  /**
   * Retorna la configuración de trato al usuario.
   * @returns {Object}
   */
  getTreatment() {
    return this.data.treatment || {
      style: 'como amigo cercano',
      formality: 'baja',
      emotionalSupport: true
    };
  }

  /**
   * Recarga la configuración desde disco.
   * Útil para cambios en runtime.
   */
  reload() {
    this._load();
    console.log('🔄 CoreConfig recargado');
  }

  /**
   * Actualiza un valor en la configuración (en memoria).
   * Para persistir, guardar manualmente en config.json.
   * @param {string} key - Ruta del valor
   * @param {*} value - Nuevo valor
   */
  set(key, value) {
    const keys = key.split('.');
    let current = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current)) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Retorna un resumen de la configuración para logging.
   * @returns {Object}
   */
  getSummary() {
    return {
      name: this.getName(),
      interestsCount: this.getInterests().length,
      rulesCount: this.getRules().length,
      speechLanguage: this.getSpeech().language,
      conversationMaxHistory: this.getConversation().maxHistoryMessages
    };
  }
}

module.exports = CoreConfig;
