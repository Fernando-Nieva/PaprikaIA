'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class MediaManager {
  constructor(db, config = {}) {
    this.db = db;
    this.uploadDir = config.uploadDir || path.join(__dirname, '../../uploads');
    this.maxFileSize = config.maxFileSize || 10 * 1024 * 1024;
    this.allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    this.allowedAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'];
  }

  async init() {
    await fs.mkdir(this.uploadDir, { recursive: true });
    await fs.mkdir(path.join(this.uploadDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(this.uploadDir, 'audio'), { recursive: true });
    await fs.mkdir(path.join(this.uploadDir, 'thumbnails'), { recursive: true });
  }

  /**
   * Stores a file record in the database.
   */
  async storeFile({ userId, type, filename, mimeType, size, filePath, metadata }) {
    const id = crypto.randomUUID();
    const thumbnailPath = null;

    // Validate filePath is within uploadDir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.uploadDir))) {
      throw new Error('Invalid file path: outside upload directory');
    }

    this.db.prepare(`
      INSERT INTO media (id, user_id, type, filename, mime_type, size, path, thumbnail_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, type, filename, mimeType, size, filePath, thumbnailPath, JSON.stringify(metadata || {}));

    return { id, type, filename, mimeType, size, path: filePath };
  }

  /**
   * Gets a media record by ID.
   */
  getMedia(id) {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  }

  /**
   * Lists media for a user.
   */
  listMedia(userId, type = null, limit = 50) {
    if (type) {
      return this.db.prepare('SELECT * FROM media WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?')
        .all(userId, type, limit);
    }
    return this.db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit);
  }

  /**
   * Deletes a media record and its file.
   */
  async deleteMedia(id) {
    const media = this.getMedia(id);
    if (!media) return false;

    // Delete DB record first, then files
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    await fs.unlink(media.path).catch(() => {});
    if (media.thumbnail_path) {
      await fs.unlink(media.thumbnail_path).catch(() => {});
    }
    return true;
  }

  /**
   * Processes an uploaded file: moves it to the right directory, generates metadata.
   */
  async processUpload(file, userId) {
    const ext = path.extname(file.originalname).toLowerCase();
    const type = this._getTypeFromMime(file.mimetype);
    const subdir = type === 'audio' ? 'audio' : 'images';
    const newFilename = `${crypto.randomUUID()}${ext}`;
    const newPath = path.join(this.uploadDir, subdir, newFilename);

    // Ensure target directory exists
    await fs.mkdir(path.dirname(newPath), { recursive: true });

    try {
      await fs.rename(file.path, newPath);
    } catch (err) {
      // Clean up temp file on failure
      await fs.unlink(file.path).catch(() => {});
      throw err;
    }

    const metadata = {
      originalName: file.originalname,
      width: null,
      height: null,
      duration: null,
    };

    if (type === 'image') {
      try {
        const sharp = require('sharp');
        const info = await sharp(newPath).metadata();
        metadata.width = info.width;
        metadata.height = info.height;
      } catch { /* sharp not available, skip */ }
    }

    return this.storeFile({
      userId,
      type,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      filePath: newPath,
      metadata,
    });
  }

  /**
   * Reads a file as base64.
   */
  async readFileAsBase64(id) {
    const media = this.getMedia(id);
    if (!media) return null;

    const buffer = await fs.readFile(media.path);
    return {
      mimeType: media.mime_type,
      data: buffer.toString('base64'),
      filename: media.filename,
      type: media.type,
    };
  }

  /**
   * Gets the MIME type category from a MIME string.
   */
  _getTypeFromMime(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }

  /**
   * Validates that a file type is allowed.
   */
  isAllowedType(mimeType) {
    return [...this.allowedImageTypes, ...this.allowedAudioTypes].includes(mimeType);
  }

  /**
   * Returns metrics.
   */
  getMetrics() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM media').get();
    const byType = this.db.prepare('SELECT type, COUNT(*) as count FROM media GROUP BY type').all();
    return { total: total.count, byType };
  }
}

module.exports = MediaManager;
