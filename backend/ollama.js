const config = require('./config.json');
const { getAvailableProviders } = require('./providers');

const PROVIDER_TIMEOUT_MS = parseInt(process.env.PAPRIKA_PROVIDER_TIMEOUT_MS, 10) || 60000;

/**
 * Construye el system prompt legacy desde config.json.
 * Se usa como fallback cuando el Personality Engine no está disponible.
 */
function buildSystemPrompt() {
  return `Eres ${config.name}. ${config.personality}

Tus gustos: ${config.gustos.join(', ')}

Reglas:
${config.reglas.map(r => `- ${r}`).join('\n')}`;
}

/**
 * Función de chat con fallback entre proveedores.
 *
 * @param {Array} messages - Mensajes de la conversación
 * @param {Function} onChunk - Callback para streaming (chunk, type)
 * @param {Object} options - Opciones opcionales
 * @param {string} options.systemPrompt - System prompt personalizado (reemplaza el legacy)
 * @returns {Promise<string>} Respuesta completa
 */
async function chat(messages, onChunk, options = {}) {
  if (process.env.DEBUG_ATTACHMENTS === 'true') {
    console.log('\n─── [DEBUG ATTACHMENTS] Etapa 5: ollama.js chat() ───');
    console.log('  Input messages:', messages.length);
    const hasMultimodal = messages.some(m => Array.isArray(m.content));
    console.log('  ¿Algún message con content array?', hasMultimodal);
    if (hasMultimodal) {
      messages.forEach((m, i) => {
        if (Array.isArray(m.content)) {
          console.log(`  msg[${i}] role=${m.role}: content is ARRAY with ${m.content.length} parts`);
          m.content.forEach((p, j) => {
            console.log(`    part[${j}]: type=${p.type}`, p.type === 'image_url' ? `url_len=${p.image_url?.url?.length}` : '');
          });
        }
      });
    }
  }

  // Si se provee un system prompt personalizado, usarlo
  // Si no, verificar si el primer mensaje ya es un system message
  const hasSystemMessage = messages.length > 0 && messages[0].role === 'system';

  let allMessages;
  if (options.systemPrompt) {
    // System prompt personalizado del Personality Engine (ya incluye tools del pipeline)
    allMessages = [
      { role: 'system', content: options.systemPrompt },
      ...messages.filter(m => m.role !== 'system')
    ];
  } else if (hasSystemMessage) {
    // Ya hay un system message en los mensajes, no agregar otro
    allMessages = [...messages];
  } else {
    // Fallback: system prompt legacy
    const systemPrompt = buildSystemPrompt();
    allMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];
  }

  const providers = getAvailableProviders();

  if (providers.length === 0) {
    throw new Error('No hay ningún proveedor disponible. Configurá al menos una API key en .env o dejá Ollama corriendo.');
  }

  let lastError = null;

  for (const { name, provider } of providers) {
    try {
      if (process.env.DEBUG_ATTACHMENTS === 'true') {
        console.log(`\n─── [DEBUG ATTACHMENTS] Etapa 5b: provider.chat() → ${name} ───`);
        console.log('  Enviando allMessages:', allMessages.length, 'mensajes');
        allMessages.forEach((m, i) => {
          const contentIsArray = Array.isArray(m.content);
          console.log(`  msg[${i}] role=${m.role}: content type=${typeof m.content}, isArray=${contentIsArray}`);
          if (contentIsArray) {
            m.content.forEach((p, j) => {
              console.log(`    part[${j}]: type=${p.type}`, p.type === 'image_url' ? `url_len=${p.image_url?.url?.length}` : p.type === 'text' ? `text="${p.text?.substring(0, 40)}"` : '');
            });
          }
        });
      }

      if (onChunk) onChunk(`\n🔄 Usando: ${name}\n`, 'tool');

      const response = await Promise.race([
        provider.chat(allMessages, onChunk),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${name} no respondió en ${PROVIDER_TIMEOUT_MS / 1000}s`)), PROVIDER_TIMEOUT_MS)
        ),
      ]);
      return response;
    } catch (err) {
      lastError = err;
      if (onChunk) onChunk(`\n❌ ${name} falló: ${err.message.substring(0, 80)}\n`, 'tool');
      continue;
    }
  }

  throw new Error(`Todos los proveedores fallaron. Último error: ${lastError?.message}`);
}

module.exports = { chat };
