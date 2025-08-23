// app.js
require('dotenv').config?.(); // safe optional: only works if you add dotenv
const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const { MessageMedia } = require('whatsapp-web.js');
const mime = require('mime-types');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

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
  restartInstance,   // ✅ ensure imported for recovery
  instances,
  qrCodes
} = require('./instanceManager');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------- Global Middleware ----------
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '10mb' }));
app.use(fileUpload({ limits: { fileSize: 25 * 1024 * 1024 }, abortOnLimit: true })); // 25 MB cap

// Basic request logger (lightweight; no extra deps)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// Health check (useful for uptime monitors / PM2)
app.get('/', (_req, res) => res.json({ ok: true, service: 'waapi', time: new Date().toISOString() }));

// ---------- Routes (all preserved) ----------

// Create instance
app.post('/instance/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    await createInstance(id);
    res.json({ success: true, message: `Instance ${id} created` });
  } catch (err) {
    console.error('Create instance error:', err);
    res.status(500).json({ error: 'Failed to create instance', details: err.message });
  }
});

// Delete instance
app.delete('/instance/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    const result = await deleteInstance(id);
    if (result) return res.json({ success: true });
    return res.status(404).json({ error: 'Instance not found' });
  } catch (err) {
    console.error('Delete instance error:', err);
    res.status(500).json({ error: 'Failed to delete instance', details: err.message });
  }
});

// Get QR code image (base64)
app.get('/qr/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    if (!instances.has(id)) {
      await createInstance(id);
    }

    const client = instances.get(id);
    if (client && client.info) {
      return res.status(400).json({ error: 'Already connected. QR not needed.' });
    }

    const qr = qrCodes.get(id);
    if (!qr) {
      return res.status(404).json({ error: 'QR not available. Instance may be connected or not created.' });
    }

    const base64Image = await QRCode.toDataURL(qr);
    return res.json({ qr_image: base64Image });
  } catch (err) {
    console.error('QR generation failed:', err);
    return res.status(500).json({ error: 'Failed to generate QR image.', details: err.message });
  }
});

// Get status + info
app.get('/status/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  const status = getStatus(id);
  try {
    const info = await getInfo(id);
    res.json({
      id,
      status,
      number: info?.number || null,
      pushname: info?.pushname || null,
      profile_pic: info?.profile_pic || null
    });
  } catch (err) {
    console.error(`Failed to get status info for ${id}:`, err);
    res.status(500).json({ error: 'Failed to get status info', details: err.message });
  }
});

// Get client info only
app.get('/info/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    const info = await getInfo(id);
    if (info) return res.json(info);
    return res.status(404).json({ error: 'Instance not found or not connected' });
  } catch (err) {
    console.error('Get info error:', err);
    res.status(500).json({ error: 'Failed to get info', details: err.message });
  }
});

// Logout instance
app.post('/logout/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    const result = await logoutInstance(id);
    if (result) return res.json({ success: true, message: `Instance ${id} logged out` });
    return res.status(404).json({ error: 'Instance not found or logout failed' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout', details: err.message });
  }
});

// Reset instance
app.post('/reset/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Instance id is required' });

  try {
    const result = await resetInstance(id);
    if (result) return res.json({ success: true, message: `Instance ${id} has been reset` });
    return res.status(404).json({ error: 'Instance not found or failed to reset' });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: 'Failed to reset instance', details: err.message });
  }
});

// Send text message
app.post('/send/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  const client = getInstance(id);
  if (!client) return res.status(404).json({ error: 'Instance not found or not connected' });

  const { number, message } = req.body || {};
  if (!number || !message) return res.status(400).json({ error: 'number and message are required' });
  if (!number.endsWith('@c.us') && !number.endsWith('@g.us'))
    return res.status(400).json({ error: 'number must include @c.us or @g.us' });

  try {
    await client.sendMessage(number, message);
    res.json({ success: true, to: number, message });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// Send media (supports upload, fileUrl, filePath)
app.post('/send-media/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  const client = getInstance(id);
  if (!client) return res.status(404).json({ error: 'Instance not found or not connected' });

  const { number, fileUrl, filePath, caption } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number is required' });

  try {
    let media;

    if (req.files && req.files.media) {
      const mediaFile = req.files.media;
      const mimeType = mediaFile.mimetype;
      const base64Data = mediaFile.data.toString('base64');
      media = new MessageMedia(mimeType, base64Data, mediaFile.name);

    } else if (fileUrl) {
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const mimeType = response.headers['content-type'] || mime.lookup(fileUrl);
      const base64Data = Buffer.from(response.data, 'binary').toString('base64');
      media = new MessageMedia(mimeType, base64Data, path.basename(fileUrl));

    } else if (filePath) {
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Local file not found' });
      }
      const mimeType = mime.lookup(filePath);
      if (!mimeType) return res.status(400).json({ error: 'Cannot determine file type from filePath' });
      const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
      media = new MessageMedia(mimeType, fileData, path.basename(filePath));

    } else {
      return res.status(400).json({ error: 'Either file upload (media), fileUrl or filePath is required' });
    }

    await client.sendMessage(number, media, { caption: caption || '' });
    res.json({ success: true, message: 'Media sent successfully' });

  } catch (error) {
    console.error('Error sending media:', error);

    if (String(error.message || '').match(/Target closed|Browser disconnected|Protocol error/i)) {
      try {
        await restartInstance(id);
        return res.status(503).json({
          error: 'Instance restarted due to browser disconnect. Please retry your request.'
        });
      } catch (restartError) {
        return res.status(500).json({
          error: 'Failed to restart instance after browser disconnect.',
          details: restartError.message
        });
      }
    }

    res.status(500).json({ error: 'Failed to send media', details: error.message });
  }
});

// Get all chats
app.get('/chats/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  const client = getInstance(id);
  if (!client) return res.status(404).json({ error: 'Instance not found or not connected' });

  try {
    const chats = await client.getChats();
    res.json(chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.formattedTitle || chat.id.user,
      isGroup: chat.isGroup
    })));
  } catch (err) {
    console.error('Error fetching chats:', err);
    res.status(500).json({ error: 'Failed to fetch chats', details: err.message });
  }
});

// Get groups only
app.get('/groups/:id', async (req, res) => {
  const id = (req.params.id || '').trim();
  const client = getInstance(id);
  if (!client) return res.status(404).json({ error: 'Instance not found or not connected' });

  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    res.json(groups.map(group => ({
      id: group.id._serialized,
      name: group.name || group.formattedTitle
    })));
  } catch (err) {
    console.error('Error fetching groups:', err);
    res.status(500).json({ error: 'Failed to fetch groups', details: err.message });
  }
});

// ---------- Global error handler (last) ----------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// ---------- Start server & restore sessions ----------
(async () => {
  try {
    await restoreSessions();
  } catch (e) {
    console.error('restoreSessions error:', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp API server running on http://0.0.0.0:${PORT}`);
  });
})();
