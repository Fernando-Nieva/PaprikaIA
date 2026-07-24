const express = require('express');
const cors = require('cors');
const { router: chatRoutes, setupRoutes } = require('./routes/chat');
const { router: userRoutes, setupUserRoutes } = require('./routes/user');
const db = require('./db');
const createCore = require('./core');

const app = express();
const PORT = 3001;

// Inicializar Paprika Core (Fase 1 — stubs activos)
const core = createCore(db);
setupRoutes(core);
setupUserRoutes(core);

app.use(cors());
app.use(express.json());
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Backend corriendo en http://0.0.0.0:${PORT}`);
  console.log(`📊 Core status:`, core.getStatus());
});
