const config = require('./config.json');
const { getTools, getToolByName } = require('./tools');
const { getAvailableProviders } = require('./providers');

function buildSystemPrompt() {
  const toolsInfo = getTools().map(t =>
    `- ${t.function.name}: ${t.function.description}. Parámetros: ${JSON.stringify(t.function.parameters.properties)}`
  ).join('\n\n');

  return `Eres ${config.name}. ${config.personality}

Tus gustos: ${config.gustos.join(', ')}

Reglas:
${config.reglas.map(r => `- ${r}`).join('\n')}

HERRAMIENTAS DISPONIBLES (USALAS SIEMPRE QUE NECESITES VERIFICAR ALGO EN EL SISTEMA):
${toolsInfo}

INSTRUCCIONES IMPORTANTES SOBRE HERRAMIENTAS:
- SIEMPRE usá las herramientas antes de afirmar o negar algo sobre archivos/directorios
- Si el usuario te pide algo que involucra archivos, PRIMERO usá list_files para ver qué hay en la carpeta del proyecto
- Para ver archivos: usá list_files con path "" para ver la raíz de la carpeta del proyecto
- Para leer un archivo: usá read_file con la ruta relativa a la carpeta del proyecto
- Para escribir: usá write_file
- Para comandos del sistema: usá run_command
- NO asumas que algo no existe sin antes verificarlo con una herramienta
- Cuando uses una herramienta, explicá brevemente qué estás haciendo

Ejemplo: si te dicen "abrí el archivo X", primero usá list_files para ver si existe, y después read_file para leerlo.`;
}

function detectToolFromText(text) {
  const lower = text.toLowerCase();

  if (lower.includes('no existe') || lower.includes('no encuentro') || lower.includes('no hay') || lower.includes('no está')) {
    const pathMatch = text.match(/["'`\/\\]([A-Za-z0-9_.\-\/\\ ]+\.\w+)["'`]/);
    if (pathMatch) {
      return { name: 'read_file', args: { path: pathMatch[1].trim() } };
    }
  }

  if (lower.includes('creame el archivo') || lower.includes('creá el archivo') || lower.includes('escribe en') || lower.includes('guarda esto')) {
    const pathMatch = text.match(/(?:archivo|en|archivo)\s+["'`\/\\]([A-Za-z0-9_.\-\/\\ ]+)["'`]/i);
    if (pathMatch) {
      return { name: 'list_files', args: { path: '' } };
    }
  }

  if (lower.includes('qué hay en') || lower.includes('que hay en') || lower.includes('cuáles son los archivos') || lower.includes('cuales son los archivos') || lower.includes('mostrar archivos') || lower.includes('ver archivos')) {
    return { name: 'list_files', args: { path: '' } };
  }

  return null;
}

async function chat(messages, onChunk) {
  const systemPrompt = buildSystemPrompt();
  const allMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const providers = getAvailableProviders();

  if (providers.length === 0) {
    throw new Error('No hay ningún proveedor disponible. Configurá al menos una API key en .env o dejá Ollama corriendo.');
  }

  let lastError = null;

  for (const { name, provider } of providers) {
    try {
      if (onChunk) onChunk(`\n🔄 Usando: ${name}\n`, 'tool');
      const response = await provider.chat(allMessages, onChunk);
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
