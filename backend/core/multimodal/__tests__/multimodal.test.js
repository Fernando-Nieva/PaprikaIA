'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MediaManager = require('../MediaManager');
const { createUploadMiddleware } = require('../upload');
const STTProvider = require('../STTProvider');

// ─── Helpers ──────────────────────────────────────────────────

function createMockDb(overrides = {}) {
  const defaultMedia = {
    id: 'test-id',
    user_id: 'default',
    type: 'image',
    filename: 'test.jpg',
    mime_type: 'image/jpeg',
    size: 1024,
    path: '/tmp/test.jpg',
    thumbnail_path: null,
    metadata: '{}',
    created_at: new Date().toISOString(),
  };

  return {
    prepare: (sql) => ({
      run: (...args) => overrides.runResult || { changes: 1 },
      get: (...args) => 'getResult' in overrides ? overrides.getResult : defaultMedia,
      all: (...args) => 'allResult' in overrides ? overrides.allResult : [],
    }),
    _sql: null,
    _args: null,
  };
}

function createTrackingDb() {
  const calls = [];
  return {
    calls,
    prepare: (sql) => ({
      run: (...args) => { calls.push({ sql, args, method: 'run' }); return { changes: 1 }; },
      get: (...args) => { calls.push({ sql, args, method: 'get' }); return { id: 'test-id', user_id: 'default', type: 'image', filename: 'test.jpg', mime_type: 'image/jpeg', size: 1024, path: '/tmp/test.jpg', thumbnail_path: null, metadata: '{}', created_at: new Date().toISOString() }; },
      all: (...args) => { calls.push({ sql, args, method: 'all' }); return []; },
    }),
  };
}

// ─── MediaManager ─────────────────────────────────────────────

describe('MediaManager', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('sets default uploadDir relative to __dirname', () => {
      const mm = new MediaManager(createMockDb());
      assert.ok(mm.uploadDir);
      assert.ok(mm.uploadDir.includes('uploads'));
    });

    it('sets default maxFileSize to 10MB', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm.maxFileSize, 10 * 1024 * 1024);
    });

    it('accepts custom config', () => {
      const mm = new MediaManager(createMockDb(), {
        uploadDir: '/custom/uploads',
        maxFileSize: 5 * 1024 * 1024,
      });
      assert.equal(mm.uploadDir, '/custom/uploads');
      assert.equal(mm.maxFileSize, 5 * 1024 * 1024);
    });

    it('stores the db reference', () => {
      const db = createMockDb();
      const mm = new MediaManager(db);
      assert.equal(mm.db, db);
    });

    it('initializes allowedImageTypes', () => {
      const mm = new MediaManager(createMockDb());
      assert.ok(Array.isArray(mm.allowedImageTypes));
      assert.ok(mm.allowedImageTypes.includes('image/jpeg'));
      assert.ok(mm.allowedImageTypes.includes('image/png'));
    });

    it('initializes allowedAudioTypes', () => {
      const mm = new MediaManager(createMockDb());
      assert.ok(Array.isArray(mm.allowedAudioTypes));
      assert.ok(mm.allowedAudioTypes.includes('audio/mpeg'));
      assert.ok(mm.allowedAudioTypes.includes('audio/wav'));
    });
  });

  describe('init', () => {
    it('creates upload directory and subdirectories', async () => {
      const uploadDir = path.join(tmpDir, 'uploads');
      const mm = new MediaManager(createMockDb(), { uploadDir });
      await mm.init();

      assert.ok(fs.existsSync(uploadDir));
      assert.ok(fs.existsSync(path.join(uploadDir, 'images')));
      assert.ok(fs.existsSync(path.join(uploadDir, 'audio')));
      assert.ok(fs.existsSync(path.join(uploadDir, 'thumbnails')));
    });

    it('does not fail if directories already exist', async () => {
      const uploadDir = path.join(tmpDir, 'uploads');
      fs.mkdirSync(path.join(uploadDir, 'images'), { recursive: true });
      const mm = new MediaManager(createMockDb(), { uploadDir });
      await mm.init();
      assert.ok(fs.existsSync(path.join(uploadDir, 'images')));
    });
  });

  describe('storeFile', () => {
    it('inserts a record and returns the media object', async () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      const uploadDir = mm.uploadDir;
      const result = await mm.storeFile({
        userId: 'user-1',
        type: 'image',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 2048,
        filePath: require('path').join(uploadDir, 'images', 'photo.jpg'),
        metadata: { width: 800 },
      });

      assert.ok(result.id);
      assert.equal(result.type, 'image');
      assert.equal(result.filename, 'photo.jpg');
      assert.equal(result.mimeType, 'image/jpeg');
      assert.equal(result.size, 2048);
      assert.ok(result.path.includes('photo.jpg'));
    });

    it('calls db.prepare with INSERT query', async () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      const uploadDir = mm.uploadDir;
      await mm.storeFile({
        userId: 'user-1',
        type: 'audio',
        filename: 'recording.wav',
        mimeType: 'audio/wav',
        size: 4096,
        filePath: require('path').join(uploadDir, 'audio', 'recording.wav'),
      });

      const insertCall = db.calls.find(c => c.method === 'run' && c.sql.includes('INSERT'));
      assert.ok(insertCall);
      assert.ok(insertCall.sql.includes('INSERT INTO media'));
    });

    it('serializes metadata to JSON', async () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      const uploadDir = mm.uploadDir;
      await mm.storeFile({
        userId: 'u1',
        type: 'image',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 100,
        filePath: require('path').join(uploadDir, 'images', 'a.png'),
        metadata: { originalName: 'a.png' },
      });

      const insertCall = db.calls.find(c => c.method === 'run' && c.sql.includes('INSERT'));
      const metadataArg = insertCall.args[8];
      assert.equal(typeof metadataArg, 'string');
      assert.equal(JSON.parse(metadataArg).originalName, 'a.png');
    });

    it('defaults metadata to empty object', async () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      const uploadDir = mm.uploadDir;
      await mm.storeFile({
        userId: 'u1',
        type: 'image',
        filename: 'b.jpg',
        mimeType: 'image/jpeg',
        size: 50,
        filePath: require('path').join(uploadDir, 'images', 'b.jpg'),
      });

      const insertCall = db.calls.find(c => c.method === 'run' && c.sql.includes('INSERT'));
      assert.equal(insertCall.args[8], '{}');
    });
  });

  describe('getMedia', () => {
    it('returns media record by id', () => {
      const mm = new MediaManager(createMockDb());
      const media = mm.getMedia('test-id');
      assert.ok(media);
      assert.equal(media.id, 'test-id');
      assert.equal(media.type, 'image');
    });

    it('calls db.prepare with SELECT query', () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      mm.getMedia('some-id');
      const selectCall = db.calls.find(c => c.sql.includes('SELECT * FROM media WHERE id'));
      assert.ok(selectCall);
      assert.deepEqual(selectCall.args, ['some-id']);
    });
  });

  describe('listMedia', () => {
    it('lists all media for a user without type filter', () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      mm.listMedia('user-1');
      const call = db.calls.find(c => c.method === 'all');
      assert.ok(call.sql.includes('WHERE user_id = ?'));
      assert.ok(!call.sql.includes('AND type = ?'));
    });

    it('filters by type when provided', () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      mm.listMedia('user-1', 'image');
      const call = db.calls.find(c => c.method === 'all');
      assert.ok(call.sql.includes('AND type = ?'));
      assert.deepEqual(call.args, ['user-1', 'image', 50]);
    });

    it('respects custom limit', () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      mm.listMedia('user-1', null, 10);
      const call = db.calls.find(c => c.method === 'all');
      assert.deepEqual(call.args, ['user-1', 10]);
    });
  });

  describe('deleteMedia', () => {
    it('returns false when media does not exist', async () => {
      const db = createMockDb({ getResult: undefined });
      const mm = new MediaManager(db);
      const result = await mm.deleteMedia('nonexistent');
      assert.equal(result, false);
    });

    it('deletes existing media and returns true', async () => {
      const tmpFile = path.join(tmpDir, 'to-delete.jpg');
      fs.writeFileSync(tmpFile, 'fake-image-data');
      const db = createMockDb({ getResult: { id: 'del-id', path: tmpFile, thumbnail_path: null } });
      const mm = new MediaManager(db);
      const result = await mm.deleteMedia('del-id');
      assert.equal(result, true);
      assert.ok(!fs.existsSync(tmpFile));
    });

    it('deletes thumbnail if thumbnail_path exists', async () => {
      const tmpFile = path.join(tmpDir, 'del-thumb.jpg');
      const thumbFile = path.join(tmpDir, 'thumb.jpg');
      fs.writeFileSync(tmpFile, 'data');
      fs.writeFileSync(thumbFile, 'thumb-data');
      const db = createMockDb({ getResult: { id: 'x', path: tmpFile, thumbnail_path: thumbFile } });
      const mm = new MediaManager(db);
      const result = await mm.deleteMedia('x');
      assert.equal(result, true);
      assert.ok(!fs.existsSync(thumbFile));
    });

    it('does not throw if main file does not exist on disk', async () => {
      const db = createMockDb({ getResult: { id: 'y', path: '/nonexistent/file.jpg', thumbnail_path: null } });
      const mm = new MediaManager(db);
      const result = await mm.deleteMedia('y');
      assert.equal(result, true);
    });

    it('calls DELETE query on db', async () => {
      const db = createTrackingDb();
      const mm = new MediaManager(db);
      await mm.deleteMedia('test-id');
      const deleteCall = db.calls.find(c => c.sql.includes('DELETE FROM media'));
      assert.ok(deleteCall);
    });
  });

  describe('processUpload', () => {
    it('moves file to images subdirectory for image mime type', async () => {
      const uploadDir = path.join(tmpDir, 'uploads');
      fs.mkdirSync(path.join(uploadDir, 'images'), { recursive: true });
      fs.mkdirSync(path.join(uploadDir, 'audio'), { recursive: true });

      const srcFile = path.join(tmpDir, 'incoming.jpg');
      fs.writeFileSync(srcFile, 'fake-jpg');

      const mm = new MediaManager(createMockDb(), { uploadDir });
      const result = await mm.processUpload(
        { path: srcFile, originalname: 'photo.jpg', mimetype: 'image/jpeg', size: 100 },
        'user-1'
      );

      assert.equal(result.type, 'image');
      assert.ok(result.path.includes('images'));
      assert.ok(!fs.existsSync(srcFile));
    });

    it('moves file to audio subdirectory for audio mime type', async () => {
      const uploadDir = path.join(tmpDir, 'uploads');
      fs.mkdirSync(path.join(uploadDir, 'images'), { recursive: true });
      fs.mkdirSync(path.join(uploadDir, 'audio'), { recursive: true });

      const srcFile = path.join(tmpDir, 'incoming.wav');
      fs.writeFileSync(srcFile, 'fake-wav');

      const mm = new MediaManager(createMockDb(), { uploadDir });
      const result = await mm.processUpload(
        { path: srcFile, originalname: 'recording.wav', mimetype: 'audio/wav', size: 200 },
        'user-2'
      );

      assert.equal(result.type, 'audio');
      assert.ok(result.path.includes('audio'));
    });
  });

  describe('readFileAsBase64', () => {
    it('returns base64 encoded content for existing media', async () => {
      const tmpFile = path.join(tmpDir, 'read-test.txt');
      fs.writeFileSync(tmpFile, 'hello world');

      const db = createMockDb({
        getResult: {
          id: 'r1', path: tmpFile, mime_type: 'text/plain',
          filename: 'read-test.txt', type: 'file',
        },
      });
      const mm = new MediaManager(db);
      const result = await mm.readFileAsBase64('r1');

      assert.ok(result);
      assert.equal(result.mimeType, 'text/plain');
      assert.equal(result.filename, 'read-test.txt');
      assert.equal(result.type, 'file');
      assert.equal(Buffer.from(result.data, 'base64').toString(), 'hello world');
    });

    it('returns null for non-existent media', async () => {
      const db = createMockDb({ getResult: undefined });
      const mm = new MediaManager(db);
      const result = await mm.readFileAsBase64('nope');
      assert.equal(result, null);
    });
  });

  describe('isAllowedType', () => {
    it('returns true for allowed image types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm.isAllowedType('image/jpeg'), true);
      assert.equal(mm.isAllowedType('image/png'), true);
      assert.equal(mm.isAllowedType('image/gif'), true);
      assert.equal(mm.isAllowedType('image/webp'), true);
    });

    it('returns true for allowed audio types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm.isAllowedType('audio/mpeg'), true);
      assert.equal(mm.isAllowedType('audio/wav'), true);
      assert.equal(mm.isAllowedType('audio/ogg'), true);
      assert.equal(mm.isAllowedType('audio/webm'), true);
      assert.equal(mm.isAllowedType('audio/mp4'), true);
    });

    it('returns false for disallowed types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm.isAllowedType('video/mp4'), false);
      assert.equal(mm.isAllowedType('application/pdf'), false);
      assert.equal(mm.isAllowedType('text/plain'), false);
    });
  });

  describe('_getTypeFromMime', () => {
    it('returns image for image mime types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm._getTypeFromMime('image/jpeg'), 'image');
      assert.equal(mm._getTypeFromMime('image/png'), 'image');
    });

    it('returns audio for audio mime types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm._getTypeFromMime('audio/mpeg'), 'audio');
      assert.equal(mm._getTypeFromMime('audio/wav'), 'audio');
    });

    it('returns file for other mime types', () => {
      const mm = new MediaManager(createMockDb());
      assert.equal(mm._getTypeFromMime('video/mp4'), 'file');
      assert.equal(mm._getTypeFromMime('application/pdf'), 'file');
    });
  });

  describe('getMetrics', () => {
    it('returns total count and breakdown by type', () => {
      const db = createMockDb();
      db.prepare = (sql) => ({
        run: () => ({ changes: 1 }),
        get: () => sql.includes('COUNT(*) as count FROM media') && !sql.includes('GROUP')
          ? { count: 5 }
          : undefined,
        all: () => sql.includes('GROUP BY')
          ? [{ type: 'image', count: 3 }, { type: 'audio', count: 2 }]
          : [],
      });

      const mm = new MediaManager(db);
      const metrics = mm.getMetrics();
      assert.equal(metrics.total, 5);
      assert.equal(metrics.byType.length, 2);
      assert.equal(metrics.byType[0].type, 'image');
      assert.equal(metrics.byType[1].type, 'audio');
    });
  });
});

// ─── upload.js ────────────────────────────────────────────────

describe('upload.js', () => {
  describe('createUploadMiddleware', () => {
    it('returns a multer instance', () => {
      const upload = createUploadMiddleware();
      assert.ok(upload);
      assert.equal(typeof upload.single, 'function');
      assert.equal(typeof upload.array, 'function');
    });

    it('accepts custom maxFileSize', () => {
      const upload = createUploadMiddleware({ maxFileSize: 5 * 1024 * 1024 });
      assert.ok(upload);
    });

    it('accepts custom allowedTypes', () => {
      const upload = createUploadMiddleware({ allowedTypes: ['image/jpeg'] });
      assert.ok(upload);
    });

    it('uses default allowed types when none provided', () => {
      const upload = createUploadMiddleware();
      assert.ok(upload);
    });
  });
});

// ─── STTProvider ──────────────────────────────────────────────

describe('STTProvider', () => {
  describe('constructor', () => {
    it('defaults to groq provider', () => {
      const stt = new STTProvider();
      assert.equal(stt.provider, 'groq');
    });

    it('defaults model to whisper-large-v3', () => {
      const stt = new STTProvider();
      assert.equal(stt.model, 'whisper-large-v3');
    });

    it('sets groq baseUrl by default', () => {
      const stt = new STTProvider();
      assert.equal(stt.baseUrl, 'https://api.groq.com/openai/v1');
    });

    it('sets openai baseUrl when provider is openai', () => {
      const stt = new STTProvider({ provider: 'openai' });
      assert.equal(stt.baseUrl, 'https://api.openai.com/v1');
    });

    it('accepts custom apiKey', () => {
      const stt = new STTProvider({ apiKey: 'sk-test-123' });
      assert.equal(stt.apiKey, 'sk-test-123');
    });

    it('accepts custom model', () => {
      const stt = new STTProvider({ model: 'whisper-large-v2' });
      assert.equal(stt.model, 'whisper-large-v2');
    });

    it('accepts custom baseUrl', () => {
      const stt = new STTProvider({ baseUrl: 'https://custom.api.com/v1' });
      assert.equal(stt.baseUrl, 'https://custom.api.com/v1');
    });
  });

  describe('_getExtension', () => {
    it('returns mp3 for audio/mpeg', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/mpeg'), 'mp3');
    });

    it('returns wav for audio/wav', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/wav'), 'wav');
    });

    it('returns ogg for audio/ogg', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/ogg'), 'ogg');
    });

    it('returns webm for audio/webm', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/webm'), 'webm');
    });

    it('returns m4a for audio/mp4', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/mp4'), 'm4a');
    });

    it('returns mp3 as fallback for unknown mime types', () => {
      const stt = new STTProvider();
      assert.equal(stt._getExtension('audio/unknown'), 'mp3');
    });
  });

  describe('transcribe', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns null when no API key is set', async () => {
      const stt = new STTProvider();
      const result = await stt.transcribe('base64data', 'audio/mpeg');
      assert.equal(result, null);
    });

    it('returns transcribed text on success', async () => {
      globalThis.fetch = async (url, opts) => {
        return {
          ok: true,
          text: async () => '  hola mundo  ',
        };
      };

      const stt = new STTProvider({ apiKey: 'test-key' });
      const result = await stt.transcribe('base64data', 'audio/mpeg');
      assert.equal(result, 'hola mundo');
    });

    it('sends correct URL and Authorization header', async () => {
      let capturedUrl = null;
      let capturedHeaders = null;

      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        return { ok: true, text: async () => 'ok' };
      };

      const stt = new STTProvider({ apiKey: 'my-key', baseUrl: 'https://api.test.com/v1' });
      await stt.transcribe('base64data', 'audio/wav');

      assert.equal(capturedUrl, 'https://api.test.com/v1/audio/transcriptions');
      assert.equal(capturedHeaders['Authorization'], 'Bearer my-key');
    });

    it('returns null on non-ok response', async () => {
      globalThis.fetch = async (url, opts) => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const stt = new STTProvider({ apiKey: 'bad-key' });
      const result = await stt.transcribe('base64data', 'audio/mpeg');
      assert.equal(result, null);
    });

    it('returns null when fetch throws an error', async () => {
      globalThis.fetch = async () => {
        throw new Error('Network failure');
      };

      const stt = new STTProvider({ apiKey: 'key' });
      const result = await stt.transcribe('base64data', 'audio/mpeg');
      assert.equal(result, null);
    });
  });
});

// ─── index.js exports ─────────────────────────────────────────

describe('index.js exports', () => {
  it('exports MediaManager', () => {
    const mod = require('../index');
    assert.equal(mod.MediaManager, MediaManager);
  });

  it('exports createUploadMiddleware', () => {
    const mod = require('../index');
    assert.equal(typeof mod.createUploadMiddleware, 'function');
  });
});
