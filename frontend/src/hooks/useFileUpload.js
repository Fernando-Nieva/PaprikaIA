import { useState, useRef, useCallback } from 'react';

const ALLOWED_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'],
  document: [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ],
};

const MAX_SIZE = 10 * 1024 * 1024;

export default function useFileUpload({ onFilesChange } = {}) {
  const [previews, setPreviews] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const validateFile = useCallback((file) => {
    const allAllowed = [...ALLOWED_TYPES.image, ...ALLOWED_TYPES.audio, ...ALLOWED_TYPES.document];
    const ext = file.name.split('.').pop().toLowerCase();
    const extMap = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword' };
    const isAllowed = allAllowed.includes(file.type) || extMap[ext];
    if (!isAllowed) {
      return `Tipo no permitido: ${file.type || ext || 'desconocido'}. Imágenes, audio, PDF, TXT, MD, CSV, JSON y DOCX.`;
    }
    if (file.size > MAX_SIZE) {
      return `Archivo muy grande (${(file.size / 1024 / 1024).toFixed(1)}MB). Máximo: 10MB`;
    }
    return null;
  }, []);

  const processFiles = useCallback((files) => {
    const newPreviews = [];
    for (const file of files) {
      const error = validateFile(file);
      if (error) {
        alert(error);
        continue;
      }
      const preview = {
        file,
        id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
      };
      newPreviews.push(preview);
    }
    if (newPreviews.length > 0) {
      setPreviews(prev => {
        const next = [...prev, ...newPreviews];
        onFilesChange?.(next);
        return next;
      });
    }
  }, [validateFile, onFilesChange]);

  const prepareAttachments = useCallback(async () => {
    if (previews.length === 0) return [];
    setUploading(true);
    const results = [];

    for (const preview of previews) {
      const reader = new FileReader();
      const base64 = await new Promise((resolve) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(preview.file);
      });
      results.push({
        base64,
        mimeType: preview.type,
        filename: preview.name,
      });
    }

    setUploading(false);
    return results;
  }, [previews]);

  const removePreview = useCallback((id) => {
    setPreviews(prev => {
      const removed = prev.find(p => p.id === id);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      const next = prev.filter(p => p.id !== id);
      onFilesChange?.(next);
      return next;
    });
  }, [onFilesChange]);

  const clearPreviews = useCallback(() => {
    previews.forEach(p => {
      if (p.url) URL.revokeObjectURL(p.url);
    });
    setPreviews([]);
    onFilesChange?.([]);
  }, [previews, onFilesChange]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  }, [processFiles]);

  const handlePaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      processFiles(files);
    }
  }, [processFiles]);

  const triggerFileInput = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e) => {
    const files = Array.from(e.target.files);
    processFiles(files);
    e.target.value = '';
  }, [processFiles]);

  return {
    previews,
    uploading,
    fileInputRef,
    handleDrop,
    handlePaste,
    processFiles,
    prepareAttachments,
    removePreview,
    clearPreviews,
    triggerFileInput,
    handleFileInputChange,
    hasAttachments: previews.length > 0,
  };
}
