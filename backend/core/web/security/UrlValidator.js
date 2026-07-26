'use strict';

/**
 * UrlValidator — Protección contra SSRF y validación de URLs.
 *
 * Previene que se hagan requests a:
 *   - IPs privadas (10.x, 172.16-31.x, 192.168.x, 127.x)
 *   - Localhost y variantes (0.0.0.0, [::1], [::])
 *   - Metadata endpoints (169.254.x.x)
 *   - IPv4-mapped IPv6 ([::ffff:7f00:1] → 127.0.0.1)
 *   - Puertos internos peligrosos
 *   - Protocolos no HTTP(S)
 *   - URLs con formato inválido
 */

const { URL } = require('url');
const dns = require('dns').promises;

// IPs privadas (RFC 1918 + loopback + link-local)
const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^::$/,         // IPv6 unspecified (equivalent to 0.0.0.0)
  /^fc00:/,
  /^fd00:/,
  /^fe80:/,
  /^ff00:/,
];

// Puertos que no deberían ser accedidos externamente
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 3389, 5432, 6379, 27017,
]);

// Hosts que siempre se bloquean
const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '[::1]',
  '[::]',
  'metadata.google.internal',
  'instance-metadata',
  '169.254.169.254',
]);

/**
 * Descompone una dirección IPv4-mapped IPv6 a su IPv4 subyacente.
 * Node.js normaliza: [::ffff:127.0.0.1] → [::ffff:7f00:1]
 * Los dos últimos grupos hex codifican la IPv4.
 * Ejemplo: ::ffff:7f00:1 → 127.0.0.1
 * @param {string} addr
 * @returns {string} IPv4 original o la addr original si no es mapped
 */
function unwrapIPv4Mapped(addr) {
  const match = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (match) {
    const high = parseInt(match[1], 16);
    const low = parseInt(match[2], 16);
    const octets = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ];
    return octets.join('.');
  }
  return addr;
}

/**
 * Normaliza un hostname para verificación de SSRF.
 * Descompone IPv4-mapped IPv6 y lowercase.
 * @param {string} hostname
 * @returns {string}
 */
function normalizeHostname(hostname) {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  h = unwrapIPv4Mapped(h);
  return h;
}

class UrlValidator {
  /**
   * Valida y sanitiza una URL para descarga segura.
   *
   * @param {string} urlString
   * @param {Object} [options]
   * @param {boolean} [options.allowPrivate=false] — Permitir IPs privadas (para dev)
   * @param {number[]} [options.allowedPorts=[80,443,8080,8443]]
   * @returns {{ valid: boolean, url?: string, error?: string }}
   */
  static validate(urlString, options = {}) {
    const { allowPrivate = false } = options;

    // 1. Validar formato
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return { valid: false, error: 'URL con formato inválido' };
    }

    // 2. Solo HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Protocolo no permitido: ${parsed.protocol}` };
    }

    // 3. Normalizar hostname (descompone IPv4-mapped IPv6)
    const hostname = normalizeHostname(parsed.hostname);

    // 4. Verificar hosts bloqueados
    const hostnameBracketed = `[${hostname}]`;
    if (BLOCKED_HOSTS.has(hostname) || BLOCKED_HOSTS.has(hostnameBracketed)) {
      return { valid: false, error: 'Host bloqueado (metadata/loopback)' };
    }

    // 5. Verificar puertos bloqueados
    const port = parseInt(parsed.port, 10);
    if (port && BLOCKED_PORTS.has(port)) {
      return { valid: false, error: `Puerto bloqueado: ${port}` };
    }

    // 6. Verificar IPs privadas
    if (!allowPrivate) {
      for (const range of PRIVATE_RANGES) {
        if (range.test(hostname)) {
          return { valid: false, error: 'URL apunta a red privada (SSRF bloqueado)' };
        }
      }
    }

    // 7. Sanitizar: remover fragmentos, normalizar
    const clean = new URL(parsed.origin + parsed.pathname + parsed.search);
    clean.hash = '';

    return { valid: true, url: clean.href };
  }

  /**
   * Valida una URL para redirección (misma validación + resuelve relative redirects).
   *
   * @param {string} locationHeader — valor del header Location
   * @param {string} baseUrl — URL base para resolver relativos
   * @param {Object} [options]
   * @returns {{ valid: boolean, url?: string, error?: string }}
   */
  static validateRedirect(locationHeader, baseUrl, options = {}) {
    if (!locationHeader) {
      return { valid: false, error: 'Header Location vacío' };
    }

    let fullUrl;
    try {
      fullUrl = new URL(locationHeader, baseUrl).href;
    } catch {
      return { valid: false, error: 'URL de redirección inválida' };
    }

    return UrlValidator.validate(fullUrl, options);
  }

  /**
   * Verifica DNS de una URL para confirmar que no apunta a IP privada.
   * Más lento pero más seguro. Falla conservadoramente.
   *
   * @param {string} urlString
   * @returns {Promise<{ valid: boolean, error?: string }>}
   */
  static async validateDns(urlString) {
    const basic = UrlValidator.validate(urlString);
    if (!basic.valid) return basic;

    const parsed = new URL(basic.url);
    const hostname = parsed.hostname;

    // Check both IPv4 and IPv6
    const ipv4Addresses = await dns.resolve4(hostname).catch(() => []);
    const ipv6Addresses = await dns.resolve6(hostname).catch(() => []);

    const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

    // If no addresses resolved at all, fail conservatively
    if (allAddresses.length === 0) {
      return { valid: false, error: 'DNS: no se pudo resolver el hostname' };
    }

    for (const addr of allAddresses) {
      for (const range of PRIVATE_RANGES) {
        if (range.test(addr)) {
          return { valid: false, error: `DNS resuelve a IP privada: ${addr}` };
        }
      }
    }

    return { valid: true };
  }
}

module.exports = UrlValidator;
