/**
 * MessageAnalyzer — Analizador de mensajes del usuario
 *
 * Fuente única de verdad para interpretar mensajes.
 * Analiza CADA mensaje antes de enviarlo al modelo.
 *
 * Detecta:
 * - Intención (pregunta, comando, saludo, despedida, emoción, etc.)
 * - Tema (tecnología, personal, música, arte, etc.)
 * - Emoción del usuario (valencia, arousal, emoción dominante)
 * - Entidades (personas, lugares, fechas, proyectos)
 * - Intensidad emocional (0-1)
 * - Si el mensaje debe ser recordado (shouldRemember)
 * - Idioma del mensaje
 *
 * El objeto de análisis se consume en:
 * - EmotionEngine: para actualizar el estado emocional de Paprika
 * - MemoryManager: para decidir qué recordar
 * - ContextBuilder: para construir el contexto
 * - PersonalityEngine: para ajustar el tono
 * - RelationshipEngine: para actualizar la relación
 *
 * Ningún otro módulo analiza el mensaje por su cuenta.
 */

const {
  INTENT_PATTERNS,
  EMOTION_KEYWORDS,
  TOPIC_KEYWORDS,
  ENTITY_PATTERNS,
  INTENSITY_MARKERS,
  IMPORTANCE_PATTERNS
} = require('./patterns');

class MessageAnalyzer {
  /**
   * @param {CoreConfig} config - Configuración centralizada
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Analiza un mensaje y retorna un objeto estructurado.
   *
   * @param {string} message - Mensaje del usuario
   * @param {Array} history - Historial reciente de mensajes [{role, content}]
   * @returns {Object} Análisis estructurado del mensaje
   */
  analyze(message, history = []) {
    if (!message || typeof message !== 'string') {
      return this._emptyAnalysis(message);
    }

    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();

    // Detectar todos los aspectos en paralelo
    const intent = this._detectIntent(trimmed, lower);
    const topic = this._detectTopic(trimmed, lower);
    const emotion = this._detectEmotion(trimmed, lower);
    const entities = this._extractEntities(trimmed);
    const intensity = this._calculateIntensity(trimmed, lower, emotion);
    const language = this._detectLanguage(trimmed);
    const shouldRemember = this._shouldRemember(trimmed, lower, intent, emotion, intensity);
    const importance = this._calculateImportance(trimmed, lower, intent, emotion, intensity, entities);

    // Calcular confianza general del análisis
    const confidence = this._calculateConfidence(trimmed, lower, intent, topic, emotion, entities);

    // Generar reasoning (explicación del análisis)
    const reasoning = this._generateReasoning(trimmed, intent, topic, emotion, entities, importance, shouldRemember);

    return {
      rawMessage: trimmed,
      intent,
      topic,
      emotionalState: emotion,
      entities,
      intensity,
      importance,
      shouldRemember,
      language,
      confidence,
      reasoning
    };
  }

  // ─────────────────────────────────────────────
  //  Detección de intención
  // ─────────────────────────────────────────────

  _detectIntent(message, lower) {
    // Verificar en orden de prioridad
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          return this._normalizeIntent(intent);
        }
      }
    }
    return 'conversation';
  }

  _normalizeIntent(intent) {
    const map = {
      question: 'question',
      command: 'command',
      greeting: 'greeting',
      farewell: 'farewell',
      memory_request: 'memory_request',
      emotion_expression: 'emotion'
    };
    return map[intent] || 'conversation';
  }

  // ─────────────────────────────────────────────
  //  Detección de tema
  // ─────────────────────────────────────────────

  _detectTopic(message, lower) {
    const scores = {};

    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          score++;
        }
      }
      if (score > 0) {
        scores[topic] = score;
      }
    }

    // Retornar el tema con mayor puntuación
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      return sorted[0][0];
    }

    // Detectar temas derivados del contexto
    if (this._isPersonalQuestion(lower)) return 'personal';
    if (this._isAboutPaprika(lower)) return 'paprika_meta';

    return null;
  }

  _isPersonalQuestion(lower) {
    return /cómo\s+(estás|te\s+sientes|te\s+va)/i.test(lower) ||
           /qué\s+pensás/i.test(lower) ||
           /contame\s+sobre\s+vos/i.test(lower) ||
           /de\s+qué\s+trata\s+tu\s+vida/i.test(lower);
  }

  _isAboutPaprika(lower) {
    return /quién\s+sos/i.test(lower) ||
           /qué\s+sos/i.test(lower) ||
           /cómo\s+funcionás/i.test(lower) ||
           /para\s+qué\s+servís/i.test(lower);
  }

  // ─────────────────────────────────────────────
  //  Detección de emoción
  // ─────────────────────────────────────────────

  _detectEmotion(message, lower) {
    let valence = 0;   // -1 (negativo) a 1 (positivo)
    let arousal = 0.5;  // 0 (calmado) a 1 (intenso)
    let dominant = null;
    let confidence = 0;

    // Buscar emociones específicas
    const specificScores = {};
    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS.specific)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          specificScores[emotion] = (specificScores[emotion] || 0) + 1;
        }
      }
    }

    // Determinar emoción dominante
    const sortedEmotions = Object.entries(specificScores).sort((a, b) => b[1] - a[1]);
    if (sortedEmotions.length > 0) {
      dominant = sortedEmotions[0][0];
      confidence = Math.min(sortedEmotions[0][1] / 3, 1);
    }

    // Calcular valencia
    let positiveCount = 0;
    let negativeCount = 0;

    for (const [level, keywords] of Object.entries(EMOTION_KEYWORDS.positive)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          positiveCount += level === 'high' ? 3 : level === 'medium' ? 2 : 1;
        }
      }
    }

    for (const [level, keywords] of Object.entries(EMOTION_KEYWORDS.negative)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          negativeCount += level === 'high' ? 3 : level === 'medium' ? 2 : 1;
        }
      }
    }

    if (positiveCount > 0 || negativeCount > 0) {
      valence = (positiveCount - negativeCount) / Math.max(positiveCount + negativeCount, 1);
    }

    // Calcular arousal basado en intensidad y exclamaciones
    const exclamationCount = (message.match(/!/g) || []).length;
    const capsRatio = (message.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / message.length) || 0;
    arousal = Math.min(0.5 + (exclamationCount * 0.1) + (capsRatio * 0.3), 1);

    // Ajustar arousal por palabras de intensidad
    for (const keyword of INTENSITY_MARKERS.high) {
      if (lower.includes(keyword.toLowerCase())) {
        arousal = Math.min(arousal + 0.15, 1);
      }
    }

    return {
      valence: Math.round(valence * 100) / 100,
      arousal: Math.round(arousal * 100) / 100,
      dominant,
      confidence: Math.round(confidence * 100) / 100,
      positiveSignals: positiveCount,
      negativeSignals: negativeCount
    };
  }

  // ─────────────────────────────────────────────
  //  Extracción de entidades
  // ─────────────────────────────────────────────

  _extractEntities(message) {
    const entities = {
      people: [],
      places: [],
      dates: [],
      projects: []
    };

    // Extraer personas (nombres propios después de preposiciones)
    const peoplePatterns = [
      /\bcon\s+([A-Z][a-záéíóúñ]+)\b/g,
      /\bpara\s+([A-Z][a-záéíóúñ]+)\b/g,
      /\bhablé\s+con\s+([A-Z][a-záéíóúñ]+)\b/g,
      /\bme\s+dijo\s+([A-Z][a-záéíóúñ]+)\b/g
    ];

    for (const pattern of peoplePatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        const name = match[1];
        if (name && !entities.people.includes(name) && name.length > 2) {
          entities.people.push(name);
        }
      }
    }

    // Extraer lugares
    const placePatterns = [
      /\ben\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g,
      /\bfui\s+a\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g,
      /\bvivo\s+en\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g
    ];

    for (const pattern of placePatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        const place = match[1];
        if (place && !entities.places.includes(place) && place.length > 2) {
          entities.places.push(place);
        }
      }
    }

    // Extraer fechas
    const datePatterns = [
      /\bhoy\b/i,
      /\bayer\b/i,
      /\bmañana\b/i,
      /\bpasado\s+mañana\b/i,
      /\besta\s+semana\b/i
    ];

    for (const pattern of datePatterns) {
      const match = message.match(pattern);
      if (match && !entities.dates.includes(match[0])) {
        entities.dates.push(match[0]);
      }
    }

    // Extraer proyectos/archivos
    const projectPatterns = [
      /["""]([^"""]+)["""]/g,
      /'([^']+)'/g,
      /\b(\w+\.\w{2,4})\b/g
    ];

    for (const pattern of projectPatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        const project = match[1];
        if (project && !entities.projects.includes(project) && project.length > 2) {
          entities.projects.push(project);
        }
      }
    }

    return entities;
  }

  // ─────────────────────────────────────────────
  //  Cálculo de intensidad
  // ─────────────────────────────────────────────

  _calculateIntensity(message, lower, emotion) {
    let intensity = 0.5;

    // Exclamaciones
    const exclamations = (message.match(/!/g) || []).length;
    intensity += exclamations * 0.1;

    // Mayúsculas
    const capsRatio = (message.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / message.length) || 0;
    intensity += capsRatio * 0.3;

    // Palabras de alta intensidad
    for (const keyword of INTENSITY_MARKERS.high) {
      if (lower.includes(keyword.toLowerCase())) {
        intensity += 0.15;
      }
    }

    // Palabras de media intensidad
    for (const keyword of INTENSITY_MARKERS.medium) {
      if (lower.includes(keyword.toLowerCase())) {
        intensity += 0.05;
      }
    }

    // Emoción detectada aumenta intensidad
    if (emotion && emotion.confidence > 0.5) {
      intensity += 0.1;
    }

    // Normalizar entre 0 y 1
    return Math.min(Math.max(Math.round(intensity * 100) / 100, 0), 1);
  }

  // ─────────────────────────────────────────────
  //  Detección de idioma
  // ─────────────────────────────────────────────

  _detectLanguage(message) {
    const lower = message.toLowerCase();

    // Palabras comunes en español
    const spanishWords = ['hola', 'cómo', 'qué', 'dónde', 'cuándo', 'por qué', 'quiero', 'puedo', 'necesito', 'tengo', 'soy', 'estoy', 'hay', 'sí', 'no', 'bien', 'mal', 'gracias', 'por favor'];
    const englishWords = ['hello', 'how', 'what', 'where', 'when', 'why', 'want', 'can', 'need', 'have', 'am', 'is', 'are', 'yes', 'no', 'good', 'bad', 'thanks', 'please'];

    let spanishScore = 0;
    let englishScore = 0;

    for (const word of spanishWords) {
      if (lower.includes(word)) spanishScore++;
    }
    for (const word of englishWords) {
      if (lower.includes(word)) englishScore++;
    }

    // Detectar acentos (español tiene más)
    const hasAccents = /[áéíóúñ]/i.test(message);
    if (hasAccents) spanishScore += 3;

    return spanishScore >= englishScore ? 'es' : 'en';
  }

  // ─────────────────────────────────────────────
  //  Decisión de si recordar
  // ─────────────────────────────────────────────

  _shouldRemember(message, lower, intent, emotion, intensity) {
    // No recordar mensajes muy cortos
    if (message.length < 5) return false;

    // No recordar saludos simples
    if (intent === 'greeting' || intent === 'farewell') return false;

    // No recordar confirmaciones simples
    if (/^(ok|dale|bien|genial|Perfecto|jaja|jeje|xd|👍|❤|😂)$/i.test(message)) return false;

    // Recordar si hay alta importancia
    for (const pattern of IMPORTANCE_PATTERNS.high) {
      if (pattern.test(message)) return true;
    }

    // Recordar si hay emoción fuerte
    if (emotion && emotion.confidence > 0.6) return true;

    // Recordar si alta intensidad
    if (intensity > 0.7) return true;

    // Recordar información personal
    if (/me\s+llamo|soy\s+\w+|tengo\s+\d+\s+años|vivo\s+en/i.test(message)) return true;

    // Recordar preferencias
    if (/me\s+(gusta|encanta|odio|amo)\s+/i.test(message)) return true;

    // No recordar por defecto
    return false;
  }

  // ─────────────────────────────────────────────
  //  Cálculo de importancia
  // ─────────────────────────────────────────────

  _calculateImportance(message, lower, intent, emotion, intensity, entities) {
    let importance = 0.3; // Base

    // Intención
    if (intent === 'command') importance += 0.1;
    if (intent === 'memory_request') importance += 0.3;
    if (intent === 'emotion') importance += 0.15;

    // Emoción
    if (emotion && emotion.confidence > 0.5) importance += 0.15;
    if (emotion && emotion.confidence > 0.8) importance += 0.1;

    // Intensidad
    importance += intensity * 0.2;

    // Entidades
    if (entities.people.length > 0) importance += 0.1;
    if (entities.places.length > 0) importance += 0.05;
    if (entities.projects.length > 0) importance += 0.05;

    // Patrones de alta importancia
    for (const pattern of IMPORTANCE_PATTERNS.high) {
      if (pattern.test(message)) {
        importance += 0.2;
        break;
      }
    }

    // Patrones de baja importancia
    for (const pattern of IMPORTANCE_PATTERNS.low) {
      if (pattern.test(message)) {
        importance -= 0.2;
        break;
      }
    }

    // Longitud del mensaje (mensajes largos suelen ser más importantes)
    if (message.length > 100) importance += 0.1;
    if (message.length > 200) importance += 0.1;

    // Normalizar entre 0 y 1
    return Math.min(Math.max(Math.round(importance * 100) / 100, 0), 1);
  }

  // ─────────────────────────────────────────────
  //  Cálculo de confianza general
  // ─────────────────────────────────────────────

  _calculateConfidence(message, lower, intent, topic, emotion, entities) {
    let confidence = 0.5; // Base

    // Intención clara aumenta confianza
    if (intent !== 'conversation') confidence += 0.15;

    // Tema detectado aumenta confianza
    if (topic) confidence += 0.1;

    // Emoción con alta confianza aumenta confianza general
    if (emotion && emotion.confidence > 0.5) confidence += 0.1;
    if (emotion && emotion.confidence > 0.8) confidence += 0.1;

    // Entidades detectadas aumentan confianza
    const totalEntities = entities.people.length + entities.places.length + entities.dates.length + entities.projects.length;
    if (totalEntities > 0) confidence += 0.05;

    // Mensajes muy cortos tienen menor confianza
    if (message.length < 10) confidence -= 0.1;

    // Mensajes ambiguos (sin señales claras) tienen menor confianza
    if (!topic && intent === 'conversation' && !emotion.dominant) confidence -= 0.1;

    return Math.min(Math.max(Math.round(confidence * 100) / 100, 0), 1);
  }

  // ─────────────────────────────────────────────
  //  Generación de reasoning
  // ─────────────────────────────────────────────

  _generateReasoning(message, intent, topic, emotion, entities, importance, shouldRemember) {
    const parts = [];

    // Intención
    const intentLabels = {
      question: 'pregunta',
      command: 'comando',
      greeting: 'saludo',
      farewell: 'despedida',
      memory_request: 'solicitud de memoria',
      emotion: 'expresión emocional',
      conversation: 'conversación'
    };
    parts.push(`Intención: ${intentLabels[intent] || intent}`);

    // Tema
    if (topic) {
      parts.push(`Tema: ${topic}`);
    }

    // Emoción
    if (emotion.dominant) {
      parts.push(`Emoción detectada: ${emotion.dominant} (confianza: ${emotion.confidence})`);
    }

    // Entidades
    const entityParts = [];
    if (entities.people.length > 0) entityParts.push(`personas: ${entities.people.join(', ')}`);
    if (entities.places.length > 0) entityParts.push(`lugares: ${entities.places.join(', ')}`);
    if (entityParts.length > 0) {
      parts.push(`Entidades: ${entityParts.join('; ')}`);
    }

    // Importancia y decisión
    parts.push(`Importancia: ${importance}`);
    parts.push(shouldRemember ? '→ Marcar para recordar' : '→ No recordar');

    return parts.join(' | ');
  }

  // ─────────────────────────────────────────────
  //  Análisis vacío (fallback)
  // ─────────────────────────────────────────────

  _emptyAnalysis(message) {
    return {
      rawMessage: message || '',
      intent: 'conversation',
      topic: null,
      emotionalState: { valence: 0, arousal: 0.5, dominant: null, confidence: 0, positiveSignals: 0, negativeSignals: 0 },
      entities: { people: [], places: [], dates: [], projects: [] },
      intensity: 0.5,
      importance: 0.3,
      shouldRemember: false,
      language: 'es',
      confidence: 0.2,
      reasoning: 'Mensaje inválido o vacío'
    };
  }
}

module.exports = MessageAnalyzer;
