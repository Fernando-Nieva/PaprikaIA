require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { router: chatRoutes, setupRoutes } = require('./routes/chat');
const { router: userRoutes, setupUserRoutes } = require('./routes/user');
const createUploadRouter = require('./routes/upload');
const db = require('./db');
const createCore = require('./core');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware global (CORS, JSON) ANTES de todas las rutas ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Inicializar Paprika Core (Fase 1 — stubs activos)
const core = createCore(db);
setupRoutes(core);
setupUserRoutes(core);

// ─── Upload routes ───
const uploadRouter = createUploadRouter(core.media);
app.use('/api/upload', uploadRouter);

app.use('/api', chatRoutes);
app.use('/api', userRoutes);

// ─── Telemetry endpoint ───
app.get('/api/telemetry', (_req, res) => {
  const telemetry = core.getTelemetry();
  res.json(telemetry.getSnapshot());
});

app.get('/api/telemetry/logs', (req, res) => {
  const telemetry = core.getTelemetry();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(telemetry.getLogs(limit));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Backend corriendo en http://0.0.0.0:${PORT}`);
  console.log(`📊 Core status:`, core.getStatus());
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} ya está en uso. Usa PORT en .env para cambiarlo.`);
    process.exit(1);
  }
  throw err;
});
