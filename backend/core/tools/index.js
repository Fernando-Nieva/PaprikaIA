/**
 * ToolExecutor — Sistema de herramientas para Paprika
 *
 * Le permite a Paprika acceder a su propio sistema: leer archivos,
 * buscar contenido, escribir archivos, ejecutar comandos, etc.
 *
 * Inspirado en la arquitectura de OpenCode: herramientas definidas
 * con schema + execute, detectadas en la respuesta del AI, ejecutadas
 * en backend, y el resultado se devuelve al AI para su uso.
 *
 * Flujo:
 *   1. AI genera respuesta con tool call: [TOOL:read_file({path: "x"})]
 *   2. ToolExecutor detecta y ejecuta la herramienta
 *   3. El resultado se agrega como mensaje del sistema
 *   4. AI genera la respuesta final con la info real
 *
 * Seguridad:
 *   - Lectura: solo dentro del BASE_DIR del proyecto
 *   - Escritura: solo dentro de BASE_DIR
 *   - Comandos: timeout de 30s, se capturan errores
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = path.join(__dirname, '..', '..');

// Maximum output size for tool results (chars)
const MAX_OUTPUT = 8000;

class ToolExecutor {
  constructor(config) {
    this.baseDir = (config && config.baseDir) || BASE_DIR;
    this.maxOutput = (config && config.maxOutput) || MAX_OUTPUT;
    this._registerTools();
  }

  // ─────────────────────────────────────────────
  //  Tool registration
  // ─────────────────────────────────────────────

  _registerTools() {
    this.tools = {
      read_file: {
        description: 'Lee el contenido completo de un archivo de texto.',
        params: { path: 'string (ruta relativa al proyecto)' },
        execute: async (args) => this._readFile(args.path),
      },
      write_file: {
        description: 'Escribe contenido en un archivo. Crea si no existe, sobreescribe si existe.',
        params: { path: 'string', content: 'string' },
        execute: async (args) => this._writeFile(args.path, args.content),
      },
      edit_file: {
        description: 'Reemplaza una parte específica de un archivo (busca y reemplaza texto exacto).',
        params: { path: 'string', old_text: 'string (texto a buscar)', new_text: 'string (reemplazo)' },
        execute: async (args) => this._editFile(args.path, args.old_text, args.new_text),
      },
      list_dir: {
        description: 'Lista archivos y carpetas en un directorio.',
        params: { path: 'string (ruta relativa, "" para raíz)' },
        execute: async (args) => this._listDir(args.path || ''),
      },
      search_files: {
        description: 'Busca archivos por nombre/patrón (glob). Ejemplo: "*.js", "core/**/*.js"',
        params: { pattern: 'string (patrón glob)', dir: 'string (directorio base, opcional)' },
        execute: async (args) => this._searchFiles(args.pattern, args.dir),
      },
      search_content: {
        description: 'Busca contenido dentro de archivos (regex). Ejemplo: "class.*Engine"',
        params: { pattern: 'string (regex)', dir: 'string (directorio)', include: 'string (filtro, ej "*.js")' },
        execute: async (args) => this._searchContent(args.pattern, args.dir, args.include),
      },
      file_info: {
        description: 'Muestra info de un archivo: tamaño, fechas, si existe.',
        params: { path: 'string' },
        execute: async (args) => this._fileInfo(args.path),
      },
      run_command: {
        description: 'Ejecuta un comando del sistema. Usar con precaución.',
        params: { command: 'string' },
        execute: async (args) => this._runCommand(args.command),
      },
      create_dir: {
        description: 'Crea un directorio (y subdirectorios).',
        params: { path: 'string' },
        execute: async (args) => this._createDir(args.path),
      },
      append_file: {
        description: 'Agrega contenido al final de un archivo sin sobreescribir.',
        params: { path: 'string', content: 'string' },
        execute: async (args) => this._appendFile(args.path, args.content),
      },
    };
  }

  // ─────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────

  /**
   * Retorna la definición de todas las herramientas formateada para el system prompt.
   * @returns {string}
   */
  getToolsPrompt() {
    const lines = Object.entries(this.tools).map(([name, tool]) => {
      const params = Object.entries(tool.params)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return `- ${name}(${params}): ${tool.description}`;
    });

    return `HERRAMIENTAS DISPONIBLES (USALAS cuando necesites ver/crear/modificar archivos o ejecutar comandos):
${lines.join('\n')}

FORMATO DE LLAMADA: poné la llamada así en tu respuesta:
[TOOL:nombre_herramienta({parametro: "valor"})]

EJEMPLOS:
- [TOOL:list_dir({path: ""})]
- [TOOL:read_file({path: "backend/personality.json"})]
- [TOOL:search_content({pattern: "class.*Engine", dir: "backend/core", include: "*.js"})]
- [TOOL:write_file({path: "notas.txt", content: "Hola mundo"})]
- [TOOL:run_command({command: "node -v"})]

REGLAS:
- SIEMPRE usá herramientas antes de afirmar algo sobre archivos/directorios
- Podés usar múltiples herramientas en una respuesta
- El resultado de la herramienta aparecerá como [TOOL_RESULT:...]
- Explicá brevemente qué hacés antes de cada llamada`;
  }

  /**
   * Parsea tool calls de una respuesta del AI.
   * Detecta patrones: [TOOL:name({args})]
   *
   * @param {string} text - Respuesta del AI
   * @returns {Array<{name: string, args: Object, raw: string}>}
   */
  parseToolCalls(text) {
    const calls = [];
    // Match [TOOL:name({...})] — handles nested quotes and special chars
    const regex = /\[TOOL:(\w+)\((\{.+?\})\)\]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      let argsStr = match[2];

      try {
        // Add quotes around unquoted keys: {path: "x"} -> {"path": "x"}
        const fixed = argsStr.replace(/(\w+)\s*:/g, '"$1":');
        const args = JSON.parse(fixed);
        calls.push({ name, args, raw: match[0] });
      } catch {
        // Try lenient parsing
        const args = this._lenientParse(argsStr);
        if (args) {
          calls.push({ name, args, raw: match[0] });
        }
      }
    }

    return calls;
  }

  /**
   * Ejecuta una tool call y retorna el resultado.
   *
   * @param {string} name - Nombre de la herramienta
   * @param {Object} args - Argumentos
   * @returns {Promise<{success: boolean, result: string, tool: string}>}
   */
  async execute(name, args) {
    const tool = this.tools[name];
    if (!tool) {
      return { success: false, result: `Herramienta desconocida: ${name}`, tool: name };
    }

    try {
      let result = await tool.execute(args);
      // Truncate if too long
      if (result && result.length > this.maxOutput) {
        result = result.substring(0, this.maxOutput) + '\n... [truncado]';
      }
      return { success: true, result: result || 'Operación completada', tool: name };
    } catch (err) {
      return { success: false, result: `Error: ${err.message}`, tool: name };
    }
  }

  /**
   * Ejecuta todas las tool calls detectadas en una respuesta.
   *
   * @param {string} text - Respuesta del AI
   * @returns {Promise<{calls: Array, results: Array, cleanText: string}>}
   */
  async executeFromResponse(text) {
    const calls = this.parseToolCalls(text);
    const results = [];

    for (const call of calls) {
      const result = await this.execute(call.name, call.args);
      results.push(result);
    }

    // Remove tool call markers from text
    let cleanText = text;
    for (const call of calls) {
      cleanText = cleanText.replace(call.raw, '');
    }
    cleanText = cleanText.trim();

    return { calls, results, cleanText };
  }

  // ─────────────────────────────────────────────
  //  Tool implementations
  // ─────────────────────────────────────────────

  async _readFile(filePath) {
    const fullPath = this._resolvePath(filePath);
    this._assertInsideBase(fullPath);
    const content = await fs.readFile(fullPath, 'utf-8');
    return content;
  }

  async _writeFile(filePath, content) {
    const fullPath = this._resolvePath(filePath);
    this._assertInsideBase(fullPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return `Archivo escrito: ${filePath} (${content.length} bytes)`;
  }

  async _editFile(filePath, oldText, newText) {
    const fullPath = this._resolvePath(filePath);
    this._assertInsideBase(fullPath);
    let content = await fs.readFile(fullPath, 'utf-8');

    if (!content.includes(oldText)) {
      return `Error: no se encontró el texto buscado en ${filePath}`;
    }

    content = content.replace(oldText, newText);
    await fs.writeFile(fullPath, content, 'utf-8');
    return `Archivo editado: ${filePath}`;
  }

  async _listDir(dirPath) {
    const fullPath = this._resolvePath(dirPath);
    this._assertInsideBase(fullPath);

    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const entries = items.map((i) => {
      const prefix = i.isDirectory() ? '[DIR]' : '[FILE]';
      return `${prefix} ${i.name}`;
    });

    return entries.length > 0 ? entries.join('\n') : '(directorio vacío)';
  }

  async _searchFiles(pattern, dir) {
    const baseDir = this._resolvePath(dir || '');
    this._assertInsideBase(baseDir);

    // Simple glob implementation
    const results = [];
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );

    const walk = async (currentDir) => {
      const items = await fs.readdir(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          if (!item.name.startsWith('.') && item.name !== 'node_modules') {
            await walk(fullPath);
          }
        } else if (regex.test(item.name)) {
          results.push(path.relative(this.baseDir, fullPath));
        }
      }
    };

    await walk(baseDir);
    return results.length > 0 ? results.join('\n') : 'No se encontraron archivos';
  }

  async _searchContent(pattern, dir, include) {
    const searchDir = this._resolvePath(dir || '');
    this._assertInsideBase(searchDir);

    const regex = new RegExp(pattern, 'gi');
    const includeFilter = include
      ? new RegExp('^' + include.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      : null;

    const results = [];
    const MAX_RESULTS = 30;

    const walk = async (currentDir) => {
      if (results.length >= MAX_RESULTS) return;

      const items = await fs.readdir(currentDir, { withFileTypes: true });
      for (const item of items) {
        if (results.length >= MAX_RESULTS) break;

        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          if (!item.name.startsWith('.') && item.name !== 'node_modules') {
            await walk(fullPath);
          }
        } else if (!includeFilter || includeFilter.test(item.name)) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const relPath = path.relative(this.baseDir, fullPath);
                results.push(`${relPath}:${i + 1}: ${lines[i].trim().substring(0, 120)}`);
                regex.lastIndex = 0;
                if (results.length >= MAX_RESULTS) break;
              }
            }
          } catch {
            // Skip binary files
          }
        }
      }
    };

    await walk(searchDir);
    return results.length > 0
      ? `Encontrados ${results.length} resultados:\n${results.join('\n')}`
      : 'No se encontraron coincidencias';
  }

  async _fileInfo(filePath) {
    const fullPath = this._resolvePath(filePath);
    this._assertInsideBase(fullPath);

    try {
      const stat = await fs.stat(fullPath);
      const info = [
        `Archivo: ${filePath}`,
        `Tamaño: ${stat.size} bytes`,
        `Creado: ${stat.birthtime.toISOString()}`,
        `Modificado: ${stat.mtime.toISOString()}`,
        `Es directorio: ${stat.isDirectory()}`,
      ];
      return info.join('\n');
    } catch {
      return `El archivo no existe: ${filePath}`;
    }
  }

  async _runCommand(command) {
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: this.baseDir,
        maxBuffer: 1024 * 1024,
      });
      return output || 'Comando ejecutado sin salida';
    } catch (err) {
      return `Error: ${err.stderr || err.message}`;
    }
  }

  async _createDir(dirPath) {
    const fullPath = this._resolvePath(dirPath);
    this._assertInsideBase(fullPath);
    await fs.mkdir(fullPath, { recursive: true });
    return `Directorio creado: ${dirPath}`;
  }

  async _appendFile(filePath, content) {
    const fullPath = this._resolvePath(filePath);
    this._assertInsideBase(fullPath);
    await fs.appendFile(fullPath, content, 'utf-8');
    return `Contenido agregado a: ${filePath}`;
  }

  // ─────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────

  _resolvePath(filePath) {
    if (!filePath || filePath === '') return this.baseDir;
    return path.resolve(this.baseDir, filePath);
  }

  _assertInsideBase(fullPath) {
    const normalized = path.normalize(fullPath);
    const baseNormalized = path.normalize(this.baseDir);
    if (!normalized.startsWith(baseNormalized)) {
      throw new Error(`Acceso denegado: ${normalized} está fuera del proyecto`);
    }
  }

  _lenientParse(str) {
    // Try to extract key-value pairs from malformed JSON
    const result = {};
    // Match key: "value" or key: "" (empty value)
    const kvRegex = /(\w+)\s*:\s*"([^"]*)"/g;
    let match;
    let found = false;

    while ((match = kvRegex.exec(str)) !== null) {
      result[match[1]] = match[2];
      found = true;
    }

    return found ? result : null;
  }
}

module.exports = ToolExecutor;
