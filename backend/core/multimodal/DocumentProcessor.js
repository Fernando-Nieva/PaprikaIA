/**
 * DocumentProcessor — Extract text from documents.
 *
 * Supports: PDF, DOCX, TXT, Markdown, CSV, JSON
 * Falls back to informing the user if extraction fails.
 *
 * No external dependencies — uses built-in Buffer/regex for extraction.
 * For PDF: extracts raw text streams. For DOCX: parses XML.
 */

const MAX_EXTRACTED_CHARS = 12000;  // ~3000 tokens
const OVERFLOW_MESSAGE = '\n\n[Documento truncado — contenido excede el límite de procesamiento]';

class DocumentProcessor {
  /**
   * Process an attachment and extract its text content.
   * @param {object} attachment - { base64, mimeType, filename }
   * @returns {{ success: boolean, text: string, metadata: object, error?: string }}
   */
  async process(attachment) {
    const mime = (attachment.mimeType || '').toLowerCase();
    const filename = (attachment.filename || '').toLowerCase();

    try {
      if (mime === 'application/pdf' || filename.endsWith('.pdf')) {
        return this._processPDF(attachment);
      }
      if (mime.includes('officedocument') || filename.endsWith('.docx')) {
        return this._processDOCX(attachment);
      }
      if (mime === 'text/plain' || filename.endsWith('.txt')) {
        return this._processText(attachment, 'plain text');
      }
      if (mime === 'text/markdown' || filename.endsWith('.md')) {
        return this._processText(attachment, 'markdown');
      }
      if (mime === 'text/csv' || filename.endsWith('.csv')) {
        return this._processText(attachment, 'CSV');
      }
      if (mime === 'application/json' || filename.endsWith('.json')) {
        return this._processText(attachment, 'JSON');
      }
      if (mime.startsWith('text/')) {
        return this._processText(attachment, 'text');
      }

      return {
        success: false,
        text: '',
        metadata: { type: 'unsupported', mime, filename },
        error: `Tipo de archivo no soportado: ${mime || filename}`,
      };
    } catch (err) {
      return {
        success: false,
        text: '',
        metadata: { type: 'error', mime, filename },
        error: `Error procesando ${filename}: ${err.message}`,
      };
    }
  }

  /**
   * Process multiple attachments.
   * @param {Array} attachments
   * @returns {Array<{ success, text, metadata, error }>}
   */
  async processAll(attachments) {
    if (!attachments || !Array.isArray(attachments)) return [];
    const results = [];
    for (const att of attachments) {
      const result = await this.process(att);
      if (result.success || result.error) {
        results.push(result);
      }
    }
    return results;
  }

  // ─── PDF extraction ──────────────────────────────

  _processPDF(attachment) {
    const buf = Buffer.from(attachment.base64, 'base64');
    const raw = buf.toString('latin1');  // PDF is mostly latin1/binary

    // Extract text between BT/ET markers (PDF text operators)
    const textChunks = [];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
    let match;

    while ((match = tjRegex.exec(raw)) !== null) {
      const decoded = this._decodePDFString(match[1]);
      if (decoded.trim()) textChunks.push(decoded);
    }

    while ((match = tjArrayRegex.exec(raw)) !== null) {
      const parts = match[1].match(/\(([^)]*)\)/g) || [];
      const decoded = parts.map(p => this._decodePDFString(p.slice(1, -1))).join('');
      if (decoded.trim()) textChunks.push(decoded);
    }

    // Also try to extract from stream content (BT...ET blocks)
    const btEtRegex = /BT\s([\s\S]*?)\sET/g;
    while ((match = btEtRegex.exec(raw)) !== null) {
      const block = match[1];
      const innerTj = /\(([^)]*)\)\s*Tj/g;
      let innerMatch;
      while ((innerMatch = innerTj.exec(block)) !== null) {
        const decoded = this._decodePDFString(innerMatch[1]);
        if (decoded.trim() && !textChunks.includes(decoded)) {
          textChunks.push(decoded);
        }
      }
    }

    let text = textChunks.join(' ').trim();

    // If no text extracted (scanned PDF), inform the user
    if (!text || text.length < 10) {
      return {
        success: true,
        text: `[PDF: ${attachment.filename || 'documento'} — El archivo parece ser un PDF escaneado o sin texto extraíble. Para analizarlo, necesitaría un modelo con visión.]`,
        metadata: { type: 'pdf', filename: attachment.filename, pages: 'unknown', extracted: false },
      };
    }

    // Truncate if too long
    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.substring(0, MAX_EXTRACTED_CHARS) + OVERFLOW_MESSAGE;
    }

    return {
      success: true,
      text,
      metadata: { type: 'pdf', filename: attachment.filename, extracted: true, chars: text.length },
    };
  }

  // ─── DOCX extraction ─────────────────────────────

  _processDOCX(attachment) {
    const buf = Buffer.from(attachment.base64, 'base64');
    const raw = buf.toString('utf-8');

    // DOCX is a ZIP with word/document.xml inside
    // Extract text from <w:t> tags in the XML
    const textChunks = [];
    const wtRegex = /<w:t[^>]*>([^<]+)<\/w:t>/g;
    let match;

    while ((match = wtRegex.exec(raw)) !== null) {
      const text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (text.trim()) textChunks.push(text);
    }

    let text = textChunks.join(' ').trim();

    if (!text || text.length < 5) {
      return {
        success: true,
        text: `[DOCX: ${attachment.filename || 'documento'} — No se pudo extraer texto. El archivo puede estar corrupto o ser una imagen.]`,
        metadata: { type: 'docx', filename: attachment.filename, extracted: false },
      };
    }

    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.substring(0, MAX_EXTRACTED_CHARS) + OVERFLOW_MESSAGE;
    }

    return {
      success: true,
      text,
      metadata: { type: 'docx', filename: attachment.filename, extracted: true, chars: text.length },
    };
  }

  // ─── Plain text extraction ────────────────────────

  _processText(attachment, typeName) {
    let text = '';
    try {
      const buf = Buffer.from(attachment.base64, 'base64');
      text = buf.toString('utf-8');
    } catch {
      // Try latin1 fallback
      const buf = Buffer.from(attachment.base64, 'base64');
      text = buf.toString('latin1');
    }

    if (!text.trim()) {
      return {
        success: true,
        text: `[${typeName}: ${attachment.filename || 'archivo'} — El archivo está vacío]`,
        metadata: { type: typeName, filename: attachment.filename, extracted: false },
      };
    }

    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.substring(0, MAX_EXTRACTED_CHARS) + OVERFLOW_MESSAGE;
    }

    return {
      success: true,
      text,
      metadata: { type: typeName, filename: attachment.filename, extracted: true, chars: text.length },
    };
  }

  // ─── Utilities ────────────────────────────────────

  _decodePDFString(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }
}

module.exports = DocumentProcessor;
