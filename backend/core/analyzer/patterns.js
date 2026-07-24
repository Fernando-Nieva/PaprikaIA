/**
 * Patrones de detección para el MessageAnalyzer.
 *
 * Cada categoría contiene patrones regex y keywords para detectar
 * intenciones, emociones, temas y entidades en mensajes en español.
 *
 * Los patrones están optimizados para español rioplatense (Argentina).
 */

// ─────────────────────────────────────────────
//  Detección de intención
// ─────────────────────────────────────────────

const INTENT_PATTERNS = {
  question: [
    /\?$/,
    /\?/,
    /^qué\b/i,
    /^cómo\b/i,
    /^dónde\b/i,
    /^cuándo\b/i,
    /^por qué\b/i,
    /^cuánto\b/i,
    /^quién\b/i,
    /cuál\b/i,
    /sabés/i,
    /conocés/i,
    /puedo/i,
    /podés/i,
    /hay\b/i,
    /existe/i,
    /es verdad/i,
    /me contás/i,
    /contame/i,
    /decime/i
  ],

  command: [
    /\bhacé\b/i,
    /\bcreá\b/i,
    /\bescribí\b/i,
    /\bleé\b/i,
    /\bejecutá\b/i,
    /\bmostrá\b/i,
    /\babrí\b/i,
    /\bcerrá\b/i,
    /\bguardá\b/i,
    /\bborrá\b/i,
    /\beliminá\b/i,
    /\bmové\b/i,
    /\bcopiá\b/i,
    /\bpasteá\b/i,
    /\binstalá\b/i,
    /\bdesinstalá\b/i,
    /\brunneá\b/i,
    /\bcompilá\b/i,
    /\bteacheame\b/i,
    /\benseñame\b/i,
    /\bexplicame\b/i
  ],

  greeting: [
    /^hola\b/i,
    /^holis\b/i,
    /^buenas\b/i,
    /^buen dia\b/i,
    /^buenas tardes\b/i,
    /^buenas noches\b/i,
    /^hey\b/i,
    /^qué onda\b/i,
    /^que onda\b/i,
    /^todo bien\b/i,
    /^como va\b/i,
    /^como andas\b/i,
    /^que tal\b/i,
    /^epa\b/i,
    /^che\b/i
  ],

  farewell: [
    /\bchau\b/i,
    /\bnos vemos\b/i,
    /\bhasta luego\b/i,
    /\bhasta pronto\b/i,
    /\bme voy\b/i,
    /\bbye\b/i,
    /\badiós\b/i,
    /\bsaludos\b/i,
    /\bcuidate\b/i,
    /\bque te vaya bien\b/i
  ],

  memory_request: [
    /\bacordate\b/i,
    /\brecordá\b/i,
    /\bte acordás\b/i,
    /\bte acuerdo\b/i,
    /\bme acuerdo\b/i,
    /\bno olvides\b/i,
    /\bno te olvides\b/i,
    /\bimportante\b/i,
    /\bguarde esto\b/i,
    /\bguardá esto\b/i,
    /\bmemorizá\b/i
  ],

  emotion_expression: [
    /\bestoy\b.*(feliz|triste|enojado|cansado|estresado|ansioso|contento|malo|genial|increíble)/i,
    /\bme siento\b/i,
    /\bme pone\b/i,
    /\bme da\b.*(bronca|risa|pena|gusto|asco)/i,
    /\bodio\b/i,
    /\bamo\b/i,
    /\bme encanta\b/i,
    /\bme gusta\b/i,
    /\bno me gusta\b/i,
    /\bsoy\b.*(cansado|feliz|triste)/i,
    /\btenés razón\b/i,
    /\btenes razon\b/i,
    /\bqué\b.*(mal|bien|genial|horrible)/i
  ]
};

// ─────────────────────────────────────────────
//  Detección de emociones
// ─────────────────────────────────────────────

const EMOTION_KEYWORDS = {
  positive: {
    high: ['increíble', 'fantástico', 'genial', 'increíble', 'maravilloso', 'espectacular', 'brutal', 'copado', 'piola', 'joya'],
    medium: ['bien', 'bueno', 'joya', 'perfecto', 'dale', 'joya', 'copado', 'piola', 'lindo', 'bien'],
    low: ['normal', 'ok', 'okay', 'más o menos', 'regular']
  },

  negative: {
    high: ['odio', 'horrible', 'desastroso', 'pesimo', 'pésimo', 'insoportable', 'detesto', 'desparramo'],
    medium: ['mal', 'triste', 'enojado', 'bronca', 'molesto', 'cansado', 'estresado', 'ansioso', 'preocupado', 'furioso', 'rabia'],
    low: ['medio raro', 'incómodo', 'no sé', 'dudoso', 'confundido']
  },

  specific: {
    joy: ['feliz', 'contento', 'alegre', 'emocionado', 'entusiasmado', 'eufórico', 'recontra feliz'],
    sadness: ['triste', 'deprimido', 'mal', 'bajón', 'bajon', 'tristeza', 'llorar', 'llorando'],
    anger: ['enojado', 'bronca', 'rabia', 'furioso', 'molesto', 'indignado', 'hartado', 'cansado de', 'odio', 'detesto'],
    fear: ['asustado', 'miedo', 'nervioso', 'ansioso', 'preocupado', 'tenso', 'angustia'],
    love: ['amor', 'amor', 'te quiero', 'me encanta', 'adoro', 'mi persona favorita'],
    surprise: ['sorpresa', 'wow', 'no puede ser', 'en serio', 'posta', 'en serio?'],
    disgust: ['asco', 'repugnante', 'asqueroso', 'desagradable'],
    nostalgia: ['nostálgico', 'nostalgia', 'extraño', 'extrañar', 'épocas', 'antes', 'cuando era']
  }
};

// ─────────────────────────────────────────────
//  Detección de temas
// ─────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  technology: ['código', 'programar', 'programación', 'archivo', 'servidor', 'server', 'base de datos', 'database', 'api', 'frontend', 'backend', 'javascript', 'python', 'html', 'css', 'react', 'node', 'npm', 'git', 'github', 'computadora', 'pc', 'internet', 'software', 'hardware', 'app', 'aplicación', 'algoritmo', 'bug', 'error', 'deploy', 'hosting', 'dominio', 'contraseña', 'password', 'sistema', 'red', 'wifi', 'bluetooth', 'inteligencia artificial', 'machine learning', 'deep learning', 'neural', 'ia'],

  personal: ['vida', 'familia', 'amigos', 'amigo', 'amiga', 'relación', 'pareja', 'ex', 'novio', 'novia', 'esposo', 'esposa', 'mamá', 'papá', 'hermano', 'hermana', 'hijo', 'hija', 'abuelo', 'abuela', 'trabajo', 'empleo', 'estudio', 'universidad', 'cole', 'colegio'],

  music: ['música', 'musica', 'canción', 'cancion', 'artista', 'banda', 'álbum', 'album', 'spotify', 'playlist', 'guitarra', 'piano', 'batería', 'bateria', 'cantar', 'cantante', 'concierto', 'recital', 'rock', 'pop', 'indie', 'metal', 'hip hop', 'rap', 'reggae'],

  art: ['arte', 'dibujo', 'pintura', 'diseño', 'diseno', 'ilustración', 'ilustracion', 'fotografía', 'fotografia', 'escultura', 'pintar', 'dibujar', 'cosplay', 'manualidad', 'creatividad', 'creativo', 'canvas', 'acuarela', 'óleo', 'lapiz', 'lápiz'],

  games: ['juego', 'jugar', 'videojuego', 'gaming', 'consola', 'playstation', 'xbox', 'nintendo', 'pc gamer', 'steam', 'nivel', 'personaje', 'boss', 'final boss', 'rpg', 'fps', 'mmo', 'multiplayer', 'singleplayer'],

  food: ['cocinar', 'cocina', 'receta', 'comida', 'comer', 'almorzar', 'cenar', 'desayunar', 'ingrediente', 'horno', 'sartén', 'olla', 'receta', 'comida', 'postre', 'torta', 'pizza', 'empanada', 'asado'],

  weather: ['lluvia', 'lluvioso', 'llueve', 'sol', 'soleado', 'viento', 'ventoso', 'frío', 'frio', 'calor', 'temperatura', 'clima', 'nublado', 'tormenta', 'nevada', 'nieve'],

  anime: ['anime', 'manga', 'otaku', 'cosplay', 'naruto', 'one piece', 'attack on titan', 'demon slayer', 'jujutsu kaisen', 'dragon ball', 'evangelion', 'Studio Ghibli', 'hayao miyazaki'],

  movies: ['película', 'pelicula', 'movie', 'serie', 'netflix', 'terror', 'suspenso', 'comedia', 'drama', 'documental', 'actor', 'actriz', 'director', 'estreno', 'tráiler', 'trailer']
};

// ─────────────────────────────────────────────
//  Extracción de entidades
// ─────────────────────────────────────────────

const ENTITY_PATTERNS = {
  // Nombres propios (después de preposiciones o al inicio de oración)
  people: [
    /\bcon\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bpara\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bde\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bhablé\s+con\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bme\s+dijo\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bel\s+([A-Z][a-záéíóúñ]+)\b/g,
    /\bla\s+([A-Z][a-záéíóúñ]+)\b/g
  ],

  // Lugares
  places: [
    /en\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g,
    /fui\s+a\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g,
    /vivo\s+en\s+([A-Z][a-záéíóúñ]+(?:\s+[A-Z][a-záéíóúñ]+)*)/g
  ],

  // Fechas
  dates: [
    /\bhoy\b/i,
    /\bayer\b/i,
    /\bmañana\b/i,
    /\bmanana\b/i,
    /\bpasado\s+mañana\b/i,
    /\besta\s+semana\b/i,
    /\bpróximamente\b/i,
    /\bel\s+lunes\b/i,
    /\bel\s+martes\b/i,
    /\el\s+miércoles\b/i,
    /\el\s+jueves\b/i,
    /\el\s+viernes\b/i,
    /\el\s+sábado\b/i,
    /\el\s+domingo\b/i,
    /\d{1,2}\/\d{1,2}\/\d{2,4}/g,
    /\d{1,2}\s+de\s+\w+/g
  ],

  // Proyectos o archivos (entre comillas o con extensión)
  projects: [
    /["""]([^"""]+)["""]/g,
    /'([^']+)'/g,
    /\b(\w+\.\w{2,4})\b/g,
    /\bproyecto\s+(\w+)/gi,
    /\bcarpeta\s+(\w+)/gi
  ]
};

// ─────────────────────────────────────────────
//  Palabras de intensidad
// ─────────────────────────────────────────────

const INTENSITY_MARKERS = {
  high: ['!!!', 'increíble', 'brutal', 'espectacular', 'demencial', 'absurdo', 'en serio?', 'posta?', 'no puede ser', 'qué barbaro', 'qué locura', 'recontra', 're', 'mal', 'buenísimo', 'malísimo', 'horrible', 'perfecto', 'nunca', 'siempre'],
  medium: ['muy', 'bastante', 'realmente', 'de verdad', 'posta', 'en serio', 'tipo', 'o sea'],
  low: ['un poco', 'algo', 'medio', 'más o menos', 'más o menos', 'regular']
};

// ─────────────────────────────────────────────
//  Patrones de importancia
// ─────────────────────────────────────────────

const IMPORTANCE_PATTERNS = {
  high: [
    /me\s+llamo\s+\w+/i,
    /soy\s+\w+/i,
    /tengo\s+\d+\s+años/i,
    /vivo\s+en/i,
    /me\s+gusta\s+mucha/i,
    /odio\s+mucha/i,
    /es\s+muy\s+importante/i,
    /no\s+me\s+olvides/i,
    /guardá\s+esto/i,
    /acordate\s+de/i,
    /decisión/i,
    /decidí/i,
    /me\s+decidí/i,
    /voy\s+a\s+cambiar/i,
    /nuevo\s+trabajo/i,
    /me\s+despidieron/i,
    /renuncié/i,
    /empezó\s+una\s+relación/i,
    /terminé/i,
    /muerte/i,
    /falleció/i,
    /embarazada/i,
    /nació/i,
    /casa\s+nueva/i,
    /mudanza/i
  ],

  low: [
    /^hola$/i,
    /^buenas$/i,
    /^ok$/i,
    /^dale$/i,
    /^bien$/i,
    /^genial$/i,
    /^jaja$/i,
    /^jeje$/i,
    /^xd$/i,
    /^👍$/,
    /^❤$/,
    /^😂$/,
    /^.{0,3}$/  // mensajes muy cortos
  ]
};

module.exports = {
  INTENT_PATTERNS,
  EMOTION_KEYWORDS,
  TOPIC_KEYWORDS,
  ENTITY_PATTERNS,
  INTENSITY_MARKERS,
  IMPORTANCE_PATTERNS
};
