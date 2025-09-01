// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { MessageMedia } = require('whatsapp-web.js');
const mime = require('mime-types');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const winston = require('winston');
const os = require('os-utils');
const {
  createInstance,
  getInstance,
  deleteInstance,
  getStatus,
  getQRCode,
  restoreSessions,
  getInfo,
  logoutInstance,
  resetInstance,
  restartInstance,
  instances,
  qrCodes
} = require('./instanceManager');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ==========================
// Logging Setup (Winston)
// ==========================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' }),
  ],
});

// ==========================
// Middleware Setup
// ==========================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: '10mb' }));
app.use(fileUpload({
  limits: { fileSize: 25 * 1024 * 1024 },
  abortOnLimit: true
}));

// ==========================
// Utility Functions
// ==========================
function getId(req) {
  return (req.params.id || '').trim();
}

function sendError(res, status, message, details = null) {
  return res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

// ==========================
// Health Check Endpoint
// ==========================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    memoryUsage: process.memoryUsage().rss,
    cpuUsage: os.cpuUsage(),
    instances: instances.size,
  });
});

// ==========================
// Routes Setup
// ==========================
app.post('/instance/:id', async (req, res) => {
  const id = getId(req);
  if (!id) return sendError(res, 400, 'Instance id is required');
  if (instances.has(id)) return sendError(res, 400, 'Instance already exists');

  createInstance(id)
    .then(() => logger.info(`Instance ${id} initialization started`))
    .catch(err => logger.error(`Instance ${id} creation error:`, err.message));

  return res.json({ success: true, message: `Instance ${id} creation started` });
});

app.delete('/instance/:id', async (req, res) => {
  const id = getId(req);
  try {
    const result = await deleteInstance(id);
    if (!result) return sendError(res, 404, 'Instance not found');
    return res.json({ success: true });
  } catch (err) {
    logger.error(`Delete instance [${id}] error:`, err.message);
    return sendError(res, 500, 'Failed to delete instance', err.message);
  }
});

app.get('/qr/:id', async (req, res) => {
  const id = getId(req);
  try {
    if (!instances.has(id)) {
      createInstance(id).catch(e => logger.error('Background create error:', e.message));
      return res.status(202).json({ message: 'Instance creation started, QR not available yet' });
    }

    const client = instances.get(id);
    if (client?.info) return sendError(res, 400, 'Already connected. QR not needed.');

    const qr = qrCodes.get(id);
    if (!qr) return sendError(res, 404, 'QR not available. Instance may be connected or not ready.');

    const base64Image = await QRCode.toDataURL(qr);
    return res.json({ qr_image: base64Image });
  } catch (err) {
    logger.error(`QR generation [${id}] failed:`, err.message);
    return sendError(res, 500, 'Failed to generate QR image.', err.message);
  }
});

app.get('/status/:id', async (req, res) => {
  const id = getId(req);
  try {
    const status = getStatus(id);
    const info = await getInfo(id);
    return res.json({
      id,
      status,
      number: info?.number || null,
      pushname: info?.pushname || null,
      profile_pic: info?.profile_pic || null
    });
  } catch (err) {
    logger.error(`Status fetch [${id}] failed:`, err.message);
    return sendError(res, 500, 'Failed to get status info', err.message);
  }
});

// ==========================
// Graceful Shutdown
// ==========================
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  for (const [id, client] of instances.entries()) {
    client.destroy().catch(err => logger.error(`Failed to disconnect instance ${id}: ${err.message}`));
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  for (const [id, client] of instances.entries()) {
    client.destroy().catch(err => logger.error(`Failed to disconnect instance ${id}: ${err.message}`));
  }
  process.exit(0);
});

// ==========================
// Start Server
// ==========================
(async () => {
  try {
    await restoreSessions();
  } catch (err) {
    logger.warn('restoreSessions error:', err.message || err);
  }

  app.listen(PORT, '0.0.0.0', () => {
    const serverIp = process.env.SERVER_IP || '0.0.0.0';
    logger.info(`🚀 WhatsApp API server running on http://${serverIp}:${PORT}`);
    logger.info(`(listening on 0.0.0.0:${PORT} — reachable via your VPS public IP)`);
  });
})();
