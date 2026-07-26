'use strict';

const multer = require('multer');
const path = require('path');
const os = require('os');

/**
 * Creates multer upload middleware for Paprika.
 *
 * @param {Object} config
 * @param {number} config.maxFileSize - Max file size in bytes (default 10MB)
 * @param {string[]} config.allowedTypes - Allowed MIME types
 * @returns {multer.Multer}
 */
function createUploadMiddleware(config = {}) {
  const maxFileSize = config.maxFileSize || 10 * 1024 * 1024;
  const allowedTypes = config.allowedTypes || [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
  ];

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).substring(2)}${ext}`);
    },
  });

  const fileFilter = (req, file, cb) => {
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`), false);
    }
  };

  return multer({
    storage,
    fileFilter,
    limits: { fileSize: maxFileSize },
  });
}

module.exports = { createUploadMiddleware };
