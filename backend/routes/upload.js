'use strict';

const express = require('express');
const path = require('path');
const { createUploadMiddleware } = require('../core/multimodal/upload');

function createUploadRouter(mediaManager) {
  const router = express.Router();
  const upload = createUploadMiddleware({
    maxFileSize: 10 * 1024 * 1024,
  });

  /**
   * POST /api/upload — Upload one or more files
   */
  router.post('/', upload.array('files', 5), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No se enviaron archivos' });
      }

      const userId = req.body.userId || 'default';
      const results = [];

      for (const file of req.files) {
        const result = await mediaManager.processUpload(file, userId);
        results.push(result);
      }

      res.json({ files: results });
    } catch (err) {
      console.error('[Upload] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/upload/:id — Get media info
   */
  router.get('/:id', (req, res) => {
    const media = mediaManager.getMedia(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }
    res.json(media);
  });

  /**
   * GET /api/upload/:id/file — Serve the actual file
   */
  router.get('/:id/file', (req, res) => {
    const media = mediaManager.getMedia(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }
    // Path traversal protection
    const resolved = path.resolve(media.path);
    if (!resolved.startsWith(path.resolve(mediaManager.uploadDir))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.sendFile(resolved);
  });

  /**
   * DELETE /api/upload/:id — Delete media
   */
  router.delete('/:id', async (req, res) => {
    try {
      const deleted = await mediaManager.deleteMedia(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Media not found' });
      }
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/upload — List user media
   */
  router.get('/', (req, res) => {
    const userId = req.query.userId || 'default';
    const type = req.query.type || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const media = mediaManager.listMedia(userId, type, limit);
    res.json({ media });
  });

  return router;
}

module.exports = createUploadRouter;
