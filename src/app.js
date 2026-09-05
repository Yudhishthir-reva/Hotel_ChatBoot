const express = require('express');
const cors = require('cors');
const path = require('path');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const devRoutes = require('./routes/dev.routes');
const { errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dev', devRoutes);

app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.use('/menu', express.static(path.join(__dirname, '../public/menu')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use(errorHandler);

module.exports = app;
