const express = require('express');
const cors = require('cors');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use('/api', chatRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Backend corriendo en http://0.0.0.0:${PORT}`);
});
