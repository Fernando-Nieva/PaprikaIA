'use strict';

/**
 * run_code tool definition for ToolExecutor.
 *
 * Permite a Paprika ejecutar código JavaScript para cálculos,
 * procesamiento de datos, generación de contenido, etc.
 *
 * Seguridad:
 *   - Pre-validación de código peligroso
 *   - Proceso aislado (child_process.fork)
 *   - Globals restringidos (Math, JSON, Date, etc.)
 *   - Sin acceso a filesystem, red, process, etc.
 *   - Timeout configurable
 *
 * Uso del AI: [TOOL:run_code({code: "return Math.PI * 2"})]
 */

/**
 * Crea la definición de la herramienta run_code.
 *
 * @param {CodeExecutor} codeExecutor
 * @returns {Object} Tool definition
 */
function createRunCodeTool(codeExecutor) {
  return {
    description: 'Ejecuta código JavaScript para cálculos, procesamiento de datos, o generar contenido. Retorna el valor del return.',
    params: {
      code: 'string (código JS, debe tener un return con el resultado)',
      timeout: 'number (opcional, ms, default 5000)',
    },
    execute: async (args) => {
      const code = args.code;
      if (!code) return 'Error: code es requerido';

      // Pre-validate
      const validation = CodeExecutor.preValidate(code);
      if (!validation.safe) {
        return `Código rechazado: ${validation.reason}`;
      }

      const timeout = Math.min(parseInt(args.timeout, 10) || 5000, 10000);

      const result = await codeExecutor.execute(code, { timeout, label: 'tool' });

      if (!result.success) {
        const outputStr = result.output.length > 0
          ? `\nSalida:\n${result.output.join('\n')}`
          : '';
        return `Error: ${result.error}${outputStr}\nDuración: ${result.duration}ms`;
      }

      // Formatear resultado
      let resultStr;
      if (result.result === undefined) {
        resultStr = 'undefined';
      } else if (result.result === null) {
        resultStr = 'null';
      } else if (typeof result.result === 'object') {
        try {
          resultStr = JSON.stringify(result.result, null, 2);
        } catch {
          resultStr = String(result.result);
        }
      } else {
        resultStr = String(result.result);
      }

      // Truncate if too long
      const maxOutput = 6000;
      if (resultStr.length > maxOutput) {
        resultStr = resultStr.substring(0, maxOutput) + '\n... [resultado truncado]';
      }

      // Append console output
      const outputStr = result.output.length > 0
        ? `\nConsole:\n${result.output.join('\n')}`
        : '';

      return `Resultado: ${resultStr}${outputStr}\nDuración: ${result.duration}ms`;
    },
  };
}

module.exports = { createRunCodeTool };
