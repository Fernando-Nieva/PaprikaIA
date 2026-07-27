/**
 * ModelSelector — Automatically selects the best model for a given task.
 *
 * Priority system:
 *   Level 1 (FREE): Ollama local → Groq → Gemini free tier
 *   Level 2 (OPTIONAL): OpenRouter free models
 *   Level 3 (PAID): OpenAI, Anthropic — only if user configured AND no free alternative
 *
 * Design principles:
 *   - ALWAYS prefer free models when capabilities match
 *   - NEVER depend on a single provider
 *   - Personality belongs to Paprika, not the model
 *   - Select by capabilities, never by hardcoded names
 */

const { getModelRegistry, PRIORITY } = require('../../providers/modelRegistry');

class ModelSelector {
  /**
   * @param {object} capabilityManager - CapabilityManager instance
   * @param {object} config - { preferredChat, preferredVision, preferredAudio, preferredDocument }
   */
  constructor(capabilityManager, config = {}) {
    this.cm = capabilityManager;
    this.registry = getModelRegistry();
    this.config = {
      preferredChat: config.preferredChat || null,
      preferredVision: config.preferredVision || null,
      preferredAudio: config.preferredAudio || null,
      preferredDocument: config.preferredDocument || null,
    };
  }

  /**
   * Analyze attachments and determine what capabilities are needed.
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
   * Selection order:
   *   1. If current model supports the capability → keep it
   *   2. Try preferred model for this capability type
   *   3. Auto-discover using ModelRegistry (priority-sorted: free first)
   *   4. No model found → return unavailable
   */
  selectModel(requirements, currentModel) {
    const { needsVision, needsAudio, needsDocument } = requirements;

    // No special requirements → use current model
    if (!needsVision && !needsAudio && !needsDocument) {
      return {
        provider: currentModel.provider,
        model: currentModel.model,
        switched: false,
        reason: 'Sin requisitos especiales',
      };
    }

    // Determine required capability
    const requiredCapability = needsVision ? 'vision' : needsAudio ? 'audio' : 'tools';

    // 1. Check if current model supports it
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

    // 2. Try preferred model for this capability
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
          reason: `Modelo preferido: ${preferred.model} (${preferred.provider})`,
        };
      }
    }

    // 3. Auto-discover using ModelRegistry (priority-sorted: free first)
    const best = this.registry.selectBest({ [requiredCapability]: true });
    if (best) {
      return {
        provider: best.provider,
        model: best.model,
        switched: true,
        reason: best.reason,
      };
    }

    // 4. Fallback: try CapabilityManager (legacy path)
    const candidates = this.cm.findByCapability(requiredCapability);
    if (candidates.length > 0) {
      // Use priority from ModelRegistry if available
      const enriched = candidates.map(c => {
        const providerData = this.registry.getProvider(c.provider);
        return {
          ...c,
          priority: providerData?.priority || PRIORITY.PAID,
        };
      });
      enriched.sort((a, b) => a.priority - b.priority);
      const pick = enriched[0];
      return {
        provider: pick.provider,
        model: pick.name,
        switched: true,
        reason: `Auto-seleccionado: ${pick.name} (${pick.provider})`,
      };
    }

    // 5. No model found
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
   */
  select(attachments, currentModel) {
    const requirements = this.analyzeAttachments(attachments);
    const selection = this.selectModel(requirements, currentModel);
    return { ...selection, requirements };
  }
}

module.exports = ModelSelector;
