/**
 * ModelSelector — Automatically selects the best model for a given task.
 *
 * Analyzes the message and attachments, then picks the optimal model.
 * Falls back intelligently when the preferred model doesn't support needed capabilities.
 */

const { MODEL_CAPABILITIES } = require('./CapabilityManager');

class ModelSelector {
  /**
   * @param {object} capabilityManager - CapabilityManager instance
   * @param {object} config - { preferredChat, preferredVision, preferredAudio, preferredDocument }
   */
  constructor(capabilityManager, config = {}) {
    this.cm = capabilityManager;
    this.config = {
      preferredChat: config.preferredChat || null,       // { provider, model }
      preferredVision: config.preferredVision || null,    // { provider, model }
      preferredAudio: config.preferredAudio || null,      // { provider, model }
      preferredDocument: config.preferredDocument || null, // { provider, model }
    };
  }

  /**
   * Analyze attachments and determine what capabilities are needed.
   * @param {Array} attachments - [{ mimeType, base64?, filename? }]
   * @returns {{ needsVision: boolean, needsAudio: boolean, needsDocument: boolean, reasons: string[] }}
   */
  analyzeAttachments(attachments) {
    if (!attachments || attachments.length === 0) {
      return { needsVision: false, needsAudio: false, needsDocument: false, reasons: [] };
    }

    const reasons = [];
    let needsVision = false;
    let needsAudio = false;
    let needsDocument = false;

    for (const att of attachments) {
      const mime = (att.mimeType || '').toLowerCase();

      if (mime.startsWith('image/')) {
        needsVision = true;
        reasons.push(`Imagen detectada (${mime})`);
      } else if (mime.startsWith('audio/')) {
        needsAudio = true;
        reasons.push(`Audio detectado (${mime})`);
      } else if (
        mime === 'application/pdf' ||
        mime.includes('document') ||
        mime.includes('text/') ||
        mime === 'text/markdown' ||
        mime === 'text/plain' ||
        mime.includes('officedocument') ||
        /\.(pdf|docx?|txt|md|csv|json)$/i.test(att.filename || '')
      ) {
        needsDocument = true;
        reasons.push(`Documento detectado (${att.filename || mime})`);
      }
    }

    return { needsVision, needsAudio, needsDocument, reasons };
  }

  /**
   * Select the best model for the given requirements.
   *
   * @param {{ needsVision, needsAudio, needsDocument }} requirements
   * @param {{ provider, model }} currentModel - The currently active model
   * @returns {{ provider, model, switched: boolean, reason: string }}
   */
  selectModel(requirements, currentModel) {
    const { needsVision, needsAudio, needsDocument } = requirements;

    // No special requirements → use current model
    if (!needsVision && !needsAudio && !needsDocument) {
      return {
        provider: currentModel.provider,
        model: currentModel.model,
        switched: false,
        reason: ' Sin requisitos especiales',
      };
    }

    // Determine required capability
    const requiredCapability = needsVision ? 'vision' : needsAudio ? 'audio' : 'tools';

    // Check if current model supports it
    const currentSupports = this.cm.modelSupports(
      currentModel.provider, currentModel.model, requiredCapability
    );

    if (currentSupports) {
      return {
        provider: currentModel.provider,
        model: currentModel.model,
        switched: false,
        reason: `Modelo actual soporta ${requiredCapability}`,
      };
    }

    // Current model doesn't support it → find a better one
    // 1. Try preferred model for this capability
    const preferred = this.config[`preferred${needsVision ? 'Vision' : needsAudio ? 'Audio' : 'Document'}`];
    if (preferred) {
      const preferredSupports = this.cm.modelSupports(
        preferred.provider, preferred.model, requiredCapability
      );
      if (preferredSupports) {
        return {
          provider: preferred.provider,
          model: preferred.model,
          switched: true,
          reason: `Modelo actual no soporta ${requiredCapability}. Usando modelo preferido: ${preferred.model}`,
        };
      }
    }

    // 2. Auto-discover: find ANY model with the capability
    const candidates = this.cm.findByCapability(requiredCapability);
    if (candidates.length > 0) {
      // Prefer cloud models over local for reliability
      const cloud = candidates.find(c => c.provider !== 'ollama');
      const pick = cloud || candidates[0];
      return {
        provider: pick.provider,
        model: pick.name,
        switched: true,
        reason: `Modelo actual no soporta ${requiredCapability}. Auto-seleccionado: ${pick.name} (${pick.provider})`,
      };
    }

    // 3. No model found with the capability
    return {
      provider: currentModel.provider,
      model: currentModel.model,
      switched: false,
      reason: `Ningún modelo disponible soporta ${requiredCapability}`,
      unavailable: true,
    };
  }

  /**
   * Full selection flow: analyze + select.
   * @param {Array} attachments
   * @param {{ provider, model }} currentModel
   * @returns {{ provider, model, switched, reason, unavailable, requirements }}
   */
  select(attachments, currentModel) {
    const requirements = this.analyzeAttachments(attachments);
    const selection = this.selectModel(requirements, currentModel);
    return { ...selection, requirements };
  }
}

module.exports = ModelSelector;
