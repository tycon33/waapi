// instanceManager.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const os = require('os-utils');

// =========================
// DB POOL
// =========================
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'waapi',
  port: Number(process.env.DB_PORT || 3306),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
});

async function safeQuery(sql, params = []) {
  let conn;
  try {
    conn = await db.getConnection();
    const [rows] = await conn.query(sql, params);
    return rows;
  } catch (err) {
    console.error("❌ DB Query Error:", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

// =========================
// DIRECTORIES
// =========================
const APP_ROOT = __dirname;
const SESSIONS_PATH = path.join(APP_ROOT, '.wwebjs_auth');
const CHROME_PROFILES_PATH = path.join(SESSIONS_PATH, '_chrome_profiles');
ensureDir(SESSIONS_PATH);
ensureDir(CHROME_PROFILES_PATH);

// =========================
// STATE
// =========================
const instances = new Map();
const qrCodes = new Map();
const restartingInstances = new Set();
const instanceQueue = [];
let queueRunning = false;

// =========================
// HELPERS
// =========================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function updateInstanceStatusInDb(instanceId, status, extra = {}) {
  const sql = `
    UPDATE instances
    SET status = ?, number = ?, pushname = ?, profile_pic = ?, updated_at = NOW()
    WHERE instance_code = ?;
  `;
  const params = [
    status,
    extra.number || null,
    extra.pushname || null,
    extra.profile_pic || null,
    instanceId,
  ];
  await safeQuery(sql, params);
}

// =========================
// RESOURCE MONITORING
// =========================
async function canCreateInstance(maxCpu = 80, maxRamPercent = 80) {
  return new Promise(resolve => {
    os.cpuUsage(cpuPercent => {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedRamPercent = ((totalMem - freeMem) / totalMem) * 100;
      resolve(!(cpuPercent * 100 > maxCpu || usedRamPercent > maxRamPercent));
    });
  });
}

// =========================
// MEMORY CLEANUP
// =========================
setInterval(() => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedRamPercent = ((totalMem - freeMem) / totalMem) * 100;

  if (usedRamPercent > 85) {
    console.warn(`⚠️ High RAM usage (${usedRamPercent.toFixed(1)}%). Cleaning...`);

    for (const [id, client] of instances.entries()) {
      if (!client.info?.wid) {
        console.log(`🧹 Cleaning idle instance ${id}.`);
        resetInstance(id);
      }
    }

    if (global.gc) {
      console.log("🧹 Forcing garbage collection...");
      global.gc();
    }
  }
}, 2 * 60 * 1000);

// =========================
// QUEUE MANAGEMENT
// =========================
async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (instanceQueue.length > 0) {
    const { fn, resolve, reject } = instanceQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
    await delay(500);
  }
  queueRunning = false;
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    instanceQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

// =========================
// INSTANCE MANAGEMENT
// =========================
async function createInstance(id) {
  if (instances.has(id)) {
    console.log(`⚠️ Instance ${id} already exists (skipping new init)`);
    return instances.get(id);
  }

  console.log(`🚀 Creating new instance: ${id}`);

  const client = new Client({
    puppeteer: {
      headless: false,
      executablePath: getChromePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    },
    authStrategy: new LocalAuth({
      clientId: id,
      dataPath: SESSIONS_PATH
    })
  });

  client.isInitializing = true;

  client.on('qr', (qr) => {
    qrCodes.set(id, qr);
    console.log(`📲 QR code generated for ${id}`);
    updateInstanceStatusInDb(id, 'qr');
  });

  client.on('ready', async () => {
    client.isInitializing = false;
    console.log(`✅ Client ${id} is ready`);
    const info = await getInfo(id);
    await updateInstanceStatusInDb(id, 'ready', info);
  });

  client.on('authenticated', () => {
    console.log(`🔑 Client ${id} authenticated`);
    updateInstanceStatusInDb(id, 'authenticated');
  });

  client.on('disconnected', (reason) => {
    console.log(`❌ Client ${id} disconnected: ${reason}`);
    updateInstanceStatusInDb(id, 'disconnected');
    instances.delete(id);
    qrCodes.delete(id);
  });

  client.on('debug', (msg) => {
    console.log('DEBUG:', msg);
  });


  client.on('auth_failure', (msg) => {
    console.error(`⚠️ Auth failure for ${id}: ${msg}`);
    updateInstanceStatusInDb(id, 'auth_failure');
    instances.delete(id);
    qrCodes.delete(id);
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error(`❌ Init error ${id}:`, err.message);
    updateInstanceStatusInDb(id, 'error');
    instances.delete(id);
    qrCodes.delete(id);
  }

  instances.set(id, client);
  return client;
}

async function resetInstance(instanceId) {
  return enqueue(async () => {
    const client = instances.get(instanceId);
    if (client) {
      try {
        await client.destroy();
      } catch (e) {}
      instances.delete(instanceId);
    }
    qrCodes.delete(instanceId);

    const profilePath = path.join(CHROME_PROFILES_PATH, instanceId);
    await removeFolderWithRetries(profilePath);

    try {
      execSync(`pkill -f "chrome.*${instanceId}" || true`);
    } catch (e) {}
  });
}

async function removeFolderWithRetries(folderPath, maxRetries = 5, delayMs = 1000) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
      return true;
    } catch (e) {
      attempts++;
      if (attempts >= maxRetries) {
        console.error(`❌ Failed to remove ${folderPath}: ${e.message}`);
        return false;
      }
      await delay(delayMs);
    }
  }
  return false;
}

function getChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  console.warn('⚠️ No Chrome/Chromium found.');
  return null;
}

// =========================
// EXPORTS
// =========================
module.exports = {
  createInstance,
  getInstance: (id) => instances.get(id),  // Return the instance by ID
  deleteInstance: (id) => {
    if (instances.has(id)) {
      const client = instances.get(id);
      client.destroy();
      instances.delete(id);
      qrCodes.delete(id);
      return true;
    }
    return false;
  },
  getStatus: (id) => {
    const client = instances.get(id);
    return client ? client.info?.status : null;
  },
  getQRCode: (id) => qrCodes.get(id),
  restoreSessions: async () => { /* restore sessions logic here */ },
  getInfo: async (id) => {
    const client = instances.get(id);
    return client?.info || {};
  },
  logoutInstance: async (id) => {
    const client = instances.get(id);
    if (client) await client.logout();
    instances.delete(id);
    qrCodes.delete(id);
  },
  resetInstance,
  restartInstance: async (id) => {
    await resetInstance(id);
    await createInstance(id);
  },
  instances,
  qrCodes,
};
