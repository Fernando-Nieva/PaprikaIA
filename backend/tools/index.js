const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = path.join(__dirname, '..', '..');

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido completo de un archivo de texto. Úsalo cuando el usuario quiera ver qué hay dentro de un archivo. Ejemplo de uso: read_file({ path: "notas.txt" })',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Nombre o ruta del archivo relativo a la carpeta del proyecto. Ejemplo: "notas.txt" o "data/nota.txt"' }
        },
        required: ['path']
      }
    },
    async execute({ path: filePath }) {
      const fullPath = path.join(BASE_DIR, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Escribe contenido en un archivo. Crea el archivo si no existe, o sobreescribe si ya existe. Úsalo cuando el usuario quiera guardar algo en un archivo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Nombre o ruta del archivo relativo a la carpeta del proyecto' },
          content: { type: 'string', description: 'Todo el contenido que querés escribir en el archivo' }
        },
        required: ['path', 'content']
      }
    },
    async execute({ path: filePath, content }) {
      const fullPath = path.join(BASE_DIR, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      return `Archivo creado/actualizado: ${filePath}`;
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista todos los archivos y carpetas que hay en un directorio. ÚSALO PRIMERO para ver qué hay antes de afirmar que algo no existe. Ejemplo: list_files({ path: "" }) para ver el contenido de la carpeta del proyecto.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del directorio relativo a la carpeta del proyecto. Usá "" (vacío) para ver la raíz, o "carpeta/subcarpeta" para ver dentro de una carpeta.' }
        },
        required: ['path']
      }
    },
    async execute({ path: dirPath }) {
      const fullPath = path.join(BASE_DIR, dirPath);
      const items = await fs.readdir(fullPath, { withFileTypes: true });
      return items.map(i => `${i.isDirectory() ? '📁' : '📄'} ${i.name}`).join('\n');
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Ejecuta un comando del sistema operativo (terminal/cmd). Úsalo para operaciones del sistema como mover archivos, instalar programas, ver procesos, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'El comando a ejecutar. Ejemplo: "dir" para listar archivos en Windows' }
        },
        required: ['command']
      }
    },
    async execute({ command }) {
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 30000 });
        return output || 'Comando ejecutado sin salida';
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }
  }
];

function getTools() {
  return tools;
}

function getToolByName(name) {
  return tools.find(t => t.function.name === name);
}

module.exports = { getTools, getToolByName };
